// Minimal, explicit bridge between the desktop shell and the web app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pdfMaker', {
  /** The PDF the app was launched with ("Open with PDF Maker"), if any. */
  getLaunchFile: () => ipcRenderer.invoke('launch-file'),
  /** Called when another PDF is opened while the app is already running. */
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, file) => cb(file)),
  /** Version, portable/installed, and current update status. */
  getAppInfo: () => ipcRenderer.invoke('app-info'),
  /** Check GitHub for a newer version now (shows a dialog with the result). */
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  /** Called as an update is found, downloaded and ready to install. */
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, status) => cb(status)),
});
