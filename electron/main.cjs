// Electron shell for PDF Maker: serves the built web app from dist/ over a
// private app:// scheme and adds desktop niceties (open-with, save dialogs).
const { app, BrowserWindow, protocol, net, session, shell, Menu, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { setupUpdater } = require('./updater.cjs');
const shellIntegration = require('./shell-integration.cjs');

const DIST = path.join(__dirname, '..', 'dist');
const ORIGIN = 'app://pdfmaker';
const DEV_ICON = path.join(__dirname, '..', 'build', 'icon.png');

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

const OPENABLE = /\.(pdf|jpe?g|png|webp|bmp|gif|tiff?|docx|txt|md|markdown|html?)$/i;

/**
 * What the app was asked to do, from "Open with" or a right-click entry:
 * a mode (--edit, --merge, --compress, --images, --create) and the files.
 */
function requestFromArgs(argv) {
  const rest = argv.slice(1).filter((a) => a !== '.' && !a.startsWith('--remote') && !a.startsWith('--enable'));
  const mode = (rest.find((a) => /^--(edit|merge|compress|images|create)$/.test(a)) ?? '').replace(/^--/, '') || null;
  const files = rest.filter((a) => !a.startsWith('--') && OPENABLE.test(a) && fs.existsSync(a));
  return files.length ? { mode, files } : null;
}

const startedAt = Date.now();
let win = null;
let launchRequest = requestFromArgs(process.argv);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const request = requestFromArgs(argv);
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    if (request) win.webContents.send('open-files', readRequest(request));
  });
}

function readPdf(file) {
  return { name: path.basename(file), data: new Uint8Array(fs.readFileSync(file)) };
}

/** Load the requested files, skipping any that can't be read. */
function readRequest(request) {
  const files = [];
  for (const file of request.files) {
    try {
      files.push(readPdf(file));
    } catch (err) {
      console.error('Could not read', file, err);
    }
  }
  return files.length ? { mode: request.mode, files } : null;
}

/**
 * A small frameless window shown while the app starts, so there's something to
 * look at instead of an empty frame. Closed as soon as the app is ready.
 */
let splash = null;
function createSplash() {
  splash = new BrowserWindow({
    width: 470,
    height: 250,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    center: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  splash.loadFile(path.join(__dirname, 'splash.html'), { query: { v: app.getVersion() } });
  splash.once('ready-to-show', () => splash?.show());
  // Never let a stuck splash hide the app.
  setTimeout(closeSplash, 15000);
}

function closeSplash() {
  if (splash && !splash.isDestroyed()) splash.destroy();
  splash = null;
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
  win.once('ready-to-show', () => {
    // Give the splash a moment so it doesn't flash past on fast machines.
    const minShow = Number(process.env.PDFMAKER_SPLASH_MS) || 900; // overridable for screenshots
    const wait = Math.max(0, minShow - (Date.now() - startedAt));
    setTimeout(() => {
      closeSplash();
      win?.show();
    }, wait);
  });
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
  win.webContents.on('did-fail-load', closeSplash);
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const { pathname } = new URL(req.url);
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST + path.sep)) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  ipcMain.handle('launch-files', () => {
    const request = launchRequest;
    launchRequest = null;
    return request ? readRequest(request) : null;
  });

  // File Explorer right-click entries, added per user, no admin rights needed.
  ipcMain.handle('shell-integration', (_e, action) => {
    if (action === 'add') return shellIntegration.register();
    if (action === 'remove') return shellIntegration.unregister();
    return { ok: true, registered: shellIntegration.isRegistered() };
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
  createSplash();
  createWindow();
  setupUpdater(() => win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
