// Auto-updates from GitHub Releases (configured under "publish" in package.json).
//
// Installed copies (setup.exe) download updates in the background and install
// them silently on restart or on quit. The setup wizard is never shown again
// after the first install. The portable .exe can't replace itself while
// running, so it just tells the user a new version exists and opens the
// download page.
const { app, dialog, shell, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('node:fs');
const path = require('node:path');

const RELEASES_URL = 'https://github.com/KS6903/PDF_Maker/releases/latest';
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const isPortable = !!process.env.PORTABLE_EXECUTABLE_FILE;

let getWindow = () => null;
let status = { state: 'idle' };

/*
 * Whether updates install on their own. Kept next to the app's own data rather
 * than in the page, because the updater has to know the answer at startup,
 * before the window exists.
 */
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'update-settings.json');
let autoUpdate = true;

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
    if (typeof saved.auto === 'boolean') autoUpdate = saved.auto;
  } catch {
    /* no file yet, or unreadable: automatic updates stay on */
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify({ auto: autoUpdate }));
  } catch (err) {
    console.error('Could not save the update setting:', err?.message ?? err);
  }
}

function setStatus(next) {
  status = next;
  getWindow()?.webContents.send('update-status', { ...status, auto: autoUpdate });
}

function ask(options) {
  const win = getWindow();
  return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options);
}

function setupUpdater(windowGetter) {
  getWindow = windowGetter;
  loadSettings();

  ipcMain.handle('app-info', () => ({
    version: app.getVersion(),
    portable: isPortable,
    packaged: app.isPackaged,
    releasesUrl: RELEASES_URL,
    status: { ...status, auto: autoUpdate },
  }));
  ipcMain.handle('check-for-updates', () => check(true));

  // Turning automatic updates on looks for one straight away, so the switch
  // does something visible rather than only mattering hours later.
  ipcMain.handle('set-auto-update', (_e, on) => {
    autoUpdate = !!on;
    saveSettings();
    if (app.isPackaged) {
      autoUpdater.autoDownload = autoUpdate && !isPortable;
      autoUpdater.autoInstallOnAppQuit = autoUpdate;
    }
    setStatus(status);
    if (autoUpdate && app.isPackaged && status.state !== 'ready' && status.state !== 'downloading') void check(false);
    return { auto: autoUpdate };
  });

  // Fetch an update the user asked for while automatic updates are off.
  ipcMain.handle('download-update', () => {
    if (!app.isPackaged || isPortable) return status;
    setStatus({ ...status, state: 'downloading', percent: 0 });
    autoUpdater.downloadUpdate().catch((err) => {
      console.error('Update download failed:', err?.message ?? err);
      setStatus({ state: 'error' });
    });
    return status;
  });

  // Restart into the new version. Silent, so no setup wizard appears.
  ipcMain.handle('install-update', () => {
    if (status.state !== 'ready') return false;
    autoUpdater.quitAndInstall(true, true);
    return true;
  });

  // Updates only make sense for a packaged build.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = autoUpdate && !isPortable;
  autoUpdater.autoInstallOnAppQuit = autoUpdate;
  autoUpdater.logger = { info: console.log, warn: console.warn, error: console.error, debug: () => {} };

  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }));

  autoUpdater.on('update-available', async (info) => {
    if (!isPortable) {
      // With automatic updates off, sit on it until the user asks.
      setStatus(autoUpdate ? { state: 'downloading', version: info.version, percent: 0 } : { state: 'available', version: info.version });
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

  // No dialog for "nothing new": the menu shows it next to the version instead.
  autoUpdater.on('update-not-available', () => {
    setStatus({ state: 'current', version: app.getVersion() });
  });

  autoUpdater.on('download-progress', (p) => setStatus({ ...status, state: 'downloading', percent: Math.round(p.percent) }));

  // No dialog: the app shows a Restart button while an update is waiting, and
  // quitAndInstall runs from there. (isSilent, isForceRunAfter): silent runs
  // the installer with /S, so it skips the setup pages and reuses the existing
  // install folder; force-run reopens the app afterwards.
  autoUpdater.on('update-downloaded', (info) => {
    setStatus({ state: 'ready', version: info.version });
  });

  autoUpdater.on('error', (err) => {
    console.error('Update error:', err?.message ?? err);
    setStatus({ state: 'error' });
  });

  // Looking for updates carries on either way; the setting only decides whether
  // one is fetched and installed without being asked. With it off the app still
  // says an update exists and offers the button.
  setTimeout(() => check(false), 5000);
  setInterval(() => check(false), CHECK_EVERY_MS);
}

async function check(manual) {
  if (!app.isPackaged) {
    setStatus({ state: 'unsupported', version: app.getVersion() });
    return status;
  }
  // Already downloaded: nothing to re-check, the Restart button is showing.
  if (status.state === 'ready') return status;
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    /* reported through the 'error' event */
  }
  return status;
}

module.exports = { setupUpdater };
