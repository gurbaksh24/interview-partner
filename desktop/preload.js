const { contextBridge, ipcRenderer } = require('electron');

// Expose a fixed allowlist of calls, never ipcRenderer itself.
contextBridge.exposeInMainWorld('partner', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setAlwaysOnTop: (value) => ipcRenderer.invoke('window:set-always-on-top', Boolean(value)),
});
