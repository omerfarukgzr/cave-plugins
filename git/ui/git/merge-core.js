/* The three-way merge of one conflicted file, without DOM (split from merge-tool.js; tested in
   test/ui/merge-core.test.js). A session holds the three texts, the Result (it starts as the base) and one block per
   difference with the decisions taken on it (IntelliJ's MergeThreesideViewer: » / « accept a side, × ignores it, the
   magic wand merges a simple conflict word by word).
   Git.mergeCore.create({ base, left, right }, { ignore }) -> session
   .accept(s, k, 'L'|'R', whole) · .ignore(s, k, side, whole) · .applySafe(s, 'L'|'R'|'all') · .applyMagic(s, only?)
   .counts(s) -> { changes, conflicts } · .done(k) · .changed(k, side) · .sideDone(k, side) · .range(k, pane) · .simple(k)
   .kind(k) · .snap(s) / .restore(s, json) · .text(s) (the Result as file text) · .join(lines) */
(function () {
  'use strict';
  const Git = (window.Git = window.Git || {});
  const M = (Git.mergeCore = {});
  const NORMAL = { none: null, trim: (x) => x.trim(), spaces: (x) => x.replace(/\s+/g, '') };

  const join = (lines) => (lines.length ? lines.join('\n') + '\n' : '');
  const changed = (k, side) => (side === 'L' ? k.type !== 'theirs' : k.type !== 'yours');
  function done(k) { return (!changed(k, 'L') || k.doneL) && (!changed(k, 'R') || k.doneR); }
  const sideDone = (k, side) => (side === 'M' ? done(k) : side === 'L' ? k.doneL : k.doneR);
  const range = (k, pane) => (pane === 'L' ? k.L : pane === 'R' ? k.R : [k.m0, k.m1]);
  const simple = (k) => !!k.auto && !done(k) && !k.applied && !k.doneL && !k.doneR;
  /** modified / inserted / deleted, as the changed side differs from the base; a conflict is its own kind. */
  function kind(k) {
    if (k.type === 'conflict') return 'conflict';
    const side = k.type === 'theirs' ? k.R : k.L;
    return k.B[0] === k.B[1] ? 'ins' : side[0] === side[1] ? 'del' : 'mod';
  }
  Object.assign(M, { join, changed, done, sideDone, range, simple, kind });

  /** A conflict whose two sides changed different words can be merged word by word ("simple conflict"); null otherwise. */
  function wordMerge(s, k) {
    if (k.B[0] === k.B[1] || k.L[0] === k.L[1] || k.R[0] === k.R[1]) return null;
    const NL = '␤';
    const tokens = (lines) => (lines.join('\n').match(/[A-Za-z0-9_]+|\n|[^\S\n]+|[^A-Za-z0-9_\s]/g) || []).map((x) => (x === '\n' ? NL : x)).join('\n') + '\n';
    const m = Git.diff.merge3(tokens(s.base.slice(k.B[0], k.B[1])), tokens(s.left.slice(k.L[0], k.L[1])), tokens(s.right.slice(k.R[0], k.R[1])));
    if (m.chunks.some((x) => x.type === 'conflict')) return null;
    const out = [];
    m.chunks.forEach((x) => {
      const from = x.type === 'theirs' ? m.theirs : x.type === 'eq' ? m.base : m.yours;
      const r = x.type === 'theirs' ? x.theirs : x.type === 'eq' ? x.base : x.yours;
      for (let i = r[0]; i < r[1]; i++) out.push(from[i]);
    });
    return out.join('').split(NL);
  }

  /** A new session for three texts. `o.ignore`: 'none' | 'trim' | 'spaces' (how lines are compared). */
  M.create = function (texts, o) {
    const f = NORMAL[(o && o.ignore) || 'none'];
    const base = Git.diff.split(texts.base || ''), left = Git.diff.split(texts.left || ''), right = Git.diff.split(texts.right || '');
    const norm = (lines) => join(f ? lines.map(f) : lines);
    const m = Git.diff.merge3(norm(base), norm(left), norm(right));
    const s = { base, left, right, result: base.slice(), undo: [], redo: [], typing: 0, expanded: new Set(),
      finalNewline: texts.finalNewline !== false };
    s.chunks = m.chunks.filter((k) => k.type !== 'eq').map((k) => ({ type: k.type, L: k.yours.slice(), B: k.base.slice(), R: k.theirs.slice(),
      m0: k.base[0], m1: k.base[1], doneL: false, doneR: false, applied: false, auto: null }));
    s.chunks.forEach((k) => { if (k.type === 'conflict') k.auto = wordMerge(s, k); });
    return s;
  };

  /** Writes `lines` over a block's range in the result (or after it), and moves the blocks below. */
  function put(s, k, lines, append) {
    const at = append ? k.m1 : k.m0, cut = append ? 0 : k.m1 - k.m0;
    s.result.splice(at, cut, ...lines);
    const d = lines.length - cut;
    k.m1 += d;
    for (let i = s.chunks.indexOf(k) + 1; i < s.chunks.length; i++) { s.chunks[i].m0 += d; s.chunks[i].m1 += d; }
  }
  M.put = put;
  /** » / «: takes one side. In a conflict the second side taken is appended after the first; `whole` ends the conflict at once. */
  M.accept = function (s, k, side, whole) {
    if (sideDone(k, side)) return;
    const src = side === 'L' ? s.left.slice(k.L[0], k.L[1]) : s.right.slice(k.R[0], k.R[1]);
    const other = side === 'L' ? k.R : k.L;
    if (k.type !== 'conflict') { put(s, k, src); k.doneL = k.doneR = true; return; }
    put(s, k, src, k.applied);
    if (whole || other[0] === other[1]) k.doneL = k.doneR = true;
    else { k.applied = true; if (side === 'L') k.doneL = true; else k.doneR = true; }
  };
  /** ×: leaves the result as it is for that side. */
  M.ignore = function (s, k, side, whole) {
    if (k.type !== 'conflict' || whole) k.doneL = k.doneR = true;
    else if (side === 'L') k.doneL = true; else k.doneR = true;
  };
  /** Apply non-conflicting changes: Left, Right or All. */
  M.applySafe = function (s, which) {
    s.chunks.forEach((k) => {
      if (k.type === 'conflict' || done(k)) return;
      if (which === 'all') M.accept(s, k, changed(k, 'L') ? 'L' : 'R');
      else if (changed(k, which)) M.accept(s, k, which);
    });
  };
  /** The magic wand: merges simple conflicts word by word (all of them, or only `only`). Returns how many. */
  M.applyMagic = function (s, only) {
    let n = 0;
    s.chunks.forEach((k) => { if ((!only || k === only) && simple(k)) { put(s, k, k.auto); k.doneL = k.doneR = true; n++; } });
    return n;
  };
  M.counts = function (s) {
    let changes = 0, conflicts = 0;
    s.chunks.forEach((k) => { if (!done(k)) { if (k.type === 'conflict') conflicts++; else changes++; } });
    return { changes, conflicts };
  };
  M.snap = (s) => JSON.stringify({ r: s.result, k: s.chunks.map((k) => [k.m0, k.m1, k.doneL, k.doneR, k.applied]) });
  M.restore = function (s, json) {
    const v = JSON.parse(json);
    s.result = v.r;
    v.k.forEach((x, i) => { const k = s.chunks[i]; k.m0 = x[0]; k.m1 = x[1]; k.doneL = x[2]; k.doneR = x[3]; k.applied = x[4]; });
  };
  /** The Result as the text written to the file (no final newline when none of the versions had one). */
  M.text = function (s) {
    const t = join(s.result);
    return s.finalNewline || !t ? t : t.replace(/\n$/, '');
  };
  /** How many blocks are decided, of how many (the Conflicts dialog's "1/3" badge). */
  M.progress = (s) => ({ done: s.chunks.filter(done).length, total: s.chunks.length });
  /** Resolve All Simple Conflicts for one file: every non-conflicting change and every simple conflict. */
  M.autoResolve = function (s) {
    M.applySafe(s, 'all');
    const resolved = M.applyMagic(s), left = M.counts(s);
    return { resolved, remaining: left.conflicts, clear: !left.changes && !left.conflicts };
  };
})();
