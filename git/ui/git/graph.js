/* Git: the commit graph, laid out exactly as IntelliJ's log does it.
   The layout itself is graph-ref.js (the IDE's own algorithm: one layout index per first-parent chain, a column is an
   element's rank among the elements visible in its row, lane color from the head's best ref name). This file feeds it
   the repository's refs in IntelliJ's order (GitBranchLayoutComparator) and turns its print elements into rows that
   graphpaint.js draws. No DOM here.

   Git.graph.create(order, o) -> g      the whole graph and layout indexes at once (linear), rows lazily per window
     g.rowCount, g.row(i), g.rows(from, to), g.width(from, to), g.indexOf(id), g.recommendedWidth, g.layoutIndex(i)
   Git.graph.layout(order, o)          the old all-rows form: { rows, recommendedWidth, layoutIndex }
   Git.graph.collapse(order, o)        Collapse Linear Branches: the input with linear chains taken out (dotted edges) */
(function () {
  'use strict';
  const Git = (window.Git = window.Git || {});
  const G = (Git.graph = {});
  const Ref = Git.graphRef;

  // ---- which head gets the leftmost lane: origin/main, other remote branches, main, local branches, tags, HEAD
  const KINDS = ['ORIGIN_MASTER', 'REMOTE_BRANCH', 'MASTER', 'LOCAL_BRANCH', 'TAG', 'CURRENT_BRANCH', 'HEAD', 'OTHER'];
  function kind(ref) {
    if (ref.type === 'head') return 'HEAD';
    if (ref.type === 'tag') return 'TAG';
    if (ref.type === 'local') return ref.name === 'master' || ref.name === 'main' ? 'MASTER' : 'LOCAL_BRANCH';
    if (ref.type === 'remote') return ref.name === 'origin/master' || ref.name === 'origin/main' ? 'ORIGIN_MASTER' : 'REMOTE_BRANCH';
    return 'OTHER';
  }
  const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
  const layoutCmp = (r1, r2) => KINDS.indexOf(kind(r1)) - KINDS.indexOf(kind(r2)) || natural(r1.name, r2.name);
  function bestRef(refs) {
    let best = null;
    refs.forEach((r) => { if (!best || layoutCmp(r, best) < 0) best = r; });
    return best;
  }

  const colorCache = new Map();
  /** CSS color of a lane (dark theme: saturation and brightness 0.6). `colorId` 0 is the text color. */
  G.color = function (colorId) {
    if (colorId === 0) return 'var(--g-graph-default)';
    if (!colorCache.has(colorId)) {
      const c = Ref.graphColor(colorId, 0.6, 0.6);
      colorCache.set(colorId, typeof c === 'string' ? c : '#' + c.map((v) => v.toString(16).padStart(2, '0')).join(''));
    }
    return colorCache.get(colorId);
  };
  G.refColorId = (name) => Ref.javaHash(name);

  /** Builds the graph of `order` (commit ids, newest first). `o`: { parents(id), refs(id), longEdges, dotted(id, parentId) }.
      `dotted` (optional) marks an edge of a filtered log that passes over hidden commits: its lines come out `dashed`.
      A parent that is not in `order` is drawn as IntelliJ draws a commit that is not loaded: a one-row edge that ends in
      a down arrow; that stub carries `notLoaded: true` and `target` = the parent's id.
      Row i: { id, pos, color, colorId, head, merge, cols, lines: [{ from, to, color, arrow, dashed }],
      stubs: [{ pos, dir, color, target, notLoaded? }], upArrow? }. `lines` go from this row's center to the next row's
      center; `stubs` are the arrow ends of long edges; `cols` is the number of lanes the row's text has to clear. */
  G.create = function (order, o) {
    const n = order.length;
    const best = new Array(n), head = new Uint8Array(n), merge = new Uint8Array(n), commits = new Array(n), branchRows = [];
    const index = new Map();
    for (let i = 0; i < n; i++) {
      const id = order[i];
      const list = o.refs(id) || [];
      best[i] = list.length ? bestRef(list) : null;
      if (list.length) {
        if (list.some((r) => r.type !== 'tag')) branchRows.push(i);
        if (list.some((r) => r.type === 'head')) head[i] = 1;
      }
      const parents = o.parents(id) || [];
      if (parents.length > 1) merge[i] = 1;
      commits[i] = o.dotted && parents.length ? { id, parents, dotted: parents.filter((p) => o.dotted(id, p)) } : { id, parents };
      index.set(id, i);
    }
    const graph = Ref.graphFromCommits(commits);
    const notLoadedId = new Map();
    graph.notLoaded.forEach((neg, id) => notLoadedId.set(neg, id));
    const headCmp = (a, b) => {
      if (!best[a]) return best[b] ? 1 : a - b;
      if (!best[b]) return -1;
      return layoutCmp(best[a], best[b]);
    };
    const layout = Ref.buildLayout(graph, branchRows, headCmp);
    const colorOf = Ref.createColorIdGetter(layout, (h) => (best[h] ? best[h].name : null));
    const gen = Ref.createPrintElementGenerator(graph, (i) => layout.getLayoutIndex(i), colorOf,
      o.longEdges ? { longEdgeSize: 1000, visiblePartSize: 250, edgeWithArrowSize: 30 } : { longEdgeSize: 30, visiblePartSize: 1, edgeWithArrowSize: Infinity });
    const recommended = gen.recommendedWidth();
    const minCols = Number.isFinite(recommended) ? Math.min(6, recommended) : 0;   // never a NaN into a row's width

    function build(row, ends) {
      const out = { id: order[row], pos: 0, color: '', colorId: 0, lines: [], stubs: [], cols: 1, merge: merge[row] === 1, head: head[row] === 1 };
      let max = 0;
      gen.getPrintElements(row).forEach((el) => {
        max = Math.max(max, el.position);
        if (el.kind === 'node') { out.pos = el.position; out.colorId = el.colorId; out.color = G.color(el.colorId); return; }
        max = Math.max(max, (el.position + el.otherPosition) / 2);
        const color = G.color(el.colorId), e = el.element;
        if (el.terminal) {
          const stub = { pos: el.position, dir: el.type === 'DOWN' ? 'down' : 'up', color, target: order[el.type === 'DOWN' ? e.down : e.up] || null };
          if (e.type === 'NOT_LOAD_COMMIT') { stub.target = notLoadedId.get(e.target) || null; stub.notLoaded = true; }
          out.stubs.push(stub);
        } else if (el.type === 'DOWN') {
          const line = { from: el.position, to: el.otherPosition, color, arrow: !!el.hasArrow, dashed: el.lineStyle === 'DASHED' };
          if (ends) { line.up = e.up; line.down = e.down; }
          out.lines.push(line);
        }
        else if (el.hasArrow) out.upArrow = (out.upArrow || []).concat({ pos: el.position, to: el.otherPosition, color });
      });
      out.cols = Math.max(max + 1, minCols);
      return out;
    }
    const g = {
      rowCount: n,
      recommendedWidth: recommended,
      /** The row at `i` (a new object on every call), or null outside the table. */
      row: (i) => (i >= 0 && i < n ? build(i) : null),
      /** Rows `from` (inclusive) to `to` (exclusive), clamped to the table. */
      rows(from, to) {
        const a = Math.max(0, from | 0), b = Math.min(n, to == null ? n : to | 0), res = [];
        for (let i = a; i < b; i++) res.push(build(i));
        return res;
      },
      /** The widest `cols` among rows from..to (exclusive): how many lanes the graph column needs for that window. */
      width(from, to) {
        let w = 0;
        g.rows(from, to).forEach((r) => { if (r.cols > w) w = r.cols; });
        return w;
      },
      /** Row `i` with every line knowing its edge's two rows (`up`, `down`): for a click on an edge (graphpaint.edgeAt). */
      withEnds: (i) => (i >= 0 && i < n ? build(i, true) : null),
      indexOf: (id) => (index.has(id) ? index.get(id) : -1),
      layoutIndex: (i) => layout.getLayoutIndex(i),
    };
    return g;
  };

  /** IntelliJ's Collapse / Expand Linear Branches as a transformation of the graph's input (no DOM). A linear branch is
      a maximal chain of commits that each have exactly one parent and one child in `order` and no reference (branch,
      tag, HEAD) on them; the commit above the chain (its child) keeps an edge straight to the commit below it (the
      chain's last parent), drawn dotted, and the chain's commits leave the table.
      `o`: { parents(id), refs(id), dotted(id, p)?, collapsed(key) → bool }; a chain's key is its newest commit's id.
      → { order, parents(id), dotted(id, p), runs: [{ key, upper, lower, members, collapsed }], runOf: Map(member id →
      run), edges: Map('upper>lower' → [collapsed runs]) }. Linear time; the input is not changed. */
  G.collapse = function (order, o) {
    const n = order.length, index = new Map();
    for (let i = 0; i < n; i++) index.set(order[i], i);
    const children = new Int32Array(n), childOf = new Int32Array(n).fill(-1), first = new Array(n);
    for (let i = 0; i < n; i++) {
      const ps = o.parents(order[i]) || [];
      first[i] = ps.length === 1 && index.has(ps[0]) ? index.get(ps[0]) : -1;
      for (let k = 0; k < ps.length; k++) { const j = index.get(ps[k]); if (j !== undefined) { children[j]++; childOf[j] = i; } }
    }
    const linear = new Uint8Array(n);
    for (let i = 0; i < n; i++) linear[i] = first[i] >= 0 && children[i] === 1 && !((o.refs(order[i]) || []).length) ? 1 : 0;
    const runs = [], runOf = new Map(), hidden = new Uint8Array(n), edges = new Map(), replace = new Map();
    for (let i = 0; i < n; i++) {
      if (!linear[i] || linear[childOf[i]]) continue;           // not the top of a chain
      const members = [];
      let j = i;
      while (j >= 0 && linear[j]) { members.push(order[j]); j = first[j]; }
      const run = { key: order[i], upper: order[childOf[i]], lower: order[j], members, collapsed: !!o.collapsed(order[i]) };
      runs.push(run);
      members.forEach((m) => runOf.set(m, run));
      if (!run.collapsed) continue;
      for (let k = 0; k < members.length; k++) hidden[index.get(members[k])] = 1;
      const ek = run.upper + '>' + run.lower;
      if (!edges.has(ek)) edges.set(ek, []);
      edges.get(ek).push(run);
      if (!replace.has(run.upper)) replace.set(run.upper, new Map());
      replace.get(run.upper).set(run.key, run.lower);
    }
    const visible = [];
    for (let i = 0; i < n; i++) if (!hidden[i]) visible.push(order[i]);
    const parents = (id) => {
      const ps = o.parents(id) || [], map = replace.get(id);
      if (!map) return ps;
      const out = [];
      ps.forEach((p) => { const q = map.has(p) ? map.get(p) : p; if (out.indexOf(q) < 0) out.push(q); });
      return out;
    };
    const dotted = (id, p) => edges.has(id + '>' + p) || (o.dotted ? !!o.dotted(id, p) : false);
    return { order: visible, parents, dotted, runs, runOf, edges };
  };

  /** The old form: every row at once. `{ rows, recommendedWidth, layoutIndex }`. Use G.create for real repositories. */
  G.layout = function (order, o) {
    const g = G.create(order, o);
    const layoutIndex = [];
    for (let i = 0; i < g.rowCount; i++) layoutIndex.push(g.layoutIndex(i));
    return { rows: g.rows(0, g.rowCount), recommendedWidth: g.recommendedWidth, layoutIndex };
  };
})();
