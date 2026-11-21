// Main-process side of Studio: screenshots, source lookup, brief file, and the
// "send to agent" step. Dev-only: disabled in packaged builds unless DESK_STUDIO=1.
const fs = require('fs');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { findSources } = require('./source');
const { buildBrief } = require('./brief');

function register({ app, ipcMain, BrowserWindow, root }) {
  const enabled = process.env.DESK_STUDIO === '1' || !app.isPackaged;
  const dir = path.join(root, '.studio');
  let sending = false;

  ipcMain.handle('studio:config', () => ({ enabled, root }));
  if (!enabled) return { enabled, menu: [] };

  ipcMain.handle('studio:capture', async (e, name) => {
    if (!['before', 'after', 'annotated'].includes(name)) throw new Error('bad screenshot name');
    const win = BrowserWindow.fromWebContents(e.sender);
    const img = await win.webContents.capturePage();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    fs.writeFileSync(file, img.toPNG());
    return file;
  });

  ipcMain.handle('studio:brief', (_e, data) => {
    let full;
    if (data.mode === 'draw') {
      // Point the agent at the source of every element a mark sits on.
      const flat = (data.annotations || []).flatMap((a) => a.targets);
      const found = findSources(root, flat.map((x) => ({ classes: x.classes, ids: x.ids })));
      let k = 0;
      const annotations = (data.annotations || []).map((a) => ({ ...a, targets: a.targets.map((x) => ({ ...x, sources: found[k++] })) }));
      full = { ...data, annotations, root, capturedAt: new Date().toISOString() };
    } else {
      const sources = findSources(root, data.changes.map((c) => ({ classes: c.classes, ids: c.ids })));
      const changes = data.changes.map((c, i) => ({ ...c, sources: sources[i] }));
      full = { ...data, changes, root, capturedAt: new Date().toISOString() };
    }
    const markdown = buildBrief(full);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'brief.md');
    fs.writeFileSync(file, markdown);
    fs.writeFileSync(path.join(dir, 'brief.json'), JSON.stringify(full, null, 2));
    return { path: file, markdown };
  });

  ipcMain.handle('studio:send', (_e, opts = {}) => new Promise((resolve) => {
    if (sending) return resolve({ ok: false, error: 'An agent run is already in progress.' });
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
    let dirty;
    try { dirty = git('status', '--porcelain').trim(); }
    catch { return resolve({ ok: false, error: 'This project is not a git repository, so Studio cannot make its edits reviewable.' }); }
    if (dirty) {
      return resolve({ ok: false, error: 'You have uncommitted changes. Commit or stash them first so the agent\'s edits show up as their own reviewable diff.', dirty: dirty.split('\n').slice(0, 8) });
    }
    if (!fs.existsSync(path.join(dir, 'brief.md'))) return resolve({ ok: false, error: 'No brief found. Open the brief first.' });

    const prompt = 'Read .studio/brief.md and apply the visual changes it describes to the source files, following its instructions. ' +
      'Look at the screenshots it lists (in .studio/, such as before.png, after.png or annotated.png). Then reply with a short summary of what you changed and anything you were unsure about.';
    const script = opts.dry
      ? 'claude --version'
      : 'claude -p "$STUDIO_PROMPT" --permission-mode acceptEdits --allowedTools Read Edit Glob Grep';

    sending = true;
    let output = '';
    const child = spawn('/bin/zsh', ['-lc', script], { cwd: root, env: { ...process.env, STUDIO_PROMPT: prompt } });
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
      label: 'Studio',
      submenu: [{
        label: 'Studio Mode',
        accelerator: 'CmdOrCtrl+L',
        click: (_item, win) => win?.webContents.send('studio:toggle'),
      }],
    }],
  };
}

module.exports = { register };
