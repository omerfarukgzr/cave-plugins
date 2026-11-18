/* The Commit view (IntelliJ's Commit tool window): toolbar, the changes tree, then the Amend row, the message
   and the two buttons. The lower half's logic (message, Amend, history, commit checks) is in commit-message.js; the
   dialogs (Rollback Changes, Delete) are in commit-dialogs.js; the Git ▸ submenu and the menus it shares with the
   Files tool window are in changes-menus.js. State lives in Git._commit.S, by path, outside the DOM, so every redraw
   after a snapshot change shows the same ticks.
   Git.views.commit = { mount(el), order(), included(), optionsMenu(anchor), locate() } */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const R = Git.repo;
  const C = (Git._commit = Git._commit || {});
  Git.views = Git.views || {};
  const prefs = () => Git.host.prefs;

  Git.addTR({
    'Changes': 'Değişiklikler', 'Unversioned Files': 'Takip edilmeyen dosyalar', 'Merge Conflicts': 'Merge çakışmaları', 'Resolve': 'Çöz',
    '1 file': '1 dosya', '{0} files': '{0} dosya', 'Ignored Files': 'Yok sayılan dosyalar', 'Show': 'Göster',
    'Refresh': 'Yenile', 'Rollback…': 'Geri al…', 'Rollback': 'Geri al', 'View Options': 'Görünüm seçenekleri', 'Group By': 'Grupla',
    'Directory': 'Klasör', 'Expand All': 'Tümünü aç', 'Collapse All': 'Tümünü kapat', 'Select Opened File in Changes View': 'Açık dosyayı değişikliklerde seç',
    'Show Diff': 'Diff\'i göster', 'Show Diff in a New Tab': 'Diff\'i yeni sekmede göster', 'Jump to Source': 'Kaynağa git', 'Show History': 'Geçmişi göster',
    'Add to VCS': 'Git\'e ekle', 'Delete…': 'Sil…', 'Annotate with Git Blame': 'Git Blame ile annotate et', 'Git': 'Git', 'Merge…': 'Merge…',
    'Accept Theirs': 'Onlarınkini al', 'Accept Yours': 'Seninkini al',
    'Amend': 'Amend', 'Commit Message': 'Commit mesajı', 'Commit': 'Commit', 'Commit and Push…': 'Commit ve Push…',
    'Amend Commit': 'Amend commit', 'Amend Commit and Push…': 'Amend commit ve Push…', 'Loading amended commit…': 'Amend edilecek commit yükleniyor…',
    'Options': 'Seçenekler', 'Show on Double-Click': 'Çift tıklayınca göster', 'Diff': 'Diff', 'Source': 'Kaynak',
  });

  let unsubs = [], ro = null;
  const S = () => C.S;
  const ign = { on: String(prefs().get('commit.ignored', '0')) === '1', list: [], truncated: false, seq: 0 };

  // ---------------------------------------------------------------- what the tree shows
  const countText = (n) => (n === 1 ? t('1 file') : t('{0} files', n));
  const M = () => Git.changesModel;
  const byName = (a, b) => M().byName(Git.fileName(a.path), Git.fileName(b.path)) || M().byName(a.path, b.path);
  const tri = (files) => {
    let n = 0;
    for (let i = 0; i < files.length; i++) if (S().included.has(files[i].path)) n++;
    return n === 0 ? false : n === files.length ? true : 'mixed';
  };
  let cache = { local: null, version: null, sets: null, index: null };
  /** Local changes, unversioned files and conflicts, sorted the way IntelliJ lists them (cached per snapshot). */
  function sets() {
    if (cache.local === R.local && cache.version === R.version && cache.sets) return cache.sets;
    const conflicts = Git.conflicts();
    const changes = [], unversioned = [];
    R.local.forEach((f) => (f.status === '?' ? unversioned : changes).push(f));
    const mark = (list, set) => list.slice().sort(byName).map((f) => ({ path: f.path, status: f.status, oldPath: f.oldPath, set }));
    cache = { local: R.local, version: R.version, index: null,
      sets: { changes: mark(changes, 'f'), unversioned: mark(unversioned, 'u'), conflicts: mark(conflicts, 'c') } };
    return cache.sets;
  }
  /** path → local entry, built once per snapshot (Git.localFile is a linear search). */
  function local(path) {
    sets();
    if (!cache.index) { cache.index = new Map(); R.local.forEach((f) => cache.index.set(f.path, f)); }
    return cache.index.get(path) || null;
  }
  C.local = local;

  function mergeButton(path) {
    return h('button.gc-merge', { type: 'button', title: t('Merge…'), 'aria-label': t('Merge…'),
      onclick: (e) => { e.stopPropagation(); resolveFile(path); } }, Git.icon('vcs/merge'));
  }
  function fileNode(f) {
    const tip = f.oldPath ? f.oldPath + ' → ' + f.path : f.path;
    return { id: f.set + ':' + f.path, kind: 'file', label: Git.fileName(f.path), get icon() { return Git.fileIcon(f.path); }, tooltip: tip,
      color: Git.statusColor(f.set === 'c' ? 'C' : f.status), dim: S().group ? null : Git.dirName(f.path) || R.name,
      checked: f.set === 'a' ? undefined : S().included.has(f.path), right: f.set === 'c' ? mergeButton(f.path) : null, data: { files: [f] } };
  }
  /** Group By Directory: the repository root, then folders; a chain of folders with nothing else in it is one row. */
  function dirNodes(files, set) {
    const conv = (x) => (x.kind === 'file' ? fileNode(x.file) : { id: 'd:' + set + ':' + x.path, kind: 'dir', label: x.name, icon: 'nodes/folder',
      dim: countText(x.files.length), checked: set === 'a' ? undefined : tri(x.files), children: x.children.map(conv), data: { files: x.files, dir: x.path } });
    return [{ id: 'd:' + set + ':', kind: 'dir', label: R.name, icon: 'nodes/module', dim: countText(files.length), checked: set === 'a' ? undefined : tri(files),
      children: M().dirTree(files).map(conv), data: { files, dir: '' } }];
  }
  const fileNodes = (files, set) => (S().group && files.length ? dirNodes(files, set) : files.map(fileNode));

  /** The commit Amend changes: its files under their own node (they stay in the commit; no checkboxes). */
  function amendNode() {
    const a = S().amend && S().amendInfo;
    if (!a) return null;
    if (a.loading) return { id: 'amend', kind: 'none', label: t('Loading amended commit…'), italic: true };
    const files = a.files.map((f) => ({ path: f.path, status: f.status, oldPath: f.oldPath, set: 'a' })).sort(byName);
    return { id: 'amend', kind: 'group', label: a.subject, icon: 'vcs/commit', dim: Git.short(a.id) + '  ' + countText(files.length), children: fileNodes(files, 'a'), data: { files } };
  }
  /** View Options ▸ Ignored Files: the ignored files and folders (files.ignored) in the ignored color, no checkboxes. */
  function ignoredNode() {
    if (!ign.on || !ign.list.length) return null;
    const color = 'var(--g-ignored)';
    const kid = (e) => ({ id: 'i:' + e.path, kind: e.dir ? 'dir' : 'file', label: Git.fileName(e.path), color, tooltip: e.path,
      get icon() { return e.dir ? 'nodes/folder' : Git.fileIcon(e.path); }, dim: Git.dirName(e.path) || R.name, data: { files: [{ path: e.path, set: 'i', dir: e.dir }] } });
    let kids = null;                                    // built when the node is drawn open (up to 5 000 entries)
    return { id: 'ignored', kind: 'group', label: t('Ignored Files'), color, open: false, dim: countText(ign.list.length) + (ign.truncated ? '+' : ''),
      get children() { return kids || (kids = ign.list.map(kid)); }, data: { files: [] } };
  }
  function loadIgnored() {
    if (!ign.on || !R.root) { ign.list = []; return; }
    const my = ++ign.seq;
    Git.backend.call('files.ignored', { repo: R.root }).then((res) => {
      if (my !== ign.seq) return;
      ign.list = res.entries.slice().sort((a, b) => byName(a, b));
      ign.truncated = res.truncated;
      C.refresh();
    }, () => { if (my === ign.seq) { ign.list = []; C.refresh(); } });
  }

  // ---------------------------------------------------------------- the Changes row's "+120 −34" (changes.lineStats)
  // path → [added, deleted] (nulls: binary). Read on its own, after the snapshot, only while there are changes.
  const LINES_MAX_FILES = 5000;                         // more local changes than this: no line counts (a costly diff)
  const lines = { root: null, map: null, seq: 0, timer: 0 };
  function loadLines() {
    clearTimeout(lines.timer);
    const g = sets();
    if (!R.root || !g.changes.length || g.changes.length > LINES_MAX_FILES || R.localTruncated) {
      lines.seq++;
      if (lines.map) { lines.map = null; C.refresh(); }
      return;
    }
    const my = ++lines.seq, root = R.root;
    Git.backend.call('changes.lineStats', { repo: root }).then((res) => {
      if (my !== lines.seq || root !== R.root) return;
      const map = new Map();
      res.files.forEach((f) => map.set(f.path, [f.added, f.deleted]));
      lines.root = root; lines.map = map;
      C.refresh();
    }, () => { if (my === lines.seq) { lines.map = null; C.refresh(); } });
  }
  const loadLinesSoon = () => { clearTimeout(lines.timer); lines.timer = setTimeout(loadLines, 300); };
  /** "+120 −34" for the files of the Changes group, or null (not read yet, only binary files, nothing counted). */
  function linesNode(files) {
    if (!lines.map || lines.root !== R.root) return null;
    let add = 0, del = 0;
    files.forEach((f) => { const n = lines.map.get(f.path); if (n && n[0] != null) { add += n[0]; del += n[1]; } });
    if (!add && !del) return null;
    return h('span.gc-lines', h('span.gc-lines-add', '+' + add), ' ', h('span.gc-lines-del', '−' + del));
  }

  function nodes() {
    const g = sets(), all = g.conflicts.concat(g.changes), out = [];
    if (!all.length) out.push({ id: 'changes', kind: 'none', label: t('Changes'), bold: true });
    else {
      const kids = [];
      if (g.conflicts.length) {
        kids.push({ id: 'conflicts', kind: 'group', label: t('Merge Conflicts'), bold: true, children: g.conflicts.map(fileNode),
          right: h('button.g-link.gc-resolve', { type: 'button', id: 'gc-resolve', onclick: (e) => { e.stopPropagation(); Git.actions.resolveFromCommitView(); } }, t('Resolve')),
          data: { files: g.conflicts } });
      }
      const stat = linesNode(g.changes);
      out.push({ id: 'changes', kind: 'group', label: t('Changes'), bold: true, dim: stat ? h('span', countText(all.length), stat) : countText(all.length), checked: tri(g.changes.length ? g.changes : all),
        children: kids.concat(fileNodes(g.changes, 'f')), data: { files: all } });
    }
    const amend = amendNode();
    if (amend) out.push(amend);
    if (g.unversioned.length) {
      out.push({ id: 'unversioned', kind: 'group', label: t('Unversioned Files'), dim: countText(g.unversioned.length), checked: tri(g.unversioned), open: false,
        children: fileNodes(g.unversioned, 'u'), data: { files: g.unversioned } });
    }
    const ignored = ignoredNode();
    if (ignored) out.push(ignored);
    return out;
  }

  /** The files a selection stands for, in tree order, each once. */
  function pick(list) {
    const seen = new Set(), files = [];
    (list || []).forEach((n) => ((n.data && n.data.files) || []).forEach((f) => { if (!seen.has(f.set + f.path)) { seen.add(f.set + f.path); files.push(f); } }));
    const of = (set) => files.filter((f) => f.set === set).map((f) => f.path);
    return { files, changed: of('f').filter((p) => local(p)), unversioned: of('u'), conflicts: of('c'), amended: files.filter((f) => f.set === 'a'), ignored: of('i') };
  }

  // ---------------------------------------------------------------- what a row does
  function resolveFile(path) {
    if (Git.mergeTool && Git.mergeTool.open) Git.mergeTool.open(path); else Git.actions.resolveFromCommitView();
  }
  /** `o.preview`: the selection moved while a diff shows in the centre (the diff follows, the focus stays here). */
  function openDiff(f, o) {
    if (!f) return;
    const preview = !!(o && o.preview);
    if (f.set === 'c') { resolveFile(f.path); return; }
    if (f.set === 'i') { if (!f.dir) Git.actions.jumpToSource(f.path); return; }
    if (f.set === 'a') { const a = S().amendInfo; if (a) Git.actions.showCommitDiff(a.id, f.path, { files: a.files.map((x) => x.path), preview }); return; }
    Git.actions.showLocalDiff(f.path, { preview });
  }
  const jumpable = (files) => files.filter((f) => f.status !== 'D' && f.set !== 'c' && !f.dir);
  function jump(files) { jumpable(files).slice(0, 10).forEach((f) => Git.actions.jumpToSource(f.path)); }
  const tracked = (f) => f.set !== 'u' && f.set !== 'i' && f.status !== 'A';
  function rollbackSelection() {
    const sel = C.ui ? pick(C.ui.tree.selected()) : { changed: [] };
    Git.actions.rollback(sel.changed.length ? sel.changed : Git.localChanges().map((f) => f.path));
  }
  function diffSelection() {
    const sel = C.ui ? pick(C.ui.tree.selected()) : { files: [] };
    const f = sel.files[0] || sets().changes[0] || sets().unversioned[0];
    openDiff(f);
  }
  function deletable(sel) { return sel.files.filter((f) => f.set === 'f' || f.set === 'u' || f.set === 'i').filter((f) => f.status !== 'D').map((f) => f.path); }

  /** ⋮ Options ▸ Show on Double-Click: Diff (default) or Source. */
  const dblSource = () => prefs().get('commit.dblclick', 'diff') === 'source';
  function onActivate(node, ev) {
    if (node.kind === 'file') {
      const f = node.data.files[0];
      if (ev && ev.type === 'dblclick' && dblSource() && f.set !== 'c') jump([f]); else openDiff(f);
    } else if (node.children && node.children.length) C.ui.tree.toggle(node.id);
  }
  /** One file picked (a click, the arrow keys): the diff in the centre, if one shows, switches to it (A §5.1 preview);
      a conflict or an ignored file never opens by a single click. */
  function onPick(node) {
    if (node.kind !== 'file' || !Git.centre) return;
    const f = node.data.files[0];
    if (!f || (f.set !== 'f' && f.set !== 'u' && f.set !== 'a')) return;
    Git.centre.preview(() => openDiff(f, { preview: true }));
  }
  function onCheck(node, on) {
    ((node.data && node.data.files) || []).forEach((f) => { if (f.set !== 'a' && f.set !== 'c' && f.set !== 'i') { if (on) S().included.add(f.path); else S().included.delete(f.path); } });
    if (S().error) S().error = C.problem();
    C.refresh();
    Git.emit('included', { from: 'commit' });           // the local diff's header checkbox follows
  }
  /** ChangesViewPopupMenu with the git additions (D §6.1): conflicts first, then IntelliJ's order. */
  function onContext(node, ev, selected) {
    const sel = pick(selected.length && selected.indexOf(node) >= 0 ? selected : [node]);
    if (!sel.files.length) return;
    const A = Git.actions, one = sel.files.length === 1 ? sel.files[0] : null;
    const items = [];
    if (sel.conflicts.length) {
      items.push({ label: t('Merge…'), action: () => resolveFile(sel.conflicts[0]) },
        { label: t('Accept Theirs'), disabled: !A.acceptSide, action: () => A.acceptSide(sel.conflicts, 'theirs') },
        { label: t('Accept Yours'), disabled: !A.acceptSide, action: () => A.acceptSide(sel.conflicts, 'yours') }, '-');
    }
    const diffable = sel.files.find((f) => f.set === 'f' || f.set === 'u' || f.set === 'a');
    const committable = sel.changed.concat(sel.unversioned);
    items.push({ label: t('Commit File…'), disabled: !committable.length, action: () => A.commitFiles(committable) });
    items.push({ label: t('Rollback…'), shortcut: '⌥⌘Z', disabled: !sel.changed.length, action: () => A.rollback(sel.changed) });
    items.push({ label: t('Show Diff'), shortcut: '⌘D', disabled: !diffable, action: () => openDiff(diffable) });
    items.push({ label: t('Show Diff in a New Tab'), disabled: !(diffable && diffable.set !== 'a'), action: () => A.showDiffInNewTab(diffable.path) });
    items.push({ label: t('Jump to Source'), shortcut: '⌘↓', disabled: !jumpable(sel.files).length, action: () => jump(sel.files) });
    items.push({ label: t('Copy Path/Reference…'), action: () => Git.changesMenus.copyPath(ev, sel.files.map((f) => f.path)) });
    const del = deletable(sel);
    items.push('-', { label: t('Delete…'), shortcut: '⌫', disabled: !del.length, action: () => A.deleteFiles(del) },
      { label: t('Add to VCS'), shortcut: '⌥⌘A', disabled: !sel.unversioned.length, action: () => A.addToVcs(sel.unversioned) });
    if (sel.unversioned.length) items.push({ label: t('Add to .gitignore'), children: Git.changesMenus.ignoreItems(sel.unversioned) });
    items.push('-', { label: t('Refresh'), action: () => refreshNow() });
    const file = one && one.set !== 'i' && !one.dir ? one.path : null;
    const git = Git.changesMenus.gitItems({ file, tracked: !!(one && tracked(one)), deleted: !!(one && one.status === 'D'), conflict: !!(one && one.set === 'c'),
      changed: sel.changed, unversioned: sel.unversioned, history: one && tracked(one) && one.set !== 'c' ? one.path : null,
      annotated: !!(file && Git.annotate && Git.annotate.isOn(file)) });
    items.push('-', { label: t('Git'), children: git });
    Git.menu(ev, items);
  }
  function onKey(e, selected) {
    const sel = pick(selected), cmd = e.metaKey || e.ctrlKey;
    const run = (fn) => { e.preventDefault(); fn(); };
    if (cmd && !e.altKey && e.code === 'KeyD') run(() => openDiff(sel.files[0]));
    else if (e.key === 'F4' || (cmd && e.key === 'ArrowDown')) run(() => jump(sel.files));
    else if (cmd && e.altKey && e.code === 'KeyZ') run(() => { if (sel.changed.length) Git.actions.rollback(sel.changed); });
    else if (cmd && e.altKey && e.code === 'KeyA') run(() => { if (sel.unversioned.length) Git.actions.addToVcs(sel.unversioned); });
    else if (e.key === 'Backspace' || e.key === 'Delete') { const del = deletable(sel); if (del.length) run(() => Git.actions.deleteFiles(del)); }
  }
  function refreshNow() {
    if (Git.store && Git.store.refresh) Git.store.refresh();
    C.follow();
    loadIgnored();
    loadLinesSoon();
    C.refresh();
  }
  /** The path of the active editor tab (a local diff or the file view), for Select Opened File. */
  function openedPath() {
    const id = Git.tabs && Git.tabs.active();
    if (!id) return null;
    if (id.indexOf('file:') === 0) return id.slice(5).split('@')[0];
    const tab = Git.diffTab && Git.diffTab.tab(id);
    return tab && tab.spec && tab.spec.kind === 'local' ? tab.spec.path : null;
  }
  /** Select Opened File in Changes View: opens the nodes down to the file's row and selects it. */
  function locate() {
    const path = openedPath();
    if (!path || !C.ui) return false;
    const trail = [];
    const find = (list) => list.some((n) => {
      if (n.kind === 'file' && n.data.files[0].path === path) { trail.push(n.id); return true; }
      if (n.children && find(n.children)) { trail.unshift(n.id); return true; }
      return false;
    });
    if (!find(nodes())) return false;
    trail.slice(0, -1).forEach((id) => C.ui.tree.toggle(id, true));
    C.ui.tree.select(trail[trail.length - 1]);
    return true;
  }

  /** ⋮ Options of the tool window header (CommitView.GearActions). */
  function optionsMenu(anchor) {
    const set = (v) => prefs().set('commit.dblclick', v);
    Git.menu(anchor, [{ label: t('Show on Double-Click'), children: [
      { label: t('Diff'), checked: !dblSource(), action: () => set('diff') },
      { label: t('Source'), checked: dblSource(), action: () => set('source') }] }]);
  }

  // ---------------------------------------------------------------- drawing
  /** Files ticked for the commit (changed and unversioned ones that are still there). */
  C.commitPaths = function () {
    const g = sets(), out = [];
    g.changes.concat(g.unversioned).forEach((f) => { if (S().included.has(f.path) && local(f.path)) out.push(f.path); });
    return out;
  };
  C.updateBottom = function () {
    const ui = C.ui;
    if (!ui) return;
    const g = sets(), st = S();
    Git.changesLegend(ui.legend, g.changes.concat(g.unversioned).filter((f) => st.included.has(f.path)).map((f) => (f.set === 'u' ? { status: '?' } : f)));
    ui.amend.querySelector('input').checked = st.amend;
    ui.amend.classList.toggle('disabled', !C.headCommit());
    ui.amend.querySelector('input').disabled = !C.headCommit();
    ui.amendLink.disabled = !C.headCommit();
    ui.commit.textContent = t(st.amend ? 'Amend Commit' : 'Commit');
    ui.push.textContent = t(st.amend ? 'Amend Commit and Push…' : 'Commit and Push…');
    ui.push.title = ui.push.textContent;
    ui.history.disabled = !C.messages().length;
    ui.rollback.disabled = !Git.localChanges().length;
    ui.showDiff.disabled = !R.local.length && !Git.conflicts().length;
    if (st.error) st.error = C.problem();             // the reason follows what the user fixes
    ui.error.hidden = !st.error;
    ui.error.lastChild.textContent = st.error ? t(st.error) : '';
    Git.clear(ui.check);
    const row = C.checkRow();
    if (row) ui.check.appendChild(row);
    ui.check.hidden = !row;
  };
  C.refresh = function () {
    if (!C.ui) return;
    C.ui.tree.render();
    C.updateBottom();
  };

  function build(el) {
    const st = S();
    const tool = (icon, label, id, onClick) => Git.toolBtn({ icon, title: label, id, onClick });
    const view = tool('general/show', t('View Options'), 'gc-view', (e) => Git.menu(e.currentTarget, [
      { label: t('Group By'), children: [{ header: t('Group By'), label: t('Group By'), disabled: true },
        { label: t('Directory'), shortcut: '⌃P', checked: st.group, action: () => { st.group = !st.group; prefs().set('commit-group', st.group ? '1' : '0'); C.refresh(); } }] },
      { header: t('Show'), label: t('Show'), disabled: true },
      { label: t('Ignored Files'), checked: ign.on, action: () => { ign.on = !ign.on; prefs().set('commit.ignored', ign.on ? '1' : '0'); loadIgnored(); C.refresh(); } }]
      .concat(Git.options ? Git.options.rows() : Git.languageMenu())));   // the language and Report a Problem live in the header's Options button (options.js); here only on a page without one
    view.classList.add('gc-view');
    const rollback = tool('vcs/revert', t('Rollback…') + '  ⌥⌘Z', 'gc-rollback', rollbackSelection);
    const showDiff = tool('vcs/diff', t('Show Diff') + '  ⌘D', 'gc-diff', diffSelection);
    const locateBtn = tool('general/locate', t('Select Opened File in Changes View'), 'gc-locate', locate);
    const bar = h('div.g-toolbar.gc-toolbar', { role: 'toolbar', 'aria-label': t('Commit') },
      tool('general/refresh', t('Refresh'), 'gc-refresh', refreshNow), rollback, showDiff, view, h('span.g-toolbar-sep'), locateBtn,
      tool('general/expandAll', t('Expand All'), 'gc-expand', () => C.ui.tree.expandAll()),
      tool('general/collapseAll', t('Collapse All'), 'gc-collapse', () => C.ui.tree.collapseAll()));

    const treeEl = h('div.gc-tree', { 'aria-label': t('Changes') });
    const amend = Git.checkbox({ id: 'gc-amend', label: t('Amend'), checked: st.amend, onChange: (v) => C.setAmend(v) });
    const amendLink = h('button.g-link.gc-amend-link', { type: 'button', id: 'gc-amend-link', onclick: (e) => C.amendMenu(e.currentTarget) },
      h('span', t('last commit')), Git.icon('chevronDownSmall', 12));
    const history = tool('general/history', t('Commit Message History'), 'gc-history', (e) => C.historyPopup(e.currentTarget));
    const legend = h('span.gc-legend');
    const field = Git.field({ id: 'gc-message', multiline: true, mono: true, placeholder: t('Commit Message'), value: st.message,
      onInput: (v) => { C.typed(v); if (st.error || st.check) { st.check = null; C.updateBottom(); } } });
    field.classList.add('gc-msg');
    field.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.altKey) { e.preventDefault(); C.commitNow(false); }
      else if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyK') { e.preventDefault(); C.commitNow(true); }
    });
    const error = h('div.gc-error', { role: 'alert', hidden: true }, Git.icon('status/error'), h('span'));
    const check = h('div.gc-checks', { hidden: true });
    const commit = Git.btn(t('Commit'), { primary: true, id: 'gc-commit', onClick: () => C.commitNow(false) });
    const push = Git.btn(t('Commit and Push…'), { id: 'gc-push', onClick: () => C.commitNow(true) });
    const bottom = h('div.gc-bottom',
      h('div.gc-amend', amend, amendLink, history, legend),
      h('div.gc-area', field, error, check, h('div.gc-buttons', commit, push)));

    Git.clear(el);
    el.classList.add('gc-root');
    el.appendChild(bar);
    el.appendChild(treeEl);
    el.appendChild(Git.splitter({ target: bottom, edge: 'top', min: 150, max: () => Math.max(170, (el.clientHeight || 900) - 130), key: 'commit-bottom' }));
    el.appendChild(bottom);
    C.ui = { el, msg: field.input, amend, amendLink, history, legend, error, check, commit, push, rollback, showDiff, locate: locateBtn };
    C.ui.tree = Git.tree({ el: treeEl, nodes, multi: true, dragSelect: !!C.dragDrop, onActivate, onPick, onContext, onCheck, onKey });
    if (C.dragDrop) C.dragDrop(treeEl, C.ui.tree);      // files dragged between Changes and Unversioned Files (commit-drag.js)
  }
  /** Balloons stay left of the right column (IntelliJ shows them in the editor area's corner, not over a tool window). */
  function watchColumn(el) {
    if (ro) { ro.disconnect(); ro = null; }
    const col = el.closest && el.closest('.wb-right');
    const set = () => document.documentElement.style.setProperty('--gc-right-edge', col && !col.hidden && col.offsetWidth ? Math.max(0, window.innerWidth - col.getBoundingClientRect().left) + 'px' : '0px');
    set();
    if (col && window.ResizeObserver) { ro = new ResizeObserver(set); ro.observe(col); }
    return set;
  }

  Git.views.commit = {
    /** Paths of the changed and unversioned files in the order the tree lists them (the diff tab walks files in this order). */
    order() {
      const out = [];
      const walk = (list) => list.forEach((n) => {
        if (n.children) walk(n.children);
        else if (n.kind === 'file' && n.data.files[0].set !== 'c' && n.data.files[0].set !== 'a' && n.data.files[0].set !== 'i') out.push(n.data.files[0].path);
      });
      walk(nodes());
      return out;
    },
    /** Fills the body of the right column's Commit view. Called again whenever the frame is rebuilt (skin, language). */
    mount(el) {
      unsubs.forEach((off) => off());
      build(el);
      C.follow();
      loadIgnored();
      loadLines();
      C.refresh();
      const edge = watchColumn(el);
      let soon = 0;
      unsubs = [
        Git.on('change', (ev) => {
          if (ev && ev.reason === 'log' && !S().amend) { C.updateBottom(); return; }
          C.follow(); C.refresh();
          if (ign.on && ev && (ev.reason !== 'log')) { clearTimeout(soon); soon = setTimeout(loadIgnored, 300); }
          if (ev && ev.reason !== 'log') loadLinesSoon();
        }),
        // a changed file's content moved (the snapshot stays the same while a modified file is edited again)
        Git.on('files', (ev) => { if (!ev || !ev.paths || ev.paths.some((p) => local(p))) loadLinesSoon(); }),
        Git.on('commit-message', (text) => { S().amend = false; S().amendInfo = null; S().error = null; C.setMessage(text, true); C.refresh(); if (C.ui) C.ui.msg.focus(); }),
        Git.on('right', () => setTimeout(edge, 0)),
        Git.on('included', (ev) => { if (!(ev && ev.from === 'commit')) C.refresh(); }),
        Git.on('ignored', () => loadIgnored()),
      ];
      window.addEventListener('resize', edge);
      unsubs.push(() => window.removeEventListener('resize', edge));
    },
    /** Test and host access: the paths ticked for the commit. */
    included: () => Array.from(S().included),
    optionsMenu,
    locate,
  };
})();
