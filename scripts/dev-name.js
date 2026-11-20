// On macOS the app name in the menu bar comes from the app bundle. While developing,
// the app runs inside Electron's stock bundle, so rename it to "Desk" first.
if (process.platform !== 'darwin') process.exit(0);
const { execFileSync } = require('child_process');
const path = require('path');
const app = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app');
const plist = path.join(app, 'Contents', 'Info.plist');
try {
  const current = execFileSync('plutil', ['-extract', 'CFBundleName', 'raw', plist]).toString().trim();
  if (current !== 'Desk') {
    execFileSync('plutil', ['-replace', 'CFBundleName', '-string', 'Desk', plist]);
    execFileSync('plutil', ['-replace', 'CFBundleDisplayName', '-string', 'Desk', plist]);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' });
  }
} catch (e) {
  console.warn('Could not rename the dev app bundle (menu may say "Electron"):', e.message);
}
