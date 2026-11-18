/* Drawing helpers of the three-pane merge tool (split from merge-tool.js): syntax highlighting per line, the
   changed words of a block, and the rows each pane shows (lines and folds of unchanged runs).
   Git.mergePaint.highlight(lines, path) · .innerOf(s, k, prefs) · .rangesAt(list, line) · .wordLayer(text, ranges)
   .esc(text) · .icon(name) · .layout(s, prefs) -> { L, M, R: { rows, y, folds, height } } · ROW, CONTEXT */
(function () {
  'use strict';
  const Git = window.Git;
  const C = Git.mergeCore;
  const P = (Git.mergePaint = { ROW: 22, CONTEXT: 4 });

  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  P.esc = esc;
  const LANG = { css: 'css', swift: 'swift', js: 'javascript', ts: 'typescript', json: 'json', md: 'markdown', sh: 'bash', html: 'xml', xml: 'xml', yml: 'yaml', yaml: 'yaml', py: 'python', go: 'go' };
  /** Highlighted HTML per line (spans reopened on every line); plain text when highlight.js is not on the page. */
  P.highlight = function (lines, path) {
    const H = window.hljs, lang = LANG[(path.split('.').pop() || '').toLowerCase()];
    if (!H || !lang || !H.getLanguage(lang) || !lines.length) return lines.map(esc);
    let html;
    try { html = H.highlight(lines.join('\n'), { language: lang, ignoreIllegals: true }).value; } catch (e) { return lines.map(esc); }
    const out = [], open = [];
    let cur = '';
    html.split(/(<span[^>]*>|<\/span>|\n)/).forEach((part) => {
      if (part === '\n') { out.push(cur + '</span>'.repeat(open.length)); cur = open.join(''); }
      else if (part.indexOf('<span') === 0) { open.push(part); cur += part; }
      else if (part === '</span>') { open.pop(); cur += part; }
      else cur += part;
    });
    out.push(cur + '</span>'.repeat(open.length));
    return out;
  };
  /** Character-level counterpart of Git.diff.words. */
  function charDiff(a, b) {
    const A = a.join('\n'), B = b.join('\n');
    if (A.length * B.length > 4e6) return Git.diff.words(a, b);
    const keepA = new Set(), keepB = new Set();
    Git.diff.lcs(A.split(''), B.split('')).forEach((p) => { keepA.add(p[0]); keepB.add(p[1]); });
    const ranges = (text, keep) => {
      const out = [];
      let line = 0, col = 0;
      for (let i = 0; i < text.length; i++, col++) {
        if (text[i] === '\n') { line++; col = -1; continue; }
        if (keep.has(i)) continue;
        const last = out[out.length - 1];
        if (last && last[0] === line && last[2] === col) last[2]++; else out.push([line, col, col + 1]);
      }
      return out;
    };
    return { a: ranges(A, keepA), b: ranges(B, keepB) };
  }
  /** The changed words of a block in each pane: `{ L, M, R }`, each `[[line, from, to]…]` (line counted inside the block). */
  P.innerOf = function (s, k, prefs) {
    const out = {};
    if (prefs.highlight === 'lines' || C.done(k)) return out;
    const mid = s.result.slice(k.m0, k.m1);
    const diff = prefs.highlight === 'chars' ? charDiff : Git.diff.words;
    ['L', 'R'].forEach((side) => {
      const r = C.range(k, side);
      if (!C.changed(k, side) || C.sideDone(k, side) || r[0] === r[1] || !mid.length) return;
      let w;
      try { w = diff(mid, (side === 'L' ? s.left : s.right).slice(r[0], r[1])); } catch (e) { return; }   // too big to diff: lines only
      out[side] = w.b;
      out.M = (out.M || []).concat(w.a);
    });
    return out;
  };
  P.rangesAt = function (list, line) {
    const mine = (list || []).filter((r) => r[0] === line).map((r) => [r[1], r[2]]).sort((a, b) => a[0] - b[0]);
    const out = [];
    mine.forEach((r) => { const last = out[out.length - 1]; if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else out.push(r); });
    return out;
  };
  P.wordLayer = function (text, ranges) {
    let out = '', at = 0;
    ranges.forEach((r) => { out += esc(text.slice(at, r[0])) + '<i>' + esc(text.slice(r[0], r[1])) + '</i>'; at = r[1]; });
    return '<span class="gm-w">' + out + esc(text.slice(at)) + '</span>';
  };
  P.icon = (name) => '<span class="g-ic" aria-hidden="true">' + ((Git.ICONS || {})[name] || '') + '</span>';

  /** Rows of each pane (lines and folds of unchanged runs) and the y of every line boundary. */
  P.layout = function (s, prefs) {
    const ROW = P.ROW, CONTEXT = P.CONTEXT;
    const lens = { L: s.left.length, M: s.result.length, R: s.right.length }, n = s.chunks.length, out = {};
    ['L', 'M', 'R'].forEach((p) => {
      const rows = [], y = new Array(lens[p] + 1), byLine = [], folds = {};
      let from = 0;
      const line = (i, extra) => { y[i] = rows.length * ROW; byLine[i] = Object.assign({ line: i }, extra); rows.push(byLine[i]); };
      const calm = (to, r) => {
        const a = r === 0 ? from : from + CONTEXT, b = r === n ? to : to - CONTEXT;
        const fold = n > 0 && prefs.collapse && !s.expanded.has(r) && b - a >= 3;
        for (let i = from; i < to; i++) {
          if (!fold || i < a || i >= b) line(i);
          else { if (i === a) { folds[r] = rows.length * ROW; rows.push({ fold: b - a, region: r }); } y[i] = (rows.length - 1) * ROW; }
        }
      };
      s.chunks.forEach((k, r) => {
        const c = C.range(k, p);
        calm(c[0], r);
        for (let i = c[0]; i < c[1]; i++) line(i, { chunk: k, first: i === c[0], last: i === c[1] - 1 });
        from = c[1];
      });
      calm(lens[p], n);
      if (!rows.length) rows.push({ line: 0, blank: true });
      y[lens[p]] = (lens[p] ? rows.length : 0) * ROW;
      // Where a block is empty on this side it shows as a thin line; its buttons sit on the line after it.
      s.chunks.forEach((k) => {
        if (p !== 'M' && !C.changed(k, p)) return;
        const c = C.range(k, p), row = byLine[c[0]] || rows[rows.length - 1];
        if (c[0] === c[1]) { row.edge = k; row.edgeEnd = !byLine[c[0]] && !row.blank; }
        if (p === 'M') { if (C.simple(k)) row.wand = k; }
        else if (!C.sideDone(k, p)) row.ops = k;
      });
      out[p] = { rows, y, folds, height: rows.length * ROW };
    });
    return out;
  };
})();
