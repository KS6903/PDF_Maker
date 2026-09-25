// Auto-updates from GitHub Releases (configured under "publish" in package.json).
//
// Installed copies (setup.exe) download updates in the background and install
// them silently on restart or on quit. The setup wizard is never shown again
// after the first install. The portable .exe can't replace itself while
// running, so it just tells the user a new version exists and opens the
// download page.
const { app, dialog, shell, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');

const RELEASES_URL = 'https://github.com/KS6903/PDF_Maker/releases/latest';
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const isPortable = !!process.env.PORTABLE_EXECUTABLE_FILE;

let getWindow = () => null;
let manualCheck = false;
let status = { state: 'idle' };

function setStatus(next) {
  status = next;
  getWindow()?.webContents.send('update-status', status);
}

function ask(options) {
  const win = getWindow();
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

function setupUpdater(windowGetter) {
  getWindow = windowGetter;

  ipcMain.handle('app-info', () => ({ version: app.getVersion(), portable: isPortable, packaged: app.isPackaged, status }));
  ipcMain.handle('check-for-updates', () => check(true));

  // Updates only make sense for a packaged build.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = !isPortable;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }));

  autoUpdater.on('update-available', async (info) => {
    if (!isPortable) {
      setStatus({ state: 'downloading', version: info.version, percent: 0 });
      return;
    }
    setStatus({ state: 'available', version: info.version });
    const { response } = await ask({
      type: 'info',
      buttons: ['Download', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update available',
      message: `PDF Maker ${info.version} is available.`,
      detail: `You have ${app.getVersion()}. Download the new version, then replace this file with it.`,
    });
    if (response === 0) shell.openExternal(RELEASES_URL);
  });

  autoUpdater.on('update-not-available', () => {
    setStatus({ state: 'current' });
    if (manualCheck) {
      ask({ type: 'info', title: 'No updates', message: 'You’re up to date.', detail: `PDF Maker ${app.getVersion()} is the latest version.` });
    }
    manualCheck = false;
  });

  autoUpdater.on('download-progress', (p) => setStatus({ ...status, state: 'downloading', percent: Math.round(p.percent) }));

  autoUpdater.on('update-downloaded', async (info) => {
    setStatus({ state: 'ready', version: info.version });
    const { response } = await ask({
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `PDF Maker ${info.version} is ready to install.`,
      detail: 'The app closes, updates itself and reopens. No setup wizard. Choose Later to update the next time you close it.',
    });
    // (isSilent, isForceRunAfter): silent runs the installer with /S, so it
    // skips the setup pages and reuses the existing install folder; force-run
    // reopens the app afterwards. quitAndInstall still goes through the normal
    // close flow, so unsaved edits are still prompted for.
    if (response === 0) autoUpdater.quitAndInstall(true, true);
  });

  autoUpdater.on('error', (err) => {
    console.error('Update error:', err?.message ?? err);
    setStatus({ state: 'error' });
    if (manualCheck) {
      ask({ type: 'warning', title: 'Update check failed', message: 'Couldn’t check for updates.', detail: 'Check your internet connection and try again.' });
    }
    manualCheck = false;
  });

  setTimeout(() => check(false), 5000);
  setInterval(() => check(false), CHECK_EVERY_MS);
}

async function check(manual) {
  if (!app.isPackaged) {
    if (manual) ask({ type: 'info', title: 'Updates', message: 'Updates are only available in the installed app.' });
    return status;
  }
  if (status.state === 'ready') {
    if (manual) autoUpdater.emit('update-downloaded', { version: status.version });
    return status;
  }
  manualCheck = manual;
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    /* reported through the 'error' event */
  }
  return status;
}

module.exports = { setupUpdater };
