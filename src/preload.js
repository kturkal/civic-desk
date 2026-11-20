const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  loadState: () => ipcRenderer.invoke('state:load'),
  installedFonts: () => ipcRenderer.invoke('fonts:installed'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  close: () => ipcRenderer.send('win:close'),
  minimize: () => ipcRenderer.send('win:minimize'),
  zoom: () => ipcRenderer.send('win:zoom'),
});

// Studio (dev-only visual editing tool). Inert unless main enables it.
contextBridge.exposeInMainWorld('studioBridge', {
  config: () => ipcRenderer.invoke('studio:config'),
  capture: (name) => ipcRenderer.invoke('studio:capture', name),
  brief: (data) => ipcRenderer.invoke('studio:brief', data),
  send: (opts) => ipcRenderer.invoke('studio:send', opts),
  onToggle: (cb) => ipcRenderer.on('studio:toggle', () => cb()),
});
