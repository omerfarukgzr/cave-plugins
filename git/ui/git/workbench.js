/* The page around the views (docs/ARCHITECTURE.md §6.3). Replaces the prototype's frame.js.
   Workbench: thin top bar (repository switcher, branch widget, running job, Update Project / Commit / Push, settings)
   | center: editor tab area (Git.tabs) over the Git tool window (Log, Console, + dynamic tabs) | the Commit view in
   the right column behind the tool stripe. With no editor tab open the Git tool window fills the middle.
   Single view (?view=commit|log|console|branches|files): one view fills the page (hosts with their own layout, ≥ 300 px);
   what it opens as a tab (Git.tabs / Git.frame.openTab) is a page over the view (pages.js).
   The right column holds the Commit view or the Files tool window (filetree.js), one at a time (stripe, ⌘0 / ⌘1).
   Repository: ?repo=<path>, else the last one, else the picker page (picker.js).
     Git.tabs.open({ id, title, icon, closable, mount(el), unmount() }) · .close(id) · .select(id) · .active() · .list() · .setTitle(id, t)
     Git.frame.showRight('commit'|'none') · toggleGit(open?) · openTab({ id, title, closable, mount }) · selectTab(id) ·
       closeTab(id) · setTabTitle(id, title) · activeTab() · isGitOpen() · rebuild() · setSkin(skin)
     Git.workbench.boot() · .open(path) · .mode ('workbench'|'single'|'picker'|'message') */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const prefs = () => Git.host.prefs;
  const W = (Git.workbench = { mode: null });
  const F = (Git.frame = {});

  Git.addTR({
    'Commit': 'Commit', 'Git': 'Git', 'Log': 'Log', 'Console': 'Console', 'Hide': 'Gizle', 'Close': 'Kapat', 'Close Tab': 'Sekmeyi kapat',
    'Commit…': 'Commit…', 'Push…': 'Push…', 'Update Project…': 'Projeyi güncelle…', 'Fetch': 'Fetch', 'Merge…': 'Merge…', 'Rebase…': 'Rebase…',
    'Branches…': 'Dallar…', 'New Branch…': 'Yeni dal…', 'New Tag…': 'Yeni etiket…', 'Push': 'Push', 'Update Project': 'Projeyi güncelle',
    'Settings': 'Ayarlar', 'Appearance': 'Görünüm', 'Labels': 'Etiketler', 'Türkçe': 'Türkçe', 'English': 'English',
    'Open…': 'Aç…', 'Recent Repositories': 'Son kullanılan depolar', 'Disconnected, reconnecting…': 'Bağlantı koptu, yeniden bağlanıyor…',
    'Cannot reach the {0} server': '{0} sunucusuna ulaşılamıyor', 'Retry': 'Yeniden dene', 'Default': 'Varsayılan',
    'Start it with "{0}" and try again.': '"{0}" ile başlatıp yeniden dene.',
    'Loading {0}…': '{0} yükleniyor…', 'Commit view': 'Commit görünümü', 'Open the Git tool window (⌘9)': 'Git araç penceresini aç (⌘9)',
    'Options': 'Seçenekler', 'Files': 'Dosyalar',
    'This project has no folder.': 'Bu projeye klasör seçilmemiş.',
    'Choose a folder for the project to see its repository here.': 'Projeye klasör seçince deposu burada görünür.',
  });

  const state = { right: true, rightView: 'commit', git: true, tabs: [], active: 'log', editor: [], current: null, ready: false };
  let root, top, main, center, editor, edTabs, edBody, edNote, dock, tabStrip, dockBody, right, rightBody, stripe, dockSplit, rightSplit;
  let filesBody = null, filesOff = null, rightTitle = null;   // the Files tool window (filetree.js) shares the right column
  let stashBody = null, commitHead = null;                   // the Stash tab beside Commit (stash-view.js)

  // ---------------------------------------------------------------- skin and language
  /** A skin name as stored or asked for (?skin=): the host's aliases first (Git.host.skinAliases, an old stored
      value), then `intellij` or `default`. */
  F.skinName = function (v) {
    const aliases = (Git.host && Git.host.skinAliases) || {};
    if (typeof v === 'string' && Object.prototype.hasOwnProperty.call(aliases, v)) v = aliases[v];
    return v === 'intellij' ? 'intellij' : 'default';
  };
  function applySkin(skin) {
    if (F.skinName(skin) === 'intellij') document.documentElement.dataset.gitSkin = 'intellij'; else delete document.documentElement.dataset.gitSkin;
  }
  F.setSkin = function (skin) {
    skin = F.skinName(skin);
    applySkin(skin);
    prefs().set('skin', skin);
    Git.emit('skin', skin);
    F.rebuild();
  };
  /** Switches the labels and redraws the page (the language menus: here and Git.languageMenu() of a single view). */
  Git.switchLang = function (code, o) { Git.setLang(code, o); F.rebuild(); };
  const setLang = (code) => Git.switchLang(code);
  // Other frames of the same host (another Orca panel, a second tab) follow a language picked in one of them: they
  // share localStorage when they share an origin, and get its `storage` event. Otherwise they read it on their next boot.
  window.addEventListener('storage', (e) => {
    if (!e || e.key !== Git.storagePrefix() + 'lang' || !e.newValue) return;
    let code = null;
    try { code = JSON.parse(e.newValue); } catch (err) { return; }
    if (typeof code === 'string' && code !== Git.lang && W.mode !== 'message') Git.switchLang(code, { store: false });
  });

  // ---------------------------------------------------------------- top bar
  function settingsMenu(anchor) {
    const skin = document.documentElement.dataset.gitSkin || 'default';
    Git.menu(anchor, [
      { header: t('Appearance'), label: t('Appearance'), disabled: true },
      { label: (Git.host && Git.host.skinLabel) || t('Default'), checked: skin === 'default', action: () => F.setSkin('default') },
      { label: 'IntelliJ', checked: skin === 'intellij', action: () => F.setSkin('intellij') },
      '-',
      { header: t('Labels'), label: t('Labels'), disabled: true },
    ].concat(Git.languages().map((l) => ({ label: l.name, checked: Git.lang === l.code, action: () => setLang(l.code) })),
      Git.report ? Git.report.menu({ settings: true }) : []));
  }
  async function repoMenu(anchor) {
    let recent = [];
    try { recent = (await Git.backend.call('repos.recent', {})).repos || []; } catch (e) { /* keep empty */ }
    const cur = Git.repo.root;
    Git.menu(anchor, [{ header: t('Recent Repositories'), label: t('Recent Repositories'), disabled: true }]
      .concat(recent.map((r) => ({ label: r.name, shortcut: r.root === cur ? '' : null, checked: r.root === cur, disabled: !r.exists,
        action: () => { if (r.root !== cur) W.open(r.root); } })), ['-', { label: t('Open…'), action: () => W.picker() }]));
  }
  // the Worktrees chip and the strip while another worktree is shown (worktrees.js)
  const wtChip = () => (Git.worktrees ? Git.worktrees.chip() : null);
  const wtStrip = () => (Git.worktrees ? Git.worktrees.strip() : null);
  function buildTop() {
    const tool = (icon, title, id, onClick) => Git.toolBtn({ icon, title, id, onClick });
    const repoBtn = h('button.wb-repo', { type: 'button', id: 'wb-repo', title: Git.repo.root || '', onclick: (e) => repoMenu(e.currentTarget) },
      Git.icon('nodes/module'), h('span.wb-repo-name', Git.repo.name || ''), Git.icon('chevronDownSmall', 12));
    const widget = h('div#g-widget.wb-widget');
    const busy = h('div.wb-busy#wb-busy', { hidden: true, role: 'status' });
    const A = Git.actions;
    top = h('div.wb-top', { role: 'toolbar', 'aria-label': 'Git' },
      repoBtn, wtChip(), widget, busy, h('span.g-spacer'),
      h('div.wb-vcs', { role: 'group', 'aria-label': 'VCS' },
        tool('vcs/update', t('Update Project…') + '  ⌘T', 'wb-update', () => A.updateProject()),
        tool('vcs/commit', t('Commit…') + '  ⌘K', 'wb-commit', () => (A.checkinProject ? A.checkinProject() : F.showRight('commit'))),
        tool('vcs/push', t('Push…') + '  ⇧⌘K', 'wb-push', () => A.push())),
      h('span.g-toolbar-sep'),
      tool('general/settings', t('Settings'), 'wb-settings', (e) => settingsMenu(e.currentTarget)));
    top.widget = widget;
    return top;
  }
  function drawBusy() {
    const el = document.getElementById('wb-busy');
    if (!el) return;
    const lost = W.connection === 'lost';
    const running = Git.actions.running ? Git.actions.running() : [];
    el.hidden = !lost && !running.length;
    Git.clear(el);
    if (lost) el.appendChild(h('span.wb-busy-text.lost', t('Disconnected, reconnecting…')));
    else if (running.length) el.appendChild(h('span.wb-spin', { 'aria-hidden': 'true' }), h('span.wb-busy-text', running.join(', ')));
  }
  Git.on('busy', drawBusy);
  Git.on('connection', (ev) => { W.connection = ev && ev.state === 'lost' ? 'lost' : 'open'; drawBusy(); });

  // ---------------------------------------------------------------- editor tabs (center)
  const Tabs = (Git.tabs = {});
  function renderEditor() {
    if (!edTabs) return;
    Git.clear(edTabs);
    state.editor.forEach((tab) => {
      const on = tab.id === state.current;
      const el = h('div.etab', { class: on ? 'is-active' : '', role: 'tab', 'aria-selected': String(on), tabIndex: 0, dataset: { tab: tab.id }, title: tab.title,
        onmousedown: (e) => { if (e.button === 1) { e.preventDefault(); Tabs.close(tab.id); } },
        onclick: () => Tabs.select(tab.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); Tabs.select(tab.id); } } },
        h('span.etab-custom-icon', { html: tab.icon ? (Git.ICONS || {})[tab.icon] || '' : '' }),
        h('span.etab-name.t.t12', tab.title),
        tab.closable === false ? null : h('span.etab-end', h('button.icon-btn.r4.etab-close', { type: 'button', title: t('Close Tab') + ' (⌘W)', 'aria-label': t('Close Tab'),
          onclick: (e) => { e.stopPropagation(); Tabs.close(tab.id); }, html: Git.popupMenu ? Git.popupMenu.glyph('xmark') : '×' })));
      edTabs.appendChild(el);
    });
    state.editor.forEach((tab) => { tab.el.hidden = tab.id !== state.current; });
    applyLayout();
  }
  Tabs.open = function (spec) {
    let tab = state.editor.find((x) => x.id === spec.id);
    if (tab) {
      tab.title = spec.title || tab.title;
      if (spec.icon) tab.icon = spec.icon;
      if (spec.mount && spec.mount !== tab.mount && spec.remount) { if (tab.unmount) tab.unmount(); Git.clear(tab.el); tab.mount = spec.mount; tab.unmount = spec.unmount; tab.mount(tab.el); }
    } else {
      tab = { id: spec.id, title: spec.title || spec.id, icon: spec.icon || null, closable: spec.closable !== false, mount: spec.mount, unmount: spec.unmount,
        el: h('div.wb-ed-pane') };
      state.editor.push(tab);
      if (edBody) edBody.appendChild(tab.el);
      state.current = tab.id;
      renderEditor();
      if (tab.mount) tab.mount(tab.el);
      return tab.id;
    }
    state.current = tab.id;
    renderEditor();
    return tab.id;
  };
  Tabs.close = function (id) {
    const i = state.editor.findIndex((x) => x.id === id);
    if (i < 0) return;
    const tab = state.editor[i];
    try { if (tab.unmount) tab.unmount(); } catch (e) { console.error(e); }
    tab.el.remove();
    state.editor.splice(i, 1);
    if (state.current === id) state.current = (state.editor[Math.max(0, i - 1)] || {}).id || null;
    renderEditor();
  };
  Tabs.select = function (id) { if (state.editor.some((x) => x.id === id)) { state.current = id; renderEditor(); } };
  Tabs.active = () => state.current;
  Tabs.list = () => state.editor.map((x) => ({ id: x.id, title: x.title }));
  Tabs.setTitle = function (id, title) { const tab = state.editor.find((x) => x.id === id); if (tab && tab.title !== title) { tab.title = title; renderEditor(); } };

  // ---------------------------------------------------------------- the Git tool window
  function gitMenu(anchor) {
    const A = Git.actions, op = A.opLabels();
    const items = [
      { label: t('Commit…'), shortcut: '⌘K', action: () => (A.checkinProject ? A.checkinProject() : F.showRight('commit')) },
      { label: t('Push…'), shortcut: '⇧⌘K', action: () => A.push() },
      { label: t('Update Project…'), shortcut: '⌘T', action: () => A.updateProject() },
      { label: t('Fetch'), action: () => A.fetch() },
      '-',
      { label: t('Merge…'), disabled: !!op || !Git.dialogs.merge, action: () => Git.dialogs.merge() },
      { label: t('Rebase…'), disabled: !!op || !Git.dialogs.rebase, action: () => Git.dialogs.rebase() },
    ];
    if (op) {
      items.push('-');
      if (op.go) items.push({ label: op.go, action: () => A.continueOp() });
      if (op.skip) items.push({ label: op.skip, action: () => A.skipCommit() });
      items.push({ label: op.stop, danger: true, action: () => A.abortOp() });
    }
    items.push('-',
      { label: t('Branches…'), disabled: !Git.branches, action: () => Git.branches.open(document.getElementById('g-widget') || anchor) },
      { label: t('New Branch…'), shortcut: '⌥⌘N', action: () => A.newBranch() },
      { label: t('New Tag…'), action: () => A.newTag(Git.headId()) });
    if (A.tag) items[items.length - 1].action = () => A.tag();   // Git ▸ New Tag… is IntelliJ's "Tag" dialog (Git.Tag, §21.3)
    // Git ▸ Uncommitted Changes ▸ Stash Changes… / Unstash Changes… (Git.MainMenu.LocalChanges)
    if (A.stashChanges) {
      items.push('-', { label: t('Uncommitted Changes'), children: [
        { label: t('Stash Changes…'), disabled: !!op || !Git.headId(), action: () => A.stashChanges() },
        { label: t('Unstash Changes…'), disabled: !Git.headId(), action: () => A.unstashChanges() }] });
    }
    Git.menu(anchor, items);
  }
  const consoleTab = () => ({ id: 'console', title: () => t('Console'), closable: true, mount: (el) => Git.views.console && Git.views.console.mount(el) });
  function buildDock() {
    tabStrip = h('div.g-dock-tabs', { role: 'tablist' });
    const title = h('button.g-dock-title', { type: 'button', id: 'g-dock-menu', title: 'Git', onclick: (e) => gitMenu(e.currentTarget) }, t('Git'), Git.icon('chevronDownSmall', 12));
    dockBody = h('div.g-dock-body');
    dock = h('div.wb-dock.g-dock', h('div.g-dock-head', title, tabStrip, h('span.g-spacer'),
      Git.toolBtn({ icon: 'hide', title: t('Hide') + '  ⇧Esc', id: 'g-dock-hide', onClick: () => F.toggleGit(false) })), dockBody);
    state.tabs.forEach((tab) => { tab.el = null; });
    if (!state.tabs.length) {
      state.tabs.push({ id: 'log', title: () => t('Log'), closable: false, mount: (el) => Git.views.log && Git.views.log.mount(el) });
      state.tabs.push(consoleTab());
      // IntelliJ: the Console tab appears once a VCS command ran (the `console` handler below adds it then)
      if (!(Git.repo.console || []).length) state.tabs.pop();
    }
    return dock;
  }
  function renderTabs() {
    if (!tabStrip) return;
    Git.clear(tabStrip);
    state.tabs.forEach((tab) => {
      const on = tab.id === state.active;
      const title = typeof tab.title === 'function' ? tab.title() : tab.title;
      tabStrip.appendChild(h('div.g-tab', { class: on ? 'on' : '', role: 'tab', 'aria-selected': String(on), tabIndex: 0, dataset: { tab: tab.id }, title,
        onclick: () => F.selectTab(tab.id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); F.selectTab(tab.id); } } },
        h('span.g-tab-title', title),
        tab.closable ? h('button.g-tab-x', { type: 'button', title: t('Close Tab'), 'aria-label': t('Close Tab'), onclick: (e) => { e.stopPropagation(); F.closeTab(tab.id); } }, Git.icon('closeSmall')) : null));
    });
    if (!dockBody) return;
    state.tabs.forEach((tab) => {
      if (tab.id === state.active && !tab.el) {
        tab.el = h('div.g-dock-pane.g-col');
        dockBody.appendChild(tab.el);
        tab.off = tab.mount(tab.el);
      }
      if (tab.el) tab.el.hidden = tab.id !== state.active;
    });
  }
  F.toggleGit = function (open) {
    state.git = open == null ? !state.git : !!open;
    prefs().set('wb.git', state.git);
    applyLayout();
    if (state.git) renderTabs();
  };
  F.openTab = function (tab) {
    const old = state.tabs.find((x) => x.id === tab.id);
    if (old) {
      old.title = tab.title; old.mount = tab.mount;
      if (old.el) { if (typeof old.off === 'function') old.off(); old.el.remove(); old.el = null; }
    } else state.tabs.push({ id: tab.id, title: tab.title, closable: tab.closable !== false, mount: tab.mount });
    state.active = tab.id;
    F.toggleGit(true);
    renderTabs();
  };
  F.selectTab = function (id) {
    if (!state.tabs.some((x) => x.id === id)) { if (id !== 'console') return; state.tabs.splice(1, 0, consoleTab()); }
    state.active = id;
    renderTabs();
  };
  F.closeTab = function (id) {
    const i = state.tabs.findIndex((x) => x.id === id);
    if (i < 0) return;
    const tab = state.tabs[i];
    if (id === 'console') Git.repo.console.length = 0;      // IntelliJ: closing the Console drops what it showed
    if (typeof tab.off === 'function') tab.off();
    if (tab.el) tab.el.remove();
    state.tabs.splice(i, 1);
    if (state.active === id) state.active = (state.tabs[Math.max(0, i - 1)] || { id: 'log' }).id;
    renderTabs();
  };
  F.setTabTitle = function (id, title) {
    const tab = state.tabs.find((x) => x.id === id);
    if (!tab || tab.title === title) return;
    tab.title = title;
    const el = tabStrip && tabStrip.querySelector('[data-tab="' + id + '"] .g-tab-title');
    if (el) el.textContent = typeof title === 'function' ? title() : title;
  };
  F.activeTab = () => state.active;
  F.isGitOpen = () => state.git;
  Git.on('console', () => { if (W.mode === 'workbench' && !state.tabs.some((x) => x.id === 'console')) { state.tabs.splice(1, 0, consoleTab()); renderTabs(); } });

  // ---------------------------------------------------------------- right column (Commit view) and the stripe
  /** `view` 'commit' | 'files' (the Files tool window) | 'none'. `mode` 'toggle': a stripe button (and ⌘0 / ⌘1) opens
      its view, or closes the column when that view is the one showing (IntelliJ's side group: one tool window at a time). */
  F.showRight = function (view, mode) {
    const want = view === 'files' ? 'files' : 'commit';
    if (mode === 'toggle') state.right = !(state.right && state.rightView === want);
    else state.right = view === 'commit' || view === 'files';
    if (state.right) state.rightView = want;
    prefs().set('wb.right', state.right);
    prefs().set('wb.rightView', state.rightView);
    applyLayout();
    Git.emit('right', state.right ? state.rightView : 'none');
  };
  F.rightView = () => (state.right ? state.rightView : 'none');
  function stripeBtn(icon, label, id, onClick) {
    return h('button.g-stripe-btn', { type: 'button', id, title: label, 'aria-label': label, onclick: onClick }, Git.icon(icon, 20));
  }
  function buildRight() {
    rightBody = h('div#g-commit.g-col');
    if (typeof filesOff === 'function') filesOff();
    filesOff = null;
    filesBody = h('div#g-files.g-col', { hidden: true });
    stashBody = h('div#g-stash.g-col', { hidden: true });
    rightTitle = h('span.wb-rtitle', t('Commit'));
    commitHead = h('span.wb-rhead-tabs', { hidden: true });   // the Commit | Stash tabs in place of the title (stash-view.js)
    // the tool window header's ⋮ Options (the Commit view's; hidden for Files) and — Hide (A §3.3)
    const rightOptions = Git.toolBtn({ icon: 'general/moreVertical', title: t('Options'), id: 'wb-right-options', onClick: (e) => { if (Git.views.commit && Git.views.commit.optionsMenu) Git.views.commit.optionsMenu(e.currentTarget); } });
    const rightHide = Git.toolBtn({ icon: 'general/hide', title: t('Hide') + '  ⇧Esc', id: 'wb-right-hide', onClick: () => F.showRight('none') });
    right = h('div.wb-right', h('div.wb-rhead', rightTitle, commitHead, h('span.gc-head-tools', rightOptions, rightHide)), rightBody, stashBody, filesBody);
    stripe = h('div#g-stripe.wb-stripe', { role: 'toolbar', 'aria-label': t('Commit view') },
      Git.views.files ? stripeBtn('toolwindowProject', t('Files') + '  ⌘1', 'g-stripe-files', () => F.showRight('files', 'toggle')) : null,
      stripeBtn('toolwindowCommit', t('Commit') + '  ⌘0', 'g-stripe-commit', () => F.showRight('commit', 'toggle')),
      h('span.g-spacer'),
      stripeBtn('toolwindowVcs', t('Git') + '  ⌘9', 'g-stripe-git', () => F.toggleGit()));
    if (Git.views.commit) Git.views.commit.mount(rightBody);
    if (Git.stashTab) Git.stashTab.attach({ head: commitHead, title: rightTitle, commit: rightBody, stash: stashBody });
  }
  function applyLayout() {
    if (W.mode !== 'workbench' || !root) return;
    const hasTabs = state.editor.length > 0;
    editor.hidden = !hasTabs && state.git;
    edNote.hidden = hasTabs;
    dock.hidden = !state.git;
    dockSplit.hidden = !state.git || !hasTabs;
    center.classList.toggle('dock-fills', !hasTabs);
    right.hidden = rightSplit.hidden = !state.right;
    const files = state.right && state.rightView === 'files' && !!Git.views.files;
    filesBody.hidden = !files;
    rightTitle.textContent = files ? t('Files') : t('Commit');
    rightTitle.lang = files ? Git.lang : 'en';                  // "Commit" is a git term: no Turkish dotted İ in capitals
    // the Commit view's header shows the Commit | Stash tabs in place of the title while there are stashes (stash-view.js)
    if (Git.stashTab) Git.stashTab.hostHides(files);
    else { rightBody.hidden = files; stashBody.hidden = true; }
    const opts = document.getElementById('wb-right-options');
    if (opts) opts.hidden = files;
    if (files && !filesOff) filesOff = Git.views.files.mount(filesBody) || true;
    const on = (id, v) => { const b = document.getElementById(id); if (b) { b.classList.toggle('on', v); b.setAttribute('aria-pressed', String(v)); } };
    on('g-stripe-files', files);
    on('g-stripe-commit', state.right && !files);
    on('g-stripe-git', state.git);
    window.dispatchEvent(new Event('resize'));
  }

  // ---------------------------------------------------------------- build
  function buildWorkbench(host) {
    edTabs = edTabs || h('div.ed-tabs', { role: 'tablist' });
    edBody = edBody || h('div.wb-ed-body');
    edNote = edNote || h('div.wb-ed-note');
    Git.clear(edNote).appendChild(h('span', t('Open the Git tool window (⌘9)')));
    editor = editor || h('div.wb-editor', h('div.ed-head', edTabs), edBody, edNote);
    state.editor.forEach((tab) => { if (tab.el.parentNode !== edBody) edBody.appendChild(tab.el); });
    buildDock();
    center = h('div.wb-center', editor);
    dockSplit = Git.splitter({ target: dock, edge: 'top', min: 140, max: () => Math.max(200, center.clientHeight - 120), key: 'wb-dock' });
    if (!dock.style.height) dock.style.height = '340px';
    center.appendChild(dockSplit);
    center.appendChild(dock);
    buildRight();
    rightSplit = Git.splitter({ target: right, edge: 'left', min: 260, max: () => Math.max(300, window.innerWidth - 420), key: 'wb-right' });
    if (!right.style.width) right.style.width = '400px';
    main = h('div.wb-main', center, rightSplit, right, stripe);
    root = h('div#wb.g-root.wb', buildTop(), wtStrip(), main);
    Git.clear(host).appendChild(root);
    if (Git.branchWidget) Git.branchWidget.mount(top.widget);    // the widget draws only when connected
    drawBusy();
    renderTabs();
    renderEditor();
  }
  function buildSingle(host, view) {
    const body = h('div.wb-single-body.g-col');
    root = h('div#wb.g-root.wb.wb-single', { dataset: { view } }, body);
    Git.clear(host).appendChild(root);
    // A host that keeps several repositories behind one panel (Orca: workspaces that share a name) names the one that
    // is shown, so nobody commits into another project: Git.host.repoChip() -> an element, or nothing.
    const chip = Git.host && typeof Git.host.repoChip === 'function' ? Git.host.repoChip() : null;
    // Worktrees beside the repository chip (worktrees.js), and under the header the strip while another one shows
    if (view !== 'tab') { const strip = wtStrip(); if (strip) root.insertBefore(strip, body); }
    // the header's Options button (options.js: the language, Report a Problem, the version), at its right end
    const options = () => (Git.options ? Git.options.button() : null);
    if (chip && view !== 'commit' && view !== 'files' && view !== 'tab') root.insertBefore(h('div.wb-rhead.wb-rhead-chip', chip, wtChip(), options()), root.firstChild);
    if (view === 'commit') {
      const widget = h('div#g-widget.wb-widget');
      const title = h('span.wb-rtitle', { lang: 'en' }, t('Commit'));
      const head = h('span.wb-rhead-tabs', { hidden: true });   // the Commit | Stash tabs in place of the title (stash-view.js)
      const stash = h('div.wb-single-body.g-col', { hidden: true });
      root.appendChild(stash);
      root.insertBefore(h('div.wb-rhead', title, head, chip, wtChip(), widget, options()), root.firstChild);
      if (Git.branchWidget) Git.branchWidget.mount(widget);   // root is connected already
      if (Git.views.commit) Git.views.commit.mount(body);
      if (Git.stashTab) Git.stashTab.attach({ head, title, commit: body, stash });
    } else if (view === 'log') { if (Git.views.log) Git.views.log.mount(body); }
    else if (view === 'console') { if (Git.views.console) Git.views.console.mount(body); }
    else if (view === 'branches') { if (Git.views.branches) Git.views.branches.mount(body); }
    else if (view === 'tab') { if (Git.views.tab) Git.views.tab.mount(body); }
    else if (view === 'files') {
      root.insertBefore(h('div.wb-rhead', h('span.wb-rtitle', t('Files')), chip, chip ? wtChip() : null, options()), root.firstChild);
      if (Git.views.files) Git.views.files.mount(body);
    }
  }
  F.rebuild = function () {
    if (!state.ready) return;
    Git.closePopups();
    if (Git.popupMenu) Git.popupMenu.close();
    state.tabs.forEach((tab) => { if (typeof tab.off === 'function') tab.off(); if (tab.el) { tab.el.remove(); tab.el = null; } });
    const host = document.getElementById('app');
    // The editor tabs survive a rebuild, but taking them out of the page resets their scroll offsets while their
    // virtual lists keep the rows of the old offset (a blank tab): put the offsets back, whose scroll event redraws.
    const kept = edBody ? Array.from(edBody.querySelectorAll('*')).filter((e) => e.scrollTop || e.scrollLeft).map((e) => [e, e.scrollTop, e.scrollLeft]) : [];
    if (W.mode === 'workbench') { buildWorkbench(host); applyLayout(); }
    else if (W.mode === 'single') buildSingle(host, W.view);
    else if (W.mode === 'picker' && Git.picker) Git.picker.mount(host, W.pickerOpts || {});
    kept.forEach(([e, top, left]) => { if (e.isConnected) { e.scrollTop = top; e.scrollLeft = left; } });
  };

  // ---------------------------------------------------------------- whole-page states
  function message(o) {
    W.mode = 'message';
    const host = document.getElementById('app');
    Git.clear(host).appendChild(h('div#wb-message.g-root.wb-message', { role: 'alert' },
      h('div.wb-message-title', o.title), o.text ? h('div.g-dim', o.text) : null,
      o.actions ? h('div.wb-message-actions', o.actions.map((a) => Git.btn(a.label, { primary: a.primary, id: a.id, onClick: a.run }))) : null));
  }
  W.loading = (what) => { message({ title: t('Loading {0}…', what || '') }); document.getElementById('wb-message').classList.add('wb-loading'); };
  let unreachableOff = null;
  W.unreachable = function (retry) {
    // the command that starts the server, when the host has one (the standalone server's; a worker starts on its own)
    const cmd = Git.host && Git.host.startCommand;
    // a host that runs the server itself says what to do instead (a function: the text is translated when shown)
    const hint = Git.host && typeof Git.host.unreachableHint === 'function' ? Git.host.unreachableHint() : null;
    const again = () => { if (unreachableOff) { unreachableOff(); unreachableOff = null; } retry(); };
    message({ title: t('Cannot reach the {0} server', Git.product()), text: hint || (cmd ? t('Start it with "{0}" and try again.', cmd) : null),
      actions: [{ label: t('Retry'), primary: true, id: 'wb-retry', run: () => { if (Git.backend.reconnect) Git.backend.reconnect(); again(); } }] });
    // The page recovers by itself: the transport keeps trying to reach the server (with its own backoff), and once
    // the stream is open again (the server came back: restarted, crashed and restarted, a new build) this page tries
    // once more. One try per connection event, so it cannot loop faster than the transport's backoff.
    if (unreachableOff) unreachableOff();
    unreachableOff = Git.on('connection', (ev) => {
      if (!ev || (ev.state !== 'open' && ev.state !== 'reconnected') || W.mode !== 'message') return;
      again();
    });
  };
  W.picker = function (opts) {
    W.mode = 'picker';
    W.pickerOpts = Object.assign({ onOpen: (path) => W.open(path) }, opts || {});
    if (Git.picker) Git.picker.mount(document.getElementById('app'), W.pickerOpts);
  };
  /** Opens a repository and shows the workbench (or the single view). Errors lead to the picker or the retry page. */
  /** `o.pick`: show another worktree of the repository in this page (worktrees.js); the home stays what it was, so
      the URL and the last repository keep the home. A home open shows the pick kept for that home, if any. */
  W.open = async function (path, o) {
    const WT = Git.worktrees;
    const target = WT ? WT.beforeOpen(path, o) : path;
    W.loading(String(target).split('/').filter(Boolean).pop() || target);
    try {
      let rootPath;
      try { rootPath = await Git.store.open(target); } catch (e) {
        // a kept pick whose worktree went away: forget it and open the home itself
        const lost = e && (e.code === 'unreachable' || e.code === 'transport');
        if (WT && target !== path && !(o && o.pick) && !lost) { WT.forget(); return W.open(path); }
        // a picked worktree that cannot be opened (removed meanwhile): say why and go home
        if (WT && o && o.pick && !lost && WT.home() && target !== WT.home()) { if (Git.actions && Git.actions.errorNotice) Git.actions.errorNotice(e); return WT.back(); }
        throw e;
      }
      if (!rootPath) return;
      const homeRoot = WT ? WT.afterOpen(rootPath) : rootPath;
      prefs().set('lastRepo', homeRoot);
      try {
        const q = new URLSearchParams(location.search);
        q.set('repo', homeRoot);
        history.replaceState(null, '', location.pathname + '?' + q.toString());
      } catch (e) { /* sandboxed */ }
      state.tabs = [];
      state.active = 'log';
      state.editor.slice().forEach((tab) => Tabs.close(tab.id));
      W.mode = W.view ? 'single' : 'workbench';
      state.ready = true;
      F.rebuild();
      Git.emit('workbench', { mode: W.mode });
    } catch (e) {
      if (e && (e.code === 'unreachable' || e.code === 'transport')) W.unreachable(() => W.open(path));
      else W.picker({ error: e, path });
    }
  };
  W.boot = async function () {
    const q = new URLSearchParams(location.search);
    if (q.get('skin')) prefs().set('skin', F.skinName(q.get('skin')));
    if (q.get('lang')) Git.setLang(q.get('lang'));
    applySkin(prefs().get('skin', 'default'));
    state.right = prefs().get('wb.right', true) !== false;
    state.rightView = prefs().get('wb.rightView', 'commit') === 'files' ? 'files' : 'commit';
    state.git = prefs().get('wb.git', true) !== false;
    // `tab`: a view a host registers (Git.views.tab, the Orca center tab) that shows one page full size
    W.view = ['commit', 'log', 'console', 'branches', 'files', 'tab'].indexOf(q.get('view')) >= 0 ? q.get('view') : null;
    document.documentElement.classList.toggle('wb-is-single', !!W.view);
    // `repo=` present but empty: the host's project has no folder. Say so instead of opening another project's
    // last repository.
    if (q.has('repo') && !q.get('repo')) {
      message({ title: t('This project has no folder.'), text: t('Choose a folder for the project to see its repository here.') });
      return;
    }
    let path = q.get('repo') || prefs().get('lastRepo', null);
    if (!path) {
      try {
        const recent = (await Git.backend.call('repos.recent', {})).repos || [];
        const first = recent.find((r) => r.exists);
        path = first ? first.root : null;
      } catch (e) {
        if (e && (e.code === 'unreachable' || e.code === 'transport')) { W.unreachable(() => W.boot()); return; }
      }
    }
    if (path) W.open(path); else W.picker();
  };

  // ---------------------------------------------------------------- keys and visibility
  document.addEventListener('keydown', (e) => {
    if (W.mode !== 'workbench') return;
    const mod = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
    if (e.key === 'Escape' && e.shiftKey && state.git) { e.preventDefault(); F.toggleGit(false); }
    else if (mod && e.key === '9') { e.preventDefault(); F.toggleGit(); }
    else if (mod && e.key === '0') { e.preventDefault(); F.showRight('commit', 'toggle'); }
    else if (mod && e.key.toLowerCase() === 'k' && Git.actions.checkinProject) { e.preventDefault(); Git.actions.checkinProject(); }
    else if (mod && e.key === '1' && Git.views.files) { e.preventDefault(); F.showRight('files', 'toggle'); }
    else if (mod && e.key.toLowerCase() === 'w' && state.current) { e.preventDefault(); Tabs.close(state.current); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Git.repo.root && Git.store.status === 'ready') Git.store.refresh(); });
  Git.on('store', (ev) => { if (ev && ev.error && Git.store.status === 'ready' && ev.error.code) Git.actions.errorNotice(ev.error); });
})();
