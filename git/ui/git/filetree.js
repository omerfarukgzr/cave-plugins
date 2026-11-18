/* The Files tool window (IntelliJ's Project tool window, Turkish "Dosyalar"): the repository's files from
   files.list as a lazy virtual tree (Git.tree; a folder's rows are built the first time it opens, so 50 000 files open
   at once). Names in IntelliJ's file status colors (modified blue, added green, unversioned red-brown, conflict red,
   ignored olive from files.ignored; an ignored folder's inside is read when it opens), folders that hold changes tinted
   as IntelliJ's "Highlight directories that contain modified files" does. Double-click (or Enter) opens the file view;
   the context menu has IntelliJ's Git submenu (changes-menus.js).
   It stands in for the host's own file panel in the standalone workbench.
     Git.views.files = { mount(el), reload(), reveal(path), index() } */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const R = Git.repo;
  Git.views = Git.views || {};

  Git.addTR({
    'Files': 'Dosyalar', 'Project': 'Proje', 'Collapse All': 'Tümünü kapat', 'Select Opened File': 'Açık dosyayı seç', 'Refresh': 'Yenile',
    'Open': 'Aç', 'Git': 'Git', 'Show Diff': 'Diff\'i göster', 'Show History': 'Geçmişi göster', 'Annotate with Git Blame': 'Git Blame ile annotate et',
    'Close Annotations': 'Annotation\'ları kapat', 'Rollback…': 'Geri al…', 'Add to VCS': 'Git\'e ekle', 'Delete…': 'Sil…', 'Jump to Source': 'Kaynağa git',
    'The list was cut at {0} files': 'Liste {0} dosyada kesildi', 'Loading…': 'Yükleniyor…',
  });

  let ui = null, idx = null, status = null, loadSeq = 0, unsubs = [], timer = 0, cache = new Map(), version = 0;
  // ignored entries (files.ignored): folder path → [{ path, dir }]; the inside of an ignored folder is read when it opens
  let ignored = new Map(), inside = new Map();
  const IGNORED = 'var(--g-ignored)';
  const M = () => Git.changesModel;

  // ---------------------------------------------------------------- data
  function statusNow() {
    if (!status || status.local !== R.local || status.version !== R.version) {
      status = Object.assign(M().statusIndex(R.local, Git.conflicts()), { local: R.local, version: R.version });
      cache = new Map();            // colors moved: rebuild the node objects as they are asked for
    }
    return status;
  }
  /** Reads files.list again; the tree keeps what is open and selected. */
  function reload() {
    const my = ++loadSeq;
    const ign = Git.backend.call('files.ignored', { repo: R.root }).catch(() => ({ entries: [] }));
    return Promise.all([Git.backend.call('files.list', { repo: R.root }), ign]).then(([res, ig]) => {
      if (my !== loadSeq || !ui) return;
      idx = M().fileIndex(res);
      ignored = new Map(); inside = new Map();
      (ig.entries || []).forEach((e) => {
        const cut = e.path.lastIndexOf('/'), dir = cut < 0 ? '' : e.path.slice(0, cut);
        if (!ignored.has(dir)) ignored.set(dir, []);
        ignored.get(dir).push(e);
      });
      cache = new Map();
      version++;
      draw();
    }, (e) => {
      if (my !== loadSeq || !ui) return;
      Git.clear(ui.treeEl).appendChild(Git.content.failed(e));
    });
  }
  function soon() { clearTimeout(timer); timer = setTimeout(reload, 400); }

  // ---------------------------------------------------------------- nodes (lazy)
  const color = (st) => (st ? Git.statusColor(st) : null);
  function fileNode(f) {
    const st = statusNow().file.get(f.path) || (f.untracked ? '?' : null);
    return { id: 'f:' + f.path, kind: 'file', label: f.name, get icon() { return Git.fileIcon(f.path); }, color: color(st), tooltip: f.path,
      data: { path: f.path, dir: false, status: st } };
  }
  function dirNode(d) {
    const s = statusNow();
    const tint = s.conflictDirs.has(d.path) ? 'var(--g-conflict)' : s.dirs.has(d.path) ? 'var(--g-modified)' : null;
    return { id: 'd:' + d.path, kind: 'dir', label: d.name, icon: 'nodes/folder', color: tint, open: false, tooltip: d.path,
      data: { path: d.path, dir: true }, get children() { return childrenOf(d.path); } };
  }
  /** An ignored file or folder, in IntelliJ's ignored color (FILESTATUS_IGNORED); a folder's inside is read when it opens. */
  function ignoredNode(e) {
    const name = Git.fileName(e.path);
    if (!e.dir) return { id: 'f:' + e.path, kind: 'file', label: name, get icon() { return Git.fileIcon(e.path); }, color: IGNORED, tooltip: e.path, data: { path: e.path, dir: false, status: 'I', ignored: true } };
    return { id: 'd:' + e.path, kind: 'dir', label: name, icon: 'nodes/folder', color: IGNORED, open: false, tooltip: e.path, data: { path: e.path, dir: true, ignored: true },
      get children() { return inside.has(e.path) ? inside.get(e.path).map(ignoredNode) : [{ id: 'l:' + e.path, kind: 'none', label: t('Loading…'), italic: true, selectable: false, data: { path: '', dir: true } }]; } };
  }
  function loadInside(path) {
    if (inside.has(path)) return;
    Git.backend.call('files.ignored', { repo: R.root, path }).then((res) => {
      inside.set(path, res.entries);
      if (ui) ui.tree.render();
    }, () => { inside.set(path, []); if (ui) ui.tree.render(); });
  }
  /** The rows of folder `p`, built once per data version (a closed folder only needs to know it has some). */
  function childrenOf(p) {
    statusNow();
    let list = cache.get(p);
    if (!list) {
      const c = idx.children(p), extra = ignored.get(p) || [];
      const byName = (a, b) => M().byName(a.label, b.label);
      const dirs = c.dirs.map(dirNode).concat(extra.filter((e) => e.dir && !idx.has(e.path)).map(ignoredNode)).sort(byName);
      const files = c.files.map(fileNode).concat(extra.filter((e) => !e.dir).map(ignoredNode)).sort(byName);
      list = dirs.concat(files);
      cache.set(p, list);
    }
    return list;
  }
  function nodes() {
    if (!idx) return [];
    const root = { id: 'd:', kind: 'dir', label: R.name, icon: 'nodes/module', dim: R.root ? R.root.replace(/^\/Users\/[^/]+/, '~') : '', bold: true,
      data: { path: '', dir: true }, get children() { return childrenOf(''); } };
    return [root];
  }

  // ---------------------------------------------------------------- what a row does
  function open(path) { Git.actions.jumpToSource(path, {}); }
  /** Local changes at or below the selected rows. */
  function under(rows, pred) {
    const out = [];
    rows.forEach((n) => {
      const p = n.data.path;
      R.local.forEach((f) => { if ((n.data.dir ? !p || f.path === p || f.path.startsWith(p + '/') : f.path === p) && pred(f) && out.indexOf(f.path) < 0) out.push(f.path); });
    });
    return out;
  }
  function menuFor(node, ev, selected) {
    const rows = selected.length && selected.indexOf(node) >= 0 ? selected : [node];
    const A = Git.actions, one = rows.length === 1 ? rows[0] : null, file = one && !one.data.dir ? one.data : null;
    const st = file ? statusNow().file.get(file.path) || null : null;
    const changed = under(rows, (f) => f.status !== '?');
    const unversioned = under(rows, (f) => f.status === '?');
    const isTracked = file && !file.ignored && st !== '?' && st !== 'A';
    const annotated = file && Git.annotate && Git.annotate.isOn(file.path);
    // IntelliJ's Git ▸ (Git.ContextMenu), shared with the Commit view (changes-menus.js)
    const git = Git.changesMenus.gitItems({ file: file ? file.path : null, tracked: !!isTracked, deleted: st === 'D', conflict: st === 'C',
      changed, unversioned, history: one && !one.data.ignored && (one.data.dir || isTracked) ? one.data.path : null, annotated: !!annotated });
    const paths = rows.map((n) => n.data.path).filter(Boolean);
    Git.menu(ev, [
      { label: t('Jump to Source'), shortcut: '⌘↓', disabled: !rows.some((n) => !n.data.dir), action: () => rows.filter((n) => !n.data.dir).slice(0, 10).forEach((n) => open(n.data.path)) },
      '-',
      { label: t('Delete…'), shortcut: '⌫', disabled: !paths.length, action: () => Git.dialogs.deleteFiles(paths, { folder: rows.length === 1 && rows[0].data.dir }) },
      '-',
      { label: t('Git'), children: git },
    ]);
  }
  function onKey(e, selected) {
    const cmd = e.metaKey || e.ctrlKey, A = Git.actions;
    const file = selected.length === 1 && !selected[0].data.dir ? selected[0].data.path : null;
    const run = (fn) => { e.preventDefault(); fn(); };
    if ((e.key === 'F4' || (cmd && e.key === 'ArrowDown')) && file) run(() => open(file));
    else if (cmd && !e.altKey && e.code === 'KeyD' && file && Git.localFile(file)) run(() => A.showLocalDiff(file));
    else if (cmd && e.altKey && e.code === 'KeyZ') { const c = under(selected, (f) => f.status !== '?'); if (c.length) run(() => A.rollback(c)); }
    else if (cmd && e.altKey && e.code === 'KeyA') { const u = under(selected, (f) => f.status === '?'); if (u.length) run(() => A.addToVcs(u)); }
    else if (e.key === 'Backspace' || e.key === 'Delete') { const p = selected.map((n) => n.data.path).filter(Boolean); if (p.length) run(() => Git.dialogs.deleteFiles(p)); }
  }

  /** Opens the folders down to `path` and selects its row. */
  function reveal(path) {
    if (!ui || !idx || !path) return false;
    const parts = path.split('/');
    ui.tree.toggle('d:', true);
    for (let i = 1; i < parts.length; i++) ui.tree.toggle('d:' + parts.slice(0, i).join('/'), true);
    ui.tree.select('f:' + path);
    return true;
  }

  // ---------------------------------------------------------------- drawing
  function draw() {
    if (!ui) return;
    if (!idx) { Git.clear(ui.note).appendChild(Git.content.loading()); return; }
    Git.clear(ui.note);
    if (idx.truncated) ui.note.appendChild(h('div.gf-note', t('The list was cut at {0} files', idx.count)));
    ui.tree.render();
  }
  function build(el) {
    const tool = (icon, label, id, onClick) => Git.toolBtn({ icon, title: label, id, onClick });
    const active = () => { const id = Git.tabs && Git.tabs.active(); return id && id.indexOf('file:') === 0 ? id.slice(5) : id === 'diff:local' && Git.diffTab.tab(id) ? Git.diffTab.tab(id).spec.path : null; };
    const bar = h('div.g-toolbar.gf-toolbar', { role: 'toolbar', 'aria-label': t('Files') },
      tool('general/refresh', t('Refresh'), 'gf-refresh', () => reload()),
      h('span.g-spacer'),
      tool('general/locate', t('Select Opened File'), 'gf-locate', () => reveal(active())),
      tool('general/collapseAll', t('Collapse All'), 'gf-collapse', () => { ui.tree.collapseAll(); ui.tree.toggle('d:', true); }));
    const treeEl = h('div.gf-tree', { 'aria-label': t('Files') });
    const note = h('div.gf-notes');
    Git.clear(el);
    el.classList.add('gf-root');
    el.appendChild(bar);
    el.appendChild(note);
    el.appendChild(treeEl);
    ui = { el, treeEl, note };
    ui.tree = Git.tree({ el: treeEl, nodes, multi: true, onKey, onContext: menuFor,
      onToggle: (node, open) => { if (open && node.data && node.data.ignored && node.data.dir) loadInside(node.data.path); },
      onActivate: (node) => { if (!node.data.dir) open(node.data.path); else ui.tree.toggle(node.id); } });
  }

  Git.views.files = {
    mount(el) {
      unsubs.forEach((off) => off());
      build(el);
      draw();
      if (!idx) reload(); else ui.tree.render();
      unsubs = [
        Git.on('change', (ev) => {
          if (!ev || ev.reason === 'log') return;
          const what = ev.what || [];
          if (ev.reason === 'open') { idx = null; draw(); reload(); return; }
          if (what.indexOf('worktree') >= 0 || what.indexOf('state') >= 0 || ev.reason === 'resync') soon();
          if (ui) ui.tree.render();         // colors follow the snapshot at once
        }),
        Git.on('ignored', () => soon()),   // Add to .gitignore: the file turns olive
      ];
      return () => { unsubs.forEach((off) => off()); unsubs = []; ui = null; };
    },
    reload,
    reveal,
    /** Tests: the folder index of the last files.list. */
    index: () => idx,
  };
})();
