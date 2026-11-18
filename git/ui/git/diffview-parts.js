/* Git prototype: what the diff tab (diffview.js) is built from. No tab logic and no DOM here.
   Git.diffParts.compute(left, right, { ignore, highlight })  line blocks, with typed word fragments in modified blocks
                                                              (highlight: lines | words | split | chars | none)
   .layout(model, { collapse, context, expanded, align })     rows of each pane and of the unified view, folds, line → row
                                                              (align: empty `{ pad }` rows even out a change's two sides)
   .syntax(lines, path)                                       per line [{ t, c }] runs (highlight.js when it is loaded)
   .lineHTML(runs, fragments)                                 one line as HTML: syntax classes + word highlights
   .trapezium(w, a0, a1, b0, b1) · .wave(w, y1, y2)           IntelliJ's shapes between the two panes (SVG path data)
   .revertBlock(model, block, base, current)                  the working text after one block goes back to its base lines */
(function () {
  'use strict';
  const Git = window.Git;
  const D = Git.diff;
  const P = (Git.diffParts = {});

  // ---------------------------------------------------------------- blocks
  const NORMALIZE = {
    trim: (s) => s.trim(),                               // Trim whitespaces
    ws: (s) => s.replace(/\s+/g, ''),                    // Ignore whitespaces
    'ws-empty': (s) => s.replace(/\s+/g, ''),            // … and empty lines
  };

  /** Tokens of a block's lines the way diffcore's word diff cuts them, each knowing its line and columns
      (`chars`: one token per character, IntelliJ's "Characters" highlighting). */
  function tokens(lines, chars) {
    const out = [];
    lines.forEach((text, line) => {
      const re = chars ? /[^\n]/g : /[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]/g;
      let m;
      while ((m = re.exec(text))) out.push({ text: m[0], line, from: m.index, to: m.index + m[0].length });
      out.push({ text: '\n', line, from: text.length, to: text.length });
    });
    return out;
  }
  /** Changed tokens [from, to) of one side as ranges per line, without the blanks at their ends;
      a range that is only whitespace says nothing. */
  function ranges(list, from, to, lines) {
    const out = [];
    for (let k = from; k < to; k++) {
      const tk = list[k];
      if (tk.to === tk.from) continue;
      const last = out[out.length - 1];
      if (last && last[0] === tk.line && last[2] === tk.from) last[2] = tk.to; else out.push([tk.line, tk.from, tk.to]);
    }
    return out.map(([line, a, b]) => {
      const text = lines[line].slice(a, b), lead = text.length - text.replace(/^\s+/, '').length;
      return [line, a + lead, a + text.replace(/\s+$/, '').length];
    }).filter(([, a, b]) => b > a);
  }
  /** Word fragments of a modified block, per block-relative line: `{ a: [[from, to, type]…][], b: … }`.
      A fragment with nothing opposite it is an insertion or a deletion; the rest are modifications. */
  P.words = function (aLines, bLines, chars) {
    const ta = tokens(aLines, chars), tb = tokens(bLines, chars);
    const out = { a: aLines.map(() => []), b: bLines.map(() => []), any: false, breaks: [] };
    let i = 0, j = 0;
    D.lcs(ta.map((x) => x.text), tb.map((x) => x.text)).concat([[ta.length, tb.length]]).forEach(([x, y]) => {
      // a line end matched on both sides: where "Split changes" may cut the block
      if (x < ta.length && ta[x].text === '\n' && tb[y].text === '\n') out.breaks.push([ta[x].line + 1, tb[y].line + 1]);
      if (x > i || y > j) {
        const ra = ranges(ta, i, x, aLines), rb = ranges(tb, j, y, bLines);
        const type = !ra.length ? 'ins' : !rb.length ? 'del' : 'mod';
        ra.forEach(([line, from, to]) => out.a[line].push([from, to, type]));
        rb.forEach(([line, from, to]) => out.b[line].push([from, to, type]));
        if (ra.length || rb.length) out.any = true;
      }
      i = x + 1; j = y + 1;
    });
    // Changed words with only blanks between them read as one fragment ("demo project"), the way IntelliJ paints them.
    const join = (rows, lines) => rows.map((list, line) => list.reduce((acc, f) => {
      const last = acc[acc.length - 1];
      if (last && last[2] === f[2] && !/\S/.test(lines[line].slice(last[1], f[0]))) last[1] = f[1]; else acc.push(f);
      return acc;
    }, []));
    out.a = join(out.a, aLines);
    out.b = join(out.b, bLines);
    return out;
  };

  /** Moves a pure insertion or deletion down while the line it leaves equals the line it takes in, so that an added
      function reads "blank line … closing brace" instead of starting with the previous function's brace. */
  function slideDown(blocks, a, b, same) {
    for (let i = 0; i < blocks.length; i++) {
      const k = blocks[i], next = blocks[i + 1];
      if ((k.type !== 'ins' && k.type !== 'del') || !next || next.type !== 'eq') continue;
      const lines = k.type === 'ins' ? b : a, from = k.type === 'ins' ? k.b0 : k.a0, to = k.type === 'ins' ? k.b1 : k.a1;
      const room = next.a1 - next.a0 - (i + 2 < blocks.length ? 1 : 0);
      let n = 0;
      while (n < room && same(lines[from + n], lines[to + n])) n++;
      if (!n) continue;
      let prev = blocks[i - 1];
      if (!prev || prev.type !== 'eq') { prev = { type: 'eq', a0: k.a0, a1: k.a0, b0: k.b0, b1: k.b0 }; blocks.splice(i, 0, prev); i++; }
      prev.a1 += n; prev.b1 += n;
      k.a0 += n; k.a1 += n; k.b0 += n; k.b1 += n;
      next.a0 += n; next.b0 += n;
      if (next.a0 === next.a1) blocks.splice(i + 1, 1);
    }
  }

  /** `{ a, b, blocks, changes }`: diffcore's line blocks under a whitespace policy; `changes` are the indices of the differing blocks. */
  P.compute = function (left, right, o) {
    // A final newline on one side only is a change of the last line (IntelliJ compares the line separators of the
    // documents): the side without it gets a marker char on its last line while the blocks are computed, then the
    // marker goes and `noEol` says which side lacks the newline (the pane notes it; applyBlock writes it back).
    const endA = /\n$/.test(left), endB = /\n$/.test(right), mark = !!left && !!right && endA !== endB;
    if (mark) { if (!endA) left += EOF; else right += EOF; }
    const m = computeLines(left, right, o);
    if (mark) {
      const side = endA ? m.b : m.a;
      side[side.length - 1] = side[side.length - 1].slice(0, -1);
      m.noEol = { a: !endA, b: !endB };
      // word fragments that only marked the marker: the line shows in the full change color instead
      m.blocks.forEach((k) => {
        if (!k.words) return;
        const clip = (rows, lines, from) => rows.map((list, j) => list.filter((f) => f[0] < lines[from + j].length).map((f) => [f[0], Math.min(f[1], lines[from + j].length), f[2]]));
        k.words.a = clip(k.words.a, m.a, k.a0); k.words.b = clip(k.words.b, m.b, k.b0);
        if (!k.words.a.some((l) => l.length) && !k.words.b.some((l) => l.length)) delete k.words;
      });
    }
    return m;
  };
  const EOF = '\u0000';
  function computeLines(left, right, o) {
    const a = D.split(left), b = D.split(right);
    const norm = NORMALIZE[o.ignore] || null;
    const text = (lines) => (lines.length ? lines.map(norm).join('\n') + '\n' : '');
    let blocks = (norm ? D.lines(text(a), text(b)) : D.lines(left, right)).blocks.map((k) => Object.assign({}, k));
    slideDown(blocks, a, b, norm ? (x, y) => norm(x) === norm(y) : (x, y) => x === y);
    if (o.ignore === 'ws-empty') {
      const solid = (lines, from, to) => lines.slice(from, to).map(norm).filter(Boolean).join('\n');
      blocks.forEach((k) => { if (k.type !== 'eq' && solid(a, k.a0, k.a1) === solid(b, k.b0, k.b1)) k.type = 'eq'; });
      blocks = blocks.reduce((list, k) => {
        const last = list[list.length - 1];
        if (last && last.type === 'eq' && k.type === 'eq') { last.a1 = k.a1; last.b1 = k.b1; } else list.push(k);
        return list;
      }, []);
    }
    // HighlightPolicy: lines (no fragments), words, split (words, and a block is cut where a line end matches on both
    // sides), chars (character fragments), none (diffview.js marks nothing)
    const inner = o.highlight === 'words' || o.highlight === 'split' || o.highlight === 'chars';
    const out = [];
    blocks.forEach((k) => {
      if (k.type !== 'mod' || !inner) { out.push(k); return; }
      // a block too big for a word diff keeps its line highlight only
      let w = null;
      try { w = P.words(a.slice(k.a0, k.a1), b.slice(k.b0, k.b1), o.highlight === 'chars'); } catch (e) { if (!e || e.code !== 'too_big') throw e; }
      if (!w) { out.push(k); return; }
      if (o.highlight !== 'split') { if (w.any) k.words = w; out.push(k); return; }
      splitBlock(k, w).forEach((x) => out.push(x));
    });
    const changes = [];
    out.forEach((k, i) => { if (k.type !== 'eq') changes.push(i); });
    return { a, b, blocks: out, changes };
  }
  /** "Split changes": the parts of a modified block between line ends matched on both sides, each one block. */
  function splitBlock(k, w) {
    const na = k.a1 - k.a0, nb = k.b1 - k.b0, parts = [];
    let pa = 0, pb = 0;
    w.breaks.concat([[na, nb]]).forEach(([x, y]) => {
      if (x <= pa && y <= pb) return;
      const sub = { type: x === pa ? 'ins' : y === pb ? 'del' : 'mod', a0: k.a0 + pa, a1: k.a0 + x, b0: k.b0 + pb, b1: k.b0 + y };
      if (sub.type === 'mod') {
        const wa = w.a.slice(pa, x), wb = w.b.slice(pb, y);
        if (wa.some((l) => l.length) || wb.some((l) => l.length)) sub.words = { a: wa, b: wb, any: true };
      }
      parts.push(sub);
      pa = x; pb = y;
    });
    return parts.length ? parts : [k];
  }

  // ---------------------------------------------------------------- rows and folds
  /** Rows to draw. `L` / `R`: `{ line, block }` or `{ fold }`; `U` (unified): `{ a, b, block, type }` or `{ fold }`.
      `lineRow.L[i]` is the row of left line i (a folded line answers with its fold's row; index n is the end).
      `blockRow[bi]`: `{ L: [first, end), R: [first, end) }`, the rows block bi takes on each side, its `pad` rows
      included (so with `align` a change spans the same rows on both sides, an insertion's empty rows too). */
  P.layout = function (m, o) {
    const L = [], Rr = [], U = [], folds = [];
    const lineRow = { L: new Array(m.a.length + 1), R: new Array(m.b.length + 1) };
    const blockRowU = {}, blockRow = [];
    const single = m.blocks.length === 1;
    m.blocks.forEach((k, bi) => {
      const startL = L.length, startR = Rr.length;
      let fold = null;
      const key = k.a0 + ':' + k.b0;
      if (k.type === 'eq' && o.collapse && !single && !o.expanded.has(key)) {
        const head = bi === 0 ? 0 : o.context, tail = bi === m.blocks.length - 1 ? 0 : o.context;
        if (Math.min(k.a1 - k.a0, k.b1 - k.b0) - head - tail >= 2) {
          fold = { key, block: bi, a: [k.a0 + head, k.a1 - tail], b: [k.b0 + head, k.b1 - tail] };
          folds.push(fold);
        }
      }
      const side = (rows, map, from, to, hidden) => {
        for (let i = from; i < to; i++) {
          if (hidden && i >= hidden[0] && i < hidden[1]) {
            if (i === hidden[0]) rows.push({ fold });
            map[i] = rows.length - 1;
          } else { map[i] = rows.length; rows.push({ line: i, block: bi }); }
        }
      };
      side(L, lineRow.L, k.a0, k.a1, fold && fold.a);
      side(Rr, lineRow.R, k.b0, k.b1, fold && fold.b);
      // "Align Changes In Side-by-Side Diff": the shorter side of a change gets empty rows, so both end on one row
      if (o.align && k.type !== 'eq') {
        while (L.length < Rr.length) L.push({ pad: true, block: bi });
        while (Rr.length < L.length) Rr.push({ pad: true, block: bi });
      }
      blockRow[bi] = { L: [startL, L.length], R: [startR, Rr.length] };
      blockRowU[bi] = U.length;
      if (k.type === 'eq') {
        for (let j = k.b0; j < k.b1; j++) {
          if (fold && j >= fold.b[0] && j < fold.b[1]) { if (j === fold.b[0]) U.push({ fold }); continue; }
          const i = k.a0 + (j - k.b0);
          U.push({ a: i < k.a1 ? i : null, b: j, block: bi, type: 'eq' });
        }
      } else {
        for (let i = k.a0; i < k.a1; i++) U.push({ a: i, b: null, block: bi, type: 'del' });
        for (let j = k.b0; j < k.b1; j++) U.push({ a: null, b: j, block: bi, type: 'ins' });
      }
    });
    lineRow.L[m.a.length] = L.length;
    lineRow.R[m.b.length] = Rr.length;
    return { L, R: Rr, U, folds, lineRow, blockRow, blockRowU, align: !!o.align };
  };

  // ---------------------------------------------------------------- syntax colors
  const LANG = { swift: 'swift', js: 'javascript', mjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', css: 'css', scss: 'scss',
    sh: 'bash', zsh: 'bash', bash: 'bash', md: 'markdown', json: 'json', html: 'xml', xml: 'xml', plist: 'xml', svg: 'xml', go: 'go', py: 'python',
    yml: 'yaml', yaml: 'yaml', c: 'c', h: 'c', m: 'objectivec', rb: 'ruby', rs: 'rust', kt: 'kotlin', java: 'java', sql: 'sql', vue: 'xml', php: 'php' };
  const ENTITY = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': '\'', '&#39;': '\'' };
  const decode = (s) => s.replace(/&(?:amp|lt|gt|quot|#x27|#39);/g, (e) => ENTITY[e]);
  const esc = (s) => s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));

  /** highlight.js output → per line runs of `{ t: text, c: classes }` (nested spans carry all their classes). */
  function flatten(html, count) {
    const lines = [[]], stack = [];
    const re = /<span class="([^"]*)">|<\/span>|([^<]+)/g;
    let m;
    while ((m = re.exec(html))) {
      if (m[1] != null) stack.push(m[1]);
      else if (m[2] == null) stack.pop();
      else {
        decode(m[2]).split('\n').forEach((part, k) => {
          if (k) lines.push([]);
          if (part) lines[lines.length - 1].push({ t: part, c: stack.join(' ') });
        });
      }
    }
    while (lines.length < count) lines.push([]);
    return lines;
  }
  P.syntax = function (lines, path) {
    const hl = window.hljs, lang = LANG[(String(path || '').split('.').pop() || '').toLowerCase()];
    if (hl && lang && lines.length && hl.getLanguage && hl.getLanguage(lang)) {
      try { return flatten(hl.highlight(lines.join('\n'), { language: lang, ignoreIllegals: true }).value, lines.length); } catch (e) { /* plain text below */ }
    }
    return lines.map((s) => (s ? [{ t: s, c: '' }] : []));
  };

  /** One line: syntax runs cut at the word fragments `[[from, to, type]…]` (sorted, not overlapping). */
  P.lineHTML = function (runs, fragments) {
    let out = '', pos = 0, fi = 0;
    const frags = fragments || [];
    (runs || []).forEach((run) => {
      let s = 0;
      while (s < run.t.length) {
        const at = pos + s;
        while (fi < frags.length && frags[fi][1] <= at) fi++;
        const f = frags[fi];
        let end = run.t.length, type = null;
        if (f) {
          if (at >= f[0]) { type = f[2]; end = Math.min(end, f[1] - pos); } else end = Math.min(end, f[0] - pos);
        }
        const text = esc(run.t.slice(s, end));
        const inner = run.c ? '<span class="' + run.c + '">' + text + '</span>' : text;
        out += type ? '<span class="gd-w ' + type + '">' + inner + '</span>' : inner;
        s = end;
      }
      pos += run.t.length;
    });
    return out;
  };

  // ---------------------------------------------------------------- shapes between the panes (D-kaynak §5.4, §5.5)
  const r1 = (n) => Math.round(n * 10) / 10;
  /** DiffDrawUtil.drawCurveTrapezium: joins the left range [a0, a1) to the right range [b0, b1) (y in px);
      an empty range narrows to a 1 px tip. Edges are cubic curves with control points at 0.3 and 0.7 of the width. */
  P.trapezium = function (w, a0, a1, b0, b1) {
    const s1 = a1 - a0 < 2 ? a0 - 1 : a0, e1 = a1 - a0 < 2 ? a0 : a1 - 1;
    const s2 = b1 - b0 < 2 ? b0 - 1 : b0, e2 = b1 - b0 < 2 ? b0 : b1 - 1;
    const c1 = r1(w * 0.3), c2 = r1(w * 0.7);
    return 'M0 ' + r1(s1) + 'C' + c1 + ' ' + r1(s1) + ' ' + c2 + ' ' + r1(s2) + ' ' + w + ' ' + r1(s2)
      + 'L' + w + ' ' + r1(e2 + 1) + 'C' + c2 + ' ' + r1(e2 + 1) + ' ' + c1 + ' ' + r1(e1 + 1) + ' 0 ' + r1(e1 + 1) + 'Z';
  };
  /** DiffLineSeparatorRenderer.drawConnectorLine: the wave of a folded stretch crossing from one pane to the other.
      `y1`, `y2`: the vertical middle of the fold row on each side. Quarter period w / 6, half height 3 px. */
  P.wave = function (w, y1, y2) {
    const step = Math.max(w / 6, 2), ht = 3, x1 = 0, x2 = w;
    const p = (x, y) => r1(x) + ' ' + r1(y);
    let d = 'M' + p(x1 - 0.5, y1);
    if (Math.abs(y2 - y1) / w < 0.2) {
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
      d += 'Q' + p(x1 + step * 0.5, y1 + ht) + ' ' + p(x1 + step, y1 + ht) + 'Q' + p(x1 + step * 1.5, y1 + ht) + ' ' + p(x1 + step * 2, my)
        + 'Q' + p(x1 + step * 2.5, my - ht) + ' ' + p(mx, my - ht) + 'Q' + p(x2 - step * 2.5, my - ht) + ' ' + p(x2 - step * 2, my)
        + 'Q' + p(x2 - step * 1.5, y2 + ht) + ' ' + p(x2 - step, y2 + ht) + 'Q' + p(x2 - step * 0.5, y2 + ht) + ' ' + p(x2, y2);
    } else if (y1 > y2) {
      d += 'C' + p(x1 + step * 0.125, y1 + ht * 0.125) + ' ' + p(x1 + step * 0.125, y1 + ht * 0.5) + ' ' + p(x1 + step * 0.5, y1 + ht * 0.5)
        + 'C' + p(x2 - step * 2, y1 + ht * 0.5) + ' ' + p(x2 - step * 2, y2 + ht * 4) + ' ' + p(x2, y2);
    } else {
      d += 'C' + p(x1 + step * 2, y1 + ht * 4) + ' ' + p(x1 + step * 2, y2 + ht * 0.5) + ' ' + p(x2 - step * 0.5, y2 + ht * 0.5)
        + 'C' + p(x2 - step * 0.125, y2 + ht * 0.5) + ' ' + p(x2 - step * 0.125, y2 + ht * 0.125) + ' ' + p(x2, y2);
    }
    return d;
  };

  // ---------------------------------------------------------------- the panes as HTML (diffview.js puts them in the DOM)
  /** `v`: { m, lay, syn, solo, off, revert, highlight, labels: { fold, revert, append }, icon(name) → svg html } */
  const foldRow = (v, key) => '<button type="button" class="gd-fold" data-fold="' + key + '" title="' + v.labels.fold + '" aria-label="' + v.labels.fold + '"></button>';
  // The » of a local change reverts its block; with ⌘/Ctrl held it turns into the Append arrow (IntelliJ's ⌃ variant).
  const revertButton = (v, bi, ic, append) => '<button type="button" class="gd-revert" data-revert="' + bi + '" title="' + v.labels.revert + (append ? '  (⌘: ' + v.labels.append + ')' : '')
    + '" aria-label="' + v.labels.revert + '"><span class="gd-ic-revert">' + v.icon(ic) + '</span>' + (append ? '<span class="gd-ic-append">' + v.icon('diff/arrowRightDown@14x14') + '</span>' : '') + '</button>';

  /** The last line of a side without a final newline (when only one side lacks it): a gray note after the text. */
  const eofNote = (v, side, i) => (v.m.noEol && v.m.noEol[side] && i === v.m[side].length - 1 && !v.solo
    ? '<span class="gd-eof">' + (v.labels.eof || 'No newline at end of file') + '</span>' : '');
  /** One side of the side-by-side view (or the only side of a one-sided one): gutter cells and code lines. */
  P.paneHTML = function (v, side) {
    const m = v.m, left = side === 'L', runs = left ? v.syn.a : v.syn.b, n = left ? m.a.length : m.b.length;
    const paint = v.highlight !== 'none' || !!v.solo;
    const edges = {}, arrows = {};
    m.blocks.forEach((k, bi) => {
      if (k.type === 'eq') return;
      const from = left ? k.a0 : k.b0, to = left ? k.a1 : k.b1;
      // A change with nothing on this side is a 1 px line between two rows.
      if (paint && from === to && n && !v.align) { if (from < n) edges[from] = ' et-' + k.type; else edges[n - 1] = (edges[n - 1] || '') + ' eb-' + k.type; }
      if (left && v.revert && !v.off && n) arrows[Math.min(from, n - 1)] = bi;
    });
    let gutter = '', code = '';
    v.lay[side].forEach((row) => {
      if (row.fold) { gutter += '<div class="gd-gl fold" data-fold="' + row.fold.key + '"></div>'; code += foldRow(v, row.fold.key); return; }
      if (row.pad) {
        const t = paint ? ' pad ' + m.blocks[row.block].type : ' pad';
        gutter += '<div class="gd-gl' + t + '">' + (left && v.revert ? '<span class="gd-slot"></span>' : '') + '<span class="gd-n"></span></div>';
        code += '<div class="gd-ln' + t + '"></div>';
        return;
      }
      const k = m.blocks[row.block], i = row.line;
      let cls = '', attr = '', frags = null;
      if (k.type !== 'eq' && paint) {
        cls = ' ' + k.type + (k.words ? ' soft' : '');
        attr = ' data-b="' + row.block + '"';
        if (k.words) frags = k.words[left ? 'a' : 'b'][i - (left ? k.a0 : k.b0)];
      }
      cls += edges[i] || '';
      const slot = left && v.revert ? '<span class="gd-slot">' + (arrows[i] != null ? revertButton(v, arrows[i], 'diff/arrowRight@14x14', true) : '') + '</span>' : '';
      gutter += '<div class="gd-gl' + cls + '"' + attr + '>' + slot + '<span class="gd-n">' + (i + 1) + '</span></div>';
      code += '<div class="gd-ln' + cls + '">' + P.lineHTML(runs[i], frags) + eofNote(v, left ? 'a' : 'b', i) + '</div>';
    });
    return { gutter, code };
  };
  /** The unified view: removed lines, then the added ones under them; two number columns. */
  P.unifiedHTML = function (v) {
    const m = v.m, paint = v.highlight !== 'none', seen = {};
    let gutter = '', code = '';
    v.lay.U.forEach((row) => {
      if (row.fold) { gutter += '<div class="gd-gl fold" data-fold="' + row.fold.key + '"></div>'; code += foldRow(v, row.fold.key); return; }
      const k = m.blocks[row.block], del = row.type === 'del';
      let cls = '', attr = '', frags = null;
      if (row.type !== 'eq' && paint) {
        cls = ' ' + row.type + (k.words ? ' soft' : '');
        attr = ' data-b="' + row.block + '"';
        if (k.words) frags = del ? k.words.a[row.a - k.a0] : k.words.b[row.b - k.b0];
      }
      const first = row.type !== 'eq' && !seen[row.block];
      if (row.type !== 'eq') seen[row.block] = true;
      const slot = v.revert ? '<span class="gd-slot">' + (first && !v.off ? revertButton(v, row.block, 'diff/revert@14x14') : '') + '</span>' : '';
      gutter += '<div class="gd-gl' + cls + '"' + attr + '>' + slot + '<span class="gd-n">' + (row.a != null ? row.a + 1 : '') + '</span><span class="gd-n">'
        + (row.b != null ? row.b + 1 : '') + '</span></div>';
      code += '<div class="gd-ln' + cls + '">' + P.lineHTML(del ? v.syn.a[row.a] : v.syn.b[row.b], frags) + (del ? eofNote(v, 'a', row.a) : eofNote(v, 'b', row.b)) + '</div>';
    });
    return { gutter, code };
  };

  // ---------------------------------------------------------------- reverting one block
  /** The working text after one block goes back to its base lines (Git.changesModel.applyBlock; kept for old callers). */
  P.revertBlock = function (m, k, base, current) {
    return Git.changesModel.applyBlock(m, k, 'revert', current, base);
  };
})();
