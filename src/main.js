const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { installedFamilies } = require('./fonts');
const layout = require('../tools/layout/main');

// The app is called Desk. Keep saving to the original folder so nothing is lost by the rename.
app.setName('Desk');
app.setPath('userData', path.join(app.getPath('appData'), 'civic-desk'));

// Your tabs and text live in your user-data folder, never in this repo.
const stateFile = () => path.join(app.getPath('userData'), 'workspace.json');

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 640,
    minHeight: 420,
    title: 'Desk',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
}

ipcMain.handle('state:load', () => {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return null;
  }
});

ipcMain.handle('state:save', (_e, state) => {
  fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(state));
});

ipcMain.handle('fonts:installed', () => installedFamilies());

ipcMain.on('win:close', (e) => BrowserWindow.fromWebContents(e.sender)?.close());
ipcMain.on('win:minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
ipcMain.on('win:zoom', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  w.isMaximized() ? w.unmaximize() : w.maximize();
});

app.whenReady().then(() => {
  // Dock icon while running from source (the packaged app gets it from build/icon.icns).
  if (process.platform === 'darwin') app.dock?.setIcon(path.join(__dirname, '..', 'build', 'icon.png'));
  const layoutTool = layout.register({ app, ipcMain, BrowserWindow, root: process.env.LAYOUT_PROJECT || path.join(__dirname, '..') });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },   // shows "Desk" with About, Hide, Quit
    { role: 'editMenu' },  // undo, redo, cut, copy, paste, select all
    ...layoutTool.menu,    // dev-only: Layout > Layout Mode (Cmd+Shift+L)
    { role: 'windowMenu' },
  ]));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
