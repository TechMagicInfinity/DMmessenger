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
