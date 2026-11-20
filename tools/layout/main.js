// Main-process side of Layout: screenshots, source lookup, brief file, and the
// "send to agent" step. Dev-only: disabled in packaged builds unless DESK_LAYOUT=1.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { findSources } = require('./source');
const { buildBrief } = require('./brief');

function register({ app, ipcMain, BrowserWindow, root }) {
  const enabled = process.env.DESK_LAYOUT === '1' || !app.isPackaged;
  const dir = path.join(root, '.layout');
  let sending = false;

  ipcMain.handle('layout:config', () => ({ enabled, root }));
  if (!enabled) return { enabled, menu: [] };

  ipcMain.handle('layout:capture', async (e, name) => {
    if (!['before', 'after'].includes(name)) throw new Error('bad screenshot name');
    const win = BrowserWindow.fromWebContents(e.sender);
    const img = await win.webContents.capturePage();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    return file;
  });

  ipcMain.handle('layout:brief', (_e, data) => {
    const sources = findSources(root, data.changes.map((c) => ({ classes: c.classes, ids: c.ids })));
    const changes = data.changes.map((c, i) => ({ ...c, sources: sources[i] }));
    const full = { ...data, changes, root, capturedAt: new Date().toISOString() };
    const markdown = buildBrief(full);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'brief.md');
    fs.writeFileSync(file, markdown);
    fs.writeFileSync(path.join(dir, 'brief.json'), JSON.stringify(full, null, 2));
    return { path: file, markdown };
  });

  ipcMain.handle('layout:send', (_e, opts = {}) => new Promise((resolve) => {
    if (sending) return resolve({ ok: false, error: 'An agent run is already in progress.' });
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    let dirty;
    try { dirty = git('status', '--porcelain').trim(); }
    catch { return resolve({ ok: false, error: 'This project is not a git repository, so Layout cannot make its edits reviewable.' }); }
    if (dirty) {
      return resolve({ ok: false, error: 'You have uncommitted changes. Commit or stash them first so the agent\'s edits show up as their own reviewable diff.', dirty: dirty.split('\n').slice(0, 8) });
    }
    if (!fs.existsSync(path.join(dir, 'brief.md'))) return resolve({ ok: false, error: 'No brief found. Open the brief first.' });

    const prompt = 'Read .layout/brief.md and apply the visual changes it describes to the source files, following its instructions. ' +
      'You may look at .layout/before.png and .layout/after.png. Then reply with a short summary of what you changed and anything you were unsure about.';
    const script = opts.dry
      ? 'claude --version'
      : 'claude -p "$LAYOUT_PROMPT" --permission-mode acceptEdits --allowedTools Read Edit Glob Grep';

    sending = true;
    let output = '';
    const child = spawn('/bin/zsh', ['-lc', script], { cwd: root, env: { ...process.env, LAYOUT_PROMPT: prompt } });
    const timer = setTimeout(() => child.kill(), 10 * 60 * 1000);
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('error', (err) => { clearTimeout(timer); sending = false; resolve({ ok: false, error: err.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      sending = false;
      let diffStat = '';
      try { diffStat = git('diff', '--stat').trim(); } catch { /* ignore */ }
      resolve({ ok: code === 0, dry: !!opts.dry, output: output.trim().slice(-4000), diffStat, code });
    });
  }));

  return {
    enabled,
    menu: [{
      label: 'Layout',
      submenu: [{
        label: 'Layout Mode',
        accelerator: 'CmdOrCtrl+Shift+L',
        click: (_item, win) => win?.webContents.send('layout:toggle'),
      }],
    }],
  };
}

module.exports = { register };
