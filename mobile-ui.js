// Мобильная навигация FNLink: список чатов -> чат на весь экран -> назад.
// Подключается ПОСЛЕ renderer.js и renderer.js не меняет: следит за кликами
// по списку чатов и переключает класс chat-open на #chat-screen.
(() => {
  const mq = window.matchMedia('(max-width: 700px)');
  const screen = document.getElementById('chat-screen');
  const chatList = document.getElementById('chat-list');
  const header = document.querySelector('.chat-header');
  const panel = document.getElementById('contact-panel');
  const panelToggle = document.getElementById('contact-panel-toggle-btn');
  if (!screen || !chatList || !header) return;

  const backIcon =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<polyline points="15 18 9 12 15 6"/></svg>';

  // кнопка «назад» в шапке чата
  const backBtn = document.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'mobile-back-btn';
  backBtn.setAttribute('aria-label', 'Назад к списку чатов');
  backBtn.innerHTML = backIcon;
  header.insertBefore(backBtn, header.firstChild);

  // кнопка «назад» на карточке собеседника
  if (panel && panelToggle) {
    const panelBack = document.createElement('button');
    panelBack.type = 'button';
    panelBack.className = 'contact-back-btn';
    panelBack.setAttribute('aria-label', 'Закрыть');
    panelBack.innerHTML = backIcon;
    panelBack.addEventListener('click', () => panelToggle.click());
    panel.insertBefore(panelBack, panel.firstChild);
  }

  function showChat() {
    if (!mq.matches || screen.classList.contains('chat-open')) return;
    screen.classList.add('chat-open');
    // запись в истории, чтобы системная кнопка «назад» на Android
    // возвращала к списку, а не закрывала приложение
    history.pushState({ fnlinkChat: true }, '');
  }

  function hideChat() {
    screen.classList.remove('chat-open');
  }

  backBtn.addEventListener('click', () => {
    if (history.state && history.state.fnlinkChat) history.back();
    else hideChat();
  });

  window.addEventListener('popstate', () => {
    // если открыта карточка собеседника, «назад» закрывает её, а не чат
    if (panel && panelToggle && !panel.classList.contains('hidden')) {
      panelToggle.click();
      history.pushState({ fnlinkChat: true }, '');
      return;
    }
    hideChat();
  });

  // нажатие на пункт списка (renderer.js обработает его раньше) открывает чат
  chatList.addEventListener('click', (e) => {
    if (e.target !== chatList) showChat();
  });

  // после выхода из аккаунта возвращаемся к списку
  new MutationObserver(() => {
    if (screen.classList.contains('hidden') && screen.classList.contains('chat-open')) {
      hideChat();
    }
  }).observe(screen, { attributes: true, attributeFilter: ['class'] });

  mq.addEventListener('change', (e) => {
    if (!e.matches) hideChat();
  });
})();

// ---------------------------------------------------------------------------
// Обновление приложения (только внутри Android-приложения).
// Смотрит релизы на GitHub; если есть версия новее и в ней есть APK, показывает
// плашку «Обновить». По нажатию APK скачивается и открывается системное окно
// установки Android (подтвердить установку нужно нажатием: Android не
// разрешает ставить приложения молча). В Настройках есть ручная проверка.
// ---------------------------------------------------------------------------
(() => {
  const cap = window.Capacitor;
  if (!cap || typeof cap.getPlatform !== 'function' || cap.getPlatform() !== 'android') return;
  const updater =
    typeof cap.registerPlugin === 'function'
      ? cap.registerPlugin('ApkUpdater')
      : cap.Plugins && cap.Plugins.ApkUpdater;
  if (!updater) return;

  const RELEASES_URL = 'https://api.github.com/repos/TechMagicInfinity13/FNLink/releases?per_page=20';
  const DISMISS_KEY = 'fnlink-update-dismissed';
  const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

  function parts(v) {
    return String(v).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  }
  function isNewer(a, b) {
    const pa = parts(a);
    const pb = parts(b);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d > 0;
    }
    return false;
  }

  const style = document.createElement('style');
  style.textContent =
    '#update-banner{position:fixed;left:0;right:0;top:0;z-index:9999;display:flex;' +
    'align-items:center;gap:10px;box-sizing:border-box;' +
    'padding:calc(10px + env(safe-area-inset-top,0px)) 12px 10px;' +
    'background:#2b7bd6;color:#fff;font-size:14px;line-height:1.3}' +
    '#update-banner .ub-text{flex:1 1 auto;min-width:0}' +
    '#update-banner button{flex:0 0 auto;border:none;border-radius:16px;padding:8px 14px;' +
    'font-size:14px;cursor:pointer}' +
    '#update-banner .ub-go{background:#fff;color:#1b4f8f;font-weight:600}' +
    '#update-banner .ub-go:disabled{opacity:.6}' +
    '#update-banner .ub-close{background:transparent;color:#fff;padding:8px 10px}';
  document.head.appendChild(style);

  let banner = null;

  function showBanner(tag, url) {
    if (banner) return;
    banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.innerHTML =
      '<span class="ub-text"></span>' +
      '<button type="button" class="ub-go">Обновить</button>' +
      '<button type="button" class="ub-close" aria-label="Закрыть">\u2715</button>';
    const text = banner.querySelector('.ub-text');
    const go = banner.querySelector('.ub-go');
    const close = banner.querySelector('.ub-close');
    text.textContent = 'Доступна новая версия ' + String(tag).replace(/^v/i, '');
    document.body.appendChild(banner);

    close.addEventListener('click', () => {
      try { localStorage.setItem(DISMISS_KEY, tag); } catch (e) { /* ignore */ }
      banner.remove();
      banner = null;
    });

    Promise.resolve(
      updater.addListener('progress', (ev) => {
        if (go.disabled) text.textContent = 'Скачивание: ' + ev.percent + '%';
      })
    ).catch(() => {});

    go.addEventListener('click', async () => {
      go.disabled = true;
      text.textContent = 'Скачивание: 0%';
      try {
        const res = await updater.downloadAndInstall({ url });
        if (res && res.status === 'needs_permission') {
          text.textContent =
            'Разрешите установку для FNLink в настройках, вернитесь и нажмите «Обновить» снова';
        } else {
          text.textContent = 'Подтвердите установку в окне Android';
        }
      } catch (e) {
        text.textContent = 'Не удалось скачать обновление: ' + (e && e.message ? e.message : e);
      }
      go.disabled = false;
    });
  }

  // Возвращает текст-результат (его показывает ручная проверка в Настройках).
  async function checkForUpdate(manual) {
    try {
      const { version } = await updater.getVersion();
      const res = await fetch(RELEASES_URL, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) return 'Не удалось проверить: GitHub ответил ' + res.status;
      const releases = await res.json();

      // самый новый по номеру релиз, в котором есть APK
      let best = null;
      for (const rel of releases) {
        if (rel.draft || rel.prerelease) continue;
        const asset = (rel.assets || []).find((a) => /\.apk$/i.test(a.name));
        if (!asset) continue;
        if (!best || isNewer(rel.tag_name, best.tag)) {
          best = { tag: rel.tag_name, url: asset.browser_download_url };
        }
      }

      if (!best) return 'В релизах на GitHub не найден APK';
      if (!isNewer(best.tag, version)) return 'У вас последняя версия (' + version + ')';

      let dismissed = null;
      try { dismissed = localStorage.getItem(DISMISS_KEY); } catch (e) { /* ignore */ }
      if (manual || dismissed !== best.tag) showBanner(best.tag, best.url);
      return 'Доступна версия ' + best.tag + ' (у вас ' + version + ')';
    } catch (e) {
      return 'Ошибка проверки: ' + (e && e.message ? e.message : e);
    }
  }

  // раздел «Обновления» в Настройках: версия приложения и ручная проверка
  function addSettingsSection() {
    const body = document.querySelector('#settings-modal .modal-body');
    if (!body) return;
    const sec = document.createElement('section');
    sec.className = 'settings-section';
    sec.innerHTML =
      '<h3>Обновления</h3>' +
      '<p class="settings-hint" id="update-status">Версия приложения: ...</p>' +
      '<button type="button" class="btn-secondary" id="update-check-btn">Проверить обновления</button>';
    body.appendChild(sec);
    const status = sec.querySelector('#update-status');
    const btn = sec.querySelector('#update-check-btn');
    Promise.resolve(updater.getVersion())
      .then((v) => { status.textContent = 'Версия приложения: ' + v.version; })
      .catch((e) => {
        status.textContent = 'Версию определить не удалось: ' + (e && e.message ? e.message : e);
      });
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      status.textContent = 'Проверка...';
      status.textContent = await checkForUpdate(true);
      btn.disabled = false;
    });
  }

  addSettingsSection();
  setTimeout(() => checkForUpdate(false), 3000);
  setInterval(() => checkForUpdate(false), CHECK_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate(false);
  });
})();
