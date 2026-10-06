const { app, BrowserWindow, Menu, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
 
// AppImage на части Linux-систем падает из-за SUID sandbox, поэтому
// отключаем песочницу Chromium только на Linux. Это нужно задать ДО
// app.whenReady().
// ВАЖНО: флаг 'disable-dev-shm-usage' убран намеренно. Он заставлял
// Chromium создавать разделяемую память в /tmp вместо /dev/shm, из-за чего
// на ряде систем окно оставалось чёрным.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('no-sandbox');
}
 
// --- установка в постоянное место + ярлык (только AppImage на Linux) ---
// При первом запуске AppImage копирует себя в ~/.local/share/fnlink/
// (папка скрытая, потому что ~/.local начинается с точки), создаёт там
// ярлык для меню и иконку. Дальше ярлык запускает именно эту копию, она же
// обновляется автообновлением. Исходный скачанный файл не трогаем.
// Отключить всё это: запустить с переменной FNLINK_NO_INSTALL=1.
function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}
 
async function integrateWithDesktop() {
  const running = process.env.APPIMAGE;
  if (process.platform !== 'linux' || !running) return;
  if (process.env.FNLINK_NO_INSTALL) return;
 
  try {
    const dataHome =
      process.env.XDG_DATA_HOME || path.join(app.getPath('home'), '.local', 'share');
    const installDir = path.join(dataHome, 'fnlink');
    const installed = path.join(installDir, 'FNLink.AppImage');
    const versionFile = path.join(installDir, 'version.txt');
    const desktopDir = path.join(dataHome, 'applications');
    const iconDir = path.join(dataHome, 'icons');
    const desktopFile = path.join(desktopDir, 'fnlink.desktop');
    const iconFile = path.join(iconDir, 'fnlink.png');
    const marker = path.join(app.getPath('userData'), 'desktop-integrated');
 
    // 1. Постоянная копия AppImage
    let target = running;
    if (path.resolve(running) === path.resolve(installed)) {
      // уже запущены из постоянного места (в т.ч. после автообновления)
      fs.writeFileSync(versionFile, app.getVersion());
    } else {
      let installedVersion = null;
      if (fs.existsSync(installed) && fs.existsSync(versionFile)) {
        installedVersion = fs.readFileSync(versionFile, 'utf8').trim();
      }
      // копируем, если копии нет или запущенная версия новее
      if (!installedVersion || compareVersions(app.getVersion(), installedVersion) > 0) {
        await fs.promises.mkdir(installDir, { recursive: true });
        const tmp = installed + '.tmp';
        await fs.promises.copyFile(running, tmp);
        await fs.promises.chmod(tmp, 0o755);
        await fs.promises.rename(tmp, installed);
        fs.writeFileSync(versionFile, app.getVersion());
      }
      target = installed;
    }
 
    // 2. Ярлык и иконка
    const execLine = `Exec="${target}" %U`;
 
    if (fs.existsSync(desktopFile)) {
      // ярлык уже есть: чиним только путь запуска, если он изменился
      const current = fs.readFileSync(desktopFile, 'utf8');
      if (!current.includes(execLine)) {
        fs.writeFileSync(desktopFile, current.replace(/^Exec=.*$/m, () => execLine));
      }
      return;
    }
 
    // ярлыка нет, но мы его уже создавали: пользователь удалил его сам
    if (fs.existsSync(marker)) return;
 
    fs.mkdirSync(desktopDir, { recursive: true });
    fs.mkdirSync(iconDir, { recursive: true });
 
    if (!fs.existsSync(iconFile)) {
      // readFileSync/writeFileSync, потому что иконка лежит внутри app.asar
      fs.writeFileSync(iconFile, fs.readFileSync(path.join(__dirname, 'assets', 'icon.png')));
    }
 
    fs.writeFileSync(
      desktopFile,
      [
        '[Desktop Entry]',
        'Type=Application',
        'Name=FNLink',
        'Comment=Микро-мессенджер',
        execLine,
        `Icon=${iconFile}`,
        'Terminal=false',
        'Categories=Network;InstantMessaging;',
        'StartupWMClass=FNLink',
        '',
      ].join('\n')
    );
 
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '1');
 
    execFile('update-desktop-database', [desktopDir], () => {});
  } catch (err) {
    console.error('Не удалось установить ярлык/копию:', err);
  }
}
 
// --- автообновление через GitHub Releases ---
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
      // OS-песочница рендерера отключена: на части Linux-систем (AppImage)
      // она ломает создание shared memory, рендерер падает и окно чёрное.
      // Изоляция остаётся за contextIsolation: true и nodeIntegration: false.
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
 
  // Без системного меню пропадает и шорткат для DevTools — возвращаем вручную.
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
  integrateWithDesktop(); // копирование идёт в фоне, окно не ждёт
 
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
