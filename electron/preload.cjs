// Minimal, explicit bridge between the desktop shell and the web app.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
  /** Where a picked or dropped file lives on disk, or '' for one made in the app. */
  pathOf: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  /** Write a PDF over the file it was opened from. Resolves { ok, error? }. */
  writePdf: (filePath, bytes) => ipcRenderer.invoke('write-pdf', filePath, bytes),
  /** Ask where to save a PDF, then write it. Resolves { ok, path?, canceled?, error? }. */
  savePdfAs: (name, bytes, nearPath) => ipcRenderer.invoke('save-pdf-as', name, bytes, nearPath || ''),
  /** Export: ask where to save one file, then write it. Resolves { ok, path?, canceled?, error? }. */
  saveFileAs: (name, bytes, nearPath) => ipcRenderer.invoke('save-file-as', name, bytes, nearPath || ''),
  /** Export: ask for a folder and write several files into it. Resolves { ok, folder?, canceled?, error? }. */
  saveFilesToFolder: (files, nearPath) => ipcRenderer.invoke('save-files-to-folder', files, nearPath || ''),
  /** Read a PDF from disk, e.g. a recent file, so it is current. Resolves bytes or null. */
  readPdf: (filePath) => ipcRenderer.invoke('read-pdf', filePath),
});
