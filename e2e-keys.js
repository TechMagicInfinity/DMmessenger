// Один ключ шифрования на аккаунт, который можно перенести между устройствами.
//
// Раньше каждое устройство создавало СВОЮ пару ключей и при каждом запуске
// перезаписывало ключ аккаунта на сервере. Получалось «кто запустился
// последним, тот и прав»: второе устройство переставало читать переписку.
//
// Теперь:
//  - устройство без ключа НЕ создаёт новый ключ, если у аккаунта он уже есть,
//    а просит перенести его с другого устройства;
//  - ключ другого устройства на сервере НЕ затирается молча;
//  - пока ключи не совпадают, отправка отключена (иначе собеседник получил бы
//    сообщение, которое не сможет прочитать);
//  - в Настройках появился раздел «Шифрование»: экспорт и импорт ключа
//    под паролем, отпечаток ключа.
//
// Подключается ПОСЛЕ renderer.js. Сам renderer.js не меняется: подменяются
// функции ensureMyKeyPair и encryptMessage.
(() => {
  const FAIL_TEXT = '⚠️ Не удалось расшифровать сообщение';
  const CURVE = { name: 'ECDH', namedCurve: 'P-256' };
  const KDF_ITER = 600000;
  const KEY_PREFIX = 'FNKEY1.';

  // ok: всё в порядке; mismatch: на сервере ключ другого устройства;
  // missing: у аккаунта ключ есть, а на этом устройстве его нет; error: нет связи
  let keyState = { status: 'ok', hasLocal: false, fingerprint: '' };

  // ---------- вспомогательное ----------

  function sameKey(a, b) {
    try {
      const x = typeof a === 'string' ? JSON.parse(a) : a;
      const y = typeof b === 'string' ? JSON.parse(b) : b;
      return !!x && !!y && x.x === y.x && x.y === y.y;
    } catch {
      return false;
    }
  }

  // короткий «отпечаток» публичного ключа: по нему можно убедиться, что на двух
  // устройствах один и тот же ключ
  async function fingerprintOf(pub) {
    const data = new TextEncoder().encode(pub.x + '.' + pub.y);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    const hex = Array.from(hash.slice(0, 8), (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
    return hex.match(/.{4}/g).join(' ');
  }

  async function loadLocalPair() {
    const stored = localStorage.getItem(myKeyStoreKey());
    if (!stored) return null;
    try {
      const { pub, priv } = JSON.parse(stored);
      const publicKey = await crypto.subtle.importKey('jwk', pub, CURVE, true, []);
      const privateKey = await crypto.subtle.importKey('jwk', priv, CURVE, true, ['deriveBits']);
      return { pub, priv, pair: { publicKey, privateKey } };
    } catch (err) {
      console.error('Не удалось прочитать ключ шифрования на этом устройстве', err);
      return null;
    }
  }

  function storeLocal(pub, priv) {
    const current = localStorage.getItem(myKeyStoreKey());
    // страховка: прежний ключ остаётся рядом, если импорт был ошибкой
    if (current) localStorage.setItem(myKeyStoreKey() + '_backup', current);
    localStorage.setItem(myKeyStoreKey(), JSON.stringify({ pub, priv }));
  }

  async function generateNewKey() {
    const pair = await crypto.subtle.generateKey(CURVE, true, ['deriveBits']);
    const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
    return { pub, priv, pair };
  }

  async function publishPub(pub) {
    await authFetch('/api/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: JSON.stringify(pub) }),
    });
  }

  // ---------- экспорт / импорт ключа под паролем ----------

  async function deriveWrapKey(password, salt, iterations) {
    const base = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function exportKeyString(password) {
    const stored = localStorage.getItem(myKeyStoreKey());
    if (!stored) throw new Error('На этом устройстве нет ключа, который можно экспортировать');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveWrapKey(password, salt, KDF_ITER);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(stored));
    const box = { i: KDF_ITER, s: bufToBase64(salt), v: bufToBase64(iv), c: bufToBase64(ct) };
    return KEY_PREFIX + btoa(JSON.stringify(box));
  }

  async function importKeyString(text, password) {
    const clean = String(text).replace(/\s+/g, '');
    if (!clean.startsWith(KEY_PREFIX)) throw new Error('Это не похоже на ключ FNLink');

    let box;
    try {
      box = JSON.parse(atob(clean.slice(KEY_PREFIX.length)));
    } catch {
      throw new Error('Ключ повреждён: скопируйте его целиком, без пропусков');
    }
    if (!box || !(box.i >= 100000 && box.i <= 2000000) || !box.s || !box.v || !box.c) {
      throw new Error('Ключ повреждён: скопируйте его целиком, без пропусков');
    }

    const key = await deriveWrapKey(password, new Uint8Array(base64ToBuf(box.s)), box.i);
    let plain;
    try {
      plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(base64ToBuf(box.v)) }, key, base64ToBuf(box.c)
      );
    } catch {
      throw new Error('Неверный пароль или ключ повреждён');
    }

    const obj = JSON.parse(new TextDecoder().decode(plain));
    if (!obj || !obj.pub || !obj.priv) throw new Error('В ключе не хватает данных');
    // проверяем, что оба ключа импортируются и принадлежат одной паре
    await crypto.subtle.importKey('jwk', obj.priv, CURVE, true, ['deriveBits']);
    await crypto.subtle.importKey('jwk', obj.pub, CURVE, true, []);
    if (obj.priv.x !== obj.pub.x || obj.priv.y !== obj.pub.y) throw new Error('Ключ повреждён');
    return { pub: obj.pub, priv: obj.priv };
  }

  // ---------- состояние ключа ----------

  async function fetchServerKey() {
    try {
      const data = await authFetch('/api/profiles');
      const mine = (data.profiles || []).find((p) => p.username === myUsername);
      return { ok: true, key: mine && mine.publicKey ? mine.publicKey : '' };
    } catch (err) {
      return { ok: false, key: '' };
    }
  }

  // isStartup=true: при входе (можно создать первый ключ или вернуть серверу
  // «забытый» ключ). false: только проверка, без побочных действий.
  async function evaluate(isStartup) {
    const server = await fetchServerKey();
    let local = await loadLocalPair();
    if (local) myKeyPair = local.pair; // старые сообщения этим ключом читаются

    let status;
    if (!server.ok) {
      status = local ? 'ok' : 'error';
    } else if (local) {
      if (!server.key) {
        // сервер «забыл» ключ (например, его данные сбрасывали): возвращаем
        if (isStartup) {
          try { await publishPub(local.pub); } catch (err) { console.error('Не удалось опубликовать ключ', err); }
        }
        status = 'ok';
      } else {
        status = sameKey(server.key, local.pub) ? 'ok' : 'mismatch';
      }
    } else if (server.key) {
      status = 'missing'; // новое устройство: ключ нужно перенести, а не создавать
    } else if (isStartup) {
      // совсем новый аккаунт: ключа нет нигде, создаём первый
      const fresh = await generateNewKey();
      storeLocal(fresh.pub, fresh.priv);
      myKeyPair = fresh.pair;
      try { await publishPub(fresh.pub); } catch (err) { console.error('Не удалось опубликовать ключ', err); }
      local = fresh;
      status = 'ok';
    } else {
      status = 'missing';
    }

    keyState = {
      status,
      hasLocal: !!local,
      fingerprint: local ? await fingerprintOf(local.pub) : '',
    };
    if (typeof document !== 'undefined') refreshUi();
  }

  const SEND_ERRORS = {
    mismatch:
      'Ключ этого устройства не совпадает с ключом аккаунта. Откройте Настройки → Шифрование: ' +
      'импортируйте ключ с другого устройства или сделайте этот ключ основным.',
    missing:
      'На этом устройстве нет ключа шифрования. Откройте Настройки → Шифрование ' +
      'и импортируйте ключ с другого устройства.',
    error: 'Не удалось проверить ключ шифрования. Проверьте связь и перезапустите приложение.',
  };

  // подмена функций из renderer.js
  window.ensureMyKeyPair = () => evaluate(true);

  const originalEncrypt = window.encryptMessage;
  window.encryptMessage = async function (contactUsername, plaintext) {
    if (keyState.status !== 'ok') throw new Error(SEND_ERRORS[keyState.status] || SEND_ERRORS.error);
    return originalEncrypt(contactUsername, plaintext);
  };

  // для проверки без браузера
  if (window.__FNLINK_TEST__) {
    window.__e2e = { exportKeyString, importKeyString, sameKey, fingerprintOf };
  }

  if (typeof document === 'undefined') return;

  // ---------- интерфейс ----------

  const style = document.createElement('style');
  style.textContent =
    '#key-warning{margin:8px 8px 0;padding:8px 10px;border-radius:8px;font-size:12px;line-height:1.4;' +
    'background:rgba(245,158,11,.14);border:1px solid rgba(245,158,11,.5);color:var(--text)}' +
    '#key-warning button{margin-top:6px;display:block}' +
    '#e2e-section input,#e2e-section textarea{width:100%;box-sizing:border-box;background:var(--bg-2);' +
    'border:1px solid var(--border);border-radius:8px;padding:8px 10px;color:var(--text);font-size:13px;' +
    'font-family:var(--font-sans)}' +
    '#e2e-section textarea{resize:vertical;margin-top:8px}' +
    '#e2e-section .e2e-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}' +
    '#e2e-section label.settings-field{margin-top:10px}';
  document.head.appendChild(style);

  // плашка-предупреждение в боковой колонке
  const warning = document.createElement('div');
  warning.id = 'key-warning';
  warning.className = 'hidden';
  warning.innerHTML = '<span id="key-warning-text"></span>';
  const warningBtn = document.createElement('button');
  warningBtn.type = 'button';
  warningBtn.className = 'btn-secondary';
  warningBtn.textContent = 'Открыть настройки шифрования';
  warning.appendChild(warningBtn);
  const sidebar = document.querySelector('.sidebar');
  const search = document.querySelector('.contact-search');
  if (sidebar && search) sidebar.insertBefore(warning, search);
  warningBtn.addEventListener('click', () => settingsBtn.click());

  // раздел «Шифрование» в Настройках
  const body = document.querySelector('#settings-modal .modal-body');
  const section = document.createElement('section');
  section.className = 'settings-section';
  section.id = 'e2e-section';
  section.innerHTML =
    '<h3>Шифрование</h3>' +
    '<p class="settings-hint" id="e2e-status"></p>' +
    '<p class="settings-hint">Отпечаток ключа этого устройства: <b id="e2e-fp">нет</b></p>' +
    '<label class="settings-field">Пароль для переноса ключа (придумайте сами, не короче 8 символов; ' +
    'тот же пароль понадобится на другом устройстве)' +
    '<input type="password" id="e2e-pass" autocomplete="new-password" /></label>' +
    '<div class="e2e-row"><button type="button" class="btn-secondary" id="e2e-export-btn">Экспортировать ключ</button></div>' +
    '<textarea id="e2e-export-out" rows="3" readonly placeholder="Здесь появится ключ для переноса"></textarea>' +
    '<label class="settings-field">Ключ с другого устройства' +
    '<textarea id="e2e-import-in" rows="3" placeholder="Вставьте сюда ключ (начинается с FNKEY1.)"></textarea></label>' +
    '<div class="e2e-row"><button type="button" class="btn-secondary" id="e2e-import-btn">Импортировать ключ</button></div>' +
    '<div class="e2e-row">' +
    '<button type="button" class="btn-text hidden" id="e2e-takeover-btn">Сделать ключ этого устройства основным</button>' +
    '<button type="button" class="btn-text hidden" id="e2e-create-btn">Создать новый ключ на этом устройстве</button>' +
    '</div>' +
    '<p class="settings-hint">Ключ открывает доступ ко всей вашей переписке. Переносите его только ' +
    'на свои устройства и никому не показывайте.</p>' +
    '<div class="auth-error" id="e2e-msg"></div>';
  if (body) body.appendChild(section);

  const $ = (id) => document.getElementById(id);
  const statusEl = $('e2e-status');
  const fpEl = $('e2e-fp');
  const passEl = $('e2e-pass');
  const exportOut = $('e2e-export-out');
  const importIn = $('e2e-import-in');
  const msgEl = $('e2e-msg');
  const takeoverBtn = $('e2e-takeover-btn');
  const createBtn = $('e2e-create-btn');

  function setMsg(text, isError = true) {
    msgEl.textContent = text;
    msgEl.style.color = isError ? '' : 'var(--accent)';
  }

  const STATUS_TEXT = {
    ok: 'Ключ этого устройства совпадает с ключом аккаунта: сообщения читаются и отправляются.',
    mismatch:
      '⚠️ На сервере ключ другого устройства, поэтому отправка здесь отключена (собеседники ' +
      'получили бы сообщения, которые не смогут прочитать). Импортируйте ключ с того устройства ' +
      'или сделайте ключ этого устройства основным.',
    missing:
      '⚠️ У аккаунта уже есть ключ, но он на другом устройстве. Импортируйте его сюда, ' +
      'тогда переписка станет читаться и здесь.',
    error: 'Не удалось проверить ключ на сервере. Проверьте связь и перезапустите приложение.',
  };

  function refreshUi() {
    const st = keyState.status;
    statusEl.textContent = STATUS_TEXT[st] || '';
    fpEl.textContent = keyState.fingerprint || 'нет';
    takeoverBtn.classList.toggle('hidden', !(st === 'mismatch' && keyState.hasLocal));
    createBtn.classList.toggle('hidden', st !== 'missing');

    const bad = st === 'mismatch' || st === 'missing';
    warning.classList.toggle('hidden', !bad);
    $('key-warning-text').textContent =
      st === 'missing'
        ? 'На этом устройстве нет ключа шифрования: сообщения не читаются и не отправляются.'
        : 'Ключ шифрования этого устройства не совпадает с ключом аккаунта: отправка отключена.';
  }

  settingsBtn.addEventListener('click', () => {
    setMsg('');
    evaluate(false);
  });

  $('e2e-export-btn').addEventListener('click', async () => {
    setMsg('');
    if (passEl.value.length < 8) return setMsg('Пароль должен быть не короче 8 символов');
    try {
      const str = await exportKeyString(passEl.value);
      exportOut.value = str;
      exportOut.focus();
      exportOut.select();
      try {
        await navigator.clipboard.writeText(str);
        setMsg('Ключ скопирован. Вставьте его на другом устройстве и введите тот же пароль.', false);
      } catch {
        setMsg('Ключ показан ниже: скопируйте его вручную.', false);
      }
    } catch (err) {
      setMsg(err.message);
    }
  });

  $('e2e-import-btn').addEventListener('click', async () => {
    setMsg('');
    if (!importIn.value.trim()) return setMsg('Вставьте ключ');
    if (!passEl.value) return setMsg('Введите пароль, который вы задали при экспорте');
    try {
      const obj = await importKeyString(importIn.value, passEl.value);
      const current = await loadLocalPair();
      if (current && !sameKey(current.pub, obj.pub)) {
        if (!confirm('Ключ на этом устройстве будет заменён. Сообщения, зашифрованные прежним ключом, ' +
          'перестанут читаться (копия прежнего ключа сохранится на устройстве). Продолжить?')) return;
      }
      storeLocal(obj.pub, obj.priv);
      await publishPub(obj.pub);
      location.reload();
    } catch (err) {
      setMsg(err.message);
    }
  });

  takeoverBtn.addEventListener('click', async () => {
    setMsg('');
    if (!confirm('Собеседники смогут писать только на это устройство. Сообщения, зашифрованные ключом ' +
      'другого устройства, перестанут читаться. Продолжить?')) return;
    try {
      const local = await loadLocalPair();
      if (!local) return setMsg('На этом устройстве нет ключа');
      await publishPub(local.pub);
      location.reload();
    } catch (err) {
      setMsg('Не удалось обновить ключ на сервере: ' + err.message);
    }
  });

  createBtn.addEventListener('click', async () => {
    setMsg('');
    if (!confirm('Будет создан новый ключ. Прежняя переписка станет нечитаемой на всех устройствах, ' +
      'пока вы не вернёте старый ключ. Продолжить?')) return;
    try {
      const fresh = await generateNewKey();
      storeLocal(fresh.pub, fresh.priv);
      await publishPub(fresh.pub);
      location.reload();
    } catch (err) {
      setMsg('Не удалось создать ключ: ' + err.message);
    }
  });

  // ---------- когда у собеседника сменился ключ ----------
  // sharedKeyCache хранит общий ключ переписки до перезапуска. Если собеседник
  // сменил ключ, сбрасываем кэш и снова пробуем расшифровать то, что не вышло.
  function retryFailed(chatId) {
    delete sharedKeyCache[chatId];
    const list = messagesByChat[chatId] || [];
    for (const msg of list) {
      if (msg._plain === FAIL_TEXT) msg._plain = undefined;
    }
    if (chatId === currentChat) renderMessages();
  }

  const previousConnectWs = window.connectWs;
  if (typeof previousConnectWs === 'function') {
    window.connectWs = function () {
      previousConnectWs();
      if (!ws) return;
      ws.addEventListener('message', (event) => {
        let data;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        if (data.type === 'profile' && data.username && data.username !== myUsername) {
          retryFailed(data.username);
        }
      });
    };
  }
})();
