/* The two comparison tabs of the Git tool window.
   Git.views.compare.mount(el, { a, b })        "Compare: a and b" (Compare with Current): one list, the commits of `a` that
                                                `b` lacks (compare.branches); Swap Branches turns it round; Changed Files and
                                                Commit Details of the selection on the right (the Log's own pane, ⌘A = all)
   Git.views.branchDiff.mount(el, { branch })   Changes Between <branch> and Current Working Tree (compare.files without `b`):
                                                the files as a tree, Show Diff, Get from Branch, Swap branches
   Each mount returns a function that ends the view's subscriptions. */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = Git.t;
  const R = Git.repo, A = Git.actions;
  const L = (Git.logUI = Git.logUI || {});
  const T = Git.logTabs;

  Git.addTR({
    'Log': 'Log', "Commits that exist in {0} but don't exist in {1}": "{0} dalında olup {1} dalında olmayan commit'ler",
    'Compare': 'Karşılaştır', '{0} and {1}': '{0} ve {1}', 'Changes Between {0} and Current Working Tree': '{0} ile çalışma kopyası arasındaki değişiklikler',
    '{0} contains all commits from {1}': "{0}, {1} dalındaki bütün commit'leri içeriyor", 'Swap Branches': 'Dalların yerini değiştir',
    'Difference between current working tree on {0} and files in {1}:': '{0} üzerindeki çalışma kopyası ile {1} dosyaları arasındaki fark:',
    'Difference between files in {0} and current working tree on {1}:': '{0} dosyaları ile {1} üzerindeki çalışma kopyası arasındaki fark:',
    'Swap branches': 'Dalların yerini değiştir', 'Get from Branch': 'Daldan al', 'Edit Source': 'Kaynağı düzenle', 'Show Diff': 'Diff\'i göster',
    'Group By': 'Grupla', 'Directory': 'Klasör', 'Expand All': 'Tümünü aç', 'Collapse All': 'Tümünü kapat', 'View Options': 'Görünüm seçenekleri',
    "'{0}' not found": "'{0}' bulunamadı", 'Changes': 'Değişiklikler', 'No differences': 'Fark yok', 'Local': 'Yerel',
  });

  // ---------------------------------------------------------------- a ↔ b (Compare with Current)
  Git.views.compare = {
    mount(el, o) {
      // `a`, `b`: ref pairs (or typed text); the engine gets A.wire of them, the screen their names
      const tabKey = 'compare:' + A.wire(o.a);
      let a = A.asRef(o.a), b = o.b ? A.asRef(o.b) : A.ref('revision', 'HEAD');
      if (!A.refId(b)) b = A.ref('revision', 'HEAD');
      const nm = (r) => A.refLabel(r);
      let res = null, loading = true, failed = null;
      const slot = Git.content.slot();
      const details = L.createDetails ? L.createDetails({ reveal: (id) => A.showInLog(id) }) : null;

      /** IntelliJ's one list (GitCompareBranchesUi): the commits that exist in `a` but not in `b`; Swap Branches turns it
          round. ⌘A selects every commit: Changed Files then lists every file that differs. */
      const head = h('div.glt-chead');
      const table = T.commitTable({ label: t('Log'), graph: true, multi: true, columns: () => ['subject', 'author', 'date'],
        ids: () => (res ? (res.a.rev === A.wire(a) ? res.onlyA : res.onlyB) : []),
        empty: () => (loading ? Git.content.loading() : failed ? Git.content.failed(failed) : t('{0} contains all commits from {1}', nm(b), nm(a))),
        onSelect: (ids) => { if (details) details.update(ids.slice()); } });
      const top = { el: h('div.glt-cside.g-col', head, table.el), table };
      function draw() {
        Git.clear(head);
        head.appendChild(h('span.glt-chead-text', { title: t("Commits that exist in {0} but don't exist in {1}", nm(a), nm(b)) },
          T.rich("Commits that exist in {0} but don't exist in {1}", [h('b', nm(a)), h('b', nm(b))])));
        head.appendChild(h('button.g-link.glt-swap', { type: 'button', onclick: swap }, t('Swap Branches')));
        table.render();
        if (details) details.update(table.selected());
        // git.compare.branches.tab.name + .tab.suffix
        if (Git.frame && Git.frame.setTabTitle) Git.frame.setTabTitle(tabKey, t('Compare') + ': ' + t('{0} and {1}', nm(a), nm(b)));
      }
      function load() {
        slot.run(() => Git.content.compareBranches(A.wire(a), A.wire(b)), {
          loading: () => { loading = true; failed = null; draw(); },
          done: (r) => { loading = false; failed = null; res = r; draw(); },
          error: (err) => { loading = false; failed = err; res = null; draw(); },
        });
      }
      function swap() {
        const x = a;
        a = b; b = x;
        table.select([], true);
        load();
      }

      const left = h('div.glt-cleft.g-col', top.el);
      const root = h('div.gl-root.glt-root.g-grow', left);
      if (details) {
        const right = h('div.gl-right.glt-cright.g-col', details.files);
        right.appendChild(Git.splitter({ target: details.files, edge: 'bottom', min: 80, max: () => Math.max(100, right.clientHeight - 90), key: 'compare-files' }));
        right.appendChild(details.details);
        root.appendChild(Git.splitter({ target: right, edge: 'left', min: 200, max: () => Math.max(220, root.clientWidth - 320), key: 'compare-right', onResize: () => details.layout() }));
        root.appendChild(right);
      }
      el.appendChild(root);
      T.solids(table.el);
      load();
      T.focusSoon(table.el);
      const sub = T.follow(root, (ev) => { if (!ev || ev.reason !== 'changed' || (ev.what || []).indexOf('refs') >= 0) load(); });
      sub.also(() => { table.destroy(); });
      return sub.stop;
    },
  };

  // ---------------------------------------------------------------- Changes Between <branch> and Current Working Tree
  Git.views.branchDiff = {
    mount(el, o) {
      // `branch`: a ref pair, or { kind: 'revision', name: id } (the Log's Compare with Local); typed text is resolved
      const pair = A.asRef(o.branch), ref = A.wire(pair);
      const named = pair.kind !== 'revision';
      const label = () => A.refLabel(pair);
      let swapped = false, items = [], nodes = [], loading = true, failed = null, files = [];
      const slot = Git.content.slot();

      /** The engine's changes from `ref` to the work tree; swapped, the statuses read the other way round. */
      function toItems() {
        const flip = { A: 'D', D: 'A', M: 'M', R: 'R' };
        return files.map((ch) => ({ path: ch.path, oldPath: ch.oldPath || null, status: swapped ? flip[ch.status] || ch.status : ch.status, change: ch }));
      }
      const picked = () => tree.selected().reduce((list, n) => list.concat(L.filesUnder(n)), []).filter((it, i, all) => all.indexOf(it) === i);
      const id = () => Git.refId(ref) || ref;

      /** One file of the list as descriptors (ui/git/openers.js `texts`): the branch's side and the working tree's. */
      function sides(x) {
        const ch = x.change;
        const theirs = { title: label(), path: ch.oldPath || ch.path, at: ch.status === 'A' ? null : { path: ch.oldPath || ch.path, rev: id() }, locked: true };
        const mine = { title: t('Local'), path: ch.path, at: ch.status === 'D' ? null : { path: ch.path, worktree: true } };
        return { path: x.path, title: Git.fileName(x.path), left: swapped ? mine : theirs, right: swapped ? theirs : mine };
      }
      function openDiff(it) {
        if (!it) return;
        const list = nodes.reduce((all, n) => all.concat(L.filesUnder(n)), []);
        Git.open('texts', Object.assign({ id: 'diff:branch', what: 'Show Diff', items: list.map(sides) }, sides(it)));
      }
      const editSource = (list) => list.filter((it) => it.change.status !== 'D').forEach((it) => A.jumpToSource(it.path));
      /** The working tree's files become their versions from the branch (a rename takes both of its paths). */
      function getFromBranch(list) {
        const paths = [];
        list.forEach((it) => [it.change.oldPath, it.change.path].forEach((p) => { if (p && paths.indexOf(p) < 0) paths.push(p); }));
        if (paths.length) A.getFromRevision(named ? ref : id(), paths);
      }

      const info = h('div.glt-info');
      const bar = h('div.g-toolbar', { role: 'toolbar' });
      const treeEl = h('div.gl-ftree.glt-tree');
      const leaf = (it, flat) => ({ id: 'f:' + it.path, label: Git.fileName(it.path), icon: Git.fileIcon(it.path), color: Git.statusColor(it.status),
        dim: flat ? Git.dirName(it.path) : null, tooltip: it.oldPath ? it.oldPath + ' → ' + it.path : it.path, kind: 'file', data: it });
      const tree = Git.tree({ el: treeEl, nodes: () => nodes, multi: true, emptyText: t('No differences'),
        onSelect: () => drawBar(),
        onActivate(node) { if (node.kind === 'file') openDiff(node.data); },
        onContext(node, ev) {
          if (tree.selected().indexOf(node) < 0) tree.select(node.id);
          const list = picked();
          if (!list.length) return;
          Git.menu(ev, [
            { label: t('Show Diff'), shortcut: '⌘D', action: () => openDiff(list[0]) },
            { label: t('Edit Source'), shortcut: '⌘↓', disabled: list.every((it) => it.change.status === 'D'), action: () => editSource(list) }, '-',
            { label: t('Get from Branch'), action: () => getFromBranch(list) }]);
        },
        onKey(e) {
          if (e.key === 'F4') { e.preventDefault(); editSource(picked()); return; }
          if (!(e.metaKey || e.ctrlKey)) return;
          if (e.key.toLowerCase() === 'd') { e.preventDefault(); openDiff(picked()[0]); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); editSource(picked()); }
        } });

      function drawInfo() {
        const here = h('b', Git.currentBranch() || Git.short(Git.headId())), there = h('b', label());
        Git.clear(info);
        info.appendChild(h('span.glt-info-text', swapped ? T.rich('Difference between files in {0} and current working tree on {1}:', [there, here])
          : T.rich('Difference between current working tree on {0} and files in {1}:', [here, there])));
        info.appendChild(h('button.g-link.glt-swap', { type: 'button', onclick: () => { swapped = !swapped; draw(); } }, t('Swap branches')));
      }
      function drawBar() {
        const list = picked();
        const regroup = () => { T.opts.byDir = !T.opts.byDir; T.saveOpts(); draw(); };
        Git.clear(bar);
        [Git.toolBtn({ icon: 'vcs/diff', title: t('Show Diff') + '  ⌘D', id: 'glt-bdiff-diff', disabled: !list.length, onClick: () => openDiff(list[0]) }),
          Git.toolBtn({ icon: 'general/download', title: t('Get from Branch'), id: 'glt-bdiff-get', disabled: !list.length, onClick: () => getFromBranch(list) }),
          h('span.g-toolbar-sep'),
          Git.toolBtn({ icon: 'general/show', title: t('View Options'), onClick: (e) => Git.menu(e.currentTarget, [T.header(t('Group By')), { label: t('Directory'), checked: !!T.opts.byDir, action: regroup }]) }),
          h('span.g-spacer'),
          T.opts.byDir ? Git.toolBtn({ icon: 'general/expandAll', title: t('Expand All'), onClick: () => tree.expandAll() }) : null,
          T.opts.byDir ? Git.toolBtn({ icon: 'general/collapseAll', title: t('Collapse All'), onClick: () => tree.collapseAll() }) : null,
        ].forEach((x) => { if (x) bar.appendChild(x); });
      }
      function draw() {
        const known = !!Git.refId(ref);
        items = toItems();
        nodes = known && !failed ? L.fileTree(items, T.opts.byDir, '', leaf) : [];
        const state = !known ? h('div', t("'{0}' not found", label())) : loading && !files.length ? Git.content.loading() : failed ? Git.content.failed(failed) : null;
        Git.clear(status);
        if (state) status.appendChild(state);
        status.hidden = !state;
        treeEl.hidden = !!state;
        tree.expandAll();
        drawInfo();
        drawBar();
      }
      function load() {
        if (!Git.refId(ref)) { loading = false; draw(); return; }
        slot.run(() => Git.content.compareFiles(ref), {
          loading: () => { loading = true; failed = null; draw(); },
          done: (res) => { loading = false; failed = null; files = res.files || []; draw(); },
          error: (err) => { loading = false; failed = err; files = []; draw(); },
        });
      }

      const status = h('div.gl-fnote', { hidden: true });
      const root = h('div.gl-root.glt-root.glt-bdiff.g-grow', info, bar, treeEl, status);
      el.appendChild(root);
      load();
      if (Git.frame && Git.frame.setTabTitle) Git.frame.setTabTitle('branchdiff:' + ref, t('Changes Between {0} and Current Working Tree', label()));
      T.focusSoon(treeEl);
      return T.follow(root, () => load(), ['change', 'files']).stop;
    },
  };
})();
