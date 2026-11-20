(() => {
  const $ = (s) => document.querySelector(s);
  const frame = $('#frame');
  const tabsEl = $('#tabs');
  const editor = $('#editor');
  const countEl = $('#count');
  const panel = $('#panel');
  const fab = $('#fab');

  let state = { tabs: [], active: null, inspectorOpen: true, myFonts: [] };
  let saveTimer = null;

  const uid = () => Math.random().toString(36).slice(2, 10);
  const blankTab = (title = 'Untitled') => ({ id: uid(), title, html: '' });

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

  function pickFont(name) {
    editor.focus();
    document.execCommand('fontName', false, name);
    pendingFont = name;
    closeFontList();
    saveCurrent(); updateToolbar(); persist();
  }

  function fontItem(name, mine) {
    const li = document.createElement('li');
    li.dataset.font = name;
    li.setAttribute('role', 'option');
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
      rm.addEventListener('mousedown', (e) => e.preventDefault());
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        state.myFonts = state.myFonts.filter((f) => f !== name);
        buildFontList(); persist();
      });
      li.appendChild(rm);
    }
    li.addEventListener('mousedown', (e) => e.preventDefault()); // keep the text selection
    li.addEventListener('click', () => pickFont(name));
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
    b.addEventListener('click', () => {
      editor.focus();
      document.execCommand(b.dataset.cmd, false, b.dataset.val || null);
      saveCurrent(); updateCount(); updateToolbar(); persist();
    });
  });
  $('#collapse').addEventListener('click', () => { closeFontList(); setPanel(false); });
  fab.addEventListener('click', () => setPanel(true));
  document.addEventListener('selectionchange', () => { updateToolbar(); updateCount(); });

  /* ---------- Editor, window, shortcuts ---------- */

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
    if (mod && e.key === 't') { e.preventDefault(); newTab(); }
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

  // Boot: blank by default
  (async () => {
    const saved = await window.desk.loadState();
    if (saved && Array.isArray(saved.tabs) && saved.tabs.length) {
      state = { inspectorOpen: true, myFonts: [], ...saved };
      if (!activeTab()) state.active = state.tabs[0].id;
    } else {
      const t = blankTab();
      state = { tabs: [t], active: t.id, inspectorOpen: true, myFonts: [] };
    }
    editor.innerHTML = activeTab().html || '';
    renderTabs();
    updateCount();
    buildFontList();
    window.desk.installedFonts().then((list) => { installedFonts = list; buildFontList(); }).catch(() => {});
    setPanel(state.inspectorOpen);
    editor.focus();
  })();
})();
