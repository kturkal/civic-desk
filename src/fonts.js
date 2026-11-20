// Finds fonts the user installed themselves (on macOS: what's in ~/Library/Fonts,
// i.e. fonts added through Font Book) and reads each file's family name.
const fs = require('fs');
const os = require('os');
const path = require('path');

function userFontDirs() {
  const home = os.homedir();
  if (process.platform === 'darwin') return [path.join(home, 'Library', 'Fonts')];
  if (process.platform === 'win32') {
    return [path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Microsoft', 'Windows', 'Fonts')];
  }
  return [path.join(home, '.local', 'share', 'fonts'), path.join(home, '.fonts')];
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ttf|otf|ttc)$/i.test(e.name)) out.push(p);
  }
  return out;
}

function decode(buf, platformID) {
  if (platformID === 3 || platformID === 0) {
    let s = '';
    for (let i = 0; i + 1 < buf.length; i += 2) s += String.fromCharCode(buf.readUInt16BE(i));
    return s;
  }
  return buf.toString('latin1');
}

// Read the family name (typographic family if present) from a TTF/OTF/TTC file.
function familyName(file) {
  const buf = fs.readFileSync(file);
  let base = 0;
  if (buf.toString('latin1', 0, 4) === 'ttcf') base = buf.readUInt32BE(12);
  const numTables = buf.readUInt16BE(base + 4);
  let nameOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = base + 12 + i * 16;
    if (buf.toString('latin1', rec, rec + 4) === 'name') { nameOffset = buf.readUInt32BE(rec + 8); break; }
  }
  if (nameOffset < 0) return null;
  const count = buf.readUInt16BE(nameOffset + 2);
  const strings = nameOffset + buf.readUInt16BE(nameOffset + 4);
  let best = null;
  for (let i = 0; i < count; i++) {
    const r = nameOffset + 6 + i * 12;
    const platformID = buf.readUInt16BE(r);
    const nameID = buf.readUInt16BE(r + 6);
    if (nameID !== 1 && nameID !== 16) continue;
    const len = buf.readUInt16BE(r + 8);
    const off = buf.readUInt16BE(r + 10);
    const value = decode(buf.subarray(strings + off, strings + off + len), platformID).trim();
    if (!value) continue;
    const rank = (nameID === 16 ? 2 : 0) + (platformID === 3 ? 1 : 0);
    if (!best || rank > best.rank) best = { value, rank };
  }
  return best ? best.value : null;
}

function installedFamilies() {
  const families = new Set();
  for (const dir of userFontDirs()) {
    for (const file of walk(dir)) {
      try {
        const name = familyName(file);
        if (name && /^[^"'\\<>;{}]{1,80}$/.test(name)) families.add(name);
      } catch { /* skip unreadable or odd files */ }
    }
  }
  return [...families].sort((a, b) => a.localeCompare(b));
}

module.exports = { installedFamilies };
