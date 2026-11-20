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
  const TRACK = ['width', 'height', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-left-radius'];
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
  }

  const variableFor = (value) => (rootVars.find(([, v]) => v === value) || [])[0];

  /* ---------------- edits ---------------- */

  function ensureEdit(el) {
    let e = edits.get(el);
    if (!e) {
      const cs = getComputedStyle(el);
      const orig = {};
      for (const p of TRACK) orig[p] = cs.getPropertyValue(p);
      e = { inline: el.style.cssText, orig, touched: new Set(), boxSizing: cs.boxSizing };
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
    if (changed('border-top-left-radius')) {
      rows.push({ prop: 'border-radius', before: e.orig['border-top-left-radius'], after: now('border-top-left-radius') });
    }
    for (const r of rows) {
      const v = variableFor(r.after);
      if (v) r.variable = v;
    }
    return rows;
  }

  function activeEdits() {
    const list = [];
    for (const [el, e] of edits) {
      if (!el.isConnected) continue;
      const rows = diffFor(el, e);
      if (rows.length) list.push({ el, e, rows });
    }
    return list;
  }

  function collectChanges() {
    return activeEdits().map(({ el, e, rows }) => ({
      label: label(el),
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      classes: classesOf(el),
      ids: el.id ? [el.id] : [],
      sharedCount: sharedCount(el),
      boxSizing: e.boxSizing,
      props: rows,
    }));
  }

  function snapshot(el) {
    const e = edits.get(el);
    history.push({ el, css: el.style.cssText, touched: new Set(e ? e.touched : []), had: !!e });
  }

  function undo() {
    const h = history.pop();
    if (!h) return;
    h.el.style.cssText = h.css;
    const e = edits.get(h.el);
    if (!h.had) edits.delete(h.el);
    else if (e) e.touched = h.touched;
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
    ui.hint = el('div', 'hint', 'Click an element. Drag pink to resize, green for padding, orange for corners. ↑ selects the parent, Cmd+Z undoes, Esc exits.');
    ui.list = el('div', 'list');
    ui.btns = el('div', 'btns');
    ui.viewBtn = button('View brief', '', viewBrief);
    ui.sendBtn = button('Send to agent', 'primary', sendClick);
    ui.resetBtn = button('Reset all', '', () => { resetAll(); setStatus(''); });
    ui.doneBtn = button('Done', '', exit);
    ui.btns.append(ui.viewBtn, ui.sendBtn, ui.resetBtn, ui.doneBtn);
    ui.status = el('div', 'status');
    ui.panel.append(head, ui.hint, ui.list, ui.btns, ui.status);
    root.appendChild(ui.panel);
    document.body.appendChild(root);
    renderList();
  }

  function setStatus(text) { if (ui.status) ui.status.textContent = text; }

  function renderList() {
    if (!ui.list) return;
    ui.list.textContent = '';
    const list = activeEdits();
    if (!list.length) {
      ui.list.appendChild(el('div', 'hint', 'No changes yet.'));
    }
    for (const { el: target, rows } of list) {
      const item = el('div', 'item');
      const title = el('b', null, '');
      title.append(el('span', null, label(target)));
      const x = el('button', 'x', '×');
      x.title = 'Reset this element';
      x.addEventListener('click', () => resetElement(target));
      title.appendChild(x);
      item.appendChild(title);
      for (const r of rows) item.appendChild(el('span', 'r', `${r.prop}: ${r.before} → ${r.after}`));
      ui.list.appendChild(item);
    }
    const n = list.length;
    ui.viewBtn.disabled = ui.sendBtn.disabled = n === 0;
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
    if (hoverEl && hoverEl.isConnected && hoverEl !== selEl) {
      ui.hover.style.display = 'block';
      place(ui.hover, hoverEl.getBoundingClientRect());
    } else {
      ui.hover.style.display = 'none';
    }

    if (selEl && selEl.isConnected) {
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
      const rad = px(cs.borderTopLeftRadius);
      const k = Math.min(rad * 0.3 + 12, Math.min(r.width, r.height) / 2);
      set(H.r, k, k);
    } else {
      ui.sel.style.display = 'none';
    }

    // Outline every element that has recorded changes.
    const list = activeEdits();
    while (ui.changed.children.length > list.length) ui.changed.lastChild.remove();
    while (ui.changed.children.length < list.length) ui.changed.appendChild(el('div', 'box changed'));
    list.forEach(({ el: target }, i) => {
      const b = ui.changed.children[i];
      if (target === selEl) b.style.display = 'none';
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
      rad: px(cs.borderTopLeftRadius), border: cs.boxSizing === 'border-box',
    };
    const size = (outer, padSum, borderSum) => (start.border ? outer : outer - padSum - borderSum);

    const move = (e) => {
      const dx = e.clientX - x0, dy = e.clientY - y0;
      const clamp = (v) => Math.max(0, v);
      if (kind === 'e' || kind === 'se') setProp(target, 'width', clamp(size(start.w + dx, start.pl + start.pr, start.bx)));
      if (kind === 's' || kind === 'se') setProp(target, 'height', clamp(size(start.h + dy, start.pt + start.pb, start.by)));
      if (kind === 'pt') setProp(target, 'padding-top', clamp(start.pt + dy));
      if (kind === 'pb') setProp(target, 'padding-bottom', clamp(start.pb - dy));
      if (kind === 'pl') setProp(target, 'padding-left', clamp(start.pl + dx));
      if (kind === 'pr') setProp(target, 'padding-right', clamp(start.pr - dx));
      if (kind === 'r') {
        // One radius for all corners, like the app's phone-style rounding.
        const v = round(Math.min(clamp(start.rad + (dx + dy) / 2), Math.min(start.w, start.h) / 2));
        ensureEdit(target).touched.add('border-top-left-radius');
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

  /* ---------------- picking ---------------- */

  function pickAt(x, y) {
    const t = document.elementFromPoint(x, y);
    if (!t || inRoot(t) || t === document.documentElement || t === document.body) return null;
    return t;
  }

  function onMove(e) {
    if (!on || inRoot(e.target)) return;
    hoverEl = pickAt(e.clientX, e.clientY);
  }

  function onPointerDown(e) {
    if (!on || inRoot(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
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
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopPropagation(); undo(); return; }
    if (mod) return; // let menu shortcuts (like toggling this mode) through
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      if (ui.viewer) closeViewer();
      else if (selEl) selEl = null;
      else exit();
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
    root?.remove();
    root = null; ui = {}; selEl = null; hoverEl = null;
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
