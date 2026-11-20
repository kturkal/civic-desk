// Renders build/icon.svg to build/icon.png (1024px, macOS padding) and build/icon.icns.
// Run with: bunx electron scripts/render-icon.js
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const build = path.join(__dirname, '..', 'build');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(build, 'icon.svg'), 'utf8');
  const html = `<!doctype html><html><body style="margin:0;background:transparent">
    <div style="position:absolute;left:100px;top:100px;width:824px;height:824px">${svg.replace('<svg ', '<svg style="width:824px;height:824px" ')}</div></body></html>`;
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false,
    webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 600));
  const img = await win.webContents.capturePage();
  const sized = img.resize({ width: 1024, height: 1024, quality: 'best' });
  fs.writeFileSync(path.join(build, 'icon.png'), sized.toPNG());

  const set = path.join(build, 'icon.iconset');
  fs.mkdirSync(set, { recursive: true });
  const sizes = [['16x16', 16], ['16x16@2x', 32], ['32x32', 32], ['32x32@2x', 64], ['128x128', 128],
    ['128x128@2x', 256], ['256x256', 256], ['256x256@2x', 512], ['512x512', 512], ['512x512@2x', 1024]];
  for (const [name, px] of sizes) {
    fs.writeFileSync(path.join(set, `icon_${name}.png`), sized.resize({ width: px, height: px, quality: 'best' }).toPNG());
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(build, 'icon.icns')]);
  fs.rmSync(set, { recursive: true });
  app.quit();
});
