// Minimal, explicit bridge between the desktop shell and the web app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pdfMaker', {
  /** Files the app was launched with, plus the right-click verb used, if any. */
  getLaunchFiles: () => ipcRenderer.invoke('launch-files'),
  /** Called when files are opened while the app is already running. */
  onOpenFiles: (cb) => ipcRenderer.on('open-files', (_e, payload) => cb(payload)),
  /** Add or remove the File Explorer right-click entries ('add' | 'remove' | 'status'). */
  shellIntegration: (action) => ipcRenderer.invoke('shell-integration', action),
  /** Version, portable/installed, and current update status. */
  getAppInfo: () => ipcRenderer.invoke('app-info'),
  /** Check GitHub for a newer version now (shows a dialog with the result). */
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  /** Called as an update is found, downloaded and ready to install. */
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, status) => cb(status)),
});
