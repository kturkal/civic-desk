(() => {
  const $ = (s) => document.querySelector(s);
  const tabsEl = $('#tabs');
  const editor = $('#editor');
  const countEl = $('#count');

  let state = { tabs: [], active: null };
  let saveTimer = null;

  const uid = () => Math.random().toString(36).slice(2, 10);
  const blankTab = (title = 'Untitled') => ({ id: uid(), title, html: '' });

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => window.desk.saveState(state), 300);
  }

  function activeTab() {
    return state.tabs.find((t) => t.id === state.active);
  }

  function wordCount(text) {
    const m = text.trim().match(/\S+/g);
    return m ? m.length : 0;
  }

  function updateCount() {
    const n = wordCount(editor.innerText);
    countEl.textContent = `${n} word${n === 1 ? '' : 's'}`;
  }

  function renderTabs() {
    tabsEl.textContent = '';
    for (const t of state.tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (t.id === state.active ? ' active' : '');
      el.setAttribute('role', 'tab');

      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = t.title;
      el.appendChild(title);

      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = '×';
      x.setAttribute('aria-label', 'Close tab');
      x.addEventListener('click', (e) => { e.stopPropagation(); closeTab(t.id); });
      el.appendChild(x);

      el.addEventListener('click', () => switchTo(t.id));
      title.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(t, title); });
      tabsEl.appendChild(el);
    }
  }

  function startRename(tab, titleEl) {
    titleEl.contentEditable = 'true';
    titleEl.focus();
    document.getSelection().selectAllChildren(titleEl);
    const finish = () => {
      titleEl.contentEditable = 'false';
      tab.title = titleEl.textContent.trim() || 'Untitled';
      titleEl.textContent = tab.title;
      persist();
    };
    titleEl.addEventListener('blur', finish, { once: true });
    titleEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
    });
  }

  function saveCurrent() {
    const t = activeTab();
    if (t) t.html = editor.innerHTML;
  }

  function switchTo(id) {
    saveCurrent();
    state.active = id;
    editor.innerHTML = activeTab()?.html || '';
    renderTabs();
    updateCount();
    editor.focus();
    persist();
  }

  function newTab() {
    saveCurrent();
    const t = blankTab();
    state.tabs.push(t);
    switchTo(t.id);
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

  // Editor events
  editor.addEventListener('input', () => { saveCurrent(); updateCount(); persist(); });

  // Toolbar (mousedown preventDefault keeps the text selection)
  document.querySelectorAll('#toolbar button').forEach((b) => {
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      document.execCommand(b.dataset.cmd, false, b.dataset.val || null);
      saveCurrent(); persist();
    });
  });

  // Window controls
  $('#btn-close').addEventListener('click', () => window.desk.close());
  $('#btn-min').addEventListener('click', () => window.desk.minimize());
  $('#btn-zoom').addEventListener('click', () => window.desk.zoom());
  $('#new-tab').addEventListener('click', newTab);

  // Shortcuts: Cmd+T new, Cmd+W close, Cmd+1..9 jump, Ctrl+Tab cycle
  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 't') { e.preventDefault(); newTab(); }
    else if (mod && e.key === 'w') { e.preventDefault(); closeTab(state.active); }
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
      state = saved;
      if (!activeTab()) state.active = state.tabs[0].id;
    } else {
      const t = blankTab();
      state = { tabs: [t], active: t.id };
    }
    editor.innerHTML = activeTab().html || '';
    renderTabs();
    updateCount();
    editor.focus();
  })();
})();
