const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  loadState: () => ipcRenderer.invoke('state:load'),
  installedFonts: () => ipcRenderer.invoke('fonts:installed'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  close: () => ipcRenderer.send('win:close'),
  minimize: () => ipcRenderer.send('win:minimize'),
  zoom: () => ipcRenderer.send('win:zoom'),
});

// Layout (dev-only visual editing tool). Inert unless main enables it.
contextBridge.exposeInMainWorld('layoutBridge', {
  config: () => ipcRenderer.invoke('layout:config'),
  capture: (name) => ipcRenderer.invoke('layout:capture', name),
  brief: (data) => ipcRenderer.invoke('layout:brief', data),
  send: (opts) => ipcRenderer.invoke('layout:send', opts),
  onToggle: (cb) => ipcRenderer.on('layout:toggle', () => cb()),
});
