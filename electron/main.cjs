// Moonfang desktop app: serves the built web app (dist/) from a private app:// origin in a Chromium window.
// No network access is needed; IndexedDB (autosaves, versions, material library) lives in the app's user-data folder.
const { app, BrowserWindow, dialog, net, protocol, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCHEME = 'app';
const ORIGIN = `${SCHEME}://moonfang`;
const DIST = path.join(__dirname, '..', 'dist');

// A fixed, secure origin: ES modules, workers and IndexedDB behave as on https, and storage survives app updates.
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// Two instances would share (and lock) the same IndexedDB; focus the running one instead.
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: '#17181b',
    title: 'Moonfang',
    icon: path.join(__dirname, '..', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.once('ready-to-show', () => {
    win.maximize();
    win.show();
  });

  // Links (GitHub, Ko-fi, bug reports) open in the user's browser; the app itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) e.preventDefault();
  });

  // The page asks before closing with changes newer than the last autosave. Electron would otherwise silently
  // refuse to close, so show the question natively.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Close anyway', 'Keep working'],
      defaultId: 1,
      cancelId: 1,
      title: 'Moonfang',
      message: 'Close Moonfang?',
      detail: 'Your latest changes are newer than the last autosave (autosaves run every 30 seconds) and would be lost.',
    });
    if (choice === 0) e.preventDefault();
  });

  void win.loadURL(`${ORIGIN}/index.html`);
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(() => {
  protocol.handle(SCHEME, (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(DIST, decodeURIComponent(pathname)));
    // Only files inside dist/ are served.
    if (!file.startsWith(DIST + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());
