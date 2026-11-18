/* The Stash tab beside Commit (IntelliJ's GitStashContentProvider / SavedPatchesUi; docs/spec-stash.md §3): the list
   of stashes on top, the selected stash's files below with their toolbar, and the Apply / Pop strip. Shown while the
   repository has stashes (the tab hides with the last one, as IntelliJ's does, unless it is the tab being looked at).
     Git.views.stash.mount(el)                       the tab's body
     Git.stashTab.attach({ head, commit, stash })    the Commit view header's Commit | Stash tabs (workbench.js)
     Git.stashTab.show(id?) · .apply() · .active()   select the Stash tab (and a stash) · redraw · 'commit' | 'stash' */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const R = Git.repo, A = Git.actions;
  const prefs = () => Git.host.prefs;

  Git.addTR({
    'Pop': 'Pop', 'Unstash…': 'Unstash…', 'Show Diff with Local': 'Yerel sürümle karşılaştır', 'Compare with Local': 'Yerel sürümle karşılaştır',
    'No stashes or shelves added.': 'Hiç stash ya da shelf eklenmedi.', 'Getting started with Stash and Shelf': 'Stash ve Shelf\'e başlarken',
    'Select stash or shelf to view files': 'Dosyaları görmek için bir stash ya da shelf seç', 'Loading…': 'Yükleniyor…',
    '{0} created on {1} at {2}': '{0}, {1} tarihinde {2} saatinde oluşturuldu',
    'Apply — apply and keep the stash in the list.\nPop — apply and remove the stash from the list.':
      'Apply: uygula ve stash\'i listede tut.\nPop: uygula ve stash\'i listeden kaldır.',
    'Stashes are shared by all worktrees of this repository': 'Stash\'ler bu deponun bütün worktree\'lerinde ortaktır',
    'Stashes': 'Stash\'ler',
  });

  const st = { sel: null, loading: false, loaded: false, group: String(prefs().get('stash.group', '1')) !== '0' };
  let ui = null;
  const list = () => A.stashes();
  const current = () => list().find((s) => s.id === st.sel) || list()[0] || null;

  /** DateFormatUtil.formatDateTime: the date in the language's short order and the time ("11.02.26, 15:52"). */
  function dateTime(ms) {
    const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
    const date = Git.dateOrder() === 'dmy' ? p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + String(d.getFullYear()).slice(2)
      : (d.getMonth() + 1) + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(2);
    return { date, time: p(d.getHours()) + ':' + p(d.getMinutes()) };
  }
  /** GitStashBranchComponent: the tag icon and the branch, in the current branch's colour when it is the current one. */
  function branchLabel(s) {
    if (!s.branch || !Git.logUI || !Git.logUI.tagIcon) return null;
    const color = Git.logUI.refColor(s.branch === R.head.branch ? 'head' : 'local');
    return h('span.gs-branch', { title: s.branch }, Git.logUI.tagIcon([color]), h('span.gs-branch-text', s.branch));
  }

  // ---------------------------------------------------------------- the list (top)
  function listNodes() {
    return list().map((s) => {
      const dt = dateTime(s.time);
      return { id: s.id, kind: 'stash', label: s.message || s.subject, dim: dt.date + ', ' + dt.time, right: branchLabel(s),
        tooltip: t('{0} created on {1} at {2}', A.stashRef(s), dt.date, dt.time), data: { stash: s } };
    });
  }
  function rowMenu(node, ev) {
    const s = node.data.stash;
    pick(s.id);
    const first = firstFile(s);
    Git.menu(ev, [
      { label: t('Pop'), action: () => A.stashPop(s) },
      { label: t('Apply'), action: () => A.stashApply(s) },
      { label: t('Unstash…'), action: () => A.unstashAs(s) },
      { label: t('Drop'), shortcut: '⌫', action: () => Git.dialogs.stashDrop(s) },
      { label: t('Clear'), action: () => Git.dialogs.stashClear() },
      '-',
      { label: t('Show Diff'), shortcut: '⌘D', disabled: !first, action: () => openDiff(s, first) },
      { label: t('Show Diff in a New Tab'), disabled: !first, action: () => openDiff(s, first, { newTab: true }) },
      { label: t('Compare with Local'), disabled: !first, action: () => openDiff(s, first) },
    ]);
  }
  function pick(id) {
    if (st.sel === id) return;
    st.sel = id;
    if (ui) { ui.list.select([id], true); drawFiles(); }
  }

  // ---------------------------------------------------------------- the files (bottom)
  const M = () => Git.changesModel;
  const countText = (n) => (n === 1 ? t('1 file') : t('{0} files', n));
  /** "Index on main" / "Untracked files on main": the parent commit's subject before ':' (GitStashProvider). */
  const partLabel = (s, part) => t(part === 'index' ? 'Index on {0}' : 'Untracked files on {0}', s.branch || '');
  function fileNode(s, part, c) {
    return { id: part + ':' + c.path, kind: 'file', label: Git.fileName(c.path), get icon() { return Git.fileIcon(c.path); },
      color: Git.statusColor(c.status), dim: st.group ? null : Git.dirName(c.path) || R.name, tooltip: c.oldPath ? c.oldPath + ' → ' + c.path : c.path,
      data: { stash: s, part, change: c } };
  }
  function grouped(s, part, changes) {
    if (!st.group || !changes.length) return changes.map((c) => fileNode(s, part, c));
    const byPath = new Map(changes.map((c) => [c.path, c]));
    const conv = (x) => (x.kind === 'file' ? fileNode(s, part, byPath.get(x.file.path)) : { id: part + ':d:' + x.path, kind: 'dir', label: x.name, icon: 'nodes/folder',
      dim: countText(x.files.length), children: x.children.map(conv) });
    return [{ id: part + ':d:', kind: 'dir', label: R.name, icon: 'nodes/module', dim: countText(changes.length), children: M().dirTree(changes.map((c) => ({ path: c.path, status: c.status }))).map(conv) }];
  }
  function fileNodes() {
    const s = current();
    if (!s || !s.files) return [];
    const f = s.files;
    const out = grouped(s, 'changes', f.changes || []);
    ['index', 'untracked'].forEach((part) => {
      const list = f[part] || [];
      if (list.length) out.push({ id: part, kind: 'group', label: partLabel(s, part), open: false, dim: countText(list.length), children: grouped(s, part, list) });
    });
    return out;
  }
  const allFiles = (s, part) => ((s.files && s.files[part]) || []).map((c) => c.path);
  function firstFile(s) {
    const f = s.files || {};
    for (const part of ['changes', 'untracked', 'index']) if ((f[part] || []).length) return { part, change: f[part][0] };
    return null;
  }
  /** A stashed file's diff (GitStashChange): the local file on the left, the stash's version on the right ("Stash@{0}"). */
  function openDiff(s, f, o) {
    if (!f) return;
    const partId = f.part === 'index' ? s.indexId : f.part === 'untracked' ? s.untrackedId : s.id;
    Git.open('diff', Object.assign({ kind: 'stash', stash: s.id, ref: A.stashTitle(s), part: f.part, rev: partId, path: f.change.path,
      status: f.change.status, oldPath: f.change.oldPath || null, files: allFiles(s, f.part), changes: (s.files && s.files[f.part]) || [] },
    o && o.newTab ? { tabId: 'diff:stash#' + Date.now() } : null, o && o.preview ? { preview: true } : null));
  }
  function selectedFile() {
    const n = ui && ui.files.selected()[0];
    if (n && n.kind === 'file') return { part: n.data.part, change: n.data.change };
    const s = current();
    return s ? firstFile(s) : null;
  }
  function drawFiles() {
    if (!ui) return;
    const s = current();
    ui.files.render();
    ui.filesEmpty.textContent = !s ? t('Select stash or shelf to view files') : !s.files ? t('Loading…') : '';
    ui.filesEmpty.hidden = !!(s && s.files && fileNodes().length);
    const none = !list().length;
    ui.bottom.hidden = none;
    ui.split.hidden = none;
    ui.apply.disabled = ui.pop.disabled = !s;
  }

  // ---------------------------------------------------------------- the view
  function build(el) {
    Git.clear(el);
    el.classList.add('gs-root');
    const listEl = h('div.gs-list-tree', { 'aria-label': t('Stashes') });
    const help = h('button.g-link.gs-help-link', { type: 'button', onclick: () => Git.host.openExternal && Git.host.openExternal('https://www.jetbrains.com/help/idea/shelving-and-unshelving-changes.html') },
      Git.icon('general/questionMark'), t('Getting started with Stash and Shelf'));
    const empty = h('div.gs-empty', h('div', t('No stashes or shelves added.')), help);
    const shared = h('div.gs-shared', t('Stashes are shared by all worktrees of this repository'));
    const top = h('div.gs-top', listEl, empty, shared);
    const tool = (icon, label, id, onClick) => Git.toolBtn({ icon, title: label, id, onClick });
    const view = tool('general/show', t('View Options'), 'gs-view', (e) => Git.menu(e.currentTarget, [
      { label: t('Group By'), children: [{ header: t('Group By'), label: t('Group By'), disabled: true },
        { label: t('Directory'), checked: st.group, action: () => { st.group = !st.group; prefs().set('stash.group', st.group ? '1' : '0'); drawFiles(); } }] }]));
    const bar = h('div.g-toolbar.gs-toolbar', { role: 'toolbar' },
      tool('vcs/diff', t('Show Diff') + '  ⌘D', 'gs-diff', () => { const s = current(); if (s) openDiff(s, selectedFile()); }), view,
      h('span.g-spacer'),
      tool('general/expandAll', t('Expand All'), 'gs-expand', () => ui.files.expandAll()),
      tool('general/collapseAll', t('Collapse All'), 'gs-collapse', () => ui.files.collapseAll()));
    const filesEl = h('div.gs-files', { 'aria-label': t('Changes') });
    const filesEmpty = h('div.gs-files-empty');
    const apply = Git.btn(t('Apply'), { primary: true, id: 'gs-apply', onClick: () => { const s = current(); if (s) A.stashApply(s); } });
    const pop = Git.btn(t('Pop'), { id: 'gs-pop', onClick: () => { const s = current(); if (s) A.stashPop(s); } });
    const tip = h('span.gs-tip', { title: t('Apply — apply and keep the stash in the list.\nPop — apply and remove the stash from the list.') }, Git.icon('general/questionMark'));
    const bottom = h('div.gs-bottom', bar, h('div.gs-files-wrap', filesEl, filesEmpty), h('div.gs-strip', apply, pop, tip));
    const split = Git.splitter({ target: bottom, edge: 'top', min: 120, max: () => Math.max(160, (el.clientHeight || 600) - 90), key: 'stash-split' });
    el.appendChild(top);
    el.appendChild(split);
    el.appendChild(bottom);
    if (!bottom.style.height) bottom.style.height = '50%';
    ui = { el, top, listEl, empty, shared, bottom, split, filesEmpty, apply, pop };
    ui.list = Git.tree({ el: listEl, nodes: listNodes,
      onSelect: (nodes) => { const n = nodes[0]; if (n && n.data && n.data.stash && st.sel !== n.id) { st.sel = n.id; drawFiles(); } },
      onActivate: (node) => { const s = node.data.stash; openDiff(s, firstFile(s)); },   // double-click / Enter: the diff of its files
      onContext: (node, ev) => rowMenu(node, ev),
      onKey: (e, sel) => {
        const s = sel[0] && sel[0].data && sel[0].data.stash;
        if (!s) return;
        if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); Git.dialogs.stashDrop(s); }
        else if ((e.metaKey || e.ctrlKey) && e.code === 'KeyD') { e.preventDefault(); openDiff(s, firstFile(s)); }
        else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); A.stashApply(s); }
      } });
    ui.files = Git.tree({ el: filesEl, nodes: fileNodes,
      onActivate: (node) => { if (node.kind === 'file') openDiff(node.data.stash, { part: node.data.part, change: node.data.change }); else if (node.children) ui.files.toggle(node.id); },
      onPick: (node) => { if (node.kind === 'file' && Git.centre) Git.centre.preview(() => openDiff(node.data.stash, { part: node.data.part, change: node.data.change }, { preview: true })); },
      onContext: (node, ev) => {
        if (node.kind !== 'file') return;
        const f = { part: node.data.part, change: node.data.change };
        Git.menu(ev, [{ label: t('Show Diff'), shortcut: '⌘D', action: () => openDiff(node.data.stash, f) },
          { label: t('Compare with Local'), action: () => openDiff(node.data.stash, f) },
          { label: t('Jump to Source'), shortcut: '⌘↓', disabled: f.change.status === 'D', action: () => A.jumpToSource(f.change.path) }]);
      } });
    redraw();
  }
  function redraw() {
    if (!ui) return;
    const l = list();
    if (l.length && !l.some((s) => s.id === st.sel)) st.sel = l[0].id;
    ui.list.render();
    if (st.sel) ui.list.select([st.sel], true);
    ui.empty.hidden = !!l.length || !st.loaded;
    ui.listEl.hidden = !l.length;
    const wts = Git.worktrees && Git.worktrees.list ? Git.worktrees.list() : null;
    ui.shared.hidden = !l.length || !((wts && wts.length > 1) || R.linked);
    drawFiles();
  }

  let unsubs = [];
  let seen = null;
  function load() {
    st.loading = true;
    return A.stashList().then(() => { st.loading = false; st.loaded = true; redraw(); if (Git.stashTab) Git.stashTab.apply(); });
  }
  Git.views = Git.views || {};
  Git.views.stash = {
    mount(el) {
      unsubs.forEach((off) => off());
      build(el);
      load();
      seen = (R.stashes || []).join(',');
      unsubs = [
        Git.on('change', () => { const now = (R.stashes || []).join(','); if (now !== seen) { seen = now; load(); } else redraw(); }),
        Git.on('stashes', () => redraw()),
      ];
    },
    select(id) { if (id) pick(id); },
  };

  // ---------------------------------------------------------------- the Commit | Stash tabs of the header
  const T = (Git.stashTab = {});
  let at = null;            // { head, commit, stash, mounted }
  let active = prefs().get('commit.tab', 'commit') === 'stash' ? 'stash' : 'commit';
  let sticky = false;       // the Stash tab stays while it is the one looked at, also after its last stash went
  T.active = () => active;
  const has = () => (R.stashes || []).length > 0;
  /** `title`: the view's own title element ("Commit"), hidden while the tabs show in `head` (an empty span beside it). */
  T.attach = function (o) {
    at = { head: o.head, title: o.title || null, commit: o.commit, stash: o.stash, mounted: false };
    T.apply();
  };
  T.tabsShown = () => !!at && (has() || (active === 'stash' && sticky));
  function select(tab) {
    active = tab;
    sticky = tab === 'stash';
    prefs().set('commit.tab', tab);
    T.apply();
  }
  T.show = function (id) {
    if (!at) return;
    if (Git.frame && Git.frame.showRight && Git.frame.rightView && Git.frame.rightView() === 'none') Git.frame.showRight('commit');
    select('stash');
    if (id && Git.views.stash) { const go = () => Git.views.stash.select(id); go(); A.stashList().then(go); }
  };
  T.apply = function () {
    if (!at || !at.head.isConnected && !at.commit.isConnected) return;
    const shown = has() || (active === 'stash' && sticky);
    if (!shown && active === 'stash') active = 'commit';
    Git.clear(at.head);
    at.head.hidden = !shown || !!at.hiddenByHost;
    if (at.title && !at.hiddenByHost) at.title.hidden = shown;
    if (shown) {
      const tab = (id, label) => h('div.g-tab', { class: active === id ? 'on' : '', role: 'tab', 'aria-selected': String(active === id), tabIndex: 0, dataset: { tab: id },
        onclick: () => select(id), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(id); } } }, h('span.g-tab-title', { lang: 'en' }, label));
      at.head.appendChild(h('div.g-dock-tabs.gs-tabs', { role: 'tablist' }, tab('commit', t('Commit')), tab('stash', t('Stash'))));
    }
    if (at.hiddenByHost) return;
    at.commit.hidden = active === 'stash';
    at.stash.hidden = active !== 'stash';
    if (active === 'stash' && !at.mounted && Git.views.stash) { at.mounted = true; Git.views.stash.mount(at.stash); }
  };
  /** The workbench hides both bodies while its right column shows Files. */
  T.hostHides = function (v) {
    if (!at) return;
    at.hiddenByHost = !!v;
    if (v) { at.commit.hidden = true; at.stash.hidden = true; at.head.hidden = true; if (at.title) at.title.hidden = false; } else T.apply();
  };
  Git.on('change', () => { if (at) T.apply(); });
})();
