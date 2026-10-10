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
//
// Перенос ключа на новое устройство делается автоматически: на новом устройстве
// после входа появляется окно «подтвердите на другом устройстве», на старом
// устройстве приходит запрос, и после подтверждения показывается код из 6
// символов, который нужно ввести на новом. Сервер ключа прочитать не может.
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

    return validateBundle(JSON.parse(new TextDecoder().decode(plain)));
  }

  // проверяем, что оба ключа импортируются и принадлежат одной паре
  async function validateBundle(obj) {
    if (!obj || !obj.pub || !obj.priv) throw new Error('В ключе не хватает данных');
    await crypto.subtle.importKey('jwk', obj.priv, CURVE, true, ['deriveBits']);
    await crypto.subtle.importKey('jwk', obj.pub, CURVE, true, []);
    if (obj.priv.x !== obj.pub.x || obj.priv.y !== obj.pub.y) throw new Error('Ключ повреждён');
    return { pub: obj.pub, priv: obj.priv };
  }

  // ---------- перенос ключа по коду (криптография) ----------
  // Старое устройство шифрует ключ под временным ECDH-секретом с новым
  // устройством; сервер видит только шифротекст.

  const SAS_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  // Код из 6 символов; такая же функция на сервере (transfer.js)
  async function sasCode(id, nPubStr, oPubStr) {
    const data = new TextEncoder().encode('fnlink-sas-v1|' + id + '|' + nPubStr + '|' + oPubStr);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    let out = '';
    for (let i = 0; i < 6; i++) {
      let value = 0;
      for (let j = 0; j < 5; j++) {
        const bit = i * 5 + j;
        value = (value << 1) | ((hash[bit >> 3] >> (7 - (bit & 7))) & 1);
      }
      out += SAS_ALPHABET[value];
    }
    return out;
  }

  function normalizeCode(text) {
    return String(text || '').toUpperCase().replace(/[\s-]/g, '');
  }

  async function transferWrapKey(sharedBits, id) {
    const base = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: new TextEncoder().encode('fnlink-transfer-v1:' + id),
      },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  function minimalJwk(jwk) {
    return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
  }

  // Новое устройство: временная пара ключей для этого переноса
  async function makeTransferKeys() {
    const pair = await crypto.subtle.generateKey(CURVE, true, ['deriveBits']);
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    return { privateKey: pair.privateKey, pubStr: minimalJwk(jwk) };
  }

  // Старое устройство: зашифровать свой ключ для нового
  async function buildTransfer(nPubStr, id, bundleStr) {
    const nPub = await crypto.subtle.importKey('jwk', JSON.parse(nPubStr), CURVE, true, []);
    const eph = await crypto.subtle.generateKey(CURVE, true, ['deriveBits']);
    const oJwk = await crypto.subtle.exportKey('jwk', eph.publicKey);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: nPub }, eph.privateKey, 256);
    const key = await transferWrapKey(shared, id);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(bundleStr));
    return { oPubStr: minimalJwk(oJwk), ct: bufToBase64(ct), iv: bufToBase64(iv) };
  }

  // Новое устройство: расшифровать присланный ключ
  async function openTransfer(nPrivateKey, oPubStr, id, ctB64, ivB64) {
    const oPub = await crypto.subtle.importKey('jwk', JSON.parse(oPubStr), CURVE, true, []);
    const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: oPub }, nPrivateKey, 256);
    const key = await transferWrapKey(shared, id);
    let plain;
    try {
      plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(base64ToBuf(ivB64)) }, key, base64ToBuf(ctB64)
      );
    } catch {
      throw new Error('Не удалось расшифровать ключ: перенос нужно повторить');
    }
    return validateBundle(JSON.parse(new TextDecoder().decode(plain)));
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
    if (typeof document !== 'undefined') {
      refreshUi();
      // новое устройство: сразу предлагаем подтвердить вход на другом
      if (isStartup && status === 'missing') startTransferFlow();
    }
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
    window.__e2e = {
      exportKeyString, importKeyString, sameKey, fingerprintOf,
      sasCode, makeTransferKeys, buildTransfer, openTransfer, normalizeCode,
    };
  }

  if (typeof document === 'undefined') return;

  // ---------- интерфейс ----------

  // плашка-предупреждение в боковой колонке
  const warning = document.createElement('div');
  warning.id = 'key-warning';
  warning.className = 'hidden';
  warning.innerHTML = '<span id="key-warning-text"></span>';
  const warningBtn = document.createElement('button');
  warningBtn.type = 'button';
  warningBtn.className = 'btn-secondary';
  warningBtn.textContent = 'Открыть настройки шифрования';
  const warningTransferBtn = document.createElement('button');
  warningTransferBtn.type = 'button';
  warningTransferBtn.className = 'btn-secondary';
  warningTransferBtn.textContent = 'Подтвердить на другом устройстве';
  warning.appendChild(warningTransferBtn);
  warning.appendChild(warningBtn);
  const sidebar = document.querySelector('.sidebar');
  const search = document.querySelector('.contact-search');
  if (sidebar && search) sidebar.insertBefore(warning, search);
  warningBtn.addEventListener('click', () => settingsBtn.click());
  warningTransferBtn.addEventListener('click', () => startTransferFlow());

  // раздел «Шифрование» в Настройках
  const $ = (id) => document.getElementById(id);
  const statusEl = $('e2e-status');
  const fpEl = $('e2e-fp');
  const passEl = $('e2e-pass');
  const exportOut = $('e2e-export-out');
  const importIn = $('e2e-import-in');
  const msgEl = $('e2e-msg');
  const takeoverBtn = $('e2e-takeover-btn');
  const createBtn = $('e2e-create-btn');
  const transferBtn = $('e2e-transfer-btn');
  transferBtn.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
    startTransferFlow();
  });

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
      '⚠️ У аккаунта уже есть ключ, но он на другом устройстве. Нажмите «Подтвердить вход на ' +
      'другом устройстве» (проще всего) или импортируйте ключ вручную.',
    error: 'Не удалось проверить ключ на сервере. Проверьте связь и перезапустите приложение.',
  };

  function refreshUi() {
    const st = keyState.status;
    statusEl.textContent = STATUS_TEXT[st] || '';
    fpEl.textContent = keyState.fingerprint || 'нет';
    takeoverBtn.classList.toggle('hidden', !(st === 'mismatch' && keyState.hasLocal));
    createBtn.classList.toggle('hidden', st !== 'missing');
    transferBtn.classList.toggle('hidden', !(st === 'missing' || st === 'mismatch'));
    warningTransferBtn.classList.toggle('hidden', !(st === 'missing' || st === 'mismatch'));

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


  // ---------- перенос ключа на новое устройство: экраны ----------

  const ktStyle = document.createElement('style');
  ktStyle.textContent =
    '#kt-overlay{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;' +
    'justify-content:center;padding:16px;background:rgba(0,0,0,.72)}' +
    '#kt-card{width:100%;max-width:420px;max-height:100%;overflow-y:auto;box-sizing:border-box;' +
    'background:var(--bg-1);border:1px solid var(--border);border-radius:12px;padding:20px;color:var(--text)}' +
    '#kt-card h3{margin:0 0 12px;font-size:16px}' +
    '#kt-card p{margin:0 0 12px;font-size:13px;line-height:1.5;color:var(--text-dim)}' +
    '#kt-card .kt-device{color:var(--text);font-weight:600}' +
    '#kt-card .kt-code{margin:8px 0 14px;text-align:center;font-family:var(--font-mono);font-size:34px;' +
    'font-weight:700;letter-spacing:6px;color:var(--accent)}' +
    '#kt-card input{width:100%;box-sizing:border-box;margin-bottom:8px;background:var(--bg-2);' +
    'border:1px solid var(--border);border-radius:8px;padding:10px;color:var(--text);' +
    'font-family:var(--font-mono);font-size:22px;letter-spacing:5px;text-align:center;text-transform:uppercase}' +
    '#kt-card .kt-error{min-height:18px;margin-bottom:8px;font-size:12px;color:var(--danger)}' +
    '#kt-card .kt-buttons{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}';
  document.head.appendChild(ktStyle);

  function h(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text; // только textContent: имя устройства приходит с сервера
    return el;
  }

  function ktShow(title, nodes, buttons) {
    let overlay = document.getElementById('kt-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'kt-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = '';
    const card = document.createElement('div');
    card.id = 'kt-card';
    card.appendChild(h('h3', '', title));
    nodes.forEach((n) => card.appendChild(n));
    const row = h('div', 'kt-buttons');
    buttons.forEach((b) => {
      const btn = h('button', b.className || 'btn-secondary', b.text);
      btn.type = 'button';
      btn.addEventListener('click', b.onClick);
      row.appendChild(btn);
    });
    card.appendChild(row);
    overlay.appendChild(card);
    return card;
  }

  function ktClose() {
    const overlay = document.getElementById('kt-overlay');
    if (overlay) overlay.remove();
  }

  function deviceName() {
    const ua = navigator.userAgent || '';
    if (window.Capacitor && typeof window.Capacitor.getPlatform === 'function' &&
        window.Capacitor.getPlatform() === 'android') return 'Телефон (Android)';
    if (/Windows/i.test(ua)) return 'Компьютер (Windows)';
    if (/Mac OS X/i.test(ua)) return 'Компьютер (macOS)';
    if (/Linux/i.test(ua)) return 'Компьютер (Linux)';
    return 'Новое устройство';
  }

  function formatCode(code) {
    return code.slice(0, 3) + '-' + code.slice(3);
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // --- новое устройство ---
  let transferRun = null;

  async function cancelOwnTransfer(run) {
    run.cancelled = true;
    if (run.id) {
      try {
        await authFetch('/api/key-transfer/' + run.id + '/decline', { method: 'POST' });
      } catch (err) {
        /* запрос и так скоро истечёт */
      }
    }
  }

  function showTransferMessage(title, text, retry) {
    const buttons = [{ text: 'Закрыть', onClick: ktClose }];
    if (retry) buttons.unshift({ text: 'Повторить', className: 'btn-primary', onClick: () => { ktClose(); startTransferFlow(); } });
    buttons.push({
      text: 'Другие способы',
      className: 'btn-text',
      onClick: () => { ktClose(); settingsBtn.click(); },
    });
    ktShow(title, [h('p', '', text)], buttons);
  }

  async function startTransferFlow() {
    if (transferRun) return;
    const run = { cancelled: false, id: null };
    transferRun = run;

    try {
      const keys = await makeTransferKeys();
      const res = await authFetch('/api/key-transfer/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nPub: keys.pubStr, deviceName: deviceName() }),
      });
      run.id = res.id;

      const statusP = h('p', '', 'Ждём подтверждения…');
      ktShow(
        'Подтвердите вход на другом устройстве',
        [
          h('p', '', 'Чтобы читать переписку на этом устройстве, откройте FNLink на другом своём ' +
            'устройстве и нажмите «Подтвердить». Запрос действует 5 минут.'),
          statusP,
        ],
        [
          { text: 'Отмена', onClick: () => { cancelOwnTransfer(run); ktClose(); } },
          {
            text: 'У меня нет другого устройства',
            className: 'btn-text',
            onClick: () => { cancelOwnTransfer(run); ktClose(); settingsBtn.click(); },
          },
        ]
      );

      // ждём, пока старое устройство подтвердит
      let oPubStr = null;
      let failures = 0;
      while (!run.cancelled) {
        await sleep(2000);
        if (run.cancelled) return;
        let st;
        try {
          st = await authFetch('/api/key-transfer/' + run.id);
          failures = 0;
        } catch (err) {
          if (++failures >= 5) throw new Error('Нет связи с сервером');
          continue;
        }
        if (st.status === 'approved') { oPubStr = st.oPub; break; }
        if (st.status === 'declined') {
          return showTransferMessage('Вход отклонён', 'Запрос отклонили на другом устройстве.', true);
        }
        if (st.status === 'expired') {
          return showTransferMessage('Время вышло', 'Запрос не подтвердили за 5 минут.', true);
        }
      }
      if (run.cancelled) return;

      await askForCode(run, keys, oPubStr);
    } catch (err) {
      if (!run.cancelled) showTransferMessage('Не удалось перенести ключ', err.message, true);
    } finally {
      transferRun = null;
    }
  }

  // экран ввода кода; возвращает управление, когда код принят или окно закрыто
  function askForCode(run, keys, oPubStr) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 7;
      input.autocomplete = 'off';
      input.setAttribute('autocapitalize', 'characters');
      input.placeholder = 'XXX-XXX';
      const errorEl = h('div', 'kt-error');
      let localFails = 0;
      let busy = false;

      const finish = () => { run.cancelled = true; resolve(); };

      const submit = async () => {
        if (busy) return;
        const typed = normalizeCode(input.value);
        if (typed.length !== 6) { errorEl.textContent = 'Код состоит из 6 символов'; return; }
        busy = true;
        errorEl.textContent = '';
        try {
          // сверяем код с тем, который получается из ключей, что мы видим сами:
          // если ключи подменили по дороге, код не совпадёт
          const expected = await sasCode(run.id, keys.pubStr, oPubStr);
          if (typed !== expected) {
            localFails += 1;
            if (localFails >= 5) {
              cancelOwnTransfer(run);
              showTransferMessage('Слишком много попыток', 'Код введён неверно 5 раз. Начните заново.', true);
              return finish();
            }
            errorEl.textContent = 'Код не совпадает. Проверьте его на другом устройстве (осталось попыток: ' +
              (5 - localFails) + ')';
            return;
          }

          const res = await authFetch('/api/key-transfer/' + run.id + '/claim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: typed }),
          });
          if (res.oPub !== oPubStr) throw new Error('Данные переноса изменились по дороге, повторите');
          const bundle = await openTransfer(keys.privateKey, oPubStr, run.id, res.ct, res.iv);
          storeLocal(bundle.pub, bundle.priv);
          ktShow('Готово', [h('p', '', 'Ключ перенесён. Перезапускаем приложение…')], []);
          setTimeout(() => location.reload(), 600);
          return finish();
        } catch (err) {
          errorEl.textContent = err.message;
        } finally {
          busy = false;
        }
      };

      ktShow(
        'Введите код',
        [
          h('p', '', 'На другом устройстве появился код из 6 символов. Введите его здесь.'),
          input,
          errorEl,
        ],
        [
          { text: 'Подтвердить', className: 'btn-primary', onClick: submit },
          { text: 'Отмена', onClick: () => { cancelOwnTransfer(run); ktClose(); finish(); } },
        ]
      );
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
      input.focus();
    });
  }

  // --- старое устройство ---
  let approval = null; // { id, step: 'ask' | 'code' }

  function onTransferRequest(msg) {
    // подтверждать можно только с устройства, где ключ в порядке
    if (!(keyState.status === 'ok' && keyState.hasLocal)) return;
    if (approval && approval.id === msg.id) return;
    approval = { id: msg.id, step: 'ask' };

    const deviceEl = h('p', '');
    deviceEl.appendChild(document.createTextNode('Устройство: '));
    deviceEl.appendChild(h('span', 'kt-device', msg.deviceName || 'Новое устройство'));

    ktShow(
      'Новое устройство хочет войти в аккаунт',
      [
        deviceEl,
        h('p', '', 'Если вы сейчас сами входите в FNLink на этом устройстве, нажмите «Подтвердить». ' +
          'Если вы ничего не делали, нажмите «Это не я»: возможно, кто-то узнал ваш пароль.'),
      ],
      [
        {
          text: 'Подтвердить',
          className: 'btn-primary',
          onClick: async () => {
            try {
              const bundleStr = localStorage.getItem(myKeyStoreKey());
              const built = await buildTransfer(msg.nPub, msg.id, bundleStr);
              await authFetch('/api/key-transfer/' + msg.id + '/approve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ oPub: built.oPubStr, ct: built.ct, iv: built.iv }),
              });
              approval = { id: msg.id, step: 'code' };
              const code = await sasCode(msg.id, msg.nPub, built.oPubStr);
              ktShow(
                'Введите этот код на новом устройстве',
                [
                  h('div', 'kt-code', formatCode(code)),
                  h('p', '', 'Код действует 5 минут. Никому его не говорите и не вводите нигде, кроме ' +
                    'устройства, на котором вы входите.'),
                ],
                [{ text: 'Готово', className: 'btn-primary', onClick: () => { approval = null; ktClose(); } }]
              );
            } catch (err) {
              approval = null;
              ktShow('Не получилось подтвердить', [h('p', '', err.message)], [{ text: 'Закрыть', onClick: ktClose }]);
            }
          },
        },
        {
          text: 'Это не я',
          onClick: async () => {
            approval = null;
            ktClose();
            try {
              await authFetch('/api/key-transfer/' + msg.id + '/decline', { method: 'POST' });
            } catch (err) {
              console.error('Не удалось отклонить запрос', err);
            }
          },
        },
      ]
    );
  }

  // другое устройство уже ответило или запрос истёк: закрываем окно вопроса
  function onTransferClosed(msg) {
    if (approval && approval.id === msg.id && approval.step === 'ask') {
      approval = null;
      ktClose();
    }
  }

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
        } else if (data.type === 'key_transfer_request') {
          onTransferRequest(data);
        } else if (data.type === 'key_transfer_closed') {
          onTransferClosed(data);
        }
      });
    };
  }
})();
