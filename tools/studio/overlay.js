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
  let drawOn = false;      // Draw (sketch) mode
  let drawTool = 'pen', drawColor = '#ff2d8a', drawW = 4, drawFill = false;
  let eraserPos = null;
  let objs = [], dUndo = [], dRedo = [], selId = null, objSeq = 0, textInput = null;
  let busy = false;        // a drag is in progress
  let idSeq = 0;
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
    #__studio .dim { position: fixed; inset: 0; background: rgba(10,14,22,.6); pointer-events: none; opacity: 0; }
    #__studio .shapebox { outline: 2px dashed rgba(255,255,255,.7); outline-offset: 0; }
    #__studio .stage {
      position: fixed; overflow: hidden; pointer-events: none; border: 0 solid ${INK}; box-sizing: border-box;
      background-color: rgba(255,255,255,calc(var(--bg, 0) * 0.97));
      background-image: linear-gradient(45deg, rgba(128,128,128,.14) 25%, transparent 25%, transparent 75%, rgba(128,128,128,.14) 75%),
        linear-gradient(45deg, rgba(128,128,128,.14) 25%, transparent 25%, transparent 75%, rgba(128,128,128,.14) 75%);
      background-size: 20px 20px; background-position: 0 0, 10px 10px;
      box-shadow: 0 12px 40px rgba(0,0,0,.35);
    }
    @media (prefers-color-scheme: dark) { #__studio .stage { background-color: rgba(30,36,44,calc(var(--bg, 0) * 0.97)); } }
    #__studio .stage .mirror { position: absolute; transform-origin: 0 0; pointer-events: none; }
    #__studio .stage .ghost { position: absolute; outline: 1.5px dashed rgba(128,128,128,.8); pointer-events: none; }
    #__studio .handlelayer { position: fixed; inset: 0; pointer-events: none; }
    #__studio .handlelayer .c { position: absolute; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%; background: #f59e0b; border: 2px solid #fff; box-shadow: 0 1px 4px rgba(0,0,0,.4); pointer-events: auto; touch-action: none; }
    #__studio .shapelayer { position: fixed; inset: 0; }
    #__studio .shapelayer svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
    #__studio .cluster { position: fixed; width: 0; height: 0; pointer-events: none; }
    #__studio .cb {
      position: absolute; width: 32px; height: 32px; margin: -16px 0 0 -16px; padding: 0; border-radius: 50%;
      border: 2px solid ${INK}; background: #fff; color: ${INK}; font-size: 15px; font-weight: 700; line-height: 1;
      cursor: pointer; pointer-events: auto; box-shadow: 0 3px 10px rgba(0,0,0,.25);
      opacity: 0; transform: scale(.3); animation: __studioBloom .22s cubic-bezier(.2,1.4,.4,1) forwards;
    }
    @media (prefers-color-scheme: dark) { #__studio .cb { background: #151b22; } }
    #__studio .cb:hover { background: ${INK}; color: #fff; }
    #__studio .cb[disabled] { display: none; }
    #__studio .cb:hover::after {
      content: attr(data-label); position: absolute; left: 50%; bottom: 40px; transform: translateX(-50%);
      background: ${INK}; color: #fff; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap;
    }
    #__studio .cluster.below .cb:hover::after { bottom: auto; top: 40px; }
    @keyframes __studioBloom { to { opacity: 1; transform: scale(1); } }
    #__studio .shapebar { left: 50%; top: 18px; bottom: auto; transform: translateX(-50%); width: 520px; max-height: none; border-radius: 24px; padding: 10px 14px 12px; }
    #__studio .shapebar .btns { margin: 6px 0; }
    #__studio .shapebar .hint { margin: 4px 0 0; }
    #__studio .drawlayer { user-select: none; position: fixed; inset: 0; cursor: crosshair; touch-action: none; pointer-events: auto; }
    #__studio .drawlayer svg, #__studio .drawhud svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
    #__studio .drawhud { position: fixed; inset: 0; pointer-events: none; }
    #__studio .drawhud svg { pointer-events: none; }
    #__studio .drawhud .hd { pointer-events: all; cursor: move; }
    #__studio .drawbar { left: 50%; top: 18px; bottom: auto; transform: translateX(-50%); width: 540px; max-height: none; border-radius: 24px; padding: 8px 14px 10px; user-select: none; }
    #__studio .drawbar .btns { margin: 5px 0; align-items: center; }
    #__studio .drawbar button.b { height: 26px; padding: 0 10px; font-size: 11.5px; }
    #__studio .drawbar textarea {
      width: 100%; min-height: 34px; height: 34px; resize: vertical; user-select: text; border: 2px solid ${INK}; border-radius: 14px; background: transparent;
      color: inherit; padding: 6px 10px; font-size: 12px; margin-top: 4px;
    }
    #__studio .drawbar button.b.icon { width: 38px; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
    #__studio .drawbar button.b.icon svg { pointer-events: none; }
    #__studio .drawbar .sw { width: 20px; height: 20px; }
    #__studio .drawbar .sw.on { border-color: ${INK}; box-shadow: 0 0 0 2px #fff, 0 0 0 4px ${INK}; }
    #__studio .drawbar input[type=color] { width: 26px; height: 22px; padding: 0; border: 2px solid ${INK}; border-radius: 50%; background: none; cursor: pointer; }
    #__studio .drawbar select { height: 26px; border-radius: 999px; border: 2px solid ${INK}; background: transparent; color: inherit; font-size: 11.5px; padding: 0 6px; }
    #__studio .drawbar label { display: flex; align-items: center; gap: 4px; font-size: 11.5px; }
    #__studio .dtext { position: fixed; z-index: 3; min-width: 120px; font: 700 20px -apple-system, sans-serif; border: 2px dashed ${INK}; background: rgba(255,255,255,.85); color: #111; padding: 2px 6px; border-radius: 8px; outline: none; pointer-events: auto; }
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
    // A small fan of buttons that appears next to the selected element.
    ui.cluster = el('div', 'cluster hud');
    ui.clusterBtns = [
      ['↑', 'Select parent', () => { if (selEl?.parentElement && selEl.parentElement !== document.body && !inRoot(selEl.parentElement)) { childStack.push(selEl); selEl = selEl.parentElement; } }],
      ['◐', 'Shape', () => enterShape()],
      ['Aa', 'Style', () => toggleStylePanel()],
      ['⌫', 'Delete', () => deleteSelected()],
    ].map(([glyph, name, fn]) => {
      const b = el('button', 'cb', glyph);
      b.dataset.label = name;
      b.title = name;
      b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
      ui.cluster.appendChild(b);
      return b;
    });
    ui.changed = el('div', 'changedLayer');
    root.append(ui.hover, ui.changed, ui.sel, ui.cluster);

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
    ui.hint = el('div', 'hint', 'Click an element. Drag pink to resize (hold Shift to keep proportions), green for padding, orange for corners. Delete removes it. Style opens colors and borders, Shape cuts and reshapes, Draw (or D) lets you sketch what you want. ↑ selects the parent, Cmd+Z undoes, Esc exits.');
    ui.list = el('div', 'list');
    ui.btns = el('div', 'btns');
    ui.deleteBtn = button('Delete element', '', deleteSelected);
    ui.viewBtn = button('View brief', '', viewBrief);
    ui.sendBtn = button('Send to agent', 'primary', () => sendClick(ui.sendBtn));
    ui.resetBtn = button('Reset all', '', () => { resetAll(); setStatus(''); });
    ui.doneBtn = button('Done', '', exit);
    ui.styleBtn = button('Style ▸', '', () => toggleStylePanel());
    ui.shapeBtn = button('Shape', '', () => enterShape());
    ui.drawBtn = button('Draw', '', () => enterDraw());
    ui.btns.append(ui.deleteBtn, ui.styleBtn, ui.shapeBtn, ui.drawBtn, ui.viewBtn, ui.sendBtn, ui.resetBtn, ui.doneBtn);
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

  function setStatus(text) {
    if (ui.status) ui.status.textContent = text;
    if (ui.dStatus) ui.dStatus.textContent = text;
  }

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


  // Keep the button fan above the selected element (or below it when there is no room),
  // out of the way of the shape and its handles.
  function tickCluster() {
    const c = ui.cluster;
    const show = selEl && selEl.isConnected && !shapeEl && !drawOn && !busy && !ui.viewer;
    if (!show) { c.style.display = 'none'; c.dataset.for = ''; return; }
    const r = selEl.getBoundingClientRect();
    const R = 70, angles = [-50, -17, 17, 50];
    const above = r.top - 12 - R - 16 > 4;
    const cx = Math.max(76, Math.min(window.innerWidth - 76, r.left + r.width / 2));
    c.style.display = 'block';
    c.classList.toggle('below', !above);
    c.style.left = `${cx}px`;
    c.style.top = `${above ? r.top - 12 : r.bottom + 12}px`;
    ui.clusterBtns.forEach((b, i) => {
      const a = (angles[i] * Math.PI) / 180;
      b.style.left = `${R * Math.sin(a)}px`;
      b.style.top = `${above ? -R * Math.cos(a) : R * Math.cos(a)}px`;
      b.style.animationDelay = `${i * 35}ms`;
      if (i === 0) b.disabled = !(selEl.parentElement && selEl.parentElement !== document.body && !inRoot(selEl.parentElement));
    });
    // Replay the bloom when you select something new.
    if (c.dataset.for !== String(selEl.__studioId || (selEl.__studioId = ++idSeq))) {
      c.dataset.for = String(selEl.__studioId);
      ui.clusterBtns.forEach((b) => { b.style.animation = 'none'; void b.offsetWidth; b.style.animation = ''; });
    }
  }

  function tick() {
    if (!on) return;
    ui.deleteBtn.disabled = !selEl || !!shapeEl; // follows the selection
    ui.shapeBtn.disabled = !selEl || !!shapeEl || drawOn;
    ui.changed.style.display = drawOn ? 'none' : '';
    if (selEl !== lastSel) { lastSel = selEl; refreshStyle(); }
    placeStylePanel();
    if (hoverEl && hoverEl.isConnected && hoverEl !== selEl && !drawOn) {
      ui.hover.style.display = 'block';
      place(ui.hover, hoverEl.getBoundingClientRect());
    } else {
      ui.hover.style.display = 'none';
    }

    if (shapeEl) tickShape();
    tickCluster();
    if (selEl && selEl.isConnected && !shapeEl && !drawOn) {
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
    busy = true;
    const up = () => {
      busy = false;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }


  /* ---------------- shape mode ---------------- */
  // The shape stays where it is in the page. Shape mode opens a magnified view of it in a
  // box (it grows out of the shape), and every tool works through that view. When you
  // leave, the box shrinks back onto the shape.

  const HINTS = {
    corners: 'Drag a corner dot to round just that corner (hold Shift for all four). Arrow keys nudge the shape.',
    slice: 'Drag a line across the shape. It snaps to vertical, horizontal and the middle. Click a half to choose which half to keep, then Apply cut.',
    move: 'Drag to move the shape. Arrow keys nudge 1px (Shift: 10px).',
  };
  const CORNER_SIGNS = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
  const ANIM_MS = 260;
  let view = null;

  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => 1 - Math.pow(1 - t, 3);

  // Where the current animation frame puts things: scale, the stage position of the shape's
  // original top-left corner, and the frame rectangle.
  function viewNow() {
    const e = ease(view.t);
    return {
      e,
      k: lerp(1, view.k, e),
      S: { x: lerp(view.r0.left, view.S.x, e), y: lerp(view.r0.top, view.S.y, e) },
      frame: {
        left: lerp(view.r0.left, view.frame.left, e), top: lerp(view.r0.top, view.frame.top, e),
        width: lerp(view.r0.width, view.frame.width, e), height: lerp(view.r0.height, view.frame.height, e),
      },
    };
  }
  const toStage = (p, v = viewNow()) => ({ x: v.S.x + (p.x - view.r0.left) * v.k, y: v.S.y + (p.y - view.r0.top) * v.k });
  const fromStage = (x, y) => { const v = viewNow(); return { x: view.r0.left + (x - v.S.x) / v.k, y: view.r0.top + (y - v.S.y) / v.k }; };
  const stageReady = () => view && view.t >= 1 && view.target === 1;

  // A static copy of an element with all of its computed styles written inline, so it
  // looks the same outside its page context.
  function cloneStyled(src) {
    const dst = src.cloneNode(true);
    const srcs = [src, ...src.querySelectorAll('*')];
    const dsts = [dst, ...dst.querySelectorAll('*')];
    srcs.forEach((o, i) => {
      const c = dsts[i];
      const cs = getComputedStyle(o);
      let css = '';
      for (const name of cs) css += `${name}:${cs.getPropertyValue(name)};`;
      c.removeAttribute('id');
      c.removeAttribute('class');
      c.style.cssText = css + 'transition:none;animation:none;pointer-events:none;';
    });
    dst.style.cssText += 'position:absolute;left:0;top:0;right:auto;bottom:auto;margin:0;translate:none;transform:none;';
    return dst;
  }

  function enterShape() {
    if (!selEl || !selEl.isConnected || shapeEl) return;
    shapeEl = selEl;
    shapeTool = 'corners';
    pending = null;
    ui.sel.style.display = 'none';
    if (ui.cluster) ui.cluster.style.display = 'none';

    const r0 = shapeEl.getBoundingClientRect();
    const W = Math.min(620, window.innerWidth - 60);
    const H = Math.min(440, window.innerHeight - 200);
    const k = Math.max(1, Math.min((W - 110) / Math.max(1, r0.width), (H - 110) / Math.max(1, r0.height), 16));
    const frame = { left: (window.innerWidth - W) / 2, top: (window.innerHeight - H) / 2 + 50, width: W, height: H };
    const S = { x: frame.left + (W - r0.width * k) / 2, y: frame.top + (H - r0.height * k) / 2 };
    view = { r0, k, S, frame, t: 0, target: 1, last: performance.now(), sig: null };

    ui.dim = el('div', 'dim hud');
    ui.shape = el('div', 'box shapebox hud'); // marks where the shape lives in the page
    ui.stage = el('div', 'stage hud');
    ui.ghost = el('div', 'ghost');
    ui.stage.appendChild(ui.ghost);
    ui.mirror = null;
    ui.layer = el('div', 'shapelayer hud');
    ui.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ui.layer.appendChild(ui.svg);
    ui.layer.addEventListener('pointerdown', onLayerDown);
    ui.handles2 = el('div', 'handlelayer hud');
    ui.corners = CORNER_SIGNS.map((_, i) => {
      const c = el('div', 'c');
      c.style.cursor = i % 2 ? 'nesw-resize' : 'nwse-resize';
      c.addEventListener('pointerdown', (ev) => startCornerDrag(ev, i));
      ui.handles2.appendChild(c);
      return c;
    });
    for (const n of [ui.dim, ui.shape, ui.stage, ui.layer, ui.handles2]) root.insertBefore(n, ui.panel);

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
    if (!shapeEl || !view || view.target === 0) return;
    pending = null;
    view.target = 0; // shrink back onto the shape, then tickShape cleans up
    ui.layer.style.pointerEvents = 'none';
  }

  function finishShapeExit() {
    shapeEl = null; pending = null; view = null;
    for (const k of ['dim', 'shape', 'stage', 'layer', 'handles2', 'bar']) { ui[k]?.remove(); ui[k] = null; }
    ui.mirror = null;
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
    if (!shapeEl.isConnected) { finishShapeExit(); return; }
    const now = performance.now();
    const dt = now - view.last;
    view.last = now;
    view.t = Math.max(0, Math.min(1, view.t + ((view.target === 1 ? 1 : -1) * dt) / ANIM_MS));
    if (view.target === 0 && view.t <= 0) { finishShapeExit(); return; }
    const v = viewNow();
    const r = shapeEl.getBoundingClientRect();
    const cs = getComputedStyle(shapeEl);

    place(ui.shape, r);
    ui.dim.style.opacity = v.e;
    // The frame, growing from the shape to its full size.
    Object.assign(ui.stage.style, {
      left: `${v.frame.left}px`, top: `${v.frame.top}px`, width: `${v.frame.width}px`, height: `${v.frame.height}px`,
      borderWidth: `${(4 * v.e).toFixed(2)}px`, borderRadius: `${(28 * v.e).toFixed(1)}px`,
    });
    ui.stage.style.setProperty('--bg', v.e);

    // The magnified shape. Rebuilt whenever the shape's inline style (the edits) changes.
    const sig = shapeEl.getAttribute('style') || '';
    if (view.sig !== sig || !ui.mirror) {
      view.sig = sig;
      ui.mirror?.remove();
      ui.mirror = el('div', 'mirror');
      ui.mirror.appendChild(cloneStyled(shapeEl));
      ui.stage.appendChild(ui.mirror);
    }
    const pos = toStage({ x: r.left, y: r.top }, v);
    Object.assign(ui.mirror.style, {
      left: `${pos.x - v.frame.left - 4 * v.e}px`, top: `${pos.y - v.frame.top - 4 * v.e}px`,
      transform: `scale(${v.k})`,
    });
    // Dashed outline of where the shape started.
    const g = toStage({ x: view.r0.left, y: view.r0.top }, v);
    Object.assign(ui.ghost.style, {
      left: `${g.x - v.frame.left - 4 * v.e}px`, top: `${g.y - v.frame.top - 4 * v.e}px`,
      width: `${view.r0.width * v.k}px`, height: `${view.r0.height * v.k}px`,
    });

    // Corner dots on the magnified shape.
    const R = radiiPx(cs, r);
    const ready = stageReady();
    const corner = [[r.left, r.top], [r.right, r.top], [r.right, r.bottom], [r.left, r.bottom]];
    ui.corners.forEach((c, i) => {
      const p = toStage({ x: corner[i][0], y: corner[i][1] }, v);
      const [sx, sy] = CORNER_SIGNS[i];
      const d = Math.min(R[i] * v.k * 0.29 + 16, (Math.min(r.width, r.height) * v.k) / 2);
      c.style.left = `${p.x + sx * d}px`;
      c.style.top = `${p.y + sy * d}px`;
      c.style.display = shapeTool === 'corners' && ready ? 'block' : 'none';
    });
    ui.applyBtn.style.display = ui.cancelCutBtn.style.display = pending ? '' : 'none';
    drawCut(r);
  }

  /* corner dragging: one corner at a time (Shift = all four) */
  function startCornerDrag(ev, i) {
    if (!stageReady()) return;
    ev.preventDefault();
    ev.stopPropagation();
    const t = shapeEl;
    snapshot(t);
    const e = ensureEdit(t);
    e.shaped = true;
    busy = true;
    const h = ev.currentTarget;
    h.setPointerCapture(ev.pointerId);
    const x0 = ev.clientX, y0 = ev.clientY;
    const rect = t.getBoundingClientRect();
    const R0 = radiiPx(getComputedStyle(t), rect);
    const [sx, sy] = CORNER_SIGNS[i];
    const k = view.k;
    const move = (m) => {
      // The dot sits 0.29 of a radius (in magnified pixels) in from the corner, so the
      // radius follows the cursor one to one.
      const delta = ((m.clientX - x0) * sx + (m.clientY - y0) * sy) / 2 / (0.29 * k);
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
    const up = () => { busy = false; h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up); };
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
    if (!stageReady()) return;
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

  /* layer: move tool drags the shape, slice tool draws a cut line. Pointer positions are
     on the magnified view; everything is converted back to real page pixels. */
  function onLayerDown(ev) {
    if (!stageReady()) return;
    ev.preventDefault();
    ev.stopPropagation();
    const t = shapeEl;
    const k = view.k;
    const x0 = ev.clientX, y0 = ev.clientY;
    ui.layer.setPointerCapture(ev.pointerId);
    let move, up;
    if (shapeTool === 'move') {
      snapshot(t);
      const e = ensureEdit(t);
      const tx = e.tx, ty = e.ty;
      move = (m) => {
        let dx = (m.clientX - x0) / k, dy = (m.clientY - y0) / k;
        if (m.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        e.tx = tx + dx; e.ty = ty + dy;
        applyTranslate(t, e);
        renderList();
      };
      up = () => finish();
    } else {
      const r = t.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const start = fromStage(x0, y0);
      const snap = 6 / k;
      let drawing = null;
      move = (m) => {
        if (!drawing && Math.hypot(m.clientX - x0, m.clientY - y0) < 5) return;
        const p1 = { ...start }, p2 = fromStage(m.clientX, m.clientY);
        const dx = p2.x - p1.x, dy = p2.y - p1.y;
        const ang = (Math.atan2(Math.abs(dx), Math.abs(dy)) * 180) / Math.PI; // 0 = vertical
        if (ang < 4) { p2.x = p1.x; if (Math.abs(p1.x - cx) < snap) p1.x = p2.x = cx; }
        else if (ang > 86) { p2.y = p1.y; if (Math.abs(p1.y - cy) < snap) p1.y = p2.y = cy; }
        drawing = { p1, p2, keep: pending ? pending.keep : 1 };
        pending = drawing;
      };
      up = (u) => {
        if (!drawing && pending) {
          // A plain click: pick which half to keep.
          const { p1, p2 } = pending;
          const q = fromStage(u.clientX, u.clientY);
          const sgn = Math.sign(-(p2.y - p1.y) * (q.x - p1.x) + (p2.x - p1.x) * (q.y - p1.y));
          if (sgn) pending.keep = sgn;
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
    if (!pending || !view) return;
    const v = viewNow();
    const { p1, p2, keep } = pending;
    const norm = (q) => ({ x: (q.x - r.left) / r.width, y: (q.y - r.top) / r.height });
    const a = norm(p1), b = norm(p2);
    const box = CORNERS.map((c) => [c[0], c[1]]);
    const toView = (poly) => poly
      .map(([x, y]) => { const q = toStage({ x: r.left + x * r.width, y: r.top + y * r.height }, v); return `${q.x},${q.y}`; })
      .join(' ');
    const kept = clipPoly(box, a, b, keep), gone = clipPoly(box, a, b, -keep);
    if (gone.length > 2) ui.svg.appendChild(svgEl('polygon', { points: toView(gone), fill: 'rgba(239,68,68,.45)' }));
    if (kept.length > 2) ui.svg.appendChild(svgEl('polygon', { points: toView(kept), fill: 'rgba(34,197,94,.35)' }));
    // Extend the line across the whole frame so it is easy to see.
    const s1 = toStage(p1, v), s2 = toStage(p2, v);
    const dx = s2.x - s1.x, dy = s2.y - s1.y, len = Math.hypot(dx, dy) || 1;
    const ext = Math.hypot(v.frame.width, v.frame.height);
    ui.svg.appendChild(svgEl('line', {
      x1: s1.x - (dx / len) * ext, y1: s1.y - (dy / len) * ext, x2: s1.x + (dx / len) * ext, y2: s1.y + (dy / len) * ext,
      stroke: INK, 'stroke-width': 2, 'stroke-dasharray': '6 4',
    }));
    const rx = p2.x - p1.x, ry = p2.y - p1.y;
    let text = 'diagonal cut';
    if (Math.abs(rx) < 0.5) text = `vertical cut at ${round(((p1.x - r.left) / r.width) * 100)}%`;
    else if (Math.abs(ry) < 0.5) text = `horizontal cut at ${round(((p1.y - r.top) / r.height) * 100)}%`;
    const tx = svgEl('text', { x: v.frame.left + 16, y: v.frame.top + 24, fill: INK, 'font-size': 12, 'font-weight': 700 });
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

  /* ---------------- draw (sketch) mode ---------------- */
  // Sketch straight onto the running UI. The annotated screenshot, plus a list of which
  // elements each mark sits on, goes to the agent.

  const PALETTE = ['#ff2d8a', '#ef4444', '#f59e0b', '#facc15', '#22c55e', '#3b82f6', '#111827', '#ffffff'];
  const ICON = (inner) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
  const TOOLS = [
    ['pen', 'Pen (freehand, smoothed)', ICON('<path d="M3 17c3-9 6-9 8-3s5 5 10-8"/>')],
    ['line', 'Line', ICON('<path d="M5 19L19 5"/>')],
    ['curve', 'Curve (drag, then bend with the dot)', ICON('<path d="M4 19C5 9 13 4 20 6"/>')],
    ['arrow', 'Arrow', ICON('<path d="M5 19L19 5M10 5h9v9"/>')],
    ['rect', 'Box', ICON('<rect x="4" y="6" width="16" height="12"/>')],
    ['ellipse', 'Oval', ICON('<ellipse cx="12" cy="12" rx="9" ry="6"/>')],
    ['text', 'Text', ICON('<path d="M6 6h12M12 6v13"/>')],
    ['eraser', 'Eraser (rubs out freehand strokes; removes other marks you touch)', ICON('<path d="M4 15l8-9 8 7-5 6H9z"/><path d="M9 20h11"/>')],
    ['select', 'Select (move, bend, recolor, delete)', ICON('<path d="M6 4l12 7-5 1.5L11 18z"/>')],
  ];
  const SVGNS = 'http://www.w3.org/2000/svg';
  const mk = (name, attrs = {}) => {
    const n = document.createElementNS(SVGNS, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const selObj = () => objs.find((o) => o.id === selId) || null;
  const clone = (o) => JSON.parse(JSON.stringify(o));

  function pushUndo() {
    dUndo.push(JSON.stringify(objs));
    if (dUndo.length > 100) dUndo.shift();
    dRedo = [];
  }
  function drawUndo() {
    if (!dUndo.length) return;
    dRedo.push(JSON.stringify(objs));
    objs = JSON.parse(dUndo.pop());
    syncDraw();
  }
  function drawRedo() {
    if (!dRedo.length) return;
    dUndo.push(JSON.stringify(objs));
    objs = JSON.parse(dRedo.pop());
    syncDraw();
  }

  // Lines and arrows can bend: (cx, cy) is how far the curve's control point sits from the
  // middle of the straight chord. It travels with the ends, so moving or resizing keeps the arc.
  const chordMid = (o) => ({ x: (o.x1 + o.x2) / 2, y: (o.y1 + o.y2) / 2 });
  const curved = (o) => (o.type === 'line' || o.type === 'arrow') && Math.hypot(o.cx || 0, o.cy || 0) > 2;
  const ctrlPt = (o) => { const m = chordMid(o); return { x: m.x + (o.cx || 0), y: m.y + (o.cy || 0) }; };
  const curvePt = (o, t) => {
    const c = ctrlPt(o), a = 1 - t;
    return { x: a * a * o.x1 + 2 * a * t * c.x + t * t * o.x2, y: a * a * o.y1 + 2 * a * t * c.y + t * t * o.y2 };
  };

  // Light smoothing of hand-drawn points (two passes of a 1-2-1 average, ends fixed).
  function smoothPts(pts) {
    let q = pts;
    for (let k = 0; k < 2 && q.length > 3; k++) {
      const prev = q;
      q = prev.map((pt, i) => (i === 0 || i === prev.length - 1 ? pt
        : [(prev[i - 1][0] + 2 * pt[0] + prev[i + 1][0]) / 4, (prev[i - 1][1] + 2 * pt[1] + prev[i + 1][1]) / 4]));
    }
    return q;
  }

  // A smooth path through the points: quadratic curves between midpoints, so there are no corners.
  function penPath(pts) {
    if (pts.length === 1) return `M${pts[0][0]} ${pts[0][1]} L${pts[0][0] + 0.1} ${pts[0][1]}`;
    if (pts.length === 2) return `M${pts[0][0]} ${pts[0][1]} L${pts[1][0]} ${pts[1][1]}`;
    let d = `M${pts[0][0]} ${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      d += ` Q${pts[i][0]} ${pts[i][1]} ${(pts[i][0] + pts[i + 1][0]) / 2} ${(pts[i][1] + pts[i + 1][1]) / 2}`;
    }
    const l = pts[pts.length - 1];
    return d + ` L${l[0]} ${l[1]}`;
  }

  function bboxOf(o) {
    if (o.type === 'pen') {
      const xs = o.pts.map((q) => q[0]), ys = o.pts.map((q) => q[1]);
      return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) };
    }
    if (o.type === 'text') return { x1: o.x, y1: o.y - o.size, x2: o.x + Math.max(20, o.text.length * o.size * 0.58), y2: o.y + o.size * 0.3 };
    if (curved(o)) {
      const q = Array.from({ length: 21 }, (_, i) => curvePt(o, i / 20));
      return { x1: Math.min(...q.map((a) => a.x)), y1: Math.min(...q.map((a) => a.y)), x2: Math.max(...q.map((a) => a.x)), y2: Math.max(...q.map((a) => a.y)) };
    }
    return { x1: Math.min(o.x1, o.x2), y1: Math.min(o.y1, o.y2), x2: Math.max(o.x1, o.x2), y2: Math.max(o.y1, o.y2) };
  }

  function nodeFor(o) {
    const line = { stroke: o.color, 'stroke-width': o.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', fill: 'none' };
    const fill = o.fill ? { fill: o.color, 'fill-opacity': 0.22 } : {};
    if (o.type === 'pen') return mk('path', { ...line, d: penPath(o.pts) });
    const body = () => {
      if (!curved(o)) return mk('line', { ...line, x1: o.x1, y1: o.y1, x2: o.x2, y2: o.y2 });
      const c = ctrlPt(o);
      return mk('path', { ...line, d: `M${o.x1} ${o.y1} Q${c.x} ${c.y} ${o.x2} ${o.y2}` });
    };
    if (o.type === 'line') return body();
    if (o.type === 'arrow') {
      const g = mk('g');
      g.appendChild(body());
      const from = curved(o) ? ctrlPt(o) : { x: o.x1, y: o.y1 };
      const th = Math.atan2(o.y2 - from.y, o.x2 - from.x), L = 10 + o.width * 2.5;
      const pt = (d) => `${o.x2 - L * Math.cos(th + d)} ${o.y2 - L * Math.sin(th + d)}`;
      g.appendChild(mk('path', { ...line, d: `M${pt(0.45)} L${o.x2} ${o.y2} L${pt(-0.45)}` }));
      return g;
    }
    if (o.type === 'rect') {
      const b = bboxOf(o);
      return mk('rect', { ...line, ...fill, x: b.x1, y: b.y1, width: b.x2 - b.x1, height: b.y2 - b.y1, rx: 0 });
    }
    if (o.type === 'ellipse') {
      const b = bboxOf(o);
      return mk('ellipse', { ...line, ...fill, cx: (b.x1 + b.x2) / 2, cy: (b.y1 + b.y2) / 2, rx: (b.x2 - b.x1) / 2, ry: (b.y2 - b.y1) / 2 });
    }
    const t = mk('text', {
      x: o.x, y: o.y, fill: o.color, 'font-size': o.size, 'font-weight': 700, 'font-family': '-apple-system, Helvetica, sans-serif',
      stroke: '#fff', 'stroke-width': 4, 'paint-order': 'stroke', 'stroke-linejoin': 'round',
    });
    t.textContent = o.text;
    return t;
  }

  const hasEnds = (o) => ['line', 'arrow', 'rect', 'ellipse'].includes(o.type);

  function renderDraw() {
    if (!ui.dsvg) return;
    ui.dsvg.textContent = '';
    for (const o of objs) ui.dsvg.appendChild(nodeFor(o));
    ui.dhud.textContent = '';
    if (drawTool === 'eraser' && eraserPos) {
      ui.dhud.appendChild(mk('circle', { cx: eraserPos.x, cy: eraserPos.y, r: eraserR(), fill: 'rgba(255,255,255,.35)', stroke: INK, 'stroke-width': 1.5 }));
    }
    const o = selObj();
    if (!o) return;
    const b = bboxOf(o), pad = 6;
    ui.dhud.appendChild(mk('rect', { x: b.x1 - pad, y: b.y1 - pad, width: b.x2 - b.x1 + 2 * pad, height: b.y2 - b.y1 + 2 * pad, fill: 'none', stroke: INK, 'stroke-width': 1.5, 'stroke-dasharray': '5 3' }));
    if (hasEnds(o)) {
      for (const [k, x, y] of [['p1', o.x1, o.y1], ['p2', o.x2, o.y2]]) {
        const h = mk('circle', { cx: x, cy: y, r: 7, fill: '#f59e0b', stroke: '#fff', 'stroke-width': 2, class: 'hd' });
        h.addEventListener('pointerdown', (ev) => startEndDrag(ev, k));
        ui.dhud.appendChild(h);
      }
      if (o.type === 'line' || o.type === 'arrow') {
        // The dot on the middle of the curve: drag it to bend (or straighten) the line.
        const m = curved(o) ? curvePt(o, 0.5) : chordMid(o);
        const h = mk('circle', { cx: m.x, cy: m.y, r: 7, fill: '#22c55e', stroke: '#fff', 'stroke-width': 2, class: 'hd' });
        h.addEventListener('pointerdown', (ev) => startBendDrag(ev));
        ui.dhud.appendChild(h);
      }
    }
  }

  function syncDraw() {
    if (!drawOn) return;
    renderDraw();
    const has = objs.length > 0 || (ui.notes && ui.notes.value.trim());
    ui.dView.disabled = ui.dSend.disabled = !has;
    ui.dDelete.disabled = !(selObj());
    for (const [id, b] of Object.entries(ui.dTools)) b.classList.toggle('primary', id === drawTool);
    ui.dSwatches.forEach((sw) => sw.classList.toggle('on', sw.dataset.c === drawColor.toLowerCase()));
    ui.dColor.value = /^#[0-9a-f]{6}$/i.test(drawColor) ? drawColor : '#ff2d8a';
    ui.dWidth.value = String(drawW);
    ui.dFill.checked = drawFill;
    ui.dLayer.style.cursor = drawTool === 'select' ? 'default' : drawTool === 'text' ? 'text' : drawTool === 'eraser' ? 'none' : 'crosshair';
  }

  function enterDraw() {
    if (drawOn || shapeEl) return;
    drawOn = true;
    selEl = null; hoverEl = null;
    ui.sel.style.display = 'none';
    ui.dLayer = el('div', 'drawlayer');
    ui.dsvg = mk('svg');
    ui.dLayer.appendChild(ui.dsvg);
    ui.dLayer.addEventListener('pointerdown', onDrawDown);
    ui.dLayer.addEventListener('pointermove', (e) => { if (drawTool === 'eraser') { eraserPos = { x: e.clientX, y: e.clientY }; renderDraw(); } });
    ui.dLayer.addEventListener('pointerleave', () => { eraserPos = null; renderDraw(); });
    ui.dhud = null;
    const hud = el('div', 'drawhud hud');
    ui.dhudWrap = hud;
    const hsvg = mk('svg');
    hud.appendChild(hsvg);
    ui.dhud = hsvg;
    root.insertBefore(ui.dLayer, ui.panel);
    root.insertBefore(hud, ui.panel);

    const bar = el('div', 'panel drawbar hud');
    ui.dBar = bar;
    const head = el('div', 'head');
    head.append(el('span', null, 'Sketch'), el('span', null, 'drag to move'));
    head.style.cursor = 'grab';
    head.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      const r = bar.getBoundingClientRect();
      const dx = ev.clientX - r.left, dy = ev.clientY - r.top;
      bar.style.transform = 'none';
      const move = (e) => { bar.style.left = `${Math.max(0, e.clientX - dx)}px`; bar.style.top = `${Math.max(0, e.clientY - dy)}px`; };
      const up = () => { window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', up, true); };
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', up, true);
    });
    const tools = el('div', 'btns');
    ui.dTools = {};
    for (const [id, title, icon] of TOOLS) {
      const b = el('button', 'b icon');
      b.innerHTML = icon;
      b.title = title;
      b.dataset.tool = id;
      b.addEventListener('click', () => { commitText(); drawTool = id; selId = null; syncDraw(); });
      ui.dTools[id] = b;
      tools.appendChild(b);
    }
    const opts = el('div', 'btns');
    ui.dSwatches = PALETTE.map((c) => {
      const b = el('button', 'sw');
      b.dataset.c = c;
      b.style.background = c;
      b.title = c;
      b.addEventListener('click', () => setDrawProp('color', c));
      opts.appendChild(b);
      return b;
    });
    ui.dColor = document.createElement('input');
    ui.dColor.type = 'color';
    ui.dColor.title = 'Any color';
    ui.dColor.addEventListener('input', () => setDrawProp('color', ui.dColor.value));
    ui.dWidth = document.createElement('select');
    for (const [v, t] of [[2, 'Thin'], [4, 'Medium'], [8, 'Thick']]) { const o = document.createElement('option'); o.value = v; o.textContent = t; ui.dWidth.appendChild(o); }
    ui.dWidth.addEventListener('change', () => setDrawProp('width', +ui.dWidth.value));
    const fl = el('label');
    ui.dFill = document.createElement('input');
    ui.dFill.type = 'checkbox';
    ui.dFill.addEventListener('change', () => setDrawProp('fill', ui.dFill.checked));
    fl.append(ui.dFill, document.createTextNode('Fill'));
    opts.append(ui.dColor, ui.dWidth, fl);

    ui.notes = document.createElement('textarea');
    ui.notes.placeholder = 'Tell the agent what you want (optional, but it helps). Sketch with the tools above; Select moves, recolors and deletes.';
    ui.notes.addEventListener('input', syncDraw);

    const acts = el('div', 'btns');
    ui.dUndo = button('Undo', '', drawUndo);
    ui.dDelete = button('Delete', '', deleteObj);
    ui.dView = button('View brief', '', viewBrief);
    ui.dSend = button('Send to agent', 'primary', () => sendClick(ui.dSend));
    acts.append(ui.dUndo, ui.dDelete, button('Clear', '', clearDraw), ui.dView, ui.dSend, button('Done', '', exitDraw));
    ui.dStatus = el('div', 'status');
    bar.append(head, tools, opts, ui.notes, acts, ui.dStatus);
    root.appendChild(bar);
    renderList();
    syncDraw();
  }

  function exitDraw() {
    if (!drawOn) return;
    commitText();
    drawOn = false;
    selId = null;
    for (const k of ['dLayer', 'dhudWrap', 'dBar']) { ui[k]?.remove(); ui[k] = null; }
    ui.dsvg = ui.dhud = ui.dStatus = null;
    renderList();
  }

  function clearDraw() {
    if (!objs.length) return;
    pushUndo();
    objs = [];
    selId = null;
    syncDraw();
  }

  function deleteObj() {
    const o = selObj();
    if (!o) return;
    pushUndo();
    objs = objs.filter((x) => x.id !== o.id);
    selId = null;
    syncDraw();
  }

  // Colour/width/fill: sets the default for new marks, and edits the selected mark in Select mode.
  function setDrawProp(prop, value) {
    const o = drawTool === 'select' ? selObj() : null;
    if (o) { pushUndo(); o[prop] = value; }
    if (prop === 'color') drawColor = value;
    if (prop === 'width') drawW = value;
    if (prop === 'fill') drawFill = value;
    syncDraw();
  }

  function onDrawKey(e) {
    if (e.key === 'Escape') {
      if (textInput) cancelText();
      else if (selId) { selId = null; syncDraw(); }
      else exitDraw();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selObj()) deleteObj();
    else if (selObj() && /^Arrow/.test(e.key)) {
      const step = e.shiftKey ? 10 : 1, o = selObj();
      pushUndo();
      moveObj(o, e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
      syncDraw();
    }
  }

  function moveObj(o, dx, dy) {
    if (o.type === 'pen') o.pts = o.pts.map(([x, y]) => [x + dx, y + dy]);
    else if (o.type === 'text') { o.x += dx; o.y += dy; }
    else { o.x1 += dx; o.x2 += dx; o.y1 += dy; o.y2 += dy; }
  }

  function distSeg(px_, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((px_ - x1) * dx + (py - y1) * dy) / l2)) : 0;
    return Math.hypot(px_ - (x1 + t * dx), py - (y1 + t * dy));
  }

  function hitTest(x, y) {
    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i], b = bboxOf(o), tol = 8 + o.width / 2;
      const inside = x >= b.x1 - tol && x <= b.x2 + tol && y >= b.y1 - tol && y <= b.y2 + tol;
      if (!inside) continue;
      if (o.type === 'line' || o.type === 'arrow') {
        if (curved(o)) {
          const q = Array.from({ length: 25 }, (_, j) => curvePt(o, j / 24));
          if (q.some((a, j) => distSeg(x, y, a.x, a.y, (q[j + 1] || a).x, (q[j + 1] || a).y) <= tol)) return o;
        } else if (distSeg(x, y, o.x1, o.y1, o.x2, o.y2) <= tol) return o;
      }
      else if (o.type === 'pen') { if (o.pts.some((q, j) => distSeg(x, y, q[0], q[1], (o.pts[j + 1] || q)[0], (o.pts[j + 1] || q)[1]) <= tol)) return o; }
      else if ((o.type === 'rect' || o.type === 'ellipse') && !o.fill) {
        // An unfilled box is only grabbed by its outline.
        const nearEdge = Math.min(Math.abs(x - b.x1), Math.abs(x - b.x2), Math.abs(y - b.y1), Math.abs(y - b.y2)) <= tol;
        if (nearEdge) return o;
      } else return o;
    }
    return null;
  }

  // Shift keeps shapes square/round and lines at 45° steps.
  function constrain(o, shift) {
    if (!shift) return;
    const dx = o.x2 - o.x1, dy = o.y2 - o.y1;
    if (o.type === 'rect' || o.type === 'ellipse') {
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      o.x2 = o.x1 + Math.sign(dx || 1) * m; o.y2 = o.y1 + Math.sign(dy || 1) * m;
    } else {
      const len = Math.hypot(dx, dy), a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      o.x2 = o.x1 + Math.cos(a) * len; o.y2 = o.y1 + Math.sin(a) * len;
    }
  }

  function startEndDrag(ev, which) {
    const o = selObj();
    if (!o) return;
    ev.preventDefault(); ev.stopPropagation();
    pushUndo();
    const h = ev.currentTarget;
    h.setPointerCapture(ev.pointerId);
    const move = (m) => {
      if (which === 'p1') { o.x1 = m.clientX; o.y1 = m.clientY; } else { o.x2 = m.clientX; o.y2 = m.clientY; }
      if (m.shiftKey) {
        // Constrain relative to the other end.
        const t = which === 'p1' ? { ...o, x1: o.x2, y1: o.y2, x2: o.x1, y2: o.y1 } : o;
        constrain(t, true);
        if (which === 'p1') { o.x1 = t.x2; o.y1 = t.y2; }
      }
      renderDraw();
    };
    const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); syncDraw(); };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
  }

  const eraserR = () => 6 + drawW * 3;

  // Rub out part of a freehand stroke (splitting it), or remove any other mark you touch.
  function eraseAt(x, y) {
    const r = eraserR();
    const next = [];
    let changed = false;
    for (const o of objs) {
      if (o.type === 'pen') {
        const runs = [];
        let run = [];
        for (const q of o.pts) {
          if (Math.hypot(q[0] - x, q[1] - y) <= r) { if (run.length) runs.push(run); run = []; }
          else run.push(q);
        }
        if (run.length) runs.push(run);
        if (runs.length === 1 && runs[0].length === o.pts.length) { next.push(o); continue; }
        changed = true;
        for (const part of runs) if (part.length >= 2) next.push({ ...o, id: ++objSeq, pts: part });
      } else if (o.type === 'text' || hitNear(o, x, y, r)) {
        if (o.type === 'text') { const b = bboxOf(o); if (!(x >= b.x1 - r && x <= b.x2 + r && y >= b.y1 - r && y <= b.y2 + r)) { next.push(o); continue; } }
        changed = true;
      } else next.push(o);
    }
    if (changed) { objs = next; selId = null; }
    return changed;
  }

  // Is point (x, y) within `r` of this mark's drawn stroke (or inside it, if filled)?
  function hitNear(o, x, y, r) {
    if (o.type === 'line' || o.type === 'arrow') {
      if (curved(o)) {
        const q = Array.from({ length: 25 }, (_, j) => curvePt(o, j / 24));
        return q.some((a, j) => distSeg(x, y, a.x, a.y, (q[j + 1] || a).x, (q[j + 1] || a).y) <= r);
      }
      return distSeg(x, y, o.x1, o.y1, o.x2, o.y2) <= r;
    }
    const b = bboxOf(o);
    if (o.type === 'rect') {
      if (o.fill && x >= b.x1 && x <= b.x2 && y >= b.y1 && y <= b.y2) return true;
      const inside = x >= b.x1 - r && x <= b.x2 + r && y >= b.y1 - r && y <= b.y2 + r;
      return inside && Math.min(Math.abs(x - b.x1), Math.abs(x - b.x2), Math.abs(y - b.y1), Math.abs(y - b.y2)) <= r;
    }
    if (o.type === 'ellipse') {
      const rx = (b.x2 - b.x1) / 2 || 1, ry = (b.y2 - b.y1) / 2 || 1;
      const nx = (x - (b.x1 + b.x2) / 2) / rx, ny = (y - (b.y1 + b.y2) / 2) / ry;
      const d = Math.hypot(nx, ny);
      if (o.fill && d <= 1) return true;
      return Math.abs(d - 1) * Math.min(rx, ry) <= r;
    }
    return false;
  }

  function startBendDrag(ev) {
    const o = selObj();
    if (!o) return;
    ev.preventDefault(); ev.stopPropagation();
    pushUndo();
    const h = ev.currentTarget;
    h.setPointerCapture(ev.pointerId);
    const move = (m) => {
      const mid = chordMid(o);
      // The dot sits on the curve's middle, which is halfway to the control point.
      o.cx = 2 * (m.clientX - mid.x);
      o.cy = 2 * (m.clientY - mid.y);
      if (Math.hypot(o.cx, o.cy) < 6) { o.cx = 0; o.cy = 0; } // snaps back to straight
      renderDraw();
    };
    const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); syncDraw(); };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', up);
  }

  function onDrawDown(ev) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    commitText();
    const x0 = ev.clientX, y0 = ev.clientY;
    const layer = ui.dLayer;
    layer.setPointerCapture(ev.pointerId);
    let move, up;
    if (drawTool === 'select') {
      const o = hitTest(x0, y0);
      selId = o ? o.id : null;
      if (o) { drawColor = o.color || drawColor; drawW = o.width || drawW; drawFill = !!o.fill; }
      syncDraw();
      if (!o) return;
      pushUndo();
      let lx = x0, ly = y0;
      move = (m) => { moveObj(o, m.clientX - lx, m.clientY - ly); lx = m.clientX; ly = m.clientY; renderDraw(); };
      up = () => finish();
    } else if (drawTool === 'text') {
      startText(x0, y0);
      return;
    } else if (drawTool === 'eraser') {
      selId = null;
      pushUndo();
      let any = eraseAt(x0, y0);
      renderDraw();
      let last = { x: x0, y: y0 };
      move = (m) => {
        // Erase along the whole path, not just at each mouse sample, so quick strokes leave no gaps.
        const dist = Math.hypot(m.clientX - last.x, m.clientY - last.y);
        const steps = Math.max(1, Math.ceil(dist / (eraserR() / 2)));
        for (let i = 1; i <= steps; i++) {
          if (eraseAt(last.x + ((m.clientX - last.x) * i) / steps, last.y + ((m.clientY - last.y) * i) / steps)) any = true;
        }
        last = { x: m.clientX, y: m.clientY };
        eraserPos = { x: m.clientX, y: m.clientY };
        renderDraw();
      };
      up = () => { if (!any) dUndo.pop(); finish(); };
    } else {
      selId = null;
      pushUndo();
      const o = drawTool === 'pen'
        ? { id: ++objSeq, type: 'pen', color: drawColor, width: drawW, pts: [[x0, y0]] }
        : { id: ++objSeq, type: drawTool === 'curve' ? 'line' : drawTool, color: drawColor, width: drawW, fill: drawFill && (drawTool === 'rect' || drawTool === 'ellipse'), x1: x0, y1: y0, x2: x0, y2: y0, cx: 0, cy: 0 };
      objs.push(o);
      move = (m) => {
        if (o.type === 'pen') {
          const last = o.pts[o.pts.length - 1];
          if (Math.hypot(m.clientX - last[0], m.clientY - last[1]) >= 2) o.pts.push([m.clientX, m.clientY]);
        } else {
          o.x2 = m.clientX; o.y2 = m.clientY; constrain(o, m.shiftKey);
          // A new curve starts with a gentle bend you can adjust with the green dot.
          if (drawTool === 'curve') { const len = Math.hypot(o.x2 - o.x1, o.y2 - o.y1); o.cx = (-(o.y2 - o.y1) / (len || 1)) * len * 0.4; o.cy = ((o.x2 - o.x1) / (len || 1)) * len * 0.4; }
        }
        renderDraw();
      };
      up = () => {
        const tiny = o.type !== 'pen' && Math.hypot(o.x2 - o.x1, o.y2 - o.y1) < 4;
        if (tiny) { objs = objs.filter((q) => q !== o); dUndo.pop(); }
        else {
          if (o.type === 'pen') o.pts = smoothPts(o.pts);
          selId = o.id; // keep its handles handy (ends, and the bend dot on curves)
        }
        finish();
      };
    }
    function finish() {
      layer.removeEventListener('pointermove', move);
      layer.removeEventListener('pointerup', up);
      layer.removeEventListener('pointercancel', finish);
      syncDraw();
    }
    layer.addEventListener('pointermove', move);
    layer.addEventListener('pointerup', up);
    layer.addEventListener('pointercancel', finish);
  }

  /* text marks */
  function startText(x, y) {
    const i = document.createElement('input');
    i.className = 'dtext hud';
    i.style.left = `${x}px`;
    i.style.top = `${y - 16}px`;
    i.placeholder = 'Type a note, then Enter';
    i.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commitText(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelText(); }
    });
    textInput = { input: i, x, y };
    root.appendChild(i);
    setTimeout(() => i.focus(), 0);
  }
  function cancelText() { textInput?.input.remove(); textInput = null; }
  function commitText() {
    if (!textInput) return;
    const { input, x, y } = textInput;
    const text = input.value.trim();
    input.remove();
    textInput = null;
    if (!text) return;
    pushUndo();
    objs.push({ id: ++objSeq, type: 'text', color: drawColor, size: 20, text, x, y: y + 6, width: 1 });
    syncDraw();
  }

  /* brief */
  function targetAt(x, y) {
    const t = document.elementsFromPoint(x, y).find((n) => !inRoot(n) && n !== document.documentElement && n !== document.body);
    return t ? { label: label(t), selector: cssPath(t), classes: classesOf(t), ids: t.id ? [t.id] : [] } : null;
  }

  function annotationData() {
    return objs.map((o, i) => {
      const b = bboxOf(o);
      const box = { x: round(b.x1), y: round(b.y1), w: round(b.x2 - b.x1), h: round(b.y2 - b.y1) };
      const pts = [];
      if (o.type === 'text') pts.push([o.x, o.y - o.size / 2]);
      else if (o.type === 'arrow' || o.type === 'line') { pts.push([o.x1, o.y1], [o.x2, o.y2]); if (curved(o)) { const m = curvePt(o, 0.5); pts.push([m.x, m.y]); } }
      else {
        pts.push([(b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2]);
        if (o.type === 'rect' || o.type === 'ellipse') {
          for (const fx of [0.2, 0.8]) for (const fy of [0.2, 0.8]) pts.push([b.x1 + (b.x2 - b.x1) * fx, b.y1 + (b.y2 - b.y1) * fy]);
        }
      }
      const seen = new Set();
      const targets = [];
      for (const [x, y] of pts) {
        const t = targetAt(x, y);
        if (t && !seen.has(t.selector)) { seen.add(t.selector); targets.push(t); }
      }
      return { n: i + 1, kind: o.type === 'rect' ? 'box' : curved(o) ? (o.type === 'arrow' ? 'curved arrow' : 'curve') : o.type, color: o.color, filled: !!o.fill, text: o.text || '', box, targets: targets.slice(0, 4) };
    });
  }

  async function makeDrawBrief() {
    const note = (ui.notes?.value || '').trim();
    if (!objs.length && !note) throw new Error('Draw something or write a note first.');
    commitText();
    const sel = selId; selId = null; renderDraw();
    const annotations = annotationData();
    const annotated = await shoot('annotated');
    selId = sel; renderDraw();
    return bridge.brief({
      mode: 'draw',
      viewport: { w: window.innerWidth, h: window.innerHeight },
      shots: { before: beforeShot, annotated },
      notes: note,
      annotations,
      changes: [],
    });
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
    if (inRoot(e.target) && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) {
      if (e.key === 'Escape' || e.key === 'Enter') e.target.blur();
      return; // typing in a style field
    }
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault(); e.stopPropagation();
      if (drawOn) { if (e.shiftKey) drawRedo(); else drawUndo(); } else undo();
      return;
    }
    if (mod) return; // let menu shortcuts (like toggling this mode) through
    if (shapeEl) { onShapeKey(e); return; }
    if (drawOn) { onDrawKey(e); return; }
    if (e.key.toLowerCase() === 'd') { e.preventDefault(); e.stopPropagation(); enterDraw(); return; }
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
    if (drawOn) return makeDrawBrief();
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

  function sendClick(btn) {
    if (!btn.dataset.confirm) {
      btn.dataset.confirm = '1';
      btn.textContent = 'Confirm: agent edits files';
      clearTimeout(confirmTimer);
      confirmTimer = setTimeout(() => resetSendBtn(btn), 5000);
      return;
    }
    resetSendBtn(btn);
    doSend({}, btn);
  }

  function resetSendBtn(btn) {
    clearTimeout(confirmTimer);
    if (!btn) return;
    delete btn.dataset.confirm;
    btn.textContent = 'Send to agent';
  }

  async function doSend(opts = {}, btn = ui.sendBtn) {
    btn.disabled = true;
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
          const st = drawOn && ui.dStatus ? ui.dStatus : ui.status;
          st.appendChild(el('div'));
          st.appendChild(reload);
        }
      }
    } catch (err) {
      setStatus(err.message);
    } finally {
      btn.disabled = false;
      renderList();
      if (drawOn) syncDraw();
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
    shapeEl = null; pending = null; view = null; busy = false;
    drawOn = false; objs = []; dUndo = []; dRedo = []; selId = null; textInput = null;
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
