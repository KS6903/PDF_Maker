// Minimal, explicit bridge between the desktop shell and the web app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pdfMaker', {
  /** The PDF the app was launched with ("Open with PDF Maker"), if any. */
  getLaunchFile: () => ipcRenderer.invoke('launch-file'),
  /** Called when another PDF is opened while the app is already running. */
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, file) => cb(file)),
});
