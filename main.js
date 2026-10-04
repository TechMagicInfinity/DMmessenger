const { app, BrowserWindow, Menu, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

// AppImage на части Linux-систем падает из-за SUID sandbox, поэтому
// отключаем песочницу Chromium только на Linux. Это нужно задать ДО
// app.whenReady().
// ВАЖНО: флаг 'disable-dev-shm-usage' убран намеренно. Он заставлял
// Chromium создавать разделяемую память в /tmp вместо /dev/shm, из-за чего
// на ряде систем окно оставалось чёрным (ошибка "Creating shared memory
// in /tmp ... failed"). Нужен он только в Docker с крошечным /dev/shm.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
}

// --- автообновление через GitHub Releases ---
// Работает только в СОБРАННОМ приложении; в режиме разработки (npm start)
// проверка пропускается.
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true; // поставится при следующем закрытии

autoUpdater.on('error', (err) => {
  console.error('Автообновление: ошибка', err);
});

autoUpdater.on('update-available', (info) => {
  console.log('Автообновление: найдена версия', info.version, '— скачиваю...');
});

autoUpdater.on('update-downloaded', (info) => {
  console.log('Автообновление: версия', info.version, 'скачана');
  if (Notification.isSupported()) {
    new Notification({
      title: 'Обновление готово',
      body: `Версия ${info.version} скачана и установится при следующем перезапуске приложения.`,
    }).show();
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 980,
    height: 640,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#14161a',
    title: `Микро-мессенджер v${app.getVersion()}`,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // OS-песочница рендерера здесь отключена: на части Linux-систем
      // (AppImage) она ломает создание shared memory ("No such process"),
      // рендерер падает и окно остаётся чёрным. Изоляция остаётся за
      // contextIsolation: true и nodeIntegration: false.
      sandbox: false,
    },
  });

  Menu.setApplicationMenu(null); // убираем стандартное меню File/Edit/View

  // <title> из index.html иначе перезапишет заголовок и версия пропадёт.
  win.on('page-title-updated', (event) => event.preventDefault());

  // Диагностика: если окно снова окажется пустым, причина будет в терминале.
  win.webContents.on('render-process-gone', (event, details) => {
    console.error('render gone', details);
  });
  win.webContents.on('did-fail-load', (event, code, desc, url) => {
    console.error('load fail', code, desc, url);
  });
  win.webContents.on('console-message', (event, level, message) => {
    console.log('RENDERER:', message);
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  // Без системного меню пропадает и стандартный шорткат для DevTools —
  // возвращаем его вручную.
  win.webContents.on('before-input-event', (event, input) => {
    const isDevToolsShortcut =
      input.control && input.shift && input.key.toLowerCase() === 'i';
    if (isDevToolsShortcut) {
      win.webContents.toggleDevTools();
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  // Тихая проверка обновлений; ошибка не должна влиять на окно.
  if (app.isPackaged) {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('Автообновление: не удалось проверить', err);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
