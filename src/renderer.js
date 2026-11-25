(() => {
  const $ = (s) => document.querySelector(s);
  const frame = $('#frame');
  const tabsEl = $('#tabs');
  const editor = $('#editor');
  const countEl = $('#count');
  const panel = $('#panel');
  const fab = $('#fab');

  let state = { tabs: [], active: null, inspectorOpen: true, myFonts: [], defaultFont: null };
  let saveTimer = null;

  const uid = () => Math.random().toString(36).slice(2, 10);
  // New tabs start in the font you last picked.
  const blankTab = (title = 'Untitled') => ({ id: uid(), title, html: '', font: state.defaultFont || null });

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => window.desk.saveState(state), 300);
  }

  const activeTab = () => state.tabs.find((t) => t.id === state.active);

  function wordCount(text) {
    const m = text.trim().match(/\S+/g);
    return m ? m.length : 0;
  }

  // Shows the total, or "N of M words" while part of the page is highlighted.
  function updateCount() {
    const total = wordCount(editor.innerText);
    const sel = document.getSelection();
    let picked = 0;
    if (sel.rangeCount && !sel.isCollapsed && editor.contains(sel.anchorNode) && editor.contains(sel.focusNode)) {
      picked = wordCount(sel.toString());
    }
    const unit = `word${total === 1 ? '' : 's'}`;
    countEl.textContent = picked ? `${picked} of ${total} ${unit}` : `${total} ${unit}`;
  }

  // Each tab has a base font (the default when it was created). Fonts applied to
  // selected text still win over it.
  function applyTabFont() {
    const f = activeTab()?.font;
    editor.style.fontFamily = f ? `"${f.replace(/"/g, '')}", Georgia, serif` : '';
  }

  function focusEditorEnd() {
    editor.focus();
    const r = document.createRange();
    r.selectNodeContents(editor);
    r.collapse(false);
    const s = document.getSelection();
    s.removeAllRanges();
    s.addRange(r);
  }

  /* ---------- Tabs ---------- */

  function tabElement(id) {
    return tabsEl.children[state.tabs.findIndex((t) => t.id === id)];
  }

  function renderTabs() {
    tabsEl.textContent = '';
    for (const t of state.tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (t.id === state.active ? ' active' : '');
      el.setAttribute('role', 'tab');
      el.tabIndex = 0;

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = t.title;
      el.appendChild(title);

      const x = document.createElement('button');
      x.className = 'x';
      x.tabIndex = -1;
      x.textContent = '×';
      x.setAttribute('aria-label', 'Close tab');
      x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });
      el.appendChild(x);

      el.addEventListener('click', () => switchTo(t.id, 'tab'));
      title.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(t.id); });
      el.addEventListener('keydown', (e) => {
        if (e.target !== el) return; // ignore keys from the rename field
        if (e.key === 'Enter') {
          e.preventDefault();
          startRename(t.id);
        } else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
          // Arrow keys move between tabs and keep you in the tab bar.
          e.preventDefault();
          const i = state.tabs.findIndex((x) => x.id === t.id);
          const last = state.tabs.length - 1;
          const next = e.key === 'Home' ? 0 : e.key === 'End' ? last
            : e.key === 'ArrowRight' ? (i + 1) % state.tabs.length : (i - 1 + state.tabs.length) % state.tabs.length;
          switchTo(state.tabs[next].id, 'tab');
          tabElement(state.tabs[next].id)?.scrollIntoView({ inline: 'nearest' });
        } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          focusEditorEnd(); // start typing and it goes to the page
        }
      });
      tabsEl.appendChild(el);
    }
  }

  function startRename(id) {
    if (id !== state.active) switchTo(id, 'none');
    const tab = state.tabs.find((t) => t.id === id);
    const el = tabElement(id);
    if (!tab || !el) return;
    const title = el.querySelector('.title');
    const original = tab.title;
    let done = false;

    el.classList.add('renaming');
    title.contentEditable = 'true';
    title.focus();
    document.getSelection().selectAllChildren(title);

    const finish = (commit) => {
      if (done) return;
      done = true;
      title.contentEditable = 'false';
      el.classList.remove('renaming');
      if (commit) tab.title = title.textContent.trim() || original;
      title.textContent = tab.title;
      persist();
    };

    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); focusEditorEnd(); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); focusEditorEnd(); }
    });
    title.addEventListener('paste', (e) => {
      e.preventDefault();
      const text = e.clipboardData.getData('text/plain').replace(/\s+/g, ' ');
      document.execCommand('insertText', false, text);
    });
    title.addEventListener('blur', () => finish(true), { once: true });
  }

  function saveCurrent() {
    const t = activeTab();
    if (t) t.html = editor.innerHTML;
  }

  // focus: 'editor' (page), 'tab' (the tab itself), or 'none'
  function switchTo(id, focus = 'editor') {
    if (id !== state.active) {
      saveCurrent();
      state.active = id;
      editor.innerHTML = activeTab()?.html || '';
      applyTabFont();
      pendingFont = null;
      renderTabs();
      updateCount();
      persist();
    }
    if (focus === 'editor') editor.focus();
    else if (focus === 'tab') tabElement(id)?.focus();
  }

  // + : new tab, and your first keystrokes name it. Enter moves you to the page.
  function newTab() {
    saveCurrent();
    const t = blankTab();
    state.tabs.push(t);
    switchTo(t.id, 'none');
    startRename(t.id);
    tabElement(t.id)?.querySelector('.title').replaceChildren(); // empty so you type a fresh name
    document.getSelection().selectAllChildren(tabElement(t.id).querySelector('.title'));
    tabElement(t.id)?.scrollIntoView({ inline: 'nearest' });
  }

  function closeTab(id) {
    const t = state.tabs.find((x) => x.id === id);
    if (!t) return;
    if (id === state.active) saveCurrent();
    if (t.html && wordCount(t.html.replace(/<[^>]*>/g, ' ')) > 0 &&
        !confirm(`Close "${t.title}"? Its text will be deleted.`)) return;
    const i = state.tabs.indexOf(t);
    state.tabs.splice(i, 1);
    if (state.tabs.length === 0) state.tabs.push(blankTab());
    if (id === state.active) {
      const next = state.tabs[Math.min(i, state.tabs.length - 1)];
      state.active = null;
      switchTo(next.id);
    } else {
      renderTabs();
      persist();
    }
  }

  /* ---------- Format panel ---------- */

  /* Font picker: only lists fonts actually installed on this computer. */
  const FONT_CANDIDATES = ['Georgia', 'Iowan Old Style', 'Palatino', 'Baskerville', 'Times New Roman',
    'Didot', 'Helvetica Neue', 'Avenir Next', 'Optima', 'Gill Sans', 'Futura', 'Verdana',
    'Trebuchet MS', 'American Typewriter', 'Menlo', 'Courier New'];
  const fontBtn = $('#font-btn');
  const fontPop = $('#font-pop');
  const fontList = $('#font-list');
  const fontAdd = $('#font-add');
  // A font chosen with just a cursor (no selection) only applies to what you type next,
  // so remember it and show it right away instead of waiting for the first keystroke.
  let pendingFont = null;
  let installedFonts = []; // fonts you installed yourself (Font Book), read from disk

  // Your saved Google Fonts live in your own user-data file, never in the repo.
  const validFontName = (n) => /^[A-Za-z0-9][A-Za-z0-9 ]{0,60}$/.test(n);
  function loadGoogleFont(name) {
    if (!validFontName(name)) return;
    if (document.querySelector(`link[data-gf="${name}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.dataset.gf = name;
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, '+')}&display=swap`;
    document.head.appendChild(link);
  }

  function fontInstalled(name) {
    const ctx = document.createElement('canvas').getContext('2d');
    const sample = 'mmmmmmmmmmlliWWW';
    const width = (family) => { ctx.font = `72px ${family}`; return ctx.measureText(sample).width; };
    return ['monospace', 'serif', 'sans-serif'].some((fb) => width(`"${name}", ${fb}`) !== width(fb));
  }

  function currentFont() {
    if (pendingFont) return pendingFont;
    const sel = document.getSelection();
    let node = sel.anchorNode;
    if (!node || !editor.contains(node)) node = editor;
    if (node.nodeType === 3) node = node.parentElement;
    const family = getComputedStyle(node).fontFamily.split(',')[0] || '';
    return family.replace(/["']/g, '').trim();
  }

  function closeFontList() {
    fontPop.hidden = true;
    fontBtn.setAttribute('aria-expanded', 'false');
  }

  function pickFont(name, viaKeyboard) {
    editor.focus();
    document.execCommand('fontName', false, name);
    pendingFont = name;
    state.defaultFont = name; // remembered for the next tab you create
    closeFontList();
    saveCurrent(); updateToolbar(); persist();
    if (viaKeyboard) fontBtn.focus(); // keep your place in the panel when using the keyboard
  }

  function fontItem(name, mine) {
    const li = document.createElement('li');
    li.dataset.font = name;
    li.setAttribute('role', 'option');
    li.tabIndex = -1; // reachable with the arrow keys
    li.style.fontFamily = `"${name.replace(/"/g, '')}"`;
    const label = document.createElement('span');
    label.textContent = name;
    li.appendChild(label);
    if (mine) {
      li.classList.add('mine');
      const rm = document.createElement('button');
      rm.className = 'rm';
      rm.textContent = '\u00d7';
      rm.title = 'Remove from my fonts';
      rm.tabIndex = -1;
      rm.addEventListener('mousedown', (e) => e.preventDefault());
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        state.myFonts = state.myFonts.filter((f) => f !== name);
        buildFontList(); persist();
      });
      li.appendChild(rm);
    }
    li.addEventListener('mousedown', (e) => e.preventDefault()); // keep the text selection
    li.addEventListener('click', (e) => pickFont(name, e.detail === 0));
    return li;
  }

  function heading(text) {
    const li = document.createElement('li');
    li.className = 'heading';
    li.textContent = text;
    return li;
  }

  function buildFontList() {
    fontList.textContent = '';
    state.myFonts.forEach(loadGoogleFont);
    const hasMore = installedFonts.length || state.myFonts.length;
    if (installedFonts.length) {
      fontList.appendChild(heading('Installed by you'));
      installedFonts.forEach((n) => fontList.appendChild(fontItem(n, false)));
    }
    if (state.myFonts.length) {
      fontList.appendChild(heading('My Google Fonts'));
      state.myFonts.forEach((n) => fontList.appendChild(fontItem(n, true)));
    }
    if (hasMore) fontList.appendChild(heading('On this computer'));
    FONT_CANDIDATES.filter(fontInstalled).forEach((n) => fontList.appendChild(fontItem(n, false)));
    updateToolbar();
  }

  fontAdd.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); panelStep(e.key, fontAdd); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeFontList(); fontBtn.focus(); return; }
    fontAdd.classList.remove('bad');
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const name = fontAdd.value.trim().replace(/\s+/g, ' ');
    if (!validFontName(name)) { fontAdd.classList.add('bad'); return; }
    if (!state.myFonts.some((f) => f.toLowerCase() === name.toLowerCase())) state.myFonts.push(name);
    fontAdd.value = '';
    buildFontList(); persist();
  });

  fontBtn.addEventListener('mousedown', (e) => e.preventDefault());
  fontBtn.addEventListener('click', () => {
    const open = fontPop.hidden;
    fontPop.hidden = !open;
    fontBtn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('mousedown', (e) => {
    if (!fontPop.hidden && !e.target.closest('#font-pop, #font-btn')) closeFontList();
  });

  function setPanel(open) {
    state.inspectorOpen = open;
    frame.classList.toggle('panel-open', open);
    panel.hidden = !open;
    fab.hidden = open;
    persist();
  }

  const stateCmds = ['bold', 'italic', 'underline', 'strikeThrough',
    'insertUnorderedList', 'insertOrderedList', 'justifyLeft', 'justifyCenter', 'justifyRight'];

  function updateToolbar() {
    const sel = document.getSelection();
    if (!sel.rangeCount || !editor.contains(sel.anchorNode)) return;
    const font = currentFont();
    if (font) fontBtn.textContent = font;
    fontList.querySelectorAll('li[data-font]').forEach((li) => li.classList.toggle('on', li.dataset.font === font));
    let block = (document.queryCommandValue('formatBlock') || '').toLowerCase();
    if (block === '' || block === 'div') block = 'p';
    panel.querySelectorAll('button[data-cmd]').forEach((b) => {
      let on = false;
      if (b.dataset.cmd === 'formatBlock') on = b.dataset.val === block;
      else if (stateCmds.includes(b.dataset.cmd)) on = document.queryCommandState(b.dataset.cmd);
      b.classList.toggle('on', on);
    });
  }

  panel.querySelectorAll('button[data-cmd]').forEach((b) => {
    b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the text selection
    b.addEventListener('click', (e) => {
      editor.focus();
      document.execCommand(b.dataset.cmd, false, b.dataset.val || null);
      saveCurrent(); updateCount(); updateToolbar(); persist();
      if (e.detail === 0) b.focus(); // keyboard: stay on the button so the arrows keep working
    });
  });
  $('#collapse').addEventListener('click', () => { closeFontList(); setPanel(false); });
  fab.addEventListener('click', () => setPanel(true));
  document.addEventListener('selectionchange', () => { updateToolbar(); updateCount(); });


  /* ---------- Keyboard navigation in the Format panel ---------- */
  // Cmd+Shift+F jumps into the panel. Arrow keys move to the nearest control in that
  // direction, Enter/Space applies it, Escape goes back to the text.

  function panelItems() {
    return [...panel.querySelectorAll('#collapse, #font-btn, #font-list li[data-font], #font-add, button[data-cmd]')]
      .filter((n) => n.offsetParent !== null);
  }

  function panelStep(key, from) {
    const items = panelItems();
    const mid = (n) => { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
    const cur = mid(from);
    const SAME_ROW = 10;
    let pick = null;
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const dir = key === 'ArrowRight' ? 1 : -1;
      const row = items.filter((n) => n !== from && Math.abs(mid(n).y - cur.y) < SAME_ROW && (mid(n).x - cur.x) * dir > 0);
      pick = row.sort((a, b) => Math.abs(mid(a).x - cur.x) - Math.abs(mid(b).x - cur.x))[0];
    } else {
      const dir = key === 'ArrowDown' ? 1 : -1;
      const beyond = items.filter((n) => (mid(n).y - cur.y) * dir > SAME_ROW);
      if (beyond.length) {
        const nearestY = Math.min(...beyond.map((n) => Math.abs(mid(n).y - cur.y)));
        pick = beyond
          .filter((n) => Math.abs(mid(n).y - cur.y) - nearestY < SAME_ROW)
          .sort((a, b) => Math.abs(mid(a).x - cur.x) - Math.abs(mid(b).x - cur.x))[0];
      }
    }
    if (pick) pick.focus();
  }

  panel.addEventListener('keydown', (e) => {
    if (e.target === fontAdd || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^Arrow/.test(e.key)) {
      e.preventDefault();
      panelStep(e.key, e.target);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (!fontPop.hidden) { closeFontList(); fontBtn.focus(); } else editor.focus();
    } else if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('li[data-font]')) {
      e.preventDefault();
      e.target.click();
    }
  });

  function focusPanel() {
    if (!state.inspectorOpen) setPanel(true);
    fontBtn.focus();
  }

  /* ---------- Editor, window, shortcuts ---------- */

  // Copy and cut keep bold, italic, underline, headings, lists and quotes, but drop every color,
  // background and font. Otherwise the browser copies the editor's dark-mode colors too, which
  // turns the background of an email black.
  const KEEP = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'H1', 'H2', 'H3', 'P', 'DIV', 'BR',
    'UL', 'OL', 'LI', 'BLOCKQUOTE']);
  function cleanClone(root) {
    root.querySelectorAll('style, script, meta, title, head, link, img, svg, iframe').forEach((n) => n.remove());
    for (const el of [...root.querySelectorAll('*')]) {
      const st = el.style;
      const bold = parseInt(st.fontWeight, 10) >= 600 || st.fontWeight === 'bold';
      const italic = st.fontStyle === 'italic';
      const fw = st.fontWeight;
      el.removeAttribute('style');
      el.removeAttribute('class');
      el.removeAttribute('color');
      el.removeAttribute('face');
      el.removeAttribute('size');
      // Google Docs wraps whole pastes in <b style="font-weight:normal">: that is not bold.
      const fakeBold = (el.tagName === 'B' || el.tagName === 'STRONG') && fw && !bold;
      if (KEEP.has(el.tagName) && !fakeBold) continue;
      // Unwrap spans and fonts, keeping their bold/italic as real tags.
      let inner = document.createDocumentFragment();
      while (el.firstChild) inner.appendChild(el.firstChild);
      if (italic) { const i = document.createElement('i'); i.appendChild(inner); inner = i; }
      if (bold) { const b = document.createElement('b'); b.appendChild(inner); inner = b; }
      el.replaceWith(inner);
    }
  }
  // Paste keeps the same things (bold, italic, headings...) and drops the source's colors and
  // backgrounds, so pasting from an email never brings the email's background along.
  editor.addEventListener('paste', (e) => {
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    e.preventDefault();
    if (!html) { document.execCommand('insertText', false, text); return; }
    const box = document.createElement('div');
    box.innerHTML = html;
    cleanClone(box);
    document.execCommand('insertHTML', false, box.innerHTML);
  });

  for (const type of ['copy', 'cut']) {
    editor.addEventListener(type, (e) => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const box = document.createElement('div');
      box.appendChild(sel.getRangeAt(0).cloneContents());
      cleanClone(box);
      e.clipboardData.setData('text/plain', sel.toString());
      e.clipboardData.setData('text/html', box.innerHTML);
      e.preventDefault();
      if (type === 'cut') document.execCommand('delete');
    });
  }

  editor.addEventListener('input', () => { pendingFont = null; saveCurrent(); updateCount(); persist(); updateToolbar(); });
  // Moving the cursor yourself means the label should follow where you are now.
  editor.addEventListener('mousedown', () => { pendingFont = null; });
  editor.addEventListener('keydown', (e) => {
    if (/^(Arrow|Home|End|Page)/.test(e.key)) pendingFont = null;
  });

  $('#btn-close').addEventListener('click', () => window.desk.close());
  $('#btn-min').addEventListener('click', () => window.desk.minimize());
  $('#btn-zoom').addEventListener('click', () => window.desk.zoom());
  $('#new-tab').addEventListener('click', newTab);

  // Cmd+T new, Cmd+W close, Cmd+\ toggle panel, Cmd+1..9 jump, Ctrl+Tab cycle
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); focusPanel(); }
    else if (mod && e.key === 't') { e.preventDefault(); newTab(); }
    else if (mod && e.key === 'w') { e.preventDefault(); closeTab(state.active); }
    else if (mod && e.key === '\\') { e.preventDefault(); setPanel(!state.inspectorOpen); }
    else if (mod && /^[1-9]$/.test(e.key)) {
      const t = state.tabs[Number(e.key) - 1];
      if (t) { e.preventDefault(); switchTo(t.id); }
    } else if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      const i = state.tabs.findIndex((t) => t.id === state.active);
      const step = e.shiftKey ? -1 : 1;
      switchTo(state.tabs[(i + step + state.tabs.length) % state.tabs.length].id);
    }
  });

  window.addEventListener('beforeunload', () => { saveCurrent(); window.desk.saveState(state); });

  // Dev-only: load the Studio overlay when the main process enables it.
  window.studioBridge.config().then((c) => {
    if (!c.enabled) return;
    const el = document.createElement('script');
    el.src = '../tools/studio/overlay.js';
    document.head.appendChild(el);
  }).catch(() => {});

  // Boot: blank by default
  (async () => {
    const saved = await window.desk.loadState();
    if (saved && Array.isArray(saved.tabs) && saved.tabs.length) {
      state = { inspectorOpen: true, myFonts: [], defaultFont: null, ...saved };
      if (!activeTab()) state.active = state.tabs[0].id;
    } else {
      const t = blankTab();
      state = { tabs: [t], active: t.id, inspectorOpen: true, myFonts: [], defaultFont: null };
    }
    editor.innerHTML = activeTab().html || '';
    applyTabFont();
    renderTabs();
    updateCount();
    buildFontList();
    window.desk.installedFonts().then((list) => { installedFonts = list; buildFontList(); }).catch(() => {});
    setPanel(state.inspectorOpen);
    editor.focus();
  })();
})();
