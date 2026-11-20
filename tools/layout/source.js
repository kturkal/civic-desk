// Finds where an element's classes/ids are defined or used in the project's source,
// so the brief can point the agent at the right files.
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', 'build', '.layout', '.svelte-kit', 'coverage']);
const EXT = /\.(css|scss|html|svelte|vue|jsx?|tsx?)$/i;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function walk(dir, root, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    const rel = path.relative(root, p);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || rel === path.join('tools', 'layout')) continue;
      walk(p, root, out);
    } else if (EXT.test(e.name)) {
      try { if (fs.statSync(p).size < 500_000) out.push(p); } catch { /* skip */ }
    }
  }
  return out;
}

function findSources(root, hints) {
  const files = walk(root, root).map((f) => ({ file: path.relative(root, f), lines: fs.readFileSync(f, 'utf8').split('\n') }));
  return hints.map((h) => {
    const classes = (h.classes || []).filter(Boolean);
    const ids = (h.ids || []).filter(Boolean);
    const hits = [];
    for (const { file, lines } of files) {
      lines.forEach((text, i) => {
        let score = 0;
        let kind = null;
        for (const c of classes) {
          const rule = new RegExp(`(^|[\\s,>+~}])\\.${esc(c)}(?![\\w-])`);
          const markup = new RegExp(`(["'\`\\s])${esc(c)}(["'\`\\s])`);
          if (rule.test(text) && (text.includes('{') || /,\s*$/.test(text))) { score += 2; kind = 'style'; }
          else if (/class/i.test(text) && markup.test(text)) { score += 1; kind = kind || 'markup'; }
        }
        for (const id of ids) {
          if (new RegExp(`#${esc(id)}(?![\\w-])`).test(text) && text.includes('{')) { score += 2; kind = 'style'; }
          else if (new RegExp(`id\\s*=\\s*["']${esc(id)}["']`).test(text)) { score += 1; kind = kind || 'markup'; }
        }
        if (score) hits.push({ file, line: i + 1, kind, score, text: text.trim().slice(0, 120) });
      });
    }
    hits.sort((a, b) => b.score - a.score || (a.kind === 'style' ? -1 : 1));
    return hits.slice(0, 5).map(({ score, ...rest }) => rest);
  });
}

module.exports = { findSources };
