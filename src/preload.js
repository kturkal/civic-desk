const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desk', {
  loadState: () => ipcRenderer.invoke('state:load'),
  installedFonts: () => ipcRenderer.invoke('fonts:installed'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  close: () => ipcRenderer.send('win:close'),
  minimize: () => ipcRenderer.send('win:minimize'),
  zoom: () => ipcRenderer.send('win:zoom'),
});
