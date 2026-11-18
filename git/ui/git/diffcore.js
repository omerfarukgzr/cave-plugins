/* Git prototype: text diff. No DOM.
   Git.diff.lines(a, b)        line blocks between two texts (equal / modified / inserted / deleted)
   Git.diff.words(a, b)        changed character ranges inside a modified block ("Highlight words")
   Git.diff.merge3(b, y, t)    three-way chunks for the merge tool
   (The prototype's sample contents — Git.filePatch, Git.changeTexts, Git.fileAt — are gone: contents come from
   Git.content, content.js.) */
(function () {
  'use strict';
  const Git = (window.Git = window.Git || {});
  const D = (Git.diff = {});

  const split = (text) => (text === '' || text == null ? [] : String(text).replace(/\n$/, '').split('\n'));
  D.split = split;

  /** Longest common subsequence as index pairs, for two arrays of strings. */
  function lcs(a, b) {
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
    const n = endA - start, m = endB - start;
    const pairs = [];
    for (let i = 0; i < start; i++) pairs.push([i, i]);
    // The table is n*m cells: past this a diff would take seconds and hundreds of MB (IntelliJ refuses it too).
    if (n * m > D.LIMIT) throw Object.assign(new Error('diff too big'), { code: 'too_big' });
    if (n && m) {
      const w = m + 1;
      const table = new Uint32Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          table[i * w + j] = a[start + i] === b[start + j] ? table[(i + 1) * w + j + 1] + 1
            : Math.max(table[(i + 1) * w + j], table[i * w + j + 1]);
        }
      }
      let i = 0, j = 0;
      while (i < n && j < m) {
        if (a[start + i] === b[start + j]) { pairs.push([start + i, start + j]); i++; j++; }
        else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) i++;
        else j++;
      }
    }
    for (let k = 0; k < a.length - endA; k++) pairs.push([endA + k, endB + k]);
    return pairs;
  }
  D.lcs = lcs;
  D.LIMIT = 16e6;   // cells of the LCS table (64 MB); lcs() throws { code: 'too_big' } beyond it

  /** Line blocks: `{ type: 'eq'|'mod'|'ins'|'del', a0, a1, b0, b1 }` (ends exclusive). */
  D.lines = function (aText, bText) {
    const a = split(aText), b = split(bText);
    const blocks = [];
    let i = 0, j = 0;
    const flush = (ai, bj) => {
      if (ai > i || bj > j) {
        blocks.push({ type: ai > i && bj > j ? 'mod' : ai > i ? 'del' : 'ins', a0: i, a1: ai, b0: j, b1: bj });
      }
    };
    lcs(a, b).forEach(([ai, bj]) => {
      flush(ai, bj);
      const last = blocks[blocks.length - 1];
      if (last && last.type === 'eq' && last.a1 === ai && last.b1 === bj) { last.a1++; last.b1++; }
      else blocks.push({ type: 'eq', a0: ai, a1: ai + 1, b0: bj, b1: bj + 1 });
      i = ai + 1; j = bj + 1;
    });
    flush(a.length, b.length);
    return { a, b, blocks };
  };

  D.stats = function (aText, bText) {
    let added = 0, removed = 0, changes = 0;
    D.lines(aText, bText).blocks.forEach((k) => { if (k.type !== 'eq') { changes++; removed += k.a1 - k.a0; added += k.b1 - k.b0; } });
    return { added, removed, changes };
  };

  /** Changed ranges per line inside a modified block: `{ a: [[line, from, to]...], b: [...] }` (line is block-relative). */
  D.words = function (aLines, bLines) {
    const tokens = (lines) => {
      const out = [];
      lines.forEach((text, line) => {
        const re = /[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]/g;
        let m;
        while ((m = re.exec(text))) out.push({ text: m[0], line, from: m.index, to: m.index + m[0].length });
        out.push({ text: '\n', line, from: text.length, to: text.length });
      });
      return out;
    };
    const ta = tokens(aLines), tb = tokens(bLines);
    const keepA = new Set(), keepB = new Set();
    lcs(ta.map((t) => t.text), tb.map((t) => t.text)).forEach(([x, y]) => { keepA.add(x); keepB.add(y); });
    const ranges = (list, keep) => {
      const out = [];
      list.forEach((t, k) => {
        if (keep.has(k) || t.to === t.from) return;
        const last = out[out.length - 1];
        if (last && last[0] === t.line && last[2] === t.from) last[2] = t.to; else out.push([t.line, t.from, t.to]);
      });
      // A range that is only whitespace says nothing.
      return out.filter(([line, from, to]) => /\S/.test((list === ta ? aLines : bLines)[line].slice(from, to)));
    };
    return { a: ranges(ta, keepA), b: ranges(tb, keepB) };
  };

  /** Three-way chunks. `type`: eq | yours | theirs | both (same change on both sides) | conflict. Ranges are [from, to). */
  D.merge3 = function (baseText, yoursText, theirsText) {
    const base = split(baseText), yours = split(yoursText), theirs = split(theirsText);
    const my = new Map(lcs(base, yours)), mt = new Map(lcs(base, theirs));
    const chunks = [];
    let b = 0, y = 0, t = 0;
    const same = (x, x0, x1, z, z0, z1) => x1 - x0 === z1 - z0 && x.slice(x0, x1).join('\n') === z.slice(z0, z1).join('\n');
    const unstable = (b1, y1, t1) => {
      if (b1 === b && y1 === y && t1 === t) return;
      const yc = !same(base, b, b1, yours, y, y1), tc = !same(base, b, b1, theirs, t, t1);
      const type = yc && tc ? (same(yours, y, y1, theirs, t, t1) ? 'both' : 'conflict') : yc ? 'yours' : 'theirs';
      chunks.push({ type, base: [b, b1], yours: [y, y1], theirs: [t, t1] });
    };
    for (let k = 0; k < base.length; k++) {
      if (!my.has(k) || !mt.has(k)) continue;
      const yk = my.get(k), tk = mt.get(k);
      if (yk < y || tk < t) continue;
      unstable(k, yk, tk);
      const last = chunks[chunks.length - 1];
      if (last && last.type === 'eq' && last.base[1] === k && last.yours[1] === yk && last.theirs[1] === tk) {
        last.base[1]++; last.yours[1]++; last.theirs[1]++;
      } else chunks.push({ type: 'eq', base: [k, k + 1], yours: [yk, yk + 1], theirs: [tk, tk + 1] });
      b = k + 1; y = yk + 1; t = tk + 1;
    }
    unstable(base.length, yours.length, theirs.length);
    return { base, yours, theirs, chunks };
  };

})();
