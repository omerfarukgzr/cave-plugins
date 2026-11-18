/* Which commits the Log shows and its graph (split out of log.js for the real repository). No DOM.
   L.computeView(filter, { longEdges }) -> view
     view: { order: [id], graph: Git.graph.create(...), parents(id) -> [id], index: Map id -> row, dotted: Set 'child>parent',
             waiting: bool (a text/path answer is still on its way), badRegex, ms }
     Cached per (refs version, filter, long edges): a snapshot change that does not move the commit list reuses it.
   L.requestFilter(filter, onAnswer) asks the engine for what the client cannot answer itself (log.search for the
     text field, log.paths for the Paths filter); `onAnswer()` runs when an answer for the current filter arrived.
   Branch, user and date are answered here over Git.repo (50 000 commits in a few ms). */
(function () {
  'use strict';
  const Git = window.Git;
  const R = Git.repo;
  const L = (Git.logUI = Git.logUI || {});

  // ---------------------------------------------------------------- engine-side filters (text, paths)
  const remote = { text: { key: null, ids: null, bad: false, seq: 0 }, paths: { key: null, ids: null, seq: 0 }, graph: { key: null, ids: null, seq: 0 } };
  const textKey = (f) => (f.text ? (f.regex ? 'r' : '') + (f.matchCase ? 'c' : '') + ':' + f.text : null);
  const pathsKey = (f) => (f.paths ? f.paths.join('\u0000') : null);
  /** Graph Options other than IntelliJ's defaults (By Commit Date, no First Parent, no No Merges) need the engine's walk. */
  const graphKey = (g) => (g && (g.sort === 'topo' || g.firstParent || g.noMerges) ? [g.sort, g.firstParent ? 1 : 0, g.noMerges ? 1 : 0].join(':') : null);
  const graphOpts = () => { const o = L.opts || {}; return { sort: o.sort === 'topo' ? 'topo' : 'date', firstParent: !!o.firstParent, noMerges: !!o.noMerges }; };
  const refs = () => (Git.store.refsVersion ? Git.store.refsVersion() : 0);
  L.requestFilter = function (f, onAnswer) {
    const tk = textKey(f), pk = pathsKey(f), g = graphOpts(), gk = graphKey(g);
    const want = (slot, key, run) => {
      if (!key) { slot.key = null; slot.ids = null; slot.bad = false; return; }
      const full = refs() + '|' + key;
      if (slot.key === full && (slot.ids || slot.bad)) return;
      if (slot.key === full && slot.pending) return;
      // a new question: the old answer must not filter the table meanwhile (the view waits, see computeView)
      slot.key = full; slot.pending = true; slot.ids = null; slot.bad = false;
      const my = ++slot.seq;
      run().then((res) => {
        if (my !== slot.seq) return;
        slot.pending = false; slot.bad = false; slot.ids = new Set(res.ids || []); slot.list = res.ids || [];
        onAnswer();
      }, (err) => {
        if (my !== slot.seq) return;
        slot.pending = false; slot.ids = null;
        slot.bad = !!(err && err.code === 'invalid_params');
        if (!slot.bad && Git.actions && Git.actions.errorNotice) Git.actions.errorNotice(err, 'Log');
        onAnswer();
      });
    };
    want(remote.text, tk, () => Git.content.search({ text: f.text, regex: !!f.regex, caseSensitive: !!f.matchCase }));
    want(remote.paths, pk, () => Git.content.paths(f.paths));
    want(remote.graph, gk, () => Git.backend.call('log.graphOrder', Object.assign({ repo: R.root }, g)));
  };

  // ---------------------------------------------------------------- client-side filters
  function matcher(f) {
    const tests = [];
    if (f.text && remote.text.ids) { const ids = remote.text.ids; tests.push((c) => ids.has(c.id)); }
    if (f.paths && remote.paths.ids) { const ids = remote.paths.ids; tests.push((c) => ids.has(c.id)); }
    if (f.user) tests.push((c) => {
      if (f.user.me) return Git.isMine(c);
      if (f.user.key) return c.author === f.user.key;
      const a = Git.author(c.author);
      return (a.name + ' ' + a.email).toLowerCase().indexOf(f.user.text.toLowerCase()) >= 0;
    });
    if (f.date) tests.push((c) => (!f.date.after || c.time >= f.date.after) && (!f.date.before || c.time <= f.date.before));
    return tests.length ? (c) => { for (let i = 0; i < tests.length; i++) if (!tests[i](c)) return false; return true; } : null;
  }

  /** The filtered Log keeps its graph: a commit is joined to its nearest visible ancestors; an edge that passes over
      hidden commits is dotted. One pass over the whole list, oldest first (parents before children): every hidden
      commit remembers its nearest visible ancestors (shared arrays along linear stretches, at most 8). */
  function filteredParents(visible, parentsOf) {
    const all = R.log.order, pos = new Map();
    for (let i = 0; i < all.length; i++) pos.set(all[i], i);
    const near = new Map(), parents = new Map(), dotted = new Set();
    const NONE = [];
    for (let i = all.length - 1; i >= 0; i--) {
      const id = all[i], c = R.commits.get(id);
      if (!c) continue;
      const ps = parentsOf ? parentsOf(id) : c.parents;
      if (!visible.has(id) && ps.length === 1 && !visible.has(ps[0])) { const n = near.get(ps[0]); if (n) near.set(id, n); continue; }
      const direct = [], far = [];
      for (let k = 0; k < ps.length; k++) {
        const p = ps[k];
        if (visible.has(p)) { if (direct.indexOf(p) < 0) direct.push(p); continue; }
        const n = near.get(p) || NONE;
        for (let j = 0; j < n.length; j++) if (direct.indexOf(n[j]) < 0 && far.indexOf(n[j]) < 0) far.push(n[j]);
      }
      if (visible.has(id)) {
        const kept = far.length && direct.length + far.length > 1 ? far.filter((x) => !direct.concat(far).some((y) => y !== x && reaches(y, x, pos, parentsOf))) : far;
        kept.forEach((x) => dotted.add(id + '>' + x));
        parents.set(id, direct.concat(kept));
      } else {
        const list = direct.concat(far);
        if (list.length) near.set(id, list.length > 8 ? list.slice(0, 8) : list);
      }
    }
    return { parents, dotted };
  }
  /** Is `x` an ancestor of `y`? Only commits between them in log order can be on the way; gives up (false) after 4000. */
  function reaches(y, x, pos, parentsOf) {
    const limit = pos.get(x);
    if (limit == null) return false;
    const seen = new Set(), stack = [y];
    let budget = 4000;
    while (stack.length && budget-- > 0) {
      const id = stack.pop();
      if (id === x) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      const c = R.commits.get(id), at = pos.get(id);
      if (!c || at == null || at > limit) continue;
      const ps = parentsOf ? parentsOf(id) : c.parents;
      for (let k = 0; k < ps.length; k++) stack.push(ps[k]);
    }
    return false;
  }

  // ---------------------------------------------------------------- the view
  let last = null;
  /** Collapse / Expand Linear Branches: all chains folded or not, and the chains clicked open or shut against that. */
  const collapse = (L.collapse = L.collapse || { all: false, flip: new Set(), v: 0 });
  /** A Branch filter value (text: typed, or a row's name) -> the commit it names: resolved like any typed text
      (Git.actions.typed: a local branch of that name, then a remote one, then a tag), else as a revision. */
  L.filterRefId = function (text) {
    const A = Git.actions;
    if (text && typeof text === 'object') return A ? A.refId(text) : null;   // a ref pair (a row of the branches pane)
    if (A && A.typed) { const r = A.typed(text); if (r.kind !== 'revision') return A.refId(r); }
    return Git.refId(text);
  };
  /** How a Branch filter value is shown (and keyed): a pair by its name, text as it is. */
  L.filterLabel = (x) => (x && typeof x === 'object' ? x.name : String(x));
  const filterKey = (x) => (x && typeof x === 'object' ? x.kind + ':' + x.name : String(x));
  L.setCollapsed = function (all) { collapse.all = !!all; collapse.flip.clear(); collapse.v++; };
  L.toggleChain = function (key) { if (collapse.flip.has(key)) collapse.flip.delete(key); else collapse.flip.add(key); collapse.v++; };
  L.computeView = function (f, o) {
    const g = graphOpts(), gk = graphKey(g);
    const waiting = !!((f.text && !remote.text.ids && !remote.text.bad) || (f.paths && !remote.paths.ids) || (gk && !remote.graph.ids));
    const key = [refs(), R.log.order.length, f.branch ? f.branch.map(filterKey).join(',') : '', f.user ? JSON.stringify(f.user) : '', f.date ? JSON.stringify(f.date) : '',
      f.text && remote.text.ids ? remote.text.key + '#' + remote.text.seq : '', f.paths && remote.paths.ids ? remote.paths.key + '#' + remote.paths.seq : '',
      gk && remote.graph.ids ? remote.graph.key + '#' + remote.graph.seq : '', collapse.all || collapse.flip.size ? collapse.v + (collapse.all ? 'a' : 'f') : '',
      o.longEdges ? 1 : 0, R.headId].join('|');
    if (last && last.key === key) return Object.assign(last.view, { waiting });
    const t0 = performance.now();
    let heads = null, exclude = null;
    if (f.branch) {
      heads = [];
      f.branch.forEach((n) => {
        // 'a..b' (the Branch filter's Select…): the commits of b that a lacks
        const range = L.parseRange && typeof n === 'string' ? L.parseRange(n) : null;
        if (range) { const base = L.filterRefId(range.base); if (base) { exclude = exclude || new Set(); Git.closure(base).forEach((x) => exclude.add(x)); } }
        const tip = L.filterRefId(range ? range.tip : n);
        if (tip && heads.indexOf(tip) < 0) heads.push(tip);
      });
    }
    let order = Git.logOrder(heads);
    // Graph Options: the engine's walk gives the order (Topologically) and which commits take part (First Parent, No Merges)
    const walk = gk && remote.graph.list ? remote.graph : null;
    if (walk) {
      const reach = heads ? new Set(order) : null;
      order = walk.list.filter((id) => R.commits.has(id) && (!reach || reach.has(id)));
    }
    if (exclude) order = order.filter((id) => !exclude.has(id));
    const own = g.firstParent ? (id) => { const c = R.commits.get(id); return c && c.parents.length ? [c.parents[0]] : []; }
      : (id) => { const c = R.commits.get(id); return c ? c.parents : []; };
    const native = exclude ? (id) => own(id).filter((p) => !exclude.has(p)) : own;
    let parents = native, dotted = null;
    const match = matcher(f);
    if (match || (walk && g.noMerges)) {
      const visible = new Set();
      for (let i = 0; i < order.length; i++) { const c = R.commits.get(order[i]); if (c && (!match || match(c))) visible.add(order[i]); }
      if (exclude) exclude.forEach((x) => visible.delete(x));
      order = order.filter((id) => visible.has(id));
      const fp = filteredParents(visible, own);
      parents = (id) => fp.parents.get(id) || [];
      dotted = fp.dotted;
    }
    let dottedFn = dotted && dotted.size ? (id, p) => dotted.has(id + '>' + p) : null;
    let folded = null;
    if (collapse.all || collapse.flip.size) {
      folded = Git.graph.collapse(order, { parents, refs: (id) => Git.refsAt(id), dotted: dottedFn, collapsed: (k) => collapse.all !== collapse.flip.has(k) });
      order = folded.order; parents = folded.parents; dottedFn = folded.dotted;
    }
    const graph = Git.graph.create(order, { parents, refs: (id) => Git.refsAt(id), longEdges: !!o.longEdges, dotted: dottedFn });
    const index = new Map();
    for (let i = 0; i < order.length; i++) index.set(order[i], i);
    const view = { order, graph, parents, index, dotted, folded, waiting, badRegex: remote.text.bad && !!f.text, ms: Math.round(performance.now() - t0) };
    last = { key, view };
    return view;
  };
  L.dropView = () => { last = null; };
})();
