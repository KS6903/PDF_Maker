// Electron shell for PDF Maker: serves the built web app from dist/ over a
// private app:// scheme and adds desktop niceties (open-with, save dialogs).
const { app, BrowserWindow, protocol, net, session, shell, Menu, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { setupUpdater } = require('./updater.cjs');

const DIST = path.join(__dirname, '..', 'dist');
const ORIGIN = 'app://pdfmaker';
const DEV_ICON = path.join(__dirname, '..', 'build', 'icon.png');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

/** A .pdf path passed on the command line (e.g. "Open with PDF Maker"). */
function pdfFromArgs(argv) {
  return argv.slice(1).find((a) => /\.pdf$/i.test(a) && fs.existsSync(a)) ?? null;
}

let win = null;
let launchFile = pdfFromArgs(process.argv);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const file = pdfFromArgs(argv);
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    if (file) win.webContents.send('open-file', readPdf(file));
  });
}

function readPdf(file) {
  return { name: path.basename(file), data: new Uint8Array(fs.readFileSync(file)) };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 760,
    minHeight: 520,
    title: 'PDF Maker',
    backgroundColor: '#f5f4f0',
    // Packaged builds use the .exe's own icon; this covers `npm run app`.
    icon: fs.existsSync(DEV_ICON) ? DEV_ICON : undefined,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.loadURL(`${ORIGIN}/index.html`);

  // Links open in the user's browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) e.preventDefault();
  });

  // The editor asks before discarding unsaved edits.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Discard changes', 'Keep editing'],
      defaultId: 1,
      cancelId: 1,
      title: 'Unsaved changes',
      message: 'You have edits that haven’t been saved to a PDF yet.',
      detail: 'Close anyway and lose them?',
    });
    if (choice === 0) e.preventDefault();
  });

  win.on('closed', () => (win = null));
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  ipcMain.handle('launch-file', () => {
    const file = launchFile;
    launchFile = null;
    return file ? readPdf(file) : null;
  });

  // Privacy guarantee: the app window can never reach the network. Files are
  // processed and saved locally only. (The updater runs in this main process,
  // not in a window, and only downloads release info and installers.)
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const fromWindow = details.webContentsId !== undefined;
    const remote = /^(https?|wss?|ftp):/i.test(details.url);
    callback({ cancel: fromWindow && remote });
  });
  // Only clipboard writes ("Copy text"); no camera, microphone, location, notifications, etc.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, callback) => callback(perm === 'clipboard-sanitized-write'));

  Menu.setApplicationMenu(null);
  createWindow();
  setupUpdater(() => win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
