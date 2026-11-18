/* The branch rows of the Branches popup without DOM (split from branches.js; tested in
   test/ui/branches-tree.test.js): the Recent, Local, Remote and Tags sections, folders by prefix ("Group by Directory"),
   the current branch and the favorites first, speed search.
   Git.branchTree.rows({ query, group, showRecent, showTags, isOpen(id, fallback), current, isFavorite(kind, name)
     (or favorites: Set of local branch names), recent,
     local, remote, tags, isLocal(name) }) -> [{ type: 'section'|'folder'|'branch'|'tag', id, label, depth, open?, name?,
     current?, fav?, local?, kind?: 'local'|'remote'|'tag' }] */
(function () {
  'use strict';
  const Git = (window.Git = window.Git || {});
  const BT = (Git.branchTree = {});

  BT.rows = function (o) {
    const q = (o.query || '').trim().toLowerCase();
    const hit = (s) => !q || s.toLowerCase().indexOf(q) >= 0;
    const isOpen = o.isOpen || ((id, fallback) => fallback);
    const rows = [];
    function tree(names, sec, so) {
      const top = [];
      const folders = new Map();
      names.forEach((name) => {
        const parts = o.group ? name.split('/') : [name];
        let kids = top, path = '';
        parts.slice(0, -1).forEach((part) => {
          path += (path ? '/' : '') + part;
          const id = 'f:' + sec + ':' + path;
          let f = folders.get(id);
          if (!f) { f = { type: 'folder', id, label: part, kids: [] }; folders.set(id, f); kids.push(f); }
          kids = f.kids;
        });
        // the ref's kind comes from its section, never from its name (a local branch `team/x` next to the remote `team`)
        const kind = so.tag ? 'tag' : sec === 'remote' ? 'remote' : 'local';
        kids.push({ type: so.tag ? 'tag' : 'branch', id: 'b:' + sec + ':' + name, name, label: parts[parts.length - 1], kind,
          current: kind === 'local' && name === o.current, fav: o.isFavorite ? !!o.isFavorite(kind, name) : !!(kind === 'local' && o.favorites && o.favorites.has(name)), local: kind === 'local' });
      });
      // The current branch and the favorites lead, then folders, then the rest by name.
      const rank = (n) => (n.kids ? Math.min(2, ...n.kids.map(rank)) : n.current ? 0 : n.fav ? 1 : 3);
      const sort = (nodes) => {
        nodes.forEach((n) => { if (n.kids) sort(n.kids); });
        if (!so.keepOrder) nodes.sort((a, b) => rank(a) - rank(b) || a.label.localeCompare(b.label));
      };
      sort(top);
      return top;
    }
    function walk(nodes, depth) {
      nodes.forEach((n) => {
        if (!n.kids) { rows.push(Object.assign(n, { depth })); return; }
        const open = q ? true : isOpen(n.id, true);
        rows.push({ type: 'folder', id: n.id, label: n.label, open, depth });
        if (open) walk(n.kids, depth + 1);
      });
    }
    function section(sec, label, names, so) {
      const shown = names.filter(hit);
      if (!shown.length) return;
      const id = 's:' + sec;
      const open = q ? true : isOpen(id, !!so.open);
      rows.push({ type: 'section', id, label, open, depth: 0 });
      if (open) walk(tree(shown, sec, so), 1);
    }
    const labels = o.labels || { recent: 'Recent', local: 'Local', remote: 'Remote', tags: 'Tags' };
    if (o.showRecent && !q) section('recent', labels.recent, (o.recent || []).filter((n) => !o.isLocal || o.isLocal(n)).slice(0, 5), { open: true, keepOrder: true });
    section('local', labels.local, o.local || [], { open: true });
    section('remote', labels.remote, o.remote || [], { open: false });
    if (o.showTags) section('tags', labels.tags, o.tags || [], { open: false, tag: true });
    return rows;
  };
})();
