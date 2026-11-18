/* What the Log opens for revisions that is neither the commit diff nor a file's history.
     Git.views.repoAt.mount(el, { rev })        Show Repository at Revision: every file of the revision as a read-only tree
                                                (files.listAt); a file opens in the file view at that revision
     Git.views.versions.mount(el, { a, b })     Compare Versions (two commits): "Changes Between a and b", the files that
                                                differ (compare.files) as a tree, Show Diff between the two revisions
     A.showAllAffected(id)                      File History's Show All Affected Files: "Paths Affected by Commit {0}"
   Each mount returns a function that ends the view's subscriptions. */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const R = Git.repo, A = Git.actions;
  const L = (Git.logUI = Git.logUI || {});
  const T = Git.logTabs;

  Git.addTR({
    'Show Diff': 'Diff\'i göster', 'Open': 'Aç', 'Show History': 'Geçmişi göster', 'Annotate': 'Annotate', 'View Options': 'Görünüm seçenekleri',
    'Group By': 'Grupla', 'Directory': 'Klasör', 'Expand All': 'Tümünü aç', 'Collapse All': 'Tümünü kapat', 'No differences': 'Fark yok',
    'Changes Between {0} and {1}': '{0} ile {1} arasındaki değişiklikler', '{0} at {1}': '{0} @ {1}', 'Paths Affected by Commit {0}': '{0} commit\'inin değiştirdiği yollar',
    'Close': 'Kapat', 'The list was cut at {0} files': 'Liste {0} dosyada kesildi',
  });

  /** Folders and files of a path list as tree nodes (folders first, then files, by name). */
  function pathTree(paths, rev) {
    const top = { dirs: new Map(), files: [] };
    paths.forEach((p) => {
      let at = top;
      const parts = p.split('/');
      parts.slice(0, -1).forEach((d) => { if (!at.dirs.has(d)) at.dirs.set(d, { dirs: new Map(), files: [] }); at = at.dirs.get(d); });
      at.files.push(p);
    });
    const walk = (n, prefix) => Array.from(n.dirs.keys()).sort(L.natural).map((d) => ({ id: 'd:' + prefix + d, label: d, icon: 'nodes/folder', kind: 'dir', open: false,
      children: walk(n.dirs.get(d), prefix + d + '/') })).concat(n.files.slice().sort((a, b) => L.natural(Git.fileName(a), Git.fileName(b)))
      .map((p) => ({ id: 'f:' + p, label: Git.fileName(p), icon: Git.fileIcon(p), kind: 'file', tooltip: p, data: { path: p, rev } })));
    return [{ id: 'root', label: R.name, icon: 'nodes/module', dim: Git.short(rev), kind: 'dir', children: walk(top, '') }];
  }

  // ---------------------------------------------------------------- Show Repository at Revision
  Git.views.repoAt = {
    mount(el, o) {
      const rev = o.rev, slot = Git.content.slot();
      let nodes = [];
      const treeEl = h('div.gl-ftree.glr-tree');
      const note = h('div.gl-fnote', { hidden: true });
      const open = (n) => { if (n && n.kind === 'file') A.showFileAt(n.data.path, rev); };
      const tree = Git.tree({ el: treeEl, nodes: () => nodes, multi: true,
        onActivate: open,
        onContext(node, ev) {
          if (node.kind !== 'file') return;
          Git.menu(ev, [{ label: t('Open'), action: () => open(node) },
            { label: t('Show History'), disabled: !Git.views.history, action: () => A.showHistory(node.data.path, { rev }) },
            { label: t('Annotate'), disabled: !Git.annotate, action: () => A.annotate(node.data.path, { rev }) }]);
        } });
      const bar = h('div.g-toolbar', { role: 'toolbar' }, h('span.g-spacer'),
        Git.toolBtn({ icon: 'general/expandAll', title: t('Expand All'), onClick: () => tree.expandAll() }),
        Git.toolBtn({ icon: 'general/collapseAll', title: t('Collapse All'), onClick: () => tree.collapseAll() }));
      const root = h('div.gl-root.glt-root.glr-repo.g-grow', { dataset: { rev } }, bar, treeEl, note);
      el.appendChild(root);
      slot.run(() => Git.backend.call('files.listAt', { repo: R.root, rev }), {
        loading: () => { Git.clear(note).appendChild(Git.content.loading()); note.hidden = false; },
        done: (res) => {
          note.hidden = !res.truncated;
          Git.clear(note);
          if (res.truncated) note.appendChild(h('div', t('The list was cut at {0} files', res.files.length)));
          nodes = pathTree(res.files, res.id);
          tree.render();
        },
        error: (err) => { Git.clear(note).appendChild(Git.content.failed(err)); note.hidden = false; },
      });
      if (Git.frame && Git.frame.setTabTitle) Git.frame.setTabTitle('repo-at:' + rev, t('{0} at {1}', R.name, Git.short(rev)));
      T.focusSoon(treeEl);
      return () => slot.cancel();
    },
  };

  // ---------------------------------------------------------------- Compare Versions
  /** The diff of one changed file between two revisions (a texts tab, locked sides). */
  function revisionsDiff(a, b, it, list) {
    if (!it) return;
    // every file of the list as descriptors (ui/git/openers.js `texts`): Next File works wherever this runs
    const sides = (x) => {
      const ch = x.change;
      return { path: x.path, title: Git.fileName(x.path),
        left: { title: Git.short(a) + ' ' + (ch.oldPath || ch.path), at: ch.status === 'A' ? null : { path: ch.oldPath || ch.path, rev: a }, locked: true, path: ch.oldPath || ch.path },
        right: { title: Git.short(b) + ' ' + ch.path, at: ch.status === 'D' ? null : { path: ch.path, rev: b }, locked: true, path: ch.path } };
    };
    Git.open('texts', Object.assign({ id: 'diff:versions', what: 'Show Diff', items: list.map(sides) }, sides(it)));
  }
  Git.views.versions = {
    mount(el, o) {
      const a = o.a, b = o.b, slot = Git.content.slot();
      let items = [], nodes = [];
      const leaf = (it, flat) => ({ id: 'f:' + it.path, label: Git.fileName(it.path), icon: Git.fileIcon(it.path), color: Git.statusColor(it.status),
        dim: flat ? Git.dirName(it.path) : null, tooltip: it.oldPath ? it.oldPath + ' → ' + it.path : it.path, kind: 'file', data: it });
      const diff = (it) => revisionsDiff(a, b, it, nodes.reduce((list, n) => list.concat(L.filesUnder(n)), []));
      const picked = () => tree.selected().reduce((list, n) => list.concat(L.filesUnder(n)), []);
      const treeEl = h('div.gl-ftree.glt-tree');
      const note = h('div.gl-fnote', { hidden: true });
      const tree = Git.tree({ el: treeEl, nodes: () => nodes, multi: true, emptyText: t('No differences'),
        onSelect: () => drawBar(), onActivate: (n) => { if (n.kind === 'file') diff(n.data); },
        onContext(node, ev) {
          if (tree.selected().indexOf(node) < 0) tree.select(node.id);
          const list = picked();
          if (list.length) Git.menu(ev, [{ label: t('Show Diff'), shortcut: '⌘D', action: () => diff(list[0]) }]);
        },
        onKey(e) { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); diff(picked()[0]); } } });
      const bar = h('div.g-toolbar', { role: 'toolbar' });
      function drawBar() {
        const regroup = () => { T.opts.byDir = !T.opts.byDir; T.saveOpts(); draw(); };
        Git.clear(bar);
        [Git.toolBtn({ icon: 'vcs/diff', title: t('Show Diff') + '  ⌘D', id: 'glr-diff', disabled: !picked().length, onClick: () => diff(picked()[0]) }),
          h('span.g-toolbar-sep'),
          Git.toolBtn({ icon: 'general/show', title: t('View Options'), onClick: (e) => Git.menu(e.currentTarget, [T.header(t('Group By')), { label: t('Directory'), checked: !!T.opts.byDir, action: regroup }]) }),
          h('span.g-spacer'),
          T.opts.byDir ? Git.toolBtn({ icon: 'general/expandAll', title: t('Expand All'), onClick: () => tree.expandAll() }) : null,
          T.opts.byDir ? Git.toolBtn({ icon: 'general/collapseAll', title: t('Collapse All'), onClick: () => tree.collapseAll() }) : null,
        ].forEach((x) => { if (x) bar.appendChild(x); });
      }
      function draw() { nodes = L.fileTree(items, T.opts.byDir, '', leaf); tree.expandAll(); drawBar(); }
      const root = h('div.gl-root.glt-root.glr-versions.g-grow', bar, treeEl, note);
      el.appendChild(root);
      slot.run(() => Git.content.compareFiles(a, b), {
        loading: () => { Git.clear(note).appendChild(Git.content.loading()); note.hidden = false; },
        done: (res) => { note.hidden = true; items = (res.files || []).map((ch) => ({ path: ch.path, oldPath: ch.oldPath || null, status: ch.status, change: ch })); draw(); },
        error: (err) => { Git.clear(note).appendChild(Git.content.failed(err)); note.hidden = false; },
      });
      drawBar();
      if (Git.frame && Git.frame.setTabTitle) Git.frame.setTabTitle('versions:' + a + '..' + b, t('Changes Between {0} and {1}', Git.short(a), Git.short(b)));
      T.focusSoon(treeEl);
      return () => slot.cancel();
    },
  };

  // ---------------------------------------------------------------- Show All Affected Files
  /** "Paths Affected by Commit {0}": every file the commit changed (all of the commit, not only the history's file). */
  A.showAllAffected = function (id) {
    const treeEl = h('div.gl-ftree.glr-affected');
    let nodes = [], entries = [];
    const leaf = (e, flat) => ({ id: 'f:' + e.path, label: Git.fileName(e.path), icon: Git.fileIcon(e.path), color: Git.statusColor(e.status),
      dim: flat ? Git.dirName(e.path) : null, tooltip: e.oldPath ? e.oldPath + ' → ' + e.path : e.path, kind: 'file', data: e });
    const tree = Git.tree({ el: treeEl, nodes: () => nodes, multi: true, onActivate: (n) => { if (n.kind === 'file') L.showEntryDiff(n.data, entries); },
      onContext(node, ev) {
        if (node.kind !== 'file') return;
        if (tree.selected().indexOf(node) < 0) tree.select(node.id);
        const list = tree.selected().reduce((x, n) => x.concat(L.filesUnder(n)), []);
        Git.menu(ev, L.entryMenu(list, { all: entries }));
      } });
    const dlg = Git.dialog({ title: t('Paths Affected by Commit {0}', Git.short(id)), width: 520, height: 440, className: 'glr-affected-dlg', content: treeEl,
      buttons: [{ label: t('Close'), primary: true }] });
    Git.content.details(id).then((d) => {
      if (dlg.closed) return;
      const ch = d.changes[0] || { files: [], parent: null };
      entries = ch.files.map((f) => Object.assign({}, f, { commitId: id, parent: ch.parent, single: true, commits: [id],
        before: f.status === 'A' || !ch.parent ? null : { path: f.oldPath || f.path, rev: ch.parent }, after: f.status === 'D' ? null : { path: f.path, rev: id } }));
      nodes = L.fileTree(entries, true, 'aff:', leaf);
      tree.expandAll();
    }, (err) => { if (!dlg.closed) Git.clear(treeEl).appendChild(Git.content.failed(err)); });
    return dlg;
  };
})();
