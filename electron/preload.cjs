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
  /** Check GitHub for a newer version now; the result shows next to the version. */
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  /** Turn automatic downloading and installing of updates on or off. */
  setAutoUpdate: (on) => ipcRenderer.invoke('set-auto-update', !!on),
  /** Download a waiting update now (used when automatic updates are off). */
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  /** Restart into the downloaded update. Installs silently, then reopens. */
  installUpdate: () => ipcRenderer.invoke('install-update'),
  /** Called as an update is found, downloaded and ready to install. */
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, status) => cb(status)),
  /**
   * Called before the window closes, so the app can ask about unsaved edits.
   * The ack tells the shell the request was picked up and the answer is worth
   * waiting for, however long the dialog stays open.
   */
  onConfirmClose: (cb) =>
    ipcRenderer.on('confirm-close', (_e, id) => {
      ipcRenderer.send('confirm-close-ack', id);
      cb(id);
    }),
  /** Answer a 'confirm-close' request: true closes the window, false keeps it. */
  respondToClose: (id, close) => ipcRenderer.send('confirm-close-result', id, !!close),
});
