// Список чатов в стиле Telegram: аватарка, ник, время и текст последнего
// сообщения. Подключается ПОСЛЕ renderer.js и сам renderer.js не меняет:
// подменяет функции renderChatList / makeChatItem / connectWs, а остальное
// (сообщения, профили, шифрование, список друзей) берёт из его глобальных
// переменных.
(() => {
  // chatId -> { text, ts, fromMe }: расшифрованное последнее сообщение
  const previews = {};

  function lastMessage(chatId) {
    const list = messagesByChat[chatId];
    return list && list.length ? list[list.length - 1] : null;
  }

  function lastTime(chatId) {
    const last = lastMessage(chatId);
    return last ? new Date(last.ts).getTime() || 0 : 0;
  }

  // Как в Telegram: сегодня, то время; за последнюю неделю, то день недели;
  // раньше, то дата.
  function formatChatTime(ts) {
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const dayMs = 24 * 60 * 60 * 1000;
    if (d.getTime() >= startOfToday) {
      return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    }
    if (d.getTime() >= startOfToday - 6 * dayMs) {
      return d.toLocaleDateString('ru-RU', { weekday: 'short' });
    }
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' });
  }

  function themeOf(username) {
    if (username === WAVE_USER) return { cls: 'badge-technomage', icon: TECHNOMAGE_ICON_SVG };
    if (username === GLACIO_USER) return { cls: 'badge-glacio', icon: GLACIO_ICON_SVG };
    if (username === MERCURY_USER) return { cls: 'badge-mercury', icon: MERCURY_ICON };
    return null;
  }

  // Цвет кружка-заглушки для пользователей без аватара (зависит от ника)
  function colorFor(username) {
    let h = 0;
    for (let i = 0; i < username.length; i++) {
      h = (h * 31 + username.charCodeAt(i)) % 360;
    }
    return 'hsl(' + h + ', 45%, 42%)';
  }

  // Аватар приходит с сервера строкой; в CSS пускаем только обычный data:image
  function safeAvatarCss(avatar) {
    if (typeof avatar !== 'string') return '';
    if (!/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$/i.test(avatar)) return '';
    return 'url("' + avatar + '")';
  }

  function buildAvatar(username) {
    const wrap = document.createElement('span');
    wrap.className = 'chat-avatar-wrap';

    const avatar = document.createElement('span');
    const theme = themeOf(username);

    if (theme) {
      avatar.className = 'chat-avatar ' + theme.cls;
      const icon = document.createElement('span');
      icon.className = theme.cls + '-icon';
      if (typeof theme.icon === 'string') {
        icon.innerHTML = theme.icon; // константа из renderer.js, не ввод пользователя
      } else if (theme.icon && theme.icon.img) {
        const img = document.createElement('img');
        img.src = theme.icon.img;
        img.alt = '';
        icon.appendChild(img);
      }
      avatar.appendChild(icon);
    } else {
      avatar.className = 'chat-avatar';
      const profile = profilesCache[username];
      const css = profile ? safeAvatarCss(profile.avatar) : '';
      if (css) {
        avatar.style.backgroundImage = css;
      } else {
        avatar.textContent = (username[0] || '?').toUpperCase();
        avatar.style.backgroundColor = colorFor(username);
      }
    }

    const dot = document.createElement('span');
    dot.className = 'chat-avatar-dot' + (onlineUsers.has(username) ? ' online' : '');

    wrap.appendChild(avatar);
    wrap.appendChild(dot);
    return wrap;
  }

  function buildItem(chatId, label) {
    const btn = document.createElement('button');
    btn.className = 'chat-item' + (chatId === currentChat ? ' active' : '');
    btn.dataset.chat = chatId;

    btn.appendChild(buildAvatar(chatId));

    const body = document.createElement('span');
    body.className = 'chat-item-body';

    const top = document.createElement('span');
    top.className = 'chat-item-top';

    const name = document.createElement('span');
    name.className = 'chat-item-name';
    name.appendChild(createWaveName(label));

    const time = document.createElement('span');
    time.className = 'chat-item-time';
    const preview = previews[chatId];
    const last = lastMessage(chatId);
    const ts = preview ? preview.ts : last ? last.ts : null;
    time.textContent = ts ? formatChatTime(ts) : '';

    top.appendChild(name);
    top.appendChild(time);

    const previewEl = document.createElement('span');
    previewEl.className = 'chat-item-preview';
    if (preview) {
      if (preview.fromMe) {
        const you = document.createElement('span');
        you.className = 'you';
        you.textContent = 'Вы: ';
        previewEl.appendChild(you);
      }
      previewEl.appendChild(
        document.createTextNode(String(preview.text).slice(0, 200).replace(/\s+/g, ' '))
      );
    } else if (historyLoaded.has(chatId) && !last) {
      previewEl.textContent = 'Сообщений пока нет';
      previewEl.classList.add('empty');
    } else {
      previewEl.textContent = '\u00A0'; // держим высоту строки, пока история грузится
    }

    body.appendChild(top);
    body.appendChild(previewEl);
    btn.appendChild(body);

    btn.addEventListener('click', () => switchChat(chatId, label));
    return btn;
  }

  // Подмена renderChatList из renderer.js: те же правила (папки, пустое
  // состояние), но новые строки и сортировка по времени последнего сообщения.
  function renderChatListNew() {
    chatList.innerHTML = '';

    let visibleContacts = contacts;
    if (currentFolder !== 'all') {
      const folder = folders.find((f) => f.id === currentFolder);
      const members = folder ? folder.members : [];
      visibleContacts = contacts.filter((username) => members.includes(username));
    }

    if (visibleContacts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'chat-list-empty';
      empty.textContent =
        currentFolder === 'all'
          ? 'Пока нет друзей — найди кого-нибудь через поиск выше'
          : 'В этой папке пока никого нет';
      chatList.appendChild(empty);
      return;
    }

    // свежая переписка выше; без сообщений остаются в исходном порядке внизу
    const sorted = visibleContacts
      .map((username, index) => ({ username, index, ts: lastTime(username) }))
      .sort((a, b) => b.ts - a.ts || a.index - b.index);

    for (const item of sorted) {
      chatList.appendChild(buildItem(item.username, item.username));
    }
  }

  window.renderChatList = renderChatListNew;
  window.makeChatItem = (chatId, label) => buildItem(chatId, label);

  // перерисовка с небольшой паузой, чтобы пачка ответов с историей
  // не вызывала десяток перерисовок подряд
  let renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      window.renderChatList();
    }, 40);
  }

  // Расшифровываем только последнее сообщение чата и запоминаем для списка
  async function refreshPreview(chatId) {
    const list = messagesByChat[chatId] || [];
    const last = list[list.length - 1];

    if (!last) {
      delete previews[chatId];
      scheduleRender();
      return;
    }

    if (last._plain === undefined) {
      last._plain = await decryptMessage(chatId, last.text);
    }

    // пока расшифровывали, могло прийти более новое сообщение: им займётся свой вызов
    const now = messagesByChat[chatId] || [];
    if (now[now.length - 1] !== last) return;

    previews[chatId] = { text: last._plain, ts: last.ts, fromMe: last.from === myUsername };
    scheduleRender();
  }

  // Клиент грузит историю только открытого чата; для превью просим историю
  // всех друзей сразу после подключения.
  function hookSocket(sock) {
    if (!sock) return;
    const requested = new Set();

    const requestMissing = () => {
      if (sock.readyState !== WebSocket.OPEN) return;
      for (const username of contacts) {
        // историю открытого чата уже запросил основной код
        if (username === currentChat || requested.has(username)) continue;
        requested.add(username);
        sock.send(JSON.stringify({ type: 'history', chat: username }));
      }
    };

    sock.addEventListener('open', requestMissing);
    sock.addEventListener('message', (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data.type === 'history' || data.type === 'message') {
        refreshPreview(data.chat);
      } else if (data.type === 'profile') {
        scheduleRender(); // сменился чей-то аватар
      } else if (data.type === 'friend_accepted') {
        setTimeout(requestMissing, 1500); // у нового друга тоже нужна история
      }
    });
  }

  const originalConnectWs = window.connectWs;
  if (typeof originalConnectWs === 'function') {
    window.connectWs = function () {
      originalConnectWs();
      hookSocket(ws);
    };
  }
})();
