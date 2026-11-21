/* Studio: visual editing overlay.
 *
 * Toggle studio mode (Cmd+L in Desk). Click an element, drag its handles to
 * resize it, change its padding, or round its corners. Studio records exact
 * before/after values, finds likely source files, and writes a brief for a coding
 * agent (.studio/brief.md). "Send to agent" runs the agent on that brief.
 *
 * Framework-agnostic: it only needs a `window.studioBridge` that provides
 * capture(), brief(), send() and onToggle().
 */
(() => {
  if (window.__studioLoaded) return;
  window.__studioLoaded = true;
  const bridge = window.studioBridge;
  if (!bridge) return;

  const INK = '#ff2d8a';
  const SIDE_NAMES = ['top', 'right', 'bottom', 'left'];
  const BORDER_W = SIDE_NAMES.map((s) => `border-${s}-width`);
  const STYLE_PROPS = ['background-color', 'color', 'border-top-color', 'border-top-style', 'font-size', 'font-weight', ...BORDER_W];
  const RADII = ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'];
  const TRACK = ['width', 'height', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', ...RADII, 'clip-path', 'translate', ...STYLE_PROPS];
  const SIDES = ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'];
  const STATE_CLASSES = new Set(['active', 'on', 'open', 'hover', 'focus', 'selected', 'renaming', 'mine', 'bad']);

  let on = false;
  let root = null;
  let ui = {};
  let selEl = null;
  let hoverEl = null;
  let childStack = [];
  let beforeShot = null;
  let rootVars = [];
  let colorVars = [];
  let lastSel = null;
  let shapeEl = null;      // element currently in Shape mode
  let shapeTool = 'corners';
  let pending = null;      // a drawn but not yet applied cut: { p1, p2, keep }
  let lastSnap = { el: null, t: 0 };
  let raf = 0;
  let confirmTimer = 0;
  const edits = new Map(); // element -> { inline, orig, touched }
  const history = [];

  const px = (v) => parseFloat(v) || 0;
  const round = (n) => Math.round(n);
  const inRoot = (el) => !!(root && el && root.contains(el));

  /* ---------------- describing elements ---------------- */

  function classesOf(el) {
    return [...el.classList].filter((c) => !STATE_CLASSES.has(c));
  }

  function cssPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement) {
      let part = cur.tagName.toLowerCase();
      if (cur.id) {
        parts.unshift(`${part}#${CSS.escape(cur.id)}`);
        break;
      }
      const cls = classesOf(cur).slice(0, 2);
      if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.');
      else if (cur.parentElement) {
        const same = [...cur.parentElement.children].filter((s) => s.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      let unique = false;
      try { unique = document.querySelectorAll(parts.join(' > ')).length === 1; } catch { /* keep walking */ }
      if (unique) break;
      cur = cur.parentElement;
    }
    return parts.join(' > ');
  }

  function label(el) {
    let s = el.tagName.toLowerCase();
    if (el.id) s += `#${el.id}`;
    const cls = classesOf(el).slice(0, 2);
    if (cls.length) s += '.' + cls.join('.');
    const text = (el.children.length <= 3 ? el.innerText || '' : '').trim().replace(/\s+/g, ' ');
    if (text) s += ` “${text.slice(0, 24)}${text.length > 24 ? '…' : ''}”`;
    return s;
  }

  function sharedCount(el) {
    const cls = classesOf(el);
    if (!cls.length) return 1;
    try {
      return document.querySelectorAll(el.tagName.toLowerCase() + cls.map((c) => '.' + CSS.escape(c)).join('')).length;
    } catch { return 1; }
  }

  /* ---------------- design tokens (:root variables) ---------------- */

  function collectRootVars() {
    const found = new Map();
    const cs = getComputedStyle(document.documentElement);
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (rule.selectorText !== ':root' && rule.selectorText !== 'html') continue;
        for (const name of rule.style) {
          if (!name.startsWith('--')) continue;
          const v = cs.getPropertyValue(name).trim();
          if (/^-?[\d.]+px$/.test(v) && !found.has(name)) found.set(name, v);
        }
      }
    }
    rootVars = [...found];
    // Colour variables, resolved to rgb() so they can be matched against computed colours.
    const probe = document.createElement('span');
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const colors = new Map();
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) {
        if (rule.selectorText !== ':root' && rule.selectorText !== 'html') continue;
        for (const name of rule.style) {
          if (!name.startsWith('--') || colors.has(name)) continue;
          const raw = cs.getPropertyValue(name).trim();
          if (!raw || /^-?[\d.]+(px|rem|em|%)?$/.test(raw)) continue;
          probe.style.color = '';
          probe.style.color = raw;
          if (!probe.style.color) continue; // not a colour
          colors.set(name, getComputedStyle(probe).color);
        }
      }
    }
    probe.remove();
    colorVars = [...colors];
  }

  const colorVarFor = (value) => (colorVars.find(([, v]) => v === value) || [])[0];

  const variableFor = (value) => (rootVars.find(([, v]) => v === value) || [])[0];

  /* ---------------- edits ---------------- */

  // The four corner radii in px (top-left, top-right, bottom-right, bottom-left), after the
  // same shrinking the browser applies when radii are too big for the box (so 50% on a
  // 30px square reads as 15, and 9999px on a pill reads as half its height).
  function radiiPx(cs, rect) {
    const r = RADII.map((p) => {
      const t = cs.getPropertyValue(p).trim().split(/\s+/);
      const conv = (tok, ref) => (tok.endsWith('%') ? (parseFloat(tok) * ref) / 100 : parseFloat(tok) || 0);
      return [conv(t[0], rect.width), conv(t[1] || t[0], rect.height)];
    });
    const [tl, tr, br, bl] = r;
    const w = rect.width, h = rect.height;
    const f = Math.min(1,
      (tl[0] + tr[0]) > 0 ? w / (tl[0] + tr[0]) : 1,
      (bl[0] + br[0]) > 0 ? w / (bl[0] + br[0]) : 1,
      (tl[1] + bl[1]) > 0 ? h / (tl[1] + bl[1]) : 1,
      (tr[1] + br[1]) > 0 ? h / (tr[1] + br[1]) : 1);
    return r.map(([x, y]) => Math.round(Math.min(x, y) * f * 10) / 10);
  }

  function ensureEdit(el) {
    let e = edits.get(el);
    if (!e) {
      const cs = getComputedStyle(el);
      const orig = {};
      for (const p of TRACK) orig[p] = cs.getPropertyValue(p);
      radiiPx(cs, el.getBoundingClientRect()).forEach((v, i) => { orig[RADII[i]] = `${v}px`; });
      const tr = /^(-?[\d.]+)px(?: (-?[\d.]+)px)?/.exec(cs.translate || '');
      e = {
        inline: el.style.cssText, orig, touched: new Set(), boxSizing: cs.boxSizing,
        tx: tr ? +tr[1] : 0, ty: tr && tr[2] ? +tr[2] : 0, poly: null, shaped: false,
      };
      edits.set(el, e);
    }
    return e;
  }

  function setProp(el, prop, value) {
    const e = ensureEdit(el);
    e.touched.add(prop);
    el.style.setProperty(prop, `${round(value)}px`, 'important');
  }

  function shorthand(vals) {
    const [t, r, b, l] = vals;
    if (t === r && r === b && b === l) return t;
    if (t === b && r === l) return `${t} ${r}`;
    if (r === l) return `${t} ${r} ${b}`;
    return `${t} ${r} ${b} ${l}`;
  }

  // The recorded difference for one element: only properties you directly changed.
  function diffFor(el, e) {
    const cs = getComputedStyle(el);
    const rows = [];
    const now = (p) => cs.getPropertyValue(p);
    const changed = (p) => e.touched.has(p) && Math.abs(px(now(p)) - px(e.orig[p])) >= 0.5;
    for (const p of ['width', 'height']) {
      if (changed(p)) rows.push({ prop: p, before: e.orig[p], after: now(p) });
    }
    if (SIDES.every((p) => e.touched.has(p)) && SIDES.some(changed)) {
      rows.push({
        prop: 'padding',
        before: shorthand(SIDES.map((p) => e.orig[p])),
        after: shorthand(SIDES.map(now)),
      });
    } else {
      for (const p of SIDES) if (changed(p)) rows.push({ prop: p, before: e.orig[p], after: now(p) });
    }
    const rNow = radiiPx(cs, el.getBoundingClientRect()).map((v) => `${v}px`);
    const rOrig = RADII.map((p) => e.orig[p]);
    if (RADII.some((p) => e.touched.has(p)) && rNow.some((v, i) => Math.abs(px(v) - px(rOrig[i])) >= 0.5)) {
      rows.push({ prop: 'border-radius', before: shorthand(rOrig), after: shorthand(rNow) });
    }
    if (e.touched.has('clip-path') && now('clip-path') !== e.orig['clip-path']) {
      rows.push({ prop: 'clip-path', before: e.orig['clip-path'], after: now('clip-path') });
    }
    if (e.touched.has('translate') && now('translate') !== e.orig['translate']) {
      rows.push({ prop: 'translate', before: e.orig['translate'], after: now('translate') });
    }
    const sidesOf = (names) => names.filter((p) => e.touched.has(p));
    const widths = sidesOf(BORDER_W).filter((p) => Math.abs(px(now(p)) - px(e.orig[p])) >= 0.5);
    if (widths.length === 4 && BORDER_W.every((p) => now(p) === now(BORDER_W[0]))) {
      rows.push({ prop: 'border-width', before: shorthand(BORDER_W.map((p) => e.orig[p])), after: now(BORDER_W[0]) });
    } else {
      for (const p of widths) rows.push({ prop: p, before: e.orig[p], after: now(p) });
    }
    const differs = (p) => e.touched.has(p) && now(p) !== e.orig[p];
    if (differs('border-top-style')) rows.push({ prop: 'border-style', before: e.orig['border-top-style'], after: now('border-top-style') });
    if (differs('border-top-color')) rows.push({ prop: 'border-color', before: e.orig['border-top-color'], after: now('border-top-color') });
    if (differs('background-color')) rows.push({ prop: 'background-color', before: e.orig['background-color'], after: now('background-color') });
    if (differs('color')) rows.push({ prop: 'color', before: e.orig['color'], after: now('color') });
    if (changed('font-size')) rows.push({ prop: 'font-size', before: e.orig['font-size'], after: now('font-size') });
    if (differs('font-weight')) rows.push({ prop: 'font-weight', before: e.orig['font-weight'], after: now('font-weight') });
    for (const r of rows) {
      const v = variableFor(r.after) || colorVarFor(r.after);
      if (v) r.variable = v;
    }
    return rows;
  }

  function activeEdits() {
    const list = [];
    for (const [el, e] of edits) {
      if (!el.isConnected && !e.removed) continue;
      const rows = e.removed ? [] : diffFor(el, e);
      if (rows.length || e.removed) list.push({ el, e, rows });
    }
    return list;
  }

  function collectChanges() {
    return activeEdits().map(({ el, e, rows }) => ({
      removed: !!e.removed,
      childCount: e.childCount || 0,
      label: label(el),
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      classes: classesOf(el),
      ids: el.id ? [el.id] : [],
      sharedCount: sharedCount(el),
      boxSizing: e.boxSizing,
      rect: e.shaped ? (() => { const r = el.getBoundingClientRect(); return { x: round(r.left), y: round(r.top), w: round(r.width), h: round(r.height) }; })() : null,
      props: rows,
    }));
  }

  function snapshot(el) {
    const e = edits.get(el);
    history.push({
      el, css: el.style.cssText, touched: new Set(e ? e.touched : []), had: !!e, removed: !!(e && e.removed),
      tx: e?.tx, ty: e?.ty, poly: e?.poly ? e.poly.map((q) => q.slice()) : null, shaped: !!e?.shaped,
    });
  }

  // Typing or sliding in a style field fires many events; group them into one undo step.
  function snapshotSoon(el) {
    const now = performance.now();
    if (lastSnap.el === el && now - lastSnap.t < 800) { lastSnap.t = now; return; }
    lastSnap = { el, t: now };
    snapshot(el);
  }

  // Deleting hides the element (so the app keeps running and it can be undone) and
  // records it in the brief as "remove this element from the source".
  function deleteSelected() {
    const target = selEl;
    if (!target || !target.isConnected) return;
    snapshot(target);
    const e = ensureEdit(target);
    e.removed = true;
    e.childCount = target.querySelectorAll('*').length;
    target.style.setProperty('display', 'none', 'important');
    selEl = null;
    childStack = [];
    renderList();
  }

  function undo() {
    const h = history.pop();
    if (!h) return;
    h.el.style.cssText = h.css;
    const e = edits.get(h.el);
    if (!h.had) edits.delete(h.el);
    else if (e) { e.touched = h.touched; e.removed = h.removed; e.tx = h.tx; e.ty = h.ty; e.poly = h.poly; e.shaped = h.shaped; }
    renderList();
  }

  function resetElement(el) {
    const e = edits.get(el);
    if (!e) return;
    el.style.cssText = e.inline;
    edits.delete(el);
    renderList();
  }

  function resetAll() {
    for (const el of [...edits.keys()]) resetElement(el);
    history.length = 0;
  }

  /* ---------------- UI ---------------- */

  const CSS_TEXT = `
    #__studio, #__studio * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", sans-serif; }
    #__studio { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
    #__studio .box { position: fixed; pointer-events: none; }
    #__studio .hover { outline: 1.5px dashed ${INK}; outline-offset: -1px; background: rgba(255,45,138,.06); }
    #__studio .sel { outline: 2px solid ${INK}; outline-offset: -1px; }
    #__studio .changed { outline: 2px solid ${INK}; outline-offset: 1px; }
    #__studio .pad { position: absolute; background: rgba(34,197,94,.22); pointer-events: none; }
    #__studio .h { position: absolute; pointer-events: auto; touch-action: none; }
    #__studio .h.size { width: 12px; height: 12px; background: ${INK}; border: 2px solid #fff; border-radius: 3px; }
    #__studio .h.padh { width: 12px; height: 12px; background: #22c55e; border: 2px solid #fff; border-radius: 50%; }
    #__studio .h.rad { width: 12px; height: 12px; background: #f59e0b; border: 2px solid #fff; border-radius: 50%; }
    #__studio .tag { position: absolute; left: 0; top: -22px; padding: 2px 8px; border-radius: 999px; background: ${INK}; color: #fff; font-size: 11px; white-space: nowrap; }
    #__studio .panel, #__studio .viewer {
      position: fixed; pointer-events: auto; background: #fff; color: #16202b;
      border: 4px solid ${INK}; border-radius: 28px; padding: 14px 18px 16px;
      font-size: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.18);
    }
    @media (prefers-color-scheme: dark) { #__studio .panel, #__studio .viewer { background: #151b22; color: #e8eef5; } }
    #__studio .panel { left: 18px; bottom: 18px; width: 310px; max-height: 60vh; display: flex; flex-direction: column; }
    #__studio .head { display: flex; justify-content: space-between; align-items: baseline; font-weight: 700; color: ${INK}; margin-bottom: 4px; }
    #__studio .head span:last-child { font-weight: 400; font-size: 10px; opacity: .6; }
    #__studio .hint { opacity: .65; margin-bottom: 8px; line-height: 1.4; }
    #__studio .list { overflow-y: auto; margin-bottom: 8px; min-height: 0; }
    #__studio .item { padding: 6px 0; border-top: 1px solid rgba(128,128,128,.25); }
    #__studio .item b { font-weight: 600; display: flex; justify-content: space-between; gap: 8px; }
    #__studio .item span.r { opacity: .75; display: block; }
    #__studio .item .x { border: 0; background: none; cursor: pointer; color: inherit; opacity: .6; font-size: 14px; padding: 0 4px; }
    #__studio .btns { display: flex; flex-wrap: wrap; gap: 6px; }
    #__studio button.b {
      height: 28px; padding: 0 12px; border-radius: 999px; border: 2px solid ${INK};
      background: transparent; color: ${INK}; font-size: 12px; font-weight: 600; cursor: pointer;
    }
    #__studio button.b:hover { background: ${INK}; color: #fff; }
    #__studio button.b.primary { background: ${INK}; color: #fff; }
    #__studio button.b[disabled] { opacity: .4; cursor: default; }
    #__studio .status { margin-top: 8px; white-space: pre-wrap; line-height: 1.4; max-height: 140px; overflow-y: auto; }
    #__studio .viewer { left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(760px, 82vw); max-height: 74vh; display: flex; flex-direction: column; }
    #__studio .viewer pre { margin: 8px 0 10px; overflow: auto; white-space: pre-wrap; font: 11.5px/1.5 Menlo, monospace; }
    #__studio .viewer .path { opacity: .6; font-size: 11px; }
    #__studio .stylepanel { width: 250px; max-height: 80vh; overflow-y: auto; animation: __studioPop .16s ease-out; transform-origin: left bottom; }
    @keyframes __studioPop { from { opacity: 0; transform: translateX(-12px) scale(.96); } to { opacity: 1; transform: none; } }
    #__studio .stylepanel .sub { opacity: .65; margin-bottom: 8px; line-height: 1.4; word-break: break-word; }
    #__studio .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 0; border-top: 1px solid rgba(128,128,128,.25); }
    #__studio .row > span { font-weight: 600; }
    #__studio .row .ctl { display: flex; align-items: center; gap: 6px; }
    #__studio .row input[type=number], #__studio .row select {
      width: 64px; height: 26px; border-radius: 999px; border: 2px solid ${INK}; background: transparent; color: inherit; padding: 0 8px; font-size: 12px;
    }
    #__studio .row select { width: 84px; }
    #__studio .row input[type=color] { width: 30px; height: 26px; border: 2px solid ${INK}; border-radius: 50%; padding: 0; background: none; cursor: pointer; }
    #__studio .row input[type=color]::-webkit-color-swatch-wrapper { padding: 0; }
    #__studio .row input[type=color]::-webkit-color-swatch { border: 0; border-radius: 50%; }
    #__studio .swatches { display: flex; flex-wrap: wrap; gap: 5px; padding: 0 0 6px; justify-content: flex-end; }
    #__studio .sw { width: 18px; height: 18px; border-radius: 50%; border: 2px solid rgba(128,128,128,.5); cursor: pointer; padding: 0; }
    #__studio .sw:hover { border-color: ${INK}; }
    #__studio .shapebox { box-shadow: 0 0 0 100vmax rgba(10,14,22,.55); outline: 2px dashed #fff; outline-offset: 0; }
    #__studio .shapebox .c { position: absolute; width: 12px; height: 12px; margin: -6px 0 0 -6px; border-radius: 50%; background: #f59e0b; border: 2px solid #fff; pointer-events: auto; touch-action: none; }
    #__studio .shapelayer { position: fixed; inset: 0; }
    #__studio .shapelayer svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
    #__studio .shapebar { left: 50%; top: 18px; transform: translateX(-50%); width: auto; max-width: 560px; border-radius: 24px; padding: 10px 14px 12px; }
    #__studio .shapebar .btns { margin: 6px 0; }
    #__studio .shapebar .hint { margin: 4px 0 0; }
    #__studio.shooting .hud { display: none !important; }
  `;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function button(text, cls, onClick) {
    const b = el('button', `b ${cls || ''}`, text);
    b.addEventListener('click', onClick);
    return b;
  }

  function buildUI() {
    root = el('div');
    root.id = '__studio';
    const style = document.createElement('style');
    style.textContent = CSS_TEXT;
    root.appendChild(style);

    ui.hover = el('div', 'box hover hud');
    ui.sel = el('div', 'box sel hud');
    ui.tag = el('div', 'tag');
    ui.sel.appendChild(ui.tag);
    ui.padBoxes = {};
    for (const side of ['t', 'r', 'b', 'l']) {
      const p = el('div', 'pad');
      ui.padBoxes[side] = p;
      ui.sel.appendChild(p);
    }
    ui.handles = {};
    const defs = [
      ['e', 'size', 'ew-resize'], ['s', 'size', 'ns-resize'], ['se', 'size', 'nwse-resize'],
      ['pt', 'padh', 'ns-resize'], ['pr', 'padh', 'ew-resize'], ['pb', 'padh', 'ns-resize'], ['pl', 'padh', 'ew-resize'],
      ['r', 'rad', 'nwse-resize'],
    ];
    for (const [name, kind, cursor] of defs) {
      const h = el('div', `h ${kind}`);
      h.dataset.h = name;
      h.style.cursor = cursor;
      h.addEventListener('pointerdown', (ev) => startDrag(ev, name));
      ui.handles[name] = h;
      ui.sel.appendChild(h);
    }
    ui.changed = el('div', 'changedLayer');
    root.append(ui.hover, ui.changed, ui.sel);

    // Control panel
    ui.panel = el('div', 'panel hud');
    const head = el('div', 'head');
    head.append(el('span', null, 'Studio'), el('span', null, 'drag to move'));
    head.style.cursor = 'grab';
    head.style.userSelect = 'none';
    head.addEventListener('pointerdown', (ev) => {
      // Move the panel out of the way of whatever you're editing.
      ev.preventDefault();
      const r = ui.panel.getBoundingClientRect();
      const dx = ev.clientX - r.left, dy = ev.clientY - r.top;
      const move = (e) => {
        ui.panel.style.left = `${Math.max(0, Math.min(window.innerWidth - r.width, e.clientX - dx))}px`;
        ui.panel.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, e.clientY - dy))}px`;
        ui.panel.style.bottom = 'auto';
      };
      const up = () => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', up, true);
      };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
    });
    ui.hint = el('div', 'hint', 'Click an element. Drag pink to resize (hold Shift to keep proportions), green for padding, orange for corners. Delete removes it. Style opens colors and borders, Shape cuts and reshapes. ↑ selects the parent, Cmd+Z undoes, Esc exits.');
    ui.list = el('div', 'list');
    ui.btns = el('div', 'btns');
    ui.deleteBtn = button('Delete element', '', deleteSelected);
    ui.viewBtn = button('View brief', '', viewBrief);
    ui.sendBtn = button('Send to agent', 'primary', sendClick);
    ui.resetBtn = button('Reset all', '', () => { resetAll(); setStatus(''); });
    ui.doneBtn = button('Done', '', exit);
    ui.styleBtn = button('Style ▸', '', () => toggleStylePanel());
    ui.shapeBtn = button('Shape', '', () => enterShape());
    ui.btns.append(ui.deleteBtn, ui.styleBtn, ui.shapeBtn, ui.viewBtn, ui.sendBtn, ui.resetBtn, ui.doneBtn);
    ui.status = el('div', 'status');
    ui.panel.append(head, ui.hint, ui.list, ui.btns, ui.status);
    root.appendChild(ui.panel);
    document.body.appendChild(root);
    renderList();
  }

  /* ---------------- style pop-out panel ---------------- */

  const toHex = (rgb) => {
    const m = /rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)/.exec(rgb || '');
    if (!m || /,\s*0\)$/.test(rgb)) return '#ffffff';
    return '#' + [m[1], m[2], m[3]].map((n) => Math.round(+n).toString(16).padStart(2, '0')).join('');
  };

  function applyStyle(prop, value) {
    const t = selEl;
    if (!t || !t.isConnected) return;
    snapshotSoon(t);
    const e = ensureEdit(t);
    const put = (p, v) => { e.touched.add(p); t.style.setProperty(p.replace(/^border-top-(color|style)$/, 'border-$1'), v, 'important'); };
    if (prop === 'border-width') {
      const w = Math.max(0, round(+value || 0));
      const cs = getComputedStyle(t);
      const live = SIDE_NAMES.filter((s) => cs.getPropertyValue(`border-${s}-style`) !== 'none' && px(cs.getPropertyValue(`border-${s}-width`)) > 0);
      if (live.length) {
        for (const s of live) put(`border-${s}-width`, `${w}px`);
      } else if (w > 0) {
        // The element has no border yet: give it a solid one on every side.
        put('border-top-style', 'solid');
        for (const s of SIDE_NAMES) put(`border-${s}-width`, `${w}px`);
      }
    } else if (prop === 'border-color') {
      put('border-top-color', value);
    } else if (prop === 'font-size') {
      put('font-size', `${Math.max(1, round(+value || 1))}px`);
    } else {
      put(prop, value);
    }
    renderList();
  }

  function toggleStylePanel(force) {
    const open = force != null ? force : !ui.style;
    if (!open) {
      ui.style?.remove(); ui.style = null; ui.fields = null;
      if (ui.styleBtn) ui.styleBtn.textContent = 'Style ▸';
      return;
    }
    if (ui.style) return;
    ui.styleBtn.textContent = 'Style ◂';
    const p = el('div', 'panel stylepanel hud');
    const head = el('div', 'head');
    head.append(el('span', null, 'Style'));
    const close = el('button', 'x', '×');
    close.style.cssText = 'border:0;background:none;cursor:pointer;color:inherit;opacity:.6;font-size:16px;';
    close.addEventListener('click', () => toggleStylePanel(false));
    head.append(close);
    ui.styleSub = el('div', 'sub');
    ui.fields = {};
    const body = el('div', 'body');
    const row = (name, ...ctl) => {
      const r = el('div', 'row');
      const c = el('div', 'ctl');
      c.append(...ctl);
      r.append(el('span', null, name), c);
      return r;
    };
    const num = (prop, min) => {
      const i = document.createElement('input');
      i.type = 'number'; i.min = min; i.step = 1;
      i.addEventListener('input', () => { if (i.value !== '') applyStyle(prop, i.value); });
      ui.fields[prop] = i;
      return i;
    };
    const color = (prop) => {
      const i = document.createElement('input');
      i.type = 'color';
      i.addEventListener('input', () => applyStyle(prop, i.value));
      ui.fields[prop] = i;
      return i;
    };
    const swatches = (prop) => {
      const w = el('div', 'swatches');
      for (const [name, value] of colorVars) {
        const b = el('button', 'sw');
        b.title = `var(${name})`;
        b.style.background = value;
        // Applying the variable itself keeps the page tied to the design token.
        b.addEventListener('click', () => { applyStyle(prop, `var(${name})`); refreshStyle(); });
        w.appendChild(b);
      }
      return w;
    };
    const weight = document.createElement('select');
    for (const wv of ['100', '200', '300', '400', '500', '600', '700', '800', '900']) {
      const o = document.createElement('option'); o.value = o.textContent = wv; weight.appendChild(o);
    }
    weight.addEventListener('change', () => applyStyle('font-weight', weight.value));
    ui.fields['font-weight'] = weight;

    body.append(
      row('Border', num('border-width', 0), color('border-color')),
      colorVars.length ? swatches('border-color') : el('span'),
      row('Fill', color('background-color')),
      colorVars.length ? swatches('background-color') : el('span'),
      row('Text', color('color')),
      colorVars.length ? swatches('color') : el('span'),
      row('Size', num('font-size', 1)),
      row('Weight', weight),
    );
    p.append(head, ui.styleSub, body);
    root.appendChild(p);
    ui.style = p;
    refreshStyle();
  }

  // Keep the fields showing the selected element's current values.
  function refreshStyle() {
    if (!ui.style || !ui.fields) return;
    ui.styleSub.textContent = selEl && selEl.isConnected ? label(selEl) : 'Click an element to style it.';
    ui.style.querySelector('.body').style.opacity = selEl ? '1' : '.4';
    ui.style.querySelector('.body').style.pointerEvents = selEl ? 'auto' : 'none';
    if (!selEl || !selEl.isConnected) return;
    const cs = getComputedStyle(selEl);
    const F = ui.fields;
    const setv = (f, v) => { if (f && document.activeElement !== f) f.value = v; };
    const live = SIDE_NAMES.map((s) => px(cs.getPropertyValue(`border-${s}-width`))).find((w) => w > 0) || 0;
    setv(F['border-width'], round(live));
    setv(F['border-color'], toHex(cs.borderTopColor));
    setv(F['background-color'], toHex(cs.backgroundColor));
    setv(F['color'], toHex(cs.color));
    setv(F['font-size'], round(px(cs.fontSize)));
    setv(F['font-weight'], String(Math.round(px(cs.fontWeight) / 100) * 100 || 400));
  }

  // The pop-out sits beside the main panel, on whichever side has room.
  function placeStylePanel() {
    const sp = ui.style;
    if (!sp) return;
    const r = ui.panel.getBoundingClientRect();
    const w = sp.offsetWidth || 250;
    const right = r.right + 12 + w <= window.innerWidth;
    sp.style.left = `${right ? r.right + 12 : Math.max(0, r.left - 12 - w)}px`;
    sp.style.bottom = `${Math.max(0, window.innerHeight - r.bottom)}px`;
    sp.style.top = 'auto';
    sp.style.transformOrigin = right ? 'left bottom' : 'right bottom';
  }

  function setStatus(text) { if (ui.status) ui.status.textContent = text; }

  function renderList() {
    if (!ui.list) return;
    ui.list.textContent = '';
    const list = activeEdits();
    if (!list.length) {
      ui.list.appendChild(el('div', 'hint', 'No changes yet.'));
    }
    for (const { el: target, e, rows } of list) {
      const item = el('div', 'item');
      const title = el('b', null, '');
      title.append(el('span', null, label(target)));
      const x = el('button', 'x', '×');
      x.title = 'Reset this element';
      x.addEventListener('click', () => resetElement(target));
      title.appendChild(x);
      item.appendChild(title);
      if (e.removed) item.appendChild(el('span', 'r', `Delete this element${e.childCount ? ` (and its ${e.childCount} inner elements)` : ''}`));
      for (const r of rows) item.appendChild(el('span', 'r', `${r.prop}: ${r.before} → ${r.after}`));
      ui.list.appendChild(item);
    }
    const n = list.length;
    ui.viewBtn.disabled = ui.sendBtn.disabled = n === 0;
    ui.deleteBtn.disabled = !selEl || !!shapeEl;
    refreshStyle();
  }

  /* ---------------- geometry / drawing ---------------- */

  function place(box, rect) {
    box.style.left = `${rect.left}px`;
    box.style.top = `${rect.top}px`;
    box.style.width = `${rect.width}px`;
    box.style.height = `${rect.height}px`;
  }

  function tick() {
    if (!on) return;
    ui.deleteBtn.disabled = !selEl || !!shapeEl; // follows the selection
    ui.shapeBtn.disabled = !selEl || !!shapeEl;
    if (selEl !== lastSel) { lastSel = selEl; refreshStyle(); }
    placeStylePanel();
    if (hoverEl && hoverEl.isConnected && hoverEl !== selEl) {
      ui.hover.style.display = 'block';
      place(ui.hover, hoverEl.getBoundingClientRect());
    } else {
      ui.hover.style.display = 'none';
    }

    if (shapeEl) tickShape();
    if (selEl && selEl.isConnected && !shapeEl) {
      const r = selEl.getBoundingClientRect();
      const cs = getComputedStyle(selEl);
      ui.sel.style.display = 'block';
      place(ui.sel, r);
      ui.tag.textContent = `${label(selEl)}  ${round(r.width)}×${round(r.height)}`;
      const pt = px(cs.paddingTop), pr = px(cs.paddingRight), pb = px(cs.paddingBottom), pl = px(cs.paddingLeft);
      const bt = px(cs.borderTopWidth), br = px(cs.borderRightWidth), bb = px(cs.borderBottomWidth), bl = px(cs.borderLeftWidth);
      Object.assign(ui.padBoxes.t.style, { left: `${bl}px`, top: `${bt}px`, width: `${r.width - bl - br}px`, height: `${pt}px` });
      Object.assign(ui.padBoxes.b.style, { left: `${bl}px`, bottom: `${bb}px`, width: `${r.width - bl - br}px`, height: `${pb}px` });
      Object.assign(ui.padBoxes.l.style, { left: `${bl}px`, top: `${bt + pt}px`, width: `${pl}px`, height: `${Math.max(0, r.height - bt - bb - pt - pb)}px` });
      Object.assign(ui.padBoxes.r.style, { right: `${br}px`, top: `${bt + pt}px`, width: `${pr}px`, height: `${Math.max(0, r.height - bt - bb - pt - pb)}px` });
      const H = ui.handles;
      const set = (h, left, top) => { h.style.left = `${left - 6}px`; h.style.top = `${top - 6}px`; };
      set(H.e, r.width + 8, r.height / 2);
      set(H.s, r.width / 2, r.height + 8);
      set(H.se, r.width + 8, r.height + 8);
      set(H.pt, r.width / 2, bt + pt + 6);
      set(H.pb, r.width / 2, r.height - bb - pb - 6);
      set(H.pl, bl + pl + 6, r.height / 2);
      set(H.pr, r.width - br - pr - 6, r.height / 2);
      const rad = radiiPx(cs, r)[0];
      const k = Math.min(rad * 0.3 + 12, Math.min(r.width, r.height) / 2);
      set(H.r, k, k);
    } else {
      ui.sel.style.display = 'none';
    }

    // Outline every element that has recorded changes.
    const list = activeEdits();
    while (ui.changed.children.length > list.length) ui.changed.lastChild.remove();
    while (ui.changed.children.length < list.length) ui.changed.appendChild(el('div', 'box changed'));
    list.forEach(({ el: target, e }, i) => {
      const b = ui.changed.children[i];
      if (target === selEl || e.removed) b.style.display = 'none';
      else { b.style.display = 'block'; place(b, target.getBoundingClientRect()); }
    });
    raf = requestAnimationFrame(tick);
  }

  /* ---------------- dragging ---------------- */

  function startDrag(ev, kind) {
    if (!selEl) return;
    ev.preventDefault();
    ev.stopPropagation();
    const target = selEl;
    snapshot(target);
    const handle = ev.currentTarget;
    handle.setPointerCapture(ev.pointerId);
    const x0 = ev.clientX, y0 = ev.clientY;
    const cs = getComputedStyle(target);
    const rect = target.getBoundingClientRect();
    const start = {
      w: rect.width, h: rect.height,
      pt: px(cs.paddingTop), pr: px(cs.paddingRight), pb: px(cs.paddingBottom), pl: px(cs.paddingLeft),
      bx: px(cs.borderLeftWidth) + px(cs.borderRightWidth), by: px(cs.borderTopWidth) + px(cs.borderBottomWidth),
      rad: radiiPx(cs, rect)[0], border: cs.boxSizing === 'border-box',
    };
    const size = (outer, padSum, borderSum) => (start.border ? outer : outer - padSum - borderSum);
    const startedTouched = new Set(edits.get(target)?.touched || []);
    const prevInline = {};
    for (const prop of ['width', 'height']) {
      const value = target.style.getPropertyValue(prop);
      prevInline[prop] = value ? { value, priority: target.style.getPropertyPriority(prop) } : null;
    }

    const move = (e) => {
      const dx = e.clientX - x0, dy = e.clientY - y0;
      const clamp = (v) => Math.max(0, v);
      if (kind === 'e' || kind === 's' || kind === 'se') {
        // Outer (border-box) size we are heading for.
        let W = start.w + (kind === 's' ? 0 : dx);
        let H = start.h + (kind === 'e' ? 0 : dy);
        if (e.shiftKey && start.w > 0 && start.h > 0) {
          // Hold Shift to keep the proportions (a circle stays a circle).
          if (kind === 'e') H = (W * start.h) / start.w;
          else if (kind === 's') W = (H * start.w) / start.h;
          else {
            const sx = W / start.w, sy = H / start.h;
            const k = Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
            W = start.w * k; H = start.h * k;
          }
        }
        const sets = [];
        if (kind !== 's' || e.shiftKey) sets.push(['width', clamp(size(W, start.pl + start.pr, start.bx))]);
        if (kind !== 'e' || e.shiftKey) sets.push(['height', clamp(size(H, start.pt + start.pb, start.by))]);
        for (const [prop, v] of sets) setProp(target, prop, v);
        // If Shift was let go, give back the side we were only adjusting to keep proportions.
        for (const prop of ['width', 'height']) {
          const driven = (prop === 'width' && kind !== 's') || (prop === 'height' && kind !== 'e');
          if (!driven && !e.shiftKey && !startedTouched.has(prop) && edits.get(target)?.touched.has(prop)) {
            const keep = prevInline[prop];
            if (keep) target.style.setProperty(prop, keep.value, keep.priority); else target.style.removeProperty(prop);
            edits.get(target).touched.delete(prop);
          }
        }
      }
      if (kind === 'pt') setProp(target, 'padding-top', clamp(start.pt + dy));
      if (kind === 'pb') setProp(target, 'padding-bottom', clamp(start.pb - dy));
      if (kind === 'pl') setProp(target, 'padding-left', clamp(start.pl + dx));
      if (kind === 'pr') setProp(target, 'padding-right', clamp(start.pr - dx));
      if (kind === 'r') {
        // One radius for all corners, like the app's phone-style rounding.
        const v = round(Math.min(clamp(start.rad + (dx + dy) / 2), Math.min(start.w, start.h) / 2));
        for (const rp of RADII) ensureEdit(target).touched.add(rp);
        target.style.setProperty('border-radius', `${v}px`, 'important');
      }
      renderList();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }


  /* ---------------- shape mode ---------------- */

  const HINTS = {
    corners: 'Drag a corner dot to round just that corner (hold Shift for all four). Arrow keys nudge the shape.',
    slice: 'Drag a line across the shape. It snaps to vertical, horizontal and the middle. Click a half to choose which half to keep, then Apply cut.',
    move: 'Drag to move the shape. Arrow keys nudge 1px (Shift: 10px).',
  };
  const CORNER_SIGNS = [[1, 1], [-1, 1], [-1, -1], [1, -1]];

  function enterShape() {
    if (!selEl || !selEl.isConnected || shapeEl) return;
    shapeEl = selEl;
    shapeTool = 'corners';
    pending = null;
    ui.sel.style.display = 'none';
    ui.shape = el('div', 'box shapebox hud');
    ui.corners = CORNER_SIGNS.map((_, i) => {
      const c = el('div', 'c');
      c.style.cursor = i % 2 ? 'nesw-resize' : 'nwse-resize';
      c.addEventListener('pointerdown', (ev) => startCornerDrag(ev, i));
      ui.shape.appendChild(c);
      return c;
    });
    ui.layer = el('div', 'shapelayer hud');
    ui.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ui.layer.appendChild(ui.svg);
    ui.layer.addEventListener('pointerdown', onLayerDown);
    root.insertBefore(ui.shape, ui.panel);
    root.insertBefore(ui.layer, ui.panel);

    ui.bar = el('div', 'panel shapebar hud');
    const head = el('div', 'head');
    ui.barTitle = el('span', null, `Shape: ${label(shapeEl)}`);
    head.append(ui.barTitle);
    ui.toolBtns = {};
    const tools = el('div', 'btns');
    for (const [id, text] of [['corners', 'Corners'], ['slice', 'Slice'], ['move', 'Move']]) {
      ui.toolBtns[id] = button(text, '', () => setTool(id));
      tools.appendChild(ui.toolBtns[id]);
    }
    ui.applyBtn = button('Apply cut', 'primary', applyCut);
    ui.cancelCutBtn = button('Discard line', '', () => { pending = null; });
    tools.append(ui.applyBtn, ui.cancelCutBtn, button('Done', '', exitShape));
    ui.barHint = el('div', 'hint');
    ui.bar.append(head, tools, ui.barHint);
    root.appendChild(ui.bar);
    setTool('corners');
    renderList();
  }

  function exitShape() {
    if (!shapeEl) return;
    shapeEl = null; pending = null;
    for (const k of ['shape', 'layer', 'bar']) { ui[k]?.remove(); ui[k] = null; }
    renderList();
  }

  function setTool(t) {
    shapeTool = t;
    pending = null;
    for (const [id, b] of Object.entries(ui.toolBtns)) b.classList.toggle('primary', id === t);
    ui.barHint.textContent = HINTS[t];
    ui.layer.style.pointerEvents = t === 'corners' ? 'none' : 'auto';
    ui.layer.style.cursor = t === 'slice' ? 'crosshair' : 'move';
  }

  function tickShape() {
    if (!shapeEl.isConnected) { exitShape(); return; }
    const r = shapeEl.getBoundingClientRect();
    const cs = getComputedStyle(shapeEl);
    place(ui.shape, r);
    const R = radiiPx(cs, r);
    const pos = [[0, 0], [1, 0], [1, 1], [0, 1]];
    ui.corners.forEach((c, i) => {
      const d = Math.min(R[i] * 0.29 + 9, Math.min(r.width, r.height) / 2);
      c.style.left = `${pos[i][0] ? r.width - d : d}px`;
      c.style.top = `${pos[i][1] ? r.height - d : d}px`;
      c.style.display = shapeTool === 'corners' ? 'block' : 'none';
    });
    ui.applyBtn.style.display = ui.cancelCutBtn.style.display = pending ? '' : 'none';
    drawCut(r);
  }

  /* corner dragging: one corner at a time (Shift = all four) */
  function startCornerDrag(ev, i) {
    ev.preventDefault();
    ev.stopPropagation();
    const t = shapeEl;
    snapshot(t);
    const e = ensureEdit(t);
    e.shaped = true;
    const h = ev.currentTarget;
    h.setPointerCapture(ev.pointerId);
    const x0 = ev.clientX, y0 = ev.clientY;
    const rect = t.getBoundingClientRect();
    const R0 = radiiPx(getComputedStyle(t), rect);
    const [sx, sy] = CORNER_SIGNS[i];
    const move = (m) => {
      const delta = ((m.clientX - x0) * sx + (m.clientY - y0) * sy) / 2;
      // A corner may only grow until it meets its neighbours.
      const nb = [[1, 3], [0, 2], [3, 1], [2, 0]][i]; // horizontal neighbour, vertical neighbour
      const max = Math.min(rect.width - R0[nb[0]], rect.height - R0[nb[1]]);
      if (m.shiftKey) {
        const v = round(Math.max(0, Math.min(R0[i] + delta, Math.min(rect.width, rect.height) / 2)));
        for (const rp of RADII) { e.touched.add(rp); t.style.setProperty(rp, `${v}px`, 'important'); }
      } else {
        const v = round(Math.max(0, Math.min(R0[i] + delta, max)));
        e.touched.add(RADII[i]);
        t.style.setProperty(RADII[i], `${v}px`, 'important');
      }
      renderList();
    };
    const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
    h.addEventListener('pointercancel', up);
  }

  /* move */
  function applyTranslate(t, e) {
    e.touched.add('translate');
    e.shaped = true;
    t.style.setProperty('translate', `${round(e.tx)}px ${round(e.ty)}px`, 'important');
  }

  function nudge(dx, dy) {
    const t = shapeEl;
    snapshotSoon(t);
    const e = ensureEdit(t);
    e.tx += dx; e.ty += dy;
    applyTranslate(t, e);
    renderList();
  }

  function onShapeKey(e) {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'Escape') {
      if (pending) pending = null; else exitShape();
    } else if (e.key === 'Enter' && pending) {
      applyCut();
    } else if (e.key === 'ArrowLeft') nudge(-step, 0);
    else if (e.key === 'ArrowRight') nudge(step, 0);
    else if (e.key === 'ArrowUp') nudge(0, -step);
    else if (e.key === 'ArrowDown') nudge(0, step);
  }

  /* layer: move tool drags the shape, slice tool draws a cut line */
  function onLayerDown(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const t = shapeEl;
    const x0 = ev.clientX, y0 = ev.clientY;
    ui.layer.setPointerCapture(ev.pointerId);
    let move, up;
    if (shapeTool === 'move') {
      snapshot(t);
      const e = ensureEdit(t);
      const tx = e.tx, ty = e.ty;
      move = (m) => {
        let dx = m.clientX - x0, dy = m.clientY - y0;
        if (m.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        e.tx = tx + dx; e.ty = ty + dy;
        applyTranslate(t, e);
        renderList();
      };
      up = () => finish();
    } else {
      const r = t.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const start = { x: x0, y: y0 };
      let drawing = null;
      move = (m) => {
        if (!drawing && Math.hypot(m.clientX - x0, m.clientY - y0) < 5) return;
        let p2 = { x: m.clientX, y: m.clientY }, p1 = { ...start };
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const ang = (Math.atan2(Math.abs(dx), Math.abs(dy)) * 180) / Math.PI; // 0 = vertical
        if (ang < 4) { p2.x = p1.x; if (Math.abs(p1.x - cx) < 6) p1.x = p2.x = cx; }
        else if (ang > 86) { p2.y = p1.y; if (Math.abs(p1.y - cy) < 6) p1.y = p2.y = cy; }
        drawing = { p1, p2, keep: pending ? pending.keep : 1 };
        pending = drawing;
      };
      up = (u) => {
        if (!drawing && pending) {
          // A plain click: pick which half to keep.
          const { p1, p2 } = pending;
          const s = Math.sign(-(p2.y - p1.y) * (u.clientX - p1.x) + (p2.x - p1.x) * (u.clientY - p1.y));
          if (s) pending.keep = s;
        }
        finish();
      };
    }
    function finish() {
      ui.layer.removeEventListener('pointermove', move);
      ui.layer.removeEventListener('pointerup', up);
      ui.layer.removeEventListener('pointercancel', finish);
    }
    ui.layer.addEventListener('pointermove', move);
    ui.layer.addEventListener('pointerup', up);
    ui.layer.addEventListener('pointercancel', finish);
  }

  /* slicing maths */
  const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];

  // Clip a polygon (points in 0..1 box coordinates) to one side of a line.
  function clipPoly(poly, a, b, keep) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const f = (q) => keep * (-dy * (q[0] - a.x) + dx * (q[1] - a.y));
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const P = poly[i], Q = poly[(i + 1) % poly.length];
      const fp = f(P), fq = f(Q);
      if (fp >= 0) out.push(P);
      if ((fp >= 0) !== (fq >= 0)) {
        const k = fp / (fp - fq);
        out.push([P[0] + (Q[0] - P[0]) * k, P[1] + (Q[1] - P[1]) * k]);
      }
    }
    return out;
  }

  const svgEl = (name, attrs) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  function drawCut(r) {
    ui.svg.textContent = '';
    if (!pending) return;
    const { p1, p2, keep } = pending;
    const norm = (q) => ({ x: (q.x - r.left) / r.width, y: (q.y - r.top) / r.height });
    const a = norm(p1), b = norm(p2);
    const box = CORNERS.map((c) => [c[0], c[1]]);
    const toView = (poly) => poly.map(([x, y]) => `${r.left + x * r.width},${r.top + y * r.height}`).join(' ');
    const kept = clipPoly(box, a, b, keep), gone = clipPoly(box, a, b, -keep);
    if (gone.length > 2) ui.svg.appendChild(svgEl('polygon', { points: toView(gone), fill: 'rgba(239,68,68,.45)' }));
    if (kept.length > 2) ui.svg.appendChild(svgEl('polygon', { points: toView(kept), fill: 'rgba(34,197,94,.35)' }));
    // Extend the line across the whole shape so it is easy to see.
    const dx = p2.x - p1.x, dy = p2.y - p1.y, len = Math.hypot(dx, dy) || 1;
    const ext = Math.hypot(r.width, r.height) + 40;
    ui.svg.appendChild(svgEl('line', {
      x1: p1.x - (dx / len) * ext, y1: p1.y - (dy / len) * ext, x2: p1.x + (dx / len) * ext, y2: p1.y + (dy / len) * ext,
      stroke: '#fff', 'stroke-width': 2, 'stroke-dasharray': '6 4',
    }));
    const vertical = Math.abs(dx) < 0.5, horizontal = Math.abs(dy) < 0.5;
    let text = 'diagonal cut';
    if (vertical) text = `vertical cut at ${round(((p1.x - r.left) / r.width) * 100)}%`;
    else if (horizontal) text = `horizontal cut at ${round(((p1.y - r.top) / r.height) * 100)}%`;
    const tx = svgEl('text', { x: r.left, y: Math.max(14, r.top - 8), fill: '#fff', 'font-size': 12, 'font-weight': 600 });
    tx.textContent = `${text}. Green is kept, red goes.`;
    ui.svg.appendChild(tx);
  }

  function applyCut() {
    const c = pending, t = shapeEl;
    if (!c || !t) return;
    pending = null;
    const r = t.getBoundingClientRect();
    const cs = getComputedStyle(t);
    const dx = c.p2.x - c.p1.x, dy = c.p2.y - c.p1.y;
    const vertical = Math.abs(dx) < 0.5, horizontal = Math.abs(dy) < 0.5;
    const sgn = (q) => Math.sign(-dy * (q.x - c.p1.x) + dx * (q.y - c.p1.y));
    snapshot(t);
    const e = ensureEdit(t);
    e.shaped = true;

    if (!e.poly && (vertical || horizontal)) {
      // A straight cut is just a smaller box with different corner radii (a circle cut in
      // half becomes a half-width box rounded on one side), so no clip-path is needed.
      const R = radiiPx(cs, r); // TL, TR, BR, BL
      const next = R.slice();
      const borderBox = cs.boxSizing === 'border-box';
      const padW = px(cs.paddingLeft) + px(cs.paddingRight) + px(cs.borderLeftWidth) + px(cs.borderRightWidth);
      const padH = px(cs.paddingTop) + px(cs.paddingBottom) + px(cs.borderTopWidth) + px(cs.borderBottomWidth);
      let shiftX = 0, shiftY = 0;
      if (vertical) {
        const cut = c.p1.x - r.left;
        if (cut < 1 || cut > r.width - 1) return;
        const keepLeft = sgn({ x: r.left, y: c.p1.y }) === c.keep;
        const outer = keepLeft ? cut : r.width - cut;
        if (keepLeft) { next[1] = 0; next[2] = 0; } else { next[0] = 0; next[3] = 0; shiftX = cut; }
        setProp(t, 'width', Math.max(0, borderBox ? outer : outer - padW));
      } else {
        const cut = c.p1.y - r.top;
        if (cut < 1 || cut > r.height - 1) return;
        const keepTop = sgn({ x: c.p1.x, y: r.top }) === c.keep;
        const outer = keepTop ? cut : r.height - cut;
        if (keepTop) { next[2] = 0; next[3] = 0; } else { next[0] = 0; next[1] = 0; shiftY = cut; }
        setProp(t, 'height', Math.max(0, borderBox ? outer : outer - padH));
      }
      RADII.forEach((rp, i) => { e.touched.add(rp); t.style.setProperty(rp, `${next[i]}px`, 'important'); });
      // The box may have shrunk toward the wrong edge; put the kept half where it was.
      const r2 = t.getBoundingClientRect();
      e.tx += r.left + shiftX - r2.left;
      e.ty += r.top + shiftY - r2.top;
      applyTranslate(t, e);
    } else {
      const norm = (q) => ({ x: (q.x - r.left) / r.width, y: (q.y - r.top) / r.height });
      const poly = clipPoly(e.poly || CORNERS.map((q) => q.slice()), norm(c.p1), norm(c.p2), c.keep);
      if (poly.length < 3) return;
      e.poly = poly;
      const pc = (n) => `${Math.round(n * 1000) / 10}%`;
      e.touched.add('clip-path');
      t.style.setProperty('clip-path', `polygon(${poly.map(([x, y]) => `${pc(x)} ${pc(y)}`).join(', ')})`, 'important');
    }
    renderList();
  }

  /* ---------------- picking ---------------- */

  function pickAt(x, y) {
    const t = document.elementFromPoint(x, y);
    if (!t || inRoot(t) || t === document.documentElement || t === document.body) return null;
    return t;
  }

  function onMove(e) {
    if (!on || shapeEl || inRoot(e.target)) return;
    hoverEl = pickAt(e.clientX, e.clientY);
  }

  function onPointerDown(e) {
    if (!on || inRoot(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    if (shapeEl) return; // Shape mode keeps its element until you leave it
    const t = pickAt(e.clientX, e.clientY);
    if (t) { selEl = t; childStack = []; }
  }

  function swallow(e) {
    if (!on || inRoot(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function onKey(e) {
    if (!on) return;
    if (inRoot(e.target) && /^(INPUT|SELECT)$/.test(e.target.tagName)) {
      if (e.key === 'Escape' || e.key === 'Enter') e.target.blur();
      return; // typing in a style field
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); undo(); return; }
    if (mod) return; // let menu shortcuts (like toggling this mode) through
    if (shapeEl) { onShapeKey(e); return; }
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      if (ui.viewer) closeViewer();
      else if (selEl) selEl = null;
      else exit();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selEl) {
      deleteSelected();
    } else if (e.key === 'ArrowUp' && selEl?.parentElement && selEl.parentElement !== document.body && !inRoot(selEl.parentElement)) {
      childStack.push(selEl);
      selEl = selEl.parentElement;
    } else if (e.key === 'ArrowDown' && childStack.length) {
      selEl = childStack.pop();
    }
  }

  const BLOCKED = ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'auxclick', 'beforeinput', 'keypress', 'dragstart', 'selectstart'];

  /* ---------------- brief / send ---------------- */

  async function shoot(name) {
    root.classList.add('shooting');
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 80));
    try { return await bridge.capture(name); }
    finally { root.classList.remove('shooting'); }
  }

  async function makeBrief() {
    const changes = collectChanges();
    if (!changes.length) throw new Error('No changes to describe yet.');
    const after = await shoot('after');
    return bridge.brief({
      viewport: { w: window.innerWidth, h: window.innerHeight },
      shots: { before: beforeShot, after },
      changes,
    });
  }

  function closeViewer() {
    ui.viewer?.remove();
    ui.viewer = null;
  }

  async function viewBrief() {
    setStatus('Building brief…');
    try {
      const { path, markdown } = await makeBrief();
      setStatus(`Saved to ${path}`);
      closeViewer();
      const v = el('div', 'viewer hud');
      const head = el('div', 'head');
      head.append(el('span', null, 'Brief for the agent'));
      v.append(head, el('div', 'path', path));
      v.appendChild(el('pre', null, markdown));
      v.appendChild(button('Close', '', closeViewer));
      root.appendChild(v);
      ui.viewer = v;
    } catch (err) {
      setStatus(err.message);
    }
  }

  function sendClick() {
    if (!ui.sendBtn.dataset.confirm) {
      ui.sendBtn.dataset.confirm = '1';
      ui.sendBtn.textContent = 'Confirm: agent edits files';
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(resetSendBtn, 5000);
      return;
    }
    resetSendBtn();
    doSend();
  }

  function resetSendBtn() {
    clearTimeout(confirmTimer);
    if (!ui.sendBtn) return;
    delete ui.sendBtn.dataset.confirm;
    ui.sendBtn.textContent = 'Send to agent';
  }

  async function doSend(opts = {}) {
    ui.sendBtn.disabled = true;
    setStatus('Writing brief…');
    try {
      await makeBrief();
      setStatus('Agent is working. This can take a minute or two…');
      const res = await bridge.send(opts);
      if (!res.ok) {
        setStatus(`${res.error || 'The agent run failed.'}${res.dirty ? '\n' + res.dirty.join('\n') : ''}${res.output ? '\n' + res.output : ''}`);
      } else {
        setStatus(`${res.dry ? 'Dry run OK.\n' : 'Done.\n'}${res.output}${res.diffStat ? '\n\n' + res.diffStat : ''}`);
        if (!res.dry) {
          const reload = button('Reload to see changes', 'primary', () => location.reload());
          ui.status.appendChild(el('div'));
          ui.status.appendChild(reload);
        }
      }
    } catch (err) {
      setStatus(err.message);
    } finally {
      ui.sendBtn.disabled = false;
      renderList();
    }
  }

  /* ---------------- mode ---------------- */

  // `preShot` is a screenshot already in flight (the long press takes it early so
  // the overlay can appear exactly when the hold completes).
  async function enter(initial, preShot) {
    if (on) return;
    try { beforeShot = await (preShot || bridge.capture('before')); } catch { beforeShot = null; }
    collectRootVars();
    on = true;
    buildUI();
    if (initial && initial.isConnected) selEl = initial;
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKey, true);
    for (const t of BLOCKED) window.addEventListener(t, swallow, true);
    window.__studioDo = { doSend }; // test hook
    tick();
  }

  function exit() {
    if (!on) return;
    on = false;
    cancelAnimationFrame(raf);
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('keydown', onKey, true);
    for (const t of BLOCKED) window.removeEventListener(t, swallow, true);
    shapeEl = null; pending = null;
    root?.remove();
    root = null; ui = {}; selEl = null; hoverEl = null; lastSel = null;
  }

  /* ---------------- long press (4s) opens studio mode ---------------- */

  const HOLD_MS = 4000;
  const HINT_AFTER_MS = 1000;   // a dashed outline appears so you can tell it's working
  const MOVE_TOLERANCE = 8;     // px; moving more than this means it's a drag, not a hold
  let hold = null;

  function cancelHold() {
    if (!hold) return;
    clearTimeout(hold.timer);
    clearTimeout(hold.hintTimer);
    hold.ring?.remove();
    hold = null;
  }

  function startHold(e) {
    if (on || e.button !== 0 || (root && inRoot(e.target))) return;
    const target = e.target;
    if (!(target instanceof Element) || target === document.documentElement || target === document.body) return;
    cancelHold();
    hold = { x: e.clientX, y: e.clientY, target, ring: null };
    hold.hintTimer = setTimeout(() => {
      if (!hold || !target.isConnected) return;
      // Take the "before" screenshot now, while nothing of Studio is on screen yet.
      const mine = hold;
      mine.pre = bridge.capture('before').catch(() => null);
      mine.pre.then(() => { if (hold === mine) showRing(); });
    }, HINT_AFTER_MS);
    function showRing() {
      if (!hold || !target.isConnected) return;
      const ring = document.createElement('div');
      const r = target.getBoundingClientRect();
      ring.style.cssText = `position:fixed;z-index:2147483646;pointer-events:none;left:${r.left}px;top:${r.top}px;` +
        `width:${r.width}px;height:${r.height}px;outline:2px dashed ${INK};outline-offset:-1px;` +
        `background:rgba(255,45,138,.08);animation:__studioPulse ${HOLD_MS - HINT_AFTER_MS}ms ease-in forwards;`;
      if (!document.getElementById('__studioPulseStyle')) {
        const st = document.createElement('style');
        st.id = '__studioPulseStyle';
        st.textContent = '@keyframes __studioPulse{from{opacity:.25}to{opacity:1}}';
        document.head.appendChild(st);
      }
      document.body.appendChild(ring);
      hold.ring = ring;
    }
    hold.timer = setTimeout(() => {
      const t = hold && hold.target;
      const pre = hold && hold.pre;
      cancelHold();
      if (t && t.isConnected) enter(t, pre);
    }, HOLD_MS);
  }

  window.addEventListener('pointerdown', startHold, true);
  window.addEventListener('pointerup', cancelHold, true);
  window.addEventListener('pointercancel', cancelHold, true);
  window.addEventListener('pointermove', (e) => {
    if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > MOVE_TOLERANCE) cancelHold();
  }, true);

  bridge.onToggle(() => (on ? exit() : enter()));
})();
