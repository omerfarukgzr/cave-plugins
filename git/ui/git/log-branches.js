/* Git prototype: the Branches pane at the left of the Log tab (IntelliJ's branches dashboard).
   A vertical toolbar, the "Branch or tag" search field and the tree: HEAD (Current Branch), Local, Remote ▸ origin, Tags.
   Selecting a branch filters the log or jumps to the branch head (Branches Pane Settings ▸ On Single Click).
   Git.logUI.createBranches({ pane, strip, show(on), setBranchFilter(names), reveal(id) }) → { render() }; log.js mounts it. */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = Git.t;
  const R = Git.repo, A = Git.actions, L = Git.logUI;

  Git.addTR({
    'Hide Git Branches': 'Dalları gizle', 'New Branch': 'Yeni dal', 'Update Selected': 'Seçili dalı güncelle', 'Delete Branch': 'Dalı sil',
    'Delete Branches': 'Dalları sil', 'Compare with Current': 'Geçerli dalla karşılaştır', 'Show My Branches': 'Yalnız benim dallarımı göster',
    'Fetch All Remotes': 'Bütün uzak depolardan fetch yap', 'Mark/Unmark As Favorite': 'Favori yap / favoriden çıkar',
    'Navigate Log to Selected Branch Head': 'Log\'da seçili dalın başına git', 'Branches Pane Settings': 'Dallar bölmesi ayarları',
    'On Single Click': 'Tek tıkta', 'Update Branch Filter': 'Dal filtresini güncelle', 'Navigate Log to Branch Head': 'Log\'da dalın başına git',
    'Group by Directory': 'Klasöre göre grupla', 'Show Tags': 'Etiketleri göster', 'Expand All': 'Tümünü aç', 'Collapse All': 'Tümünü kapat',
    'Branch or tag': 'Dal ya da etiket', 'HEAD (Current Branch)': 'HEAD (geçerli dal)', 'Branches': 'Dallar', 'Checkout': 'Checkout', 'Delete': 'Sil',
    '{0} incoming commits': '{0} gelen commit', '{0} outgoing commits': '{0} giden commit',
  });

  /** "A branch is 'My' if all exclusive commits of this branch are made by 'me'": commits no other branch has. */
  /** -> Set of 'local:<name>' / 'remote:<name>' (a local and a remote branch of one name are two refs). */
  function myBranches() {
    const refs = Git.localBranches().map((n) => A.ref('local', n)).concat(Git.remoteBranches().map((n) => A.ref('remote', n)));
    const key = (r) => r.kind + ':' + r.name;
    // a local branch and the remote branch it tracks share their commits
    const twin = (a, b) => (a.kind === 'local' && b.kind === 'remote' && Git.upstream(a.name) === b.name) || (b.kind === 'local' && a.kind === 'remote' && Git.upstream(b.name) === a.name);
    const mine = new Set();
    refs.forEach((r) => {
      const others = refs.filter((o) => key(o) !== key(r) && !twin(r, o)).map((o) => Git.closure(A.refId(o)));
      const own = Array.from(Git.closure(A.refId(r))).filter((id) => !others.some((set) => set.has(id)));
      if (own.length && own.every((id) => Git.isMine(Git.commit(id)))) mine.add(key(r));
    });
    return mine;
  }

  /** A row's ref as the pair (its group's kind, its name): what every command of the pane gets. */
  const pair = (n) => A.ref(n.data.type, n.data.ref);

  L.createBranches = function (ctx) {
    const opts = L.opts;
    let query = '';
    const bar = h('div.g-toolbar.vertical.gl-bbar', { role: 'toolbar', 'aria-orientation': 'vertical' });
    const search = Git.field({ placeholder: t('Branch or tag'), icon: 'general/search', onInput: (v) => { query = v.trim().toLowerCase(); tree.render(); drawBar(); } });
    const treeEl = h('div.gl-btree');
    ctx.pane.appendChild(bar);
    ctx.pane.appendChild(h('div.gl-bcol', h('div.gl-bsearch', search), treeEl));
    ctx.strip.appendChild(Git.toolBtn({ icon: 'general/chevronRight', title: t('Branches'), id: 'gl-branches-show', onClick: () => ctx.show(true) }));
    ctx.strip.appendChild(h('button.gl-bstrip-label', { type: 'button', onclick: () => ctx.show(true) }, t('Branches')));

    // ---- tree
    const current = () => Git.currentBranch();
    // a row's ref is the pair (its group's kind, its name): the star and "current" are about that ref, never the name
    const isCur = (name, type) => type === 'local' && name === current();
    const first = (name, type) => (A.isFavorite(A.ref(type, name)) || isCur(name, type) ? 0 : 1);
    function icon(name, type) {
      const fav = A.isFavorite(A.ref(type, name));
      if (isCur(name, type)) return fav ? 'dvcs/currentBranchFavoriteLabel' : 'dvcs/currentBranchLabel';
      return fav ? 'nodes/star' : 'branch';
    }
    function sync(name) {
      const s = Git.isLocal(name) ? Git.sync(name) : null;
      if (!s || (!s.ahead && !s.behind)) return null;
      return h('span.gl-sync',
        s.behind ? h('span.in', { title: t('{0} incoming commits', s.behind) }, Git.icon('dvcs/changesUpdate@12x12', 12), String(s.behind)) : null,
        s.ahead ? h('span.out', { title: t('{0} outgoing commits', s.ahead) }, Git.icon('dvcs/changesPush@12x12', 12), String(s.ahead)) : null);
    }
    /** Branch rows of one group: favorites and the current branch first, then folders ("/" in the name), then the rest. */
    function rows(names, label, scope, mark, type) {
      // The row knows its kind (the group it is listed in); a name alone can mean a local branch and a remote one
      // (a local branch called `origin/main`). Such a remote row gets an id of its own.
      const idOf = (name) => (type === 'remote' && Git.isLocal(name) ? 'b:remote:' + name : 'b:' + name);
      const leaf = (name, text) => ({ id: idOf(name), label: text, icon: icon(name, type), dim: type === 'remote' ? null : sync(name), kind: 'branch', tooltip: name, data: { ref: name, type } });
      const byName = (a, b) => first(a.name, type) - first(b.name, type) || a.name.localeCompare(b.name);
      const list = names.map((name) => ({ name, parts: label(name).split('/') })).sort(byName);
      if (!opts.groupByDir) return list.map((e) => leaf(e.name, label(e.name)));
      const level = (items, prefix, depth) => {
        const dirs = new Map(), leaves = [];
        items.forEach((e) => {
          if (e.parts.length <= depth + 1) { leaves.push(e); return; }
          if (!dirs.has(e.parts[depth])) dirs.set(e.parts[depth], []);
          dirs.get(e.parts[depth]).push(e);
        });
        const folders = Array.from(dirs.keys()).sort().map((dir) => ({ id: 'd:' + prefix + dir + mark, label: dir, icon: 'nodes/folder', kind: 'folder',
          open: !!mark || dirs.get(dir).some((e) => isCur(e.name, type)), children: level(dirs.get(dir), prefix + dir + '/', depth + 1) }));
        const mk = (e) => leaf(e.name, e.parts[depth]);
        return leaves.filter((e) => first(e.name, type) === 0).map(mk).concat(folders, leaves.filter((e) => first(e.name, type) === 1).map(mk));
      };
      return level(list, scope, 0);
    }
    function nodes() {
      const mine = opts.myBranches ? myBranches() : null;
      const keep = (kind) => (name) => (!query || name.toLowerCase().indexOf(query) >= 0) && (!mine || mine.has(kind + ':' + name));
      const mark = query ? '*' : '';            // while searching, groups get their own ids so that they open without losing what was collapsed
      const out = [];
      if (!query) out.push({ id: 'head', label: t('HEAD (Current Branch)'), kind: 'head', data: { ref: 'HEAD' } });
      // an empty group is left out (IntelliJ's tree has no Remote node in a repository without remote branches); Local stays
      const group = (id, label, children, open) => { if (children.length || (!query && id === 'g:local')) out.push({ id: id + mark, label, kind: 'group', open: open || !!query, children }); };
      group('g:local', t('Local'), rows(Git.localBranches().filter(keep('local')), (n) => n, 'local/', mark, 'local'), true);
      const remotes = {};
      Git.remoteBranches().filter(keep('remote')).forEach((n) => { const r = n.split('/')[0]; (remotes[r] = remotes[r] || []).push(n); });
      group('g:remote', t('Remote'), Object.keys(remotes).sort().map((r) => ({ id: 'r:' + r + mark, label: r, icon: 'nodes/folder', kind: 'folder',
        children: rows(remotes[r], (n) => n.slice(r.length + 1), r + '/', mark, 'remote') })), false);
      if (opts.showTags) group('g:tags', t('Tags'), Git.tagNames().filter((n) => !query || n.toLowerCase().indexOf(query) >= 0)
        .map((n) => ({ id: 't:' + n, label: n, icon: 'dvcs/branchLabel', kind: 'tag', data: { ref: n, type: 'tag' } })), false);
      return out;
    }
    // what a selected row names, as the Log's Branch filter and Navigate take it: the row's pair (HEAD: the revision)
    const refsOf = (list) => list.filter((n) => n.data && n.data.ref).map((n) => (n.data.type ? pair(n) : A.ref('revision', n.data.ref)));
    const branchesOf = (list) => list.filter((n) => n.kind === 'branch').map((n) => n.data.ref);
    const tree = Git.tree({ el: treeEl, nodes, multi: true,
      onSelect(list) {
        drawBar();
        const refs = refsOf(list);
        if (!refs.length) return;
        if (opts.onClick === 'filter') ctx.setBranchFilter(refs);
        else if (opts.onClick === 'navigate' && refs.length === 1) ctx.reveal(refs[0]);
      },
      onActivate(node) { if (node.data && node.data.ref) ctx.setBranchFilter(refsOf([node])); },
      onContext(node, ev) {
        if (tree.selected().indexOf(node) < 0) tree.select(node.id, true);
        drawBar();
        if (node.kind === 'branch') Git.menu(ev, L.branchMenu(node.data.ref, node.data.type));
        // a tag: the branch widget's own tag menu (Checkout, Show Diff with Working Tree, Merge, Push to origin, Delete)
        else if (node.kind === 'tag') Git.menu(ev, Git.branches && Git.branches.menuFor ? Git.branches.menuFor(node.data.ref, 'tag')
          : [{ label: t('Checkout'), action: () => A.checkout(pair(node)) }, { label: t('Push to {0}', R.remoteName || 'origin'), disabled: !A.pushTag || !(R.remoteNames || []).length, action: () => A.pushTag(pair(node)) },
            { label: t('Delete'), danger: true, disabled: !A.deleteTag, action: () => A.deleteTag(pair(node)) }]);
      },
      onKey(e, list) {
        const names = branchesOf(list);
        if (!names.length) return;
        if (e.key === ' ') { e.preventDefault(); A.sequence(list.filter((n) => n.kind === 'branch'), (n) => A.toggleFavorite(pair(n))); }
        else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); Git.copy(names.join(' ')); }
      } });

    // ---- toolbar
    function actions() {
      const picked = tree.selected(), names = branchesOf(picked), cur = current();
      const ref = refsOf(picked).length === 1 ? refsOf(picked)[0] : null;
      const rowsPicked = picked.filter((n) => n.kind === 'branch');              // with their kind: never guessed from the name
      const isCurRow = (n) => n.data.type === 'local' && n.data.ref === cur;
      const oneRow = rowsPicked.length === 1 ? rowsPicked[0] : null;
      const tagRow = picked.length === 1 && picked[0].kind === 'tag' ? picked[0] : null;
      const check = (key, label, value) => ({ label, checked: value === undefined ? !!opts[key] : opts[key] === value, action: () => {
        opts[key] = value === undefined ? !opts[key] : opts[key] === value ? 'none' : value;
        L.saveOpts();
        tree.render();
      } });
      return [
        { icon: 'general/chevronLeft', title: t('Hide Git Branches'), id: 'gl-branches-hide', run: () => ctx.show(false) }, '-',
        { icon: 'general/add', title: t('New Branch'), disabled: names.length > 1,
          run: () => (oneRow || tagRow ? A.newBranch(pair(oneRow || tagRow), (oneRow || tagRow).data.ref) : A.newBranch(null)) },
        { icon: 'vcs/update', title: t('Update Selected'), disabled: !names.length || rowsPicked.some((n) => n.data.type !== 'local' || isCurRow(n) || !Git.upstream(n.data.ref)), run: () => A.updateBranches(rowsPicked.map(pair)) },
        { icon: 'general/delete', title: t(names.length > 1 ? 'Delete Branches' : 'Delete Branch'), disabled: !names.length || rowsPicked.some(isCurRow), run: () => A.deleteBranches(rowsPicked.map(pair)) },
        { icon: 'vcs/diff', title: t('Compare with Current'), disabled: !oneRow || isCurRow(oneRow) || !Git.views.compare, run: () => A.compareWithCurrent(pair(oneRow)) },
        { icon: 'general/search', title: t('Show My Branches'), active: !!opts.myBranches, run: () => { opts.myBranches = !opts.myBranches; L.saveOpts(); tree.render(); drawBar(); } },
        { icon: 'vcs/fetch', title: t('Fetch All Remotes'), run: () => A.fetch() },
        { icon: 'nodes/star', title: t('Mark/Unmark As Favorite'), disabled: !names.length, run: () => A.sequence(rowsPicked, (n) => A.toggleFavorite(pair(n))) },
        { icon: 'general/locate', title: t('Navigate Log to Selected Branch Head'), disabled: !ref, run: () => ctx.reveal(ref) }, '-',
        { icon: 'general/settings', title: t('Branches Pane Settings'), id: 'gl-branches-settings', run: (at) => Git.menu(at, [
          { label: t('On Single Click'), header: t('On Single Click'), disabled: true },
          check('onClick', t('Update Branch Filter'), 'filter'), check('onClick', t('Navigate Log to Branch Head'), 'navigate'), '-',
          check('groupByDir', t('Group by Directory')), check('showTags', t('Show Tags'))]) },
        { icon: 'general/expandAll', title: t('Expand All'), run: () => tree.expandAll() },
        { icon: 'general/collapseAll', title: t('Collapse All'), run: () => tree.collapseAll() },
      ];
    }
    let more = null;
    function drawBar() {
      const list = actions();
      Git.clear(bar);
      list.forEach((a) => bar.appendChild(a === '-' ? h('span.g-toolbar-sep') : Git.toolBtn({ icon: a.icon, title: a.title, id: a.id, disabled: a.disabled, active: a.active, onClick: (e) => a.run(e.currentTarget) })));
      more = Git.toolBtn({ icon: 'general/chevronRight', title: '…', onClick: (e) => {
        const hidden = actions().filter((a, i) => bar.children[i].hidden);
        Git.menu(e.currentTarget, hidden.map((a) => (a === '-' ? '-' : { label: a.title, disabled: a.disabled, checked: a.active, action: () => a.run(e.currentTarget) })));
      } });
      more.hidden = true;
      bar.appendChild(more);
      fit();
    }
    /** A short pane shows as many buttons as fit; the rest go behind a › button at the bottom. */
    function fit() {
      if (!more || !bar.clientHeight) return;
      const items = Array.prototype.slice.call(bar.children, 0, -1);
      items.forEach((el) => { el.hidden = false; });
      more.hidden = true;
      const over = () => bar.scrollHeight > bar.clientHeight;
      if (!over()) return;
      more.hidden = false;
      for (let i = items.length - 1; i > 0 && over(); i--) items[i].hidden = true;
    }
    if (window.ResizeObserver) new ResizeObserver(fit).observe(bar);

    tree.render();
    drawBar();
    return { render() { tree.render(); drawBar(); }, layout: fit, tree };
  };

  /** Single view ?view=branches: the pane on its own (a click navigates through Git.host.hooks.showInLog when the
      host has a Log elsewhere). */
  Git.views.branches = {
    mount(el) {
      const pane = h('div.gl-bpane.gl-bpane-solo'), strip = h('div.gl-bstrip', { hidden: true });
      el.appendChild(h('div.gl-root.g-grow', pane, strip));
      const hooks = (Git.host && Git.host.hooks) || {};
      const b = L.createBranches({ pane, strip, show: () => {}, setBranchFilter: (names) => { if (hooks.branchFilter) hooks.branchFilter(names.map(L.filterLabel)); },
        reveal: (ref) => { const id = ref && typeof ref === 'object' ? A.refId(ref) : ref; if (hooks.showInLog && id) hooks.showInLog(id); } });
      const off = Git.on('change', (ev) => { if (!ev || ev.reason !== 'log') b.render(); });
      return off;
    },
  };
})();
