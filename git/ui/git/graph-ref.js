/* Git: IntelliJ's commit graph layout, a line-by-line JavaScript port of the vcs-log graph classes
   (intellij-community, Apache-2.0; the list of source files is in the comment below). graph.js adapts it.
   History: generated from the prototype's arastirma/D/arac/graf-referans.js and verified against the IDE's own test
   data (11 of 11 cases). For real repositories (100 000 commits) the storage became flat arrays and the per-row work
   follows the IDE's own lazy design: EdgesInRowGenerator (block 40, walk 1000, SLRU caches 10/20) and
   PrintElementGeneratorImpl's SLRU cache of sorted row elements (100/200). The unchanged original lives in
   test/ui/fixtures/graph-original/ and test/ui/graph-*.test.js proves both give the same rows. */
(function () {
'use strict';
const module = { exports: {} };
/*
 * Port of the following upstream files (intellij-community, commit f5ca7abe2186ea90603898cff27a38d88fc51405,
 * Apache License 2.0, Copyright 2000-2026 JetBrains s.r.o. and contributors):
 *   platform/vcs-log/graph/src/com/intellij/vcs/log/graph/impl/permanent/PermanentLinearGraphBuilder.java
 *   platform/vcs-log/graph/src/com/intellij/vcs/log/graph/impl/permanent/PermanentLinearGraphImpl.java
 *   platform/vcs-log/graph/src/com/intellij/vcs/log/graph/impl/permanent/GraphLayoutBuilder.kt
 *   platform/vcs-log/graph/src/com/intellij/vcs/log/graph/impl/permanent/GraphLayoutImpl.kt
 *   platform/vcs-log/graph/src/com/intellij/vcs/log/graph/impl/print/EdgesInRowGenerator.java
 *   platform/vcs-log/graph/src/com/intellij/vcs/log/graph/impl/print/PrintElementGeneratorImpl.kt
 *   platform/vcs-log/graph/src/com/intellij/vcs/log/graph/impl/print/GraphElementComparatorByLayoutIndex.java
 *   platform/vcs-log/graph/src/com/intellij/vcs/log/graph/impl/print/GraphColorGetterByHead.kt
 *   platform/vcs-log/graph/src/com/intellij/vcs/log/graph/impl/facade/PrintElementPresentationManagerImpl.kt
 *   platform/vcs-log/impl/src/com/intellij/vcs/log/graph/GraphColorManagerImpl.kt
 *   platform/vcs-log/impl/src/com/intellij/vcs/log/graph/DefaultColorGenerator.kt
 *   platform/vcs-log/impl/src/com/intellij/vcs/log/ui/render/GraphCommitCellUtil.kt
 *   platform/util/src/com/intellij/util/containers/SLRUMap.java (cache policy only)
 */

const NORMAL_TYPES = new Set(['USUAL', 'DOTTED']);
const isNormal = e => NORMAL_TYPES.has(e.type);
const F_ALL = { upNormal: true, downNormal: true, special: true };
const F_NORMAL_DOWN = { upNormal: false, downNormal: true, special: false };
const F_NORMAL_UP = { upNormal: true, downNormal: false, special: false };
const F_SPECIAL = { upNormal: false, downNormal: false, special: true };

function edge(up, down, target, type) { return { isEdge: true, up, down, target, type }; }
function edgeKey(e) { return `E${e.up}:${e.down}:${e.target}:${e.type}`; }
function elKey(el) { return el.isEdge ? edgeKey(el) : `N${el.index}`; }
function notNullNodeIndex(e) { return e.up != null ? e.up : e.down; }

/** SLRUMap: new entries go to the probational queue, a second hit promotes to the protected queue. */
function SLRU(protectedSize, probationalSize) {
  const prot = new Map(), prob = new Map();
  const toProb = (k, v) => {
    prob.delete(k); prob.set(k, v);
    if (prob.size > probationalSize) prob.delete(prob.keys().next().value);
  };
  const toProt = (k, v) => {
    prot.set(k, v);
    if (prot.size > protectedSize) { const old = prot.keys().next().value; const ov = prot.get(old); prot.delete(old); toProb(old, ov); }
  };
  return {
    get(k) {
      if (prot.has(k)) { const v = prot.get(k); prot.delete(k); prot.set(k, v); return v; }
      if (prob.has(k)) { const v = prob.get(k); prob.delete(k); toProt(k, v); return v; }
      return undefined;
    },
    put(k, v) { if (prot.has(k)) { prot.delete(k); toProt(k, v); } else toProb(k, v); },
    clear() { prot.clear(); prob.clear(); },
    get size() { return prot.size + prob.size; },
  };
}

/**
 * The linear graph of a commit list (PermanentLinearGraphBuilder + PermanentLinearGraphImpl).
 * commits: [{ id, parents: [id…], dotted?: [parent ids drawn dashed] }] in row order (top = newest).
 * A parent that is not in the list -> NOT_LOAD_COMMIT special edge (negative target id).
 * Storage is flat (Int32Array, one edge list per node: up neighbours in ascending row order, then down neighbours in
 * parent order), exactly the order PermanentLinearGraphImpl keeps in myLongEdges.
 */
function graphFromCommits(commits) {
  const n = commits.length;
  const indexOf = new Map();
  for (let i = 0; i < n; i++) indexOf.set(commits[i].id, i); // a repeated id keeps its last row, as new Map(entries)
  // DuplicateParentFixer: a parent written twice counts once
  const parents = new Array(n);
  for (let i = 0; i < n; i++) {
    const ps = commits[i].parents || [];
    let list = ps;
    for (let a = 1; a < ps.length && list === ps; a++) for (let b = 0; b < a; b++) if (ps[a] === ps[b]) { list = [...new Set(ps)]; break; }
    parents[i] = list;
  }
  const simple = new Uint8Array(n);
  const simpleDotted = new Uint8Array(n); // the implicit i -> i+1 edge of a filtered log is DOTTED
  const dottedOf = i => (commits[i].dotted && commits[i].dotted.length ? commits[i].dotted : null);
  for (let i = 0; i < n - 1; i++) {
    if (parents[i].length === 1 && parents[i][0] === commits[i + 1].id) {
      simple[i] = 1;
      const d = dottedOf(i);
      if (d && d.indexOf(parents[i][0]) >= 0) simpleDotted[i] = 1;
    }
  }
  // fixUnderdoneEdges: not loaded parents get -(k+2) in the order of the first row that points at them
  const notLoaded = new Map();
  const upCount = new Int32Array(n), downCount = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (simple[i]) continue;
    for (const p of parents[i]) {
      const pi = indexOf.get(p);
      if (pi !== undefined) { downCount[i]++; upCount[pi]++; }
      else { downCount[i]++; if (!notLoaded.has(p)) notLoaded.set(p, -(notLoaded.size + 2)); }
    }
  }
  const start = new Int32Array(n + 1), downStart = new Int32Array(n);
  for (let i = 0; i < n; i++) { downStart[i] = start[i] + upCount[i]; start[i + 1] = downStart[i] + downCount[i]; }
  const adj = new Int32Array(start[n]);
  const dottedEdge = new Uint8Array(start[n]); // per stored down edge (and its mirror up edge)
  const upFill = new Int32Array(n), downFill = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (simple[i]) continue;
    const d = dottedOf(i);
    for (const p of parents[i]) {
      const pi = indexOf.get(p);
      const slot = downStart[i] + downFill[i]++;
      const dot = d && d.indexOf(p) >= 0 ? 1 : 0;
      if (pi !== undefined) {
        adj[slot] = pi; dottedEdge[slot] = dot;
        const up = start[pi] + upFill[pi]++;
        adj[up] = i; dottedEdge[up] = dot;
      } else adj[slot] = notLoaded.get(p);
    }
  }
  const typeAt = k => (dottedEdge[k] ? 'DOTTED' : 'USUAL');

  return {
    nodesCount: () => n,
    nodeType: () => 'USUAL',
    notLoaded,
    adjacentEdges(i, f) {
      const res = [];
      if (i !== 0 && simple[i - 1] && f.upNormal) res.push(edge(i - 1, i, null, simpleDotted[i - 1] ? 'DOTTED' : 'USUAL'));
      for (let k = start[i]; k < start[i + 1]; k++) {
        const a = adj[k];
        if (a < 0) { if (f.special) res.push(edge(i, null, a, 'NOT_LOAD_COMMIT')); continue; }
        if (a < i) { if (f.upNormal) res.push(edge(a, i, null, typeAt(k))); }
        else if (a > i && f.downNormal) res.push(edge(i, a, null, typeAt(k)));
      }
      if (simple[i] && f.downNormal) res.push(edge(i, i + 1, null, simpleDotted[i] ? 'DOTTED' : 'USUAL'));
      return res;
    },
    /** processDownNodes: the normal down neighbours, first parent first. */
    downNodes(i) {
      const res = [];
      for (let k = downStart[i]; k < start[i + 1]; k++) if (adj[k] > i) res.push(adj[k]);
      if (simple[i]) res.push(i + 1);
      return res;
    },
    hasUpNormal: i => (i !== 0 && simple[i - 1] === 1) || downStart[i] > start[i],
  };
}

/** GraphLayoutBuilder.build + GraphLayoutImpl. headCmp(nodeIndex1, nodeIndex2): the one that sorts first is more important. */
function buildLayout(graph, branchNodes, headCmp) {
  const n = graph.nodesCount();
  const downNodes = graph.downNodes || (i => graph.adjacentEdges(i, F_NORMAL_DOWN).map(e => e.down));
  const hasUp = graph.hasUpNormal || (i => graph.adjacentEdges(i, F_NORMAL_UP).length !== 0);
  const heads = [];
  for (let i = 0; i < n; i++) if (!hasUp(i)) heads.push(i);
  const all = [...new Set([...(branchNodes || []), ...heads])];
  const sortedHeads = all.map((v, i) => [v, i]).sort((a, b) => headCmp(a[0], b[0]) || a[1] - b[1]).map(x => x[0]);

  const layoutIndex = new Int32Array(n); // 0 = not assigned yet
  const headNodes = [];
  let cur = 1;
  for (const head of sortedHeads) {
    if (layoutIndex[head] !== 0) continue;
    headNodes.push(head);
    const stack = [head];
    while (stack.length) {
      const node = stack[stack.length - 1];
      const firstVisit = layoutIndex[node] === 0;
      if (firstVisit) layoutIndex[node] = cur;
      let next = -1;
      for (const d of downNodes(node)) if (layoutIndex[d] === 0) { next = d; break; }
      if (next === -1) { if (firstVisit) cur++; stack.pop(); }
      else stack.push(next);
    }
  }
  const headLayout = headNodes.map(h => layoutIndex[h]); // ascending
  function headOrder(li) { // Arrays.binarySearch; not found -> max(0, insertionPoint - 1)
    let lo = 0, hi = headLayout.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (headLayout[mid] < li) lo = mid + 1; else if (headLayout[mid] > li) hi = mid - 1; else return mid;
    }
    return Math.max(0, lo - 1);
  }
  return {
    layoutIndex,
    headNodes,
    getLayoutIndex: i => layoutIndex[i],
    getOneOfHeadNodeIndex: i => headNodes[headOrder(layoutIndex[i])],
  };
}

/**
 * EdgesInRowGenerator: the normal edges that pass a row (up < row < down). Rows are grouped in blocks of 40; the edge
 * set at a block's first row is found by walking down from at most `walkSize` rows above it, the set at the next
 * block's first row by walking up from at most `walkSize` rows below it, both kept in SLRU caches (10/20). An edge
 * longer than the walk on both sides is not returned; it is never visible there either (see isVisibleInRow).
 */
function createEdgesInRowGenerator(graph, walkSize, blockSize) {
  const WALK = walkSize == null ? 1000 : walkSize, BLOCK = blockSize == null ? 40 : blockSize;
  const n = graph.nodesCount(), K = n + 1;
  const key = e => (e.up * K + e.down) * 2 + (e.type === 'DOTTED' ? 1 : 0);
  const cacheNU = SLRU(10, 20), cacheND = SLRU(10, 20);
  const copy = s => ({ row: s.row, edges: new Map(s.edges) });
  function oneDownStep(s) {
    for (const e of graph.adjacentEdges(s.row, F_NORMAL_DOWN)) s.edges.set(key(e), e);
    for (const e of graph.adjacentEdges(s.row + 1, F_NORMAL_UP)) s.edges.delete(key(e));
    s.row++;
  }
  function oneUpStep(s) {
    for (const e of graph.adjacentEdges(s.row, F_NORMAL_UP)) s.edges.set(key(e), e);
    for (const e of graph.adjacentEdges(s.row - 1, F_NORMAL_DOWN)) s.edges.delete(key(e));
    s.row--;
  }
  function neighborU(row) {
    const at = Math.floor(row / BLOCK) * BLOCK;
    let s = cacheNU.get(at);
    if (!s) {
      s = { row: Math.max(at - WALK, 0), edges: new Map() };
      while (s.row < at) oneDownStep(s);
      cacheNU.put(at, s);
    }
    return copy(s);
  }
  function neighborD(row) {
    const at = Math.floor(row / BLOCK) * BLOCK + BLOCK;
    if (at >= n) return { row: n - 1, edges: new Map() };
    let s = cacheND.get(at);
    if (!s) {
      s = { row: Math.min(at + WALK, n - 1), edges: new Map() };
      while (s.row > at) oneUpStep(s);
      cacheND.put(at, s);
    }
    return copy(s);
  }
  return {
    /** -> [edge] in no particular order (a set). */
    getEdgesInRow(row) {
      const u = neighborU(row);
      while (u.row < row) oneDownStep(u);
      const d = neighborD(row);
      while (d.row > row) oneUpStep(d);
      for (const [k, e] of d.edges) u.edges.set(k, e);
      return [...u.edges.values()];
    },
    invalidate() { cacheNU.clear(); cacheND.clear(); },
  };
}

/**
 * PrintElementGeneratorImpl. opts: {longEdgeSize, visiblePartSize, edgeWithArrowSize, walkSize?, blockSize?}
 *   Show Long Edges off (default): {30, 1, Infinity};  on: {1000, 250, 30}
 * layoutOf(nodeIndex) -> layoutIndex; colorOf(element) -> colorId
 */
function createPrintElementGenerator(graph, layoutOf, colorOf, opts) {
  const { longEdgeSize, visiblePartSize, edgeWithArrowSize } = opts;
  const n = graph.nodesCount();
  const edgesInRow = createEdgesInRowGenerator(graph, opts.walkSize, opts.blockSize);

  function cmp2(e, nodeIndex) {
    if (!isNormal(e)) return layoutOf(notNullNodeIndex(e)) - layoutOf(nodeIndex);
    const m = Math.max(layoutOf(e.up), layoutOf(e.down));
    const li = layoutOf(nodeIndex);
    return m !== li ? m - li : e.up - nodeIndex;
  }
  function compare(o1, o2) {
    if (o1.isEdge && o2.isEdge) {
      if (!isNormal(o1)) return -cmp2(o2, notNullNodeIndex(o1));
      if (!isNormal(o2)) return cmp2(o1, notNullNodeIndex(o2));
      if (o1.up === o2.up) return o1.down < o2.down ? -cmp2(o2, o1.down) : cmp2(o1, o2.down);
      return o1.up < o2.up ? cmp2(o1, o2.up) : -cmp2(o2, o1.up);
    }
    if (o1.isEdge && !o2.isEdge) return cmp2(o1, o2.index);
    if (!o1.isEdge && o2.isEdge) return -cmp2(o2, o1.index);
    return 0;
  }

  function isVisibleInRow(e, row) {
    if (!isNormal(e)) return false;
    return e.down - e.up < longEdgeSize || Math.min(row - e.up, e.down - row) <= visiblePartSize;
  }
  function arrowType(e, row) {
    if (isNormal(e)) {
      const size = e.down - e.up, upOff = row - e.up, downOff = e.down - row;
      if (size >= longEdgeSize) {
        if (upOff === visiblePartSize) return 'DOWN';
        if (downOff === visiblePartSize) return 'UP';
      }
      if (size >= edgeWithArrowSize) {
        if (upOff === 1) return 'DOWN';
        if (downOff === 1) return 'UP';
      }
      return null;
    }
    if (e.type === 'DOTTED_ARROW_DOWN' || e.type === 'NOT_LOAD_COMMIT') { if (e.up === row - 1) return 'DOWN'; }
    else if (e.type === 'DOTTED_ARROW_UP') { if (e.down === row + 1) return 'UP'; }
    return null;
  }

  const cache = SLRU(100, 200);
  function sortedVisible(row) {
    const hit = cache.get(row);
    if (hit) return hit;
    const res = [{ isEdge: false, index: row }];
    // Java keeps a HashSet here; ordered by (up, down) to be deterministic (the comparator never returns 0 for two normal edges)
    const cr = edgesInRow.getEdgesInRow(row).filter(e => isVisibleInRow(e, row)).sort((a, b) => a.up - b.up || a.down - b.down);
    for (const e of cr) res.push(e);
    if (row > 0) for (const e of graph.adjacentEdges(row - 1, F_SPECIAL)) if (e.up === row - 1) res.push(e);
    if (row < n - 1) for (const e of graph.adjacentEdges(row + 1, F_SPECIAL)) if (e.down === row + 1) res.push(e);
    const sorted = res.map((v, i) => [v, i]).sort((a, b) => compare(a[0], b[0]) || a[1] - b[1]).map(x => x[0]); // stable
    cache.put(row, sorted);
    return sorted;
  }
  function endPosition(row2, up) {
    if (row2 < 0 || row2 >= n) return () => null;
    const pos = new Map();
    sortedVisible(row2).forEach((el, i) => pos.set(elKey(el), i));
    return e => {
      const k = edgeKey(e);
      if (pos.has(k)) return pos.get(k);
      const ni = up ? e.up : e.down;
      if (ni != null && pos.has(`N${ni}`)) return pos.get(`N${ni}`);
      return null;
    };
  }
  const lineStyle = e => (e.type === 'USUAL' || e.type === 'NOT_LOAD_COMMIT' ? 'SOLID' : 'DASHED');
  const edgeEl = (row, pos, other, type, e, hasArrow, terminal) =>
    ({ kind: 'edge', row, position: pos, otherPosition: other, type, hasArrow, terminal: !!terminal, lineStyle: lineStyle(e), element: e, colorId: colorOf(e) });

  /** The print elements of a row: edges first, then nodes (a node is drawn over the lines). */
  function getPrintElements(row) {
    const result = [], nodes = [];
    const visible = sortedVisible(row);
    const upPos = endPosition(row - 1, true), downPos = endPosition(row + 1, false);
    visible.forEach((el, position) => {
      if (!el.isEdge) {
        nodes.push({ kind: 'node', row, position, element: el, colorId: colorOf(el) });
        for (const e of graph.adjacentEdges(el.index, F_ALL)) {
          const a = arrowType(e, row), d = downPos(e), u = upPos(e);
          if (d != null) result.push(edgeEl(row, position, d, 'DOWN', e, a === 'DOWN'));
          if (u != null) result.push(edgeEl(row, position, u, 'UP', e, a === 'UP'));
        }
      } else {
        const d = downPos(el), u = upPos(el), a = arrowType(el, row);
        if (d != null) result.push(edgeEl(row, position, d, 'DOWN', el, a === 'DOWN'));
        else if (a === 'DOWN') result.push(edgeEl(row, position, position, 'DOWN', el, true, true));
        if (u != null) result.push(edgeEl(row, position, u, 'UP', el, a === 'UP'));
        else if (a === 'UP') result.push(edgeEl(row, position, position, 'UP', el, true, true));
      }
    });
    return result.concat(nodes);
  }

  /** calculateRecommendedWidth: weighted mean + deviation of the width (lanes) of the first 20000 rows. */
  function recommendedWidth() {
    if (n === 0) return 0;
    if (n === 1) return 1;
    const K = 0.1, cnt = Math.min(20000, n), N = n + 1;
    let sum = 0, sumSq = 0, edgesCount = 0;
    const current = new Map();
    for (let i = 0; i < cnt; i++) {
      let upArrows = 0, downArrows = 0;
      for (const e of graph.adjacentEdges(i, F_ALL)) {
        if (isNormal(e)) { const k = (e.up * N + e.down) * 2 + (e.type === 'DOTTED' ? 1 : 0); if (e.down === i) current.delete(k); else current.set(k, e); }
        else if (e.type === 'DOTTED_ARROW_UP') upArrows++; else downArrows++;
      }
      let newEdges = 0;
      for (const e of current.values()) {
        if (isVisibleInRow(e, i)) newEdges++;
        else { const a = arrowType(e, i); if (a === 'DOWN') downArrows++; else if (a === 'UP') upArrows++; }
      }
      const width = Math.max(edgesCount + upArrows, newEdges + downArrows);
      const weight = 2 / (cnt * (K + 1)) * (1 + (K - 1) * i / (cnt - 1));
      sum += width * weight; sumSq += width * width * weight;
      edgesCount = newEdges;
    }
    // When every row is equally wide (a history without branches: one lane all the way) the variance is zero, and in
    // floating point it can come out a hair below zero: its root is NaN then. Java's (int) Math.round(NaN) is 0, in
    // JavaScript the NaN went on into every row's width and the subjects were pushed out of the table (0.1.7 and
    // before, any repository with a purely linear history). A variance is never negative: it is cut at zero.
    const width = Math.round(sum + Math.sqrt(Math.max(0, sumSq - sum * sum)));
    return Number.isFinite(width) ? width : 0;
  }

  return { getPrintElements, sortedVisible, recommendedWidth, edgesInRow };
}

// ---- color ------------------------------------------------------------------------------------------------------

function javaHash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return h; }
function rangeFix(v) { return Math.abs(v % 100) + 70; }
/** DefaultColorGenerator.calcColor; dark theme: sat = 0.6, bri = 0.6. colorId 0 -> null (the caller uses the text color). */
function graphColor(colorId, sat, bri) {
  if (colorId === 0) return null;
  const r = rangeFix((Math.imul(colorId, 200) + 30) | 0), g = rangeFix((Math.imul(colorId, 130) + 50) | 0), b = rangeFix((Math.imul(colorId, 90) + 100) | 0);
  const f = Math.fround, cmax = Math.max(r, g, b), cmin = Math.min(r, g, b);
  let hue = 0;
  if (cmax !== cmin) {
    const d = cmax - cmin, rc = f((cmax - r) / d), gc = f((cmax - g) / d), bc = f((cmax - b) / d);
    hue = r === cmax ? f(bc - gc) : g === cmax ? f(2 + rc - bc) : f(4 + gc - rc);
    hue = f(hue / 6); if (hue < 0) hue = f(hue + 1);
  }
  const h = f((hue - Math.floor(hue)) * 6), i = Math.floor(h), ff = f(h - i);
  const p = f(bri * (1 - sat)), q = f(bri * (1 - sat * ff)), t = f(bri * (1 - sat * (1 - ff)));
  const c = [[bri, t, p], [q, bri, p], [p, bri, t], [p, q, bri], [t, p, bri], [bri, p, q]][i];
  return '#' + c.map(v => Math.floor(f(v * 255) + 0.5).toString(16).padStart(2, '0')).join('').toUpperCase();
}
/**
 * GraphColorGetterByHead + GraphColorManagerImpl + PrintElementPresentationManagerImpl.getColorId.
 * bestRefNameOfHead(headNodeIndex) -> the name of the most important ref on that commit, or null.
 */
function createColorIdGetter(layout, bestRefNameOfHead) {
  function nodeColorId(i) {
    const li = layout.getLayoutIndex(i);
    const head = layout.getOneOfHeadNodeIndex(i);
    if (layout.getLayoutIndex(head) === li) {
      const name = bestRefNameOfHead(head);
      return name == null ? 0 : javaHash(name);
    }
    return li;
  }
  return el => {
    if (!el.isEdge) return nodeColorId(el.index);
    if (!isNormal(el)) return nodeColorId(notNullNodeIndex(el));
    return layout.getLayoutIndex(el.up) >= layout.getLayoutIndex(el.down) ? nodeColorId(el.up) : nodeColorId(el.down);
  };
}

/** GraphCommitCellUtil.getGraphWidth: the x (px) where the text starts. */
function graphWidth(printElements, rowHeight, recommendedWidth) {
  if (!printElements.length) return 0;
  let maxIndex = 0;
  for (const p of printElements) {
    maxIndex = Math.max(maxIndex, p.position);
    if (p.kind === 'edge') maxIndex = Math.max(maxIndex, (p.position + p.otherPosition) / 2);
  }
  maxIndex++;
  maxIndex = Math.max(maxIndex, Math.min(6, recommendedWidth));
  return Math.trunc(maxIndex * (16 * rowHeight / 22)) + Math.trunc(2 * rowHeight / 22);
}

module.exports = {
  graphFromCommits, buildLayout, createEdgesInRowGenerator, createPrintElementGenerator, createColorIdGetter, graphColor,
  javaHash, graphWidth, SLRU, edge, isNormal, notNullNodeIndex, F_ALL, F_NORMAL_DOWN, F_NORMAL_UP, F_SPECIAL,
};

(window.Git = window.Git || {}).graphRef = module.exports;
})();
