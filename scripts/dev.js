// Runs Desk from source. On macOS the Dock, Cmd+Tab and the menu bar take the app's
// name and icon from the app bundle, so instead of running inside Electron's stock
// "Electron.app" we run a private copy named "Desk.app" with Desk's name and icon.
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function run(cmd, args) {
  const child = spawn(cmd, args, { stdio: 'inherit', cwd: root });
  child.on('exit', (code) => process.exit(code ?? 0));
}

if (process.platform !== 'darwin') {
  run(require('electron'), ['.']);
  return;
}

const src = path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
const dir = path.join(root, 'node_modules', '.desk-dev');
const dst = path.join(dir, 'Desk.app');
const stampFile = path.join(dir, 'stamp');
const icon = path.join(root, 'build', 'icon.icns');

const version = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
const stamp = `${version}:${fs.existsSync(icon) ? fs.statSync(icon).mtimeMs : 0}`;

let current = '';
try { current = fs.readFileSync(stampFile, 'utf8'); } catch { /* first run */ }

if (current !== stamp || !fs.existsSync(dst)) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('cp', ['-cR', src, dst]); // clone (fast on APFS)
  const macos = path.join(dst, 'Contents', 'MacOS');
  fs.renameSync(path.join(macos, 'Electron'), path.join(macos, 'Desk'));
  const plist = path.join(dst, 'Contents', 'Info.plist');
  const set = (key, value) => execFileSync('plutil', ['-replace', key, '-string', value, plist]);
  set('CFBundleExecutable', 'Desk');
  set('CFBundleName', 'Desk');
  set('CFBundleDisplayName', 'Desk');
  set('CFBundleIdentifier', 'com.desk.app.dev');
  if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(dst, 'Contents', 'Resources', 'electron.icns'));
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', dst], { stdio: 'ignore' });
  try {
    execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', dst]);
  } catch { /* not essential */ }
  fs.writeFileSync(stampFile, stamp);
}

run(path.join(dst, 'Contents', 'MacOS', 'Desk'), ['.']);
