/* DOM-free logic of the working tree views (tested in test/ui/changes-model.test.js).
   Git.changesModel
     .textHash(text)                       53-bit hash of a decoded text (the `expect` of changes.write; the engine has the same)
     .expectOf(text)                       { length, hash } for changes.write
     .remember(list, message, max = 25)    the Commit Message History: newest first, each message once (VcsConfiguration keeps 25)
     .dirTree(files, { compact })          Group By Directory: [{ kind: 'dir', name, path, files (all below), children } |
                                           { kind: 'file', file }]; folders first, case-insensitive; a chain of folders with
                                           nothing else in it is one node ("src/main/snapshotting") when `compact`
     .applyBlock(m, k, mode)               the work tree text after one change block of a local diff is reverted
                                           ('revert': the right lines become the left ones) or the left lines are appended
                                           below the right ones ('append'); `m` is Git.diffParts.compute's model
     .modelText(side) · .lineModel(left, right) · .writeBack(m, k, mode, right, left)
                                           one block written back with every other line's own bytes (diff », Rollback Lines)
     .fileIndex(list)                    files.list's compact answer → a lazy folder index for the Files tool window
     .statusIndex(local, conflicts)        { file: Map path → 'M'|'A'|'D'|'R'|'?'|'C', dirs: Set of folders holding changes } */
(function () {
  'use strict';
  const Git = (window.Git = window.Git || {});
  const M = (Git.changesModel = {});

  // ---------------------------------------------------------------- changes.write's `expect`
  M.textHash = function (str, seed) {
    seed = seed || 0;
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
  };
  M.expectOf = (text) => ({ length: text.length, hash: M.textHash(text) });

  // ---------------------------------------------------------------- Commit Message History
  M.remember = function (list, message, max) {
    const m = String(message || '').replace(/\s+$/, '');
    const out = (list || []).filter((x) => typeof x === 'string' && x.trim() && x.trim() !== m.trim());
    if (m.trim()) out.unshift(m);
    return out.slice(0, max || 25);
  };

  // ---------------------------------------------------------------- Group By Directory
  const lower = (s) => s.toLowerCase();
  const byName = (a, b) => (lower(a) < lower(b) ? -1 : lower(a) > lower(b) ? 1 : a < b ? -1 : a > b ? 1 : 0);
  M.byName = byName;
  M.dirTree = function (files, o) {
    const compact = !o || o.compact !== false;
    const root = { name: '', path: '', dirs: new Map(), files: [] };
    files.forEach((f) => {
      let n = root, p = '';
      const parts = f.path.split('/');
      for (let i = 0; i < parts.length - 1; i++) {
        p = p ? p + '/' + parts[i] : parts[i];
        if (!n.dirs.has(parts[i])) n.dirs.set(parts[i], { name: parts[i], path: p, dirs: new Map(), files: [] });
        n = n.dirs.get(parts[i]);
      }
      n.files.push(f);
    });
    const all = (n) => { const out = n.files.slice(); n.dirs.forEach((d) => { all(d).forEach((f) => out.push(f)); }); return out; };
    const build = (n) => Array.from(n.dirs.values()).sort((a, b) => byName(a.name, b.name)).map((d) => {
      let name = d.name;
      while (compact && d.dirs.size === 1 && !d.files.length) { d = d.dirs.values().next().value; name += '/' + d.name; }
      return { kind: 'dir', name, path: d.path, files: all(d), children: build(d) };
    }).concat(n.files.slice().sort((a, b) => byName(a.path.split('/').pop(), b.path.split('/').pop()) || byName(a.path, b.path)).map((f) => ({ kind: 'file', file: f })));
    return build(root);
  };

  // ---------------------------------------------------------------- one block of a local diff
  /** `current` / `base`: the right and left texts the model was computed from (final newline, exact bytes). */
  M.applyBlock = function (m, k, mode, current, base) {
    const right = m.b.slice(k.b0, k.b1), left = m.a.slice(k.a0, k.a1);
    const lines = m.b.slice(0, k.b0).concat(mode === 'append' ? right.concat(left) : left, m.b.slice(k.b1));
    // Back to exactly the left side: its own bytes (its final newline included).
    if (mode !== 'append' && base != null && lines.length === m.a.length && lines.every((x, i) => x === m.a[i])) return base;
    if (!lines.length) return '';
    // the sides differ in their final newline (m.noEol): the last line keeps the newline state of the side it comes from
    if (m.noEol) {
      const lastFromLeft = k.b1 === m.b.length && k.a1 > k.a0 && k.a1 === m.a.length;
      return lines.join('\n') + ((lastFromLeft ? m.noEol.a : m.noEol.b) ? '' : '\n');
    }
    return lines.join('\n') + (current == null || /\n$/.test(current) || current === '' ? '\n' : '');
  };

  /** The text a content side ({ text, eol }, PROTOCOL "Content") has in a line model: a CRLF file is compared as LF; a
      file with mixed line ends keeps its CRs, so every line carries its own line end through a write-back. */
  M.modelText = (side) => (side && side.eol === 'crlf' ? (side.text || '').replace(/\r\n/g, '\n') : (side && side.text) || '');
  /** The line model of two content sides: { a, b, noEol? } as Git.diffParts.compute makes it (a final newline on one
      side only is `noEol`), for a block found on another model of the same texts (the file view's markers). */
  M.lineModel = function (left, right) {
    const l = M.modelText(left), r = M.modelText(right);
    const split = (s) => (s === '' ? [] : s.replace(/\n$/, '').split('\n'));
    const m = { a: split(l), b: split(r) };
    const endA = /\n$/.test(l), endB = /\n$/.test(r);
    if (l && r && endA !== endB) m.noEol = { a: !endA, b: !endB };
    return m;
  };
  /** The whole work tree text to write after block `k` of `m` is reverted ('revert') or its left lines appended
      ('append'): the one write-back of the diff viewer's » and the file view's Rollback Lines. `right` / `left` are the
      content sides the model was made from; untouched lines keep their own bytes, a CRLF file gets CRLF back (the BOM
      and the encoding are kept by changes.write). */
  M.writeBack = function (m, k, mode, right, left) {
    const rt = M.modelText(right), lt = M.modelText(left);
    let text = M.applyBlock(m, k, mode, rt, lt);
    if (mode !== 'append' && left && text === lt && text !== '') text = left.text;   // exactly the left side: its own bytes
    else if (text && !/\n$/.test(text) && /\r$/.test(text)) {
      // In a mixed file a CRLF line end is the line's CR plus the joining LF. The result ends without a newline: when
      // its last line had a line end where it came from, its CR is that end's first half and goes with the LF.
      const fromLeft = mode === 'append' ? k.b1 === m.b.length && k.a1 > k.a0 : k.b1 === m.b.length && k.a1 > k.a0;
      const ended = m.b.length > k.b1 ? false                                     // the work tree file's own last line
        : fromLeft ? k.a1 < m.a.length || /\n$/.test(lt)                          // a line of the left side
          : mode === 'append' ? k.b1 < m.b.length || /\n$/.test(rt) : k.b0 > 0;   // the line above the block
      if (ended) text = text.slice(0, -1);
    }
    if (right && right.eol === 'crlf') text = text.replace(/\r?\n/g, '\r\n');
    return text;
  };

  // ---------------------------------------------------------------- the Files tool window
  /** `res` = files.list ({ dirs, files: [dirIndex, name, …], untracked, count, truncated }). */
  M.fileIndex = function (res) {
    const dirs = new Map();
    const node = (p) => {
      let d = dirs.get(p);
      if (d) return d;
      d = { path: p, name: p.split('/').pop(), dirs: [], files: [], sorted: false };
      dirs.set(p, d);
      if (p) {
        const cut = p.lastIndexOf('/');
        node(cut < 0 ? '' : p.slice(0, cut)).dirs.push(p);
      }
      return d;
    };
    node('');
    const untracked = new Set(res.untracked || []);
    const list = res.files || [];
    for (let i = 0; i < list.length; i += 2) {
      const dir = res.dirs[list[i]], name = list[i + 1];
      node(dir).files.push({ name, path: dir ? dir + '/' + name : name, untracked: untracked.has(i / 2) });
    }
    return {
      count: res.count, truncated: !!res.truncated,
      has: (p) => dirs.has(p),
      /** Folders, then files, of folder `p` (sorted the first time they are asked for). */
      children(p) {
        const d = dirs.get(p);
        if (!d) return { dirs: [], files: [] };
        if (!d.sorted) {
          d.dirs.sort((a, b) => byName(a.split('/').pop(), b.split('/').pop()));
          d.files.sort((a, b) => byName(a.name, b.name));
          d.sorted = true;
        }
        return { dirs: d.dirs.map((x) => dirs.get(x)), files: d.files };
      },
      file(path) {
        const cut = path.lastIndexOf('/'), d = dirs.get(cut < 0 ? '' : path.slice(0, cut));
        return d ? d.files.find((f) => f.path === path) || null : null;
      },
    };
  };
  M.statusIndex = function (local, conflicts) {
    const file = new Map(), dirs = new Set(), conflictDirs = new Set();
    const up = (p, set) => { let cut = p.lastIndexOf('/'); while (cut > 0) { p = p.slice(0, cut); if (set.has(p)) break; set.add(p); cut = p.lastIndexOf('/'); } };
    (local || []).forEach((f) => {
      file.set(f.path, f.status);
      if (f.status !== '?') up(f.path, dirs);          // an unversioned file does not mark its folders
    });
    (conflicts || []).forEach((c) => { file.set(c.path, 'C'); up(c.path, dirs); up(c.path, conflictDirs); });
    return { file, dirs, conflictDirs };
  };
})();
