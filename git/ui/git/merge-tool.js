/* The three-pane merge tool ("Merge Revisions for …"), after IntelliJ's MergeThreesideViewer.
   Left and right are the two sides (read-only), the middle is the Result: it starts as the base revision and every
   block's » / « / × decision rewrites that block's range; it stays an editor (one textarea per unfolded run of lines).
   Panes are not padded to line up: each keeps its own lines, scrolling is tied through the block ranges and the
   dividers draw the connecting shapes (DiffDividerDrawUtil's curved trapezium).
   The texts come from the engine (conflict.read); Apply Changes writes the Result (conflict.resolve), Accept Left /
   Right take one side as git has it (conflict.accept). The merge itself is merge-core.js, the drawing merge-paint.js.
   Git.mergeTool.open(path, { onClose }) · load(path) -> Promise<entry> · entry(path) · progress(path) · canAutoResolve(path)
   autoResolve(path) -> Promise<{ resolved, remaining }> · forget(path) · textual(conflict) · isOpen() */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const U = Git.mergeUi, C = Git.mergeCore, P = Git.mergePaint, A = Git.actions;
  const T = (Git.mergeTool = {});
  const ROW = P.ROW, DIVIDER = 24;
  const bare = (line) => (line.endsWith('\r') ? line.slice(0, -1) : line);   // a line without its CR (CRLF files)
  const prefs = { collapse: true, sync: true, highlight: 'words', ignore: 'none' };
  let live = null;

  Git.addTR({
    'Merge Revisions for {0}': '{0} için sürümleri birleştir',
    'Previous Difference': 'Önceki fark', 'Next Difference': 'Sonraki fark',
    'Apply non-conflicting changes:': 'Çakışmayan değişiklikleri uygula:',
    'Left': 'Sol', 'All': 'Tümü', 'Right': 'Sağ',
    'Apply Non-Conflicting Changes from the Left Side': 'Soldaki çakışmayan değişiklikleri uygula',
    'Apply All Non-Conflicting Changes': 'Çakışmayan bütün değişiklikleri uygula',
    'Apply Non-Conflicting Changes from the Right Side': 'Sağdaki çakışmayan değişiklikleri uygula',
    'Resolve Simple Conflicts': 'Basit çakışmaları çöz',
    'Synchronize Scrolling': 'Kaydırmayı eşzamanla', 'Settings': 'Ayarlar', 'Highlighting Differences': 'Farkları vurgula',
    'Words': 'Kelimeler', 'Lines': 'Satırlar', 'Characters': 'Karakterler', 'Ignore Differences': 'Farkları yok say', 'None': 'Hiçbiri',
    'Trim whitespaces': 'Baştaki ve sondaki boşlukları yok say', 'Ignore whitespaces': 'Boşlukları yok say',
    'No changes': 'Değişiklik yok', 'No conflicts': 'Çakışma yok', '{0}. {1}.': '{0}. {1}.',
    'All conflicts resolved': 'Bütün çakışmalar çözüldü', 'All changes have been processed': 'Bütün değişiklikler işlendi',
    'Apply Changes': 'Değişiklikleri uygula', 'Save and Close': 'Kaydet ve kapat', 'Accept Left': 'Soldakini al', 'Accept Right': 'Sağdakini al',
    'Result': 'Sonuç', 'Ignore': 'Yok say', 'Resolve': 'Çöz', 'Ctrl+click to resolve conflict': 'Çakışmayı çözmek için Ctrl+tık',
    'Accept Left Side': 'Sol tarafı al', 'Accept Right Side': 'Sağ tarafı al', 'Resolve using Left': 'Soldakiyle çöz', 'Resolve using Right': 'Sağdakiyle çöz',
    'Unprocessed Changes': 'İşlenmemiş değişiklikler',
    '1 unresolved conflict': '1 çözülmemiş çakışma', '{0} unresolved conflicts': '{0} çözülmemiş çakışma',
    '1 unprocessed change': '1 işlenmemiş değişiklik', '{0} unprocessed changes': '{0} işlenmemiş değişiklik', '{0} and {1}': '{0} ve {1}',
    '{0} still remains. The file will be saved exactly as shown in the Result pane.': '{0} hâlâ duruyor. Dosya, Sonuç bölmesinde göründüğü haliyle kaydedilecek.',
    '{0} still remain. The file will be saved exactly as shown in the Result pane.': '{0} hâlâ duruyor. Dosya, Sonuç bölmesinde göründüğü haliyle kaydedilecek.',
    'Save Current Result': 'Şu anki sonucu kaydet', 'Back to Resolving': 'Çözmeye dön',
    'Cancel File Merge': 'Dosya birleştirmeden çık', 'Are you sure you want to exit without applying changes?': 'Değişiklikleri uygulamadan çıkmak istediğine emin misin?',
    'Yes': 'Evet', 'No': 'Hayır', 'Update Highlighting Settings': 'Vurgulama ayarını güncelle',
    'Changing highlighting requires the file merge restart. Discard unsaved changes and restart merge anyway?':
      'Bu ayarı değiştirmek için dosyanın birleştirmesi baştan başlamalı. Kaydedilmemiş değişiklikler atılıp baştan başlansın mı?',
    'Discard Changes and Restart Merge': 'Değişiklikleri at ve baştan başla', 'Continue Merge': 'Merge\'e devam et', 'Expand': 'Aç',
    'Cannot Show Merge Dialog': 'Merge penceresi gösterilemiyor', 'The file is too big to be loaded': 'Dosya yüklenemeyecek kadar büyük',
    'Loading merge revisions…': 'Birleştirilecek sürümler yükleniyor…',
  });

  // ================================================================ sessions (one per conflicted file of this step)
  const sessions = new Map();   // opKey + NUL + path -> { path, read, s, textual, enc }
  const keyOf = (path) => A.opKey() + '\u0000' + path;
  /** A conflict the tool can merge line by line: both sides exist and are text. */
  T.textual = (c) => !!c && (c.kind === 'both-modified' || c.kind === 'both-added');
  function build(path, read, ignore) {
    const sides = A.opSides();
    const L = sides.flip ? read.theirs : read.yours, Rt = sides.flip ? read.yours : read.theirs;
    const textual = !!L && !!Rt && !read.binary && !read.tooLarge && L.text != null && Rt.text != null;
    const e = { path, read, textual, sides, enc: { encoding: (L && L.encoding) || 'utf-8', bom: !!(L && L.bom) }, s: null };
    if (textual) {
      e.s = C.create({ base: read.base && read.base.text != null ? read.base.text : '', left: L.text, right: Rt.text,
        finalNewline: L.finalNewline !== false || Rt.finalNewline !== false }, { ignore });
      e.texts = { left: L.text, right: Rt.text };
    }
    return e;
  }
  T.entry = (path) => sessions.get(keyOf(path)) || null;
  /** The merge tool can open this conflict (a binary or too large file is known once its versions are read). */
  T.canOpen = (c) => { if (!c || c.kind === 'both-deleted') return false; const e = T.entry(c.path); return !e || e.textual || !e.read.tooLarge; };   // binary / one-sided: openWhole
  T.load = function (path) {
    const key = keyOf(path), have = sessions.get(key);
    if (have) return Promise.resolve(have);
    return A.run({ id: 'conflict.read:' + path, title: t('Loading merge revisions…'), method: 'conflict.read', params: { path }, quiet: true }).then((read) => {
      if (!read) return null;
      const e = build(path, read, prefs.ignore);
      if (A.opKey() + '\u0000' + path === key) sessions.set(key, e);
      return e;
    });
  };
  T.forget = (path) => { sessions.delete(keyOf(path)); };
  T.progress = (path) => { const e = T.entry(path); return e && e.s ? C.progress(e.s) : null; };
  T.canAutoResolve = (path) => { const e = T.entry(path); return !!(e && e.s && e.s.chunks.some((k) => !C.done(k) && (k.type !== 'conflict' || C.simple(k)))); };
  /** Conflicts dialog ▸ Resolve All Simple Conflicts, for one file: writes it when nothing is left. */
  T.autoResolve = async function (path) {
    const e = await T.load(path);
    if (!e || !e.s) return { resolved: 0, remaining: 0, skipped: true };
    const r = C.autoResolve(e.s);
    if (r.clear) { const res = await A.resolveText(path, C.text(e.s), e.enc); if (res) T.forget(path); }
    return r;
  };
  Git.on('change', () => { const pre = A.opKey() + '\u0000'; Array.from(sessions.keys()).forEach((k) => { if (k.indexOf(pre) !== 0) sessions.delete(k); }); });

  // ================================================================ the window
  T.isOpen = () => !!live;
  T.open = function (path, o) {
    o = o || {};
    if (live) { if (live.path === path) return Promise.resolve(live.dlg); live.finish(false); }
    return T.load(path).then((e) => {
      if (!e) return null;
      if (!e.textual) {
        if (!e.read.tooLarge && T.openWhole) return T.openWhole(path, e, o);   // merge-tool-extra.js
        Git.notify({ kind: 'warning', title: t('Cannot Show Merge Dialog'), text: e.read.tooLarge ? t('The file is too big to be loaded') : null });
        return null;
      }
      return win(path, e, o);
    });
  };

  function win(path, e, o) {
    const info = U.operation();
    let s = e.s, start = C.snap(s), lay = null, inner = null, hint = false, cur = null, hl = {};
    const pane = {}, B = {};
    const expect = { L: [-1, -1], M: [-1, -1], R: [-1, -1] };
    const act = (fn) => {
      const was = C.counts(s);
      s.undo.push(C.snap(s)); s.redo.length = 0; s.typing = 0;
      fn();
      const now = C.counts(s);
      hint = !now.changes && !now.conflicts && was.changes + was.conflicts > 0;
      render();
    };

    // ---- structure
    const count = h('div.gm-count', { id: 'gm-count', 'aria-live': 'polite' });
    const bar = h('div.g-toolbar.gm-tb', { role: 'toolbar' },
      (B.prev = Git.toolBtn({ icon: 'general/up', title: t('Previous Difference') + '  ⇧F7', id: 'gm-prev', onClick: () => go(-1) })),
      (B.next = Git.toolBtn({ icon: 'general/down', title: t('Next Difference') + '  F7', id: 'gm-next', onClick: () => go(1) })),
      h('span.g-toolbar-sep'), Git.toolBtn({ icon: 'vcs/diff', title: t('Compare Contents'), id: 'gm-compare', arrow: true, onClick: (ev) => T.compareMenu(ev.currentTarget, e, s, path) }),
      h('span.g-toolbar-sep'),
      h('span.gm-tb-label', t('Apply non-conflicting changes:')),
      (B.left = Git.toolBtn({ icon: 'diff/applyNotConflictsLeft', label: t('Left'), title: t('Apply Non-Conflicting Changes from the Left Side'), id: 'gm-apply-left', onClick: () => act(() => C.applySafe(s, 'L')) })),
      (B.all = Git.toolBtn({ icon: 'diff/applyNotConflicts', label: t('All'), title: t('Apply All Non-Conflicting Changes'), id: 'gm-apply-all', onClick: () => act(() => C.applySafe(s, 'all')) })),
      (B.right = Git.toolBtn({ icon: 'diff/applyNotConflictsRight', label: t('Right'), title: t('Apply Non-Conflicting Changes from the Right Side'), id: 'gm-apply-right', onClick: () => act(() => C.applySafe(s, 'R')) })),
      (B.magic = Git.toolBtn({ icon: 'diff/magicResolveToolbar', title: t('Resolve Simple Conflicts'), id: 'gm-magic', onClick: () => act(() => C.applyMagic(s)) })),
      h('span.g-toolbar-sep'),
      (B.fold = Git.toolBtn({ icon: 'general/collapseAll', title: t('Collapse Unchanged Fragments'), id: 'gm-collapse', active: prefs.collapse, onClick: () => toggle('collapse') })),
      Git.toolBtn({ icon: 'general/settings', title: t('Settings'), id: 'gm-settings', arrow: true, onClick: (ev) => settings(ev.currentTarget) }),
      h('span.g-spacer'), count);
    const heads = h('div.gm-heads',
      h('div.gm-head.left', Git.icon('general/locked'), h('span', info.left.title()), h('span.g-spacer'), T.detailsLink(e.sides.left.side, path)),
      h('div.gm-head.mid', h('b', t('Result')), h('span.g-dim', path)),
      h('div.gm-head.right', Git.icon('general/locked'), h('span', info.right.title()), h('span.g-spacer'), T.detailsLink(e.sides.right.side, path)));
    const makePane = (p, cls) => {
      const gutter = h('div.gm-gutter'), code = h('div.gm-code');
      const scroll = h('div.gm-scroll', { tabIndex: -1 }, p === 'L' ? [code, gutter] : [gutter, code]);
      const marks = p === 'M' ? null : h('div.gm-marks');
      pane[p] = { scroll, gutter, code, marks, back: code };
      if (p === 'M') code.appendChild((pane.M.back = h('div.gm-back')));
      scroll.addEventListener('scroll', () => scrolled(p), { passive: true });
      return h('div.gm-pane.' + cls, scroll, marks);
    };
    const divider = () => { const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); el.setAttribute('class', 'gm-div'); el.setAttribute('aria-hidden', 'true'); return el; };
    const dividers = [divider(), divider()];
    const hintEl = h('div.gm-hint', { hidden: true, role: 'status' }, Git.icon('general/greenCheckmark'),
      h('div', h('b', t('All changes have been processed')), h('button.g-link', { type: 'button', id: 'gm-hint-apply', onclick: () => apply() }, t('Apply Changes'))));
    const panes = h('div.gm-panes', makePane('L', 'left'), dividers[0], makePane('M', 'mid'), dividers[1], makePane('R', 'right'), hintEl);

    const dlg = Git.dialog({ title: t('Merge Revisions for {0}', Git.repo.root + '/' + path), width: 1180, height: 680, className: 'gm-tool-dlg',
      content: h('div.gm-tool', bar, heads, panes),
      left: [Git.btn(t('Accept Left'), { id: 'gm-accept-left', onClick: () => whole('L') }), Git.btn(t('Accept Right'), { id: 'gm-accept-right', onClick: () => whole('R') })],
      buttons: [{ label: t('Save and Close'), id: 'gm-save', keepOpen: true, onClick: () => save() }, { label: t('Apply Changes'), id: 'gm-apply', primary: true, keepOpen: true, onClick: () => apply() }] });
    const shut = dlg.close;

    // ---- leaving
    let writing = false;
    function finish(next, remaining) {
      if (dlg.closed) return;
      live = null;
      shut();
      if (o.onClose) o.onClose();
      // Apply Changes moves on to the next conflicted file
      const kindOf = (p) => Git.conflicts().find((c) => c.path === p) || { path: p, kind: 'both-modified' };
      const more = next && (remaining || Git.conflicts().map((c) => c.path)).find((p) => p !== path && T.canOpen(kindOf(p)));
      if (more) T.open(more, o);
    }
    function written(res, next) { writing = false; if (!res) { render(); return; } T.forget(path); finish(next, res.remaining); }
    function resolveWith(text, next) {
      if (writing) return;
      writing = true;
      A.resolveText(path, text, e.enc).then((res) => written(res, next));
    }
    /** Accept Left / Right: that side's file exactly as git has it (conflict.accept). */
    function whole(pane) {
      if (writing) return;
      writing = true;
      const side = pane === 'L' ? e.sides.left.side : e.sides.right.side;
      A.acceptSide([path], side).then((res) => written(res, true));
    }
    function apply() {
      const n = C.counts(s);
      if (!n.changes && !n.conflicts) { resolveWith(C.text(s), true); return; }
      const parts = [];
      if (n.conflicts) parts.push(U.plural(n.conflicts, null, '1 unresolved conflict', '{0} unresolved conflicts'));
      if (n.changes) parts.push(U.plural(n.changes, null, '1 unprocessed change', '{0} unprocessed changes'));
      const what = parts.length > 1 ? t('{0} and {1}', parts[0], parts[1]) : parts[0];
      Git.confirm({ title: t('Unprocessed Changes'), width: 460, no: t('Back to Resolving'), yes: t('Save Current Result'),
        text: t(n.changes + n.conflicts === 1 ? '{0} still remains. The file will be saved exactly as shown in the Result pane.' : '{0} still remain. The file will be saved exactly as shown in the Result pane.', what),
        onYes: () => resolveWith(C.text(s), true) });
    }
    /** Save and Close: a finished file is written; otherwise the decisions stay for later (the dialog shows "2/5"). */
    function save() {
      const n = C.counts(s);
      if (!n.changes && !n.conflicts && s.chunks.length) resolveWith(C.text(s), false); else finish(false);
    }
    dlg.close = function () {
      if (C.snap(s) === start) { finish(false); return; }
      Git.confirm({ title: t('Cancel File Merge'), text: t('Are you sure you want to exit without applying changes?'), yes: t('Yes'), no: t('No'),
        onYes: () => { C.restore(s, start); s.undo.length = s.redo.length = 0; finish(false); } });
    };
    live = { path, dlg, finish };

    // ---- changes
    function step(back) {
      const from = back ? s.undo : s.redo, to = back ? s.redo : s.undo;
      if (!from.length) return;
      to.push(C.snap(s)); C.restore(s, from.pop()); s.typing = 0; hint = false;
      render();
    }
    function toggle(key) { prefs[key] = !prefs[key]; if (key === 'collapse') s.expanded.clear(); render(); }
    function restart(value) {
      const run = () => { prefs.ignore = value; const fresh = build(path, e.read, value); e.s = s = fresh.s; start = C.snap(s); hint = false; cur = null; render(); };
      if (C.snap(s) === C.snap(build(path, e.read, prefs.ignore).s)) { run(); return; }
      Git.confirm({ title: t('Update Highlighting Settings'), width: 460, yes: t('Discard Changes and Restart Merge'), no: t('Continue Merge'), onYes: run,
        text: t('Changing highlighting requires the file merge restart. Discard unsaved changes and restart merge anyway?') });
    }
    function settings(anchor) {
      const mode = (key, value, label) => ({ label: t(label), checked: prefs[key] === value,
        action: () => { if (key === 'ignore') { if (prefs.ignore !== value) restart(value); } else { prefs[key] = value; render(); } } });
      Git.menu(anchor, [
        { label: t('Highlighting Differences'), disabled: true },
        mode('highlight', 'words', 'Words'), mode('highlight', 'lines', 'Lines'), mode('highlight', 'chars', 'Characters'),
        '-',
        { label: t('Ignore Differences'), disabled: true },
        mode('ignore', 'none', 'None'), mode('ignore', 'trim', 'Trim whitespaces'), mode('ignore', 'spaces', 'Ignore whitespaces'),
        '-',
        { label: t('Synchronize Scrolling'), checked: prefs.sync, action: () => toggle('sync') },
      ]);
    }
    /** The result was typed into: finds the lines that changed and keeps the block ranges around them. */
    function typed(ta) {
      const a = +ta.dataset.a, b = +ta.dataset.b;
      // A textarea turns CRLF into LF: lines are compared without their CR, untouched lines keep theirs, typed ones get
      // the file's (the line they replace, else the line above).
      const raw = s.result.slice(a, b), old = raw.map(bare), now = a === b && ta.value === '' ? [] : ta.value.split('\n');
      let p = 0, q = 0;
      while (p < old.length && p < now.length && old[p] === now[p]) p++;
      while (q < old.length - p && q < now.length - p && old[old.length - 1 - q] === now[now.length - 1 - q]) q++;
      const cr = (k) => { const ref = raw[p + k] != null ? raw[p + k] : raw[p - 1] != null ? raw[p - 1] : s.result[a + p - 1] || s.result[a + p] || ''; return ref.endsWith('\r') ? '\r' : ''; };
      const added = now.slice(p, now.length - q).map((x, k) => x + cr(k));
      const from = a + p, to = b - q, d = now.length - old.length;
      if (from === to && d === 0) return;
      if (Date.now() - s.typing > 1500) { s.undo.push(C.snap(s)); s.redo.length = 0; }
      s.typing = Date.now();
      s.chunks.forEach((k) => {
        if (k.m0 >= to) { k.m0 += d; k.m1 += d; }
        else if (k.m1 > from) { k.m0 = Math.min(k.m0, from); k.m1 = Math.max(k.m1, to) + d; }
      });
      s.result.splice(from, to - from, ...added);
      const pos = ta.selectionStart, head = ta.value.slice(0, pos);
      const line = a + (head.match(/\n/g) || []).length, col = pos - (head.lastIndexOf('\n') + 1);
      hint = false;
      render();
      caret(line, col);
    }
    function caret(line, col) {
      const list = pane.M.code.querySelectorAll('textarea');
      for (let i = 0; i < list.length; i++) {
        const ta = list[i], a = +ta.dataset.a, b = +ta.dataset.b;
        if (line < a || (line >= b && !(a === b && line === a))) continue;
        let at = 0;
        for (let n = a; n < line; n++) at += bare(s.result[n]).length + 1;
        at += Math.min(col, bare(s.result[line] || '').length);
        ta.focus({ preventScroll: true });
        ta.setSelectionRange(at, at);
        return true;
      }
      return false;
    }
    function go(dir) {
      const open = s.chunks.filter((k) => !C.done(k)), list = open.length ? open : s.chunks;
      if (!list.length) return;
      const i = list.indexOf(cur);
      cur = list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + dir))];
      reveal(cur);
    }
    function reveal(k) {
      const el = pane.M.scroll;
      el.scrollTop = Math.max(0, lay.M.y[k.m0] - Math.floor(el.clientHeight / 3));
      follow('M');
      caret(Math.min(k.m0, Math.max(0, s.result.length - 1)), 0);
    }

    // ---- drawing
    function render() {
      lay = P.layout(s, prefs);
      if (hl.key !== prefs.ignore || hl.s !== s) hl = { key: prefs.ignore, s, L: P.highlight(s.left, path), R: P.highlight(s.right, path) };
      const html = { L: hl.L, R: hl.R, M: P.highlight(s.result, path) }, lines = { L: s.left, M: s.result, R: s.right };
      inner = new Map();
      s.chunks.forEach((k) => inner.set(k, P.innerOf(s, k, prefs)));
      ['L', 'M', 'R'].forEach((p) => {
        const g = [], body = [];
        lay[p].rows.forEach((row) => {
          if (row.fold != null) {
            const at = ' gm-fold" data-fold="' + row.region + '" title="' + P.esc(t('Expand')) + '"';
            g.push('<div class="gm-g' + at + '></div>'); body.push('<div class="gm-l' + at + ' role="button" tabindex="0" aria-label="' + P.esc(t('Expand')) + '"></div>');
            return;
          }
          const k = row.chunk, i = row.line;
          let cls = '', layer = '';
          if (k && (p === 'M' || C.changed(k, p))) {
            const rs = C.sideDone(k, p), words = inner.get(k)[p];
            cls = ' k k-' + C.kind(k) + (rs ? ' rs' + (row.first ? ' rs-a' : '') + (row.last ? ' rs-z' : '') : words ? ' soft' : '');
            const here = rs ? [] : P.rangesAt(words, i - C.range(k, p)[0]);
            if (here.length) layer = P.wordLayer(lines[p][i], here);
          }
          if (row.edge) cls += ' edge e-' + C.kind(row.edge) + (row.edgeEnd ? ' edge-z' : '') + (C.sideDone(row.edge, p) ? ' e-rs' : '');
          body.push('<div class="gm-l' + cls + '">' + layer + '<span class="gm-t">' + (row.blank ? '' : html[p][i] || '') + '</span></div>');
          g.push('<div class="gm-g' + cls + '">' + gutterCell(p, row) + '</div>');
        });
        pane[p].gutter.innerHTML = g.join('');
        pane[p].back.innerHTML = body.join('');
      });
      // editors() replaces the Result's textareas: a caret in one comes back to the same place; otherwise the dialog's
      // sink keeps the keyboard (focus on <body> would let Esc close the embedding host's page)
      const fa = document.activeElement, mine = fa && fa.tagName === 'TEXTAREA' && pane.M.code.contains(fa);
      const at = mine ? (() => { const head = fa.value.slice(0, fa.selectionStart); return { line: +fa.dataset.a + (head.match(/\n/g) || []).length, col: head.length - head.lastIndexOf('\n') - 1 }; })() : null;
      editors();
      if (at) caret(at.line, at.col);
      else if (!Git.isEditable(document.activeElement) && Git.openDialogs().slice(-1)[0] === dlg) { const sink = dlg.el.querySelector('.g-sink'); if (sink) sink.focus({ preventScroll: true }); }
      const n = C.counts(s), open = s.chunks.filter((k) => !C.done(k)), clear = !n.changes && !n.conflicts;
      B.left.disabled = !open.some((k) => k.type !== 'conflict' && C.changed(k, 'L'));
      B.right.disabled = !open.some((k) => k.type !== 'conflict' && C.changed(k, 'R'));
      B.all.disabled = !open.some((k) => k.type !== 'conflict');
      B.magic.disabled = !open.some(C.simple);
      B.prev.disabled = B.next.disabled = !s.chunks.length;
      B.fold.classList.toggle('on', prefs.collapse);
      B.fold.setAttribute('aria-pressed', String(prefs.collapse));
      Git.clear(count).classList.toggle('ok', clear);
      if (clear) { count.appendChild(Git.icon('general/greenCheckmark')); count.appendChild(document.createTextNode(t('All conflicts resolved'))); }
      else count.textContent = t('{0}. {1}.', U.plural(n.changes, 'No changes', '1 change', '{0} changes'), U.plural(n.conflicts, 'No conflicts', '1 conflict', '{0} conflicts'));
      hintEl.hidden = !(clear && hint);
      ['L', 'R'].forEach((p) => {
        // Marks on the scrollbar's track: the whole file scaled to the pane (never stretched when the file is shorter).
        const scale = Math.min(1, pane[p].scroll.clientHeight / Math.max(lay[p].height, 1));
        pane[p].marks.innerHTML = s.chunks.filter((k) => C.changed(k, p)).map((k) => {
          const r = C.range(k, p), y0 = lay[p].y[r[0]] * scale, y1 = lay[p].y[r[1]] * scale;
          return '<i class="k-' + C.kind(k) + '" style="top:' + y0.toFixed(1) + 'px;height:' + Math.max(2, y1 - y0).toFixed(1) + 'px"></i>';
        }).join('');
      });
      follow('M');
    }
    function gutterCell(p, row) {
      const num = '<span class="gm-n">' + (row.blank ? '' : row.line + 1) + '</span>';
      const op = (name, k, glyph, tip) => '<button type="button" class="gm-op" data-op="' + name + '" data-k="' + s.chunks.indexOf(k) + '" data-side="' + p +
        '" title="' + P.esc(tip) + '" aria-label="' + P.esc(tip.split('\n')[0]) + '">' + P.icon(glyph) + '</button>';
      if (p === 'M') return num + (row.wand ? op('magic', row.wand, 'diff/magicResolve@14x14', t('Resolve')) : '') + (row.chunk && C.done(row.chunk) ? '<span class="gm-bar"></span>' : '');
      const k = row.ops;
      if (!k) return num;
      const conflict = k.type === 'conflict', more = conflict && k.applied;
      const tip = (label) => t(label) + (conflict ? '\n' + t('Ctrl+click to resolve conflict') : '');
      const take = op('accept', k, p === 'L' ? (more ? 'diff/arrowRightDown@14x14' : 'diff/arrowRight@14x14') : (more ? 'diff/arrowLeftDown@14x14' : 'diff/arrow@14x14'), tip('Accept'));
      const skip = op('ignore', k, 'diff/remove@14x14', tip('Ignore'));
      return p === 'L' ? '<span class="gm-ops">' + skip + take + '</span>' + num : num + '<span class="gm-ops">' + take + skip + '</span>';
    }
    /** One textarea over every unfolded run of the result's lines; the highlighted text shows through it. */
    function editors() {
      const code = pane.M.code, rows = lay.M.rows;
      Array.prototype.forEach.call(code.querySelectorAll('textarea'), (x) => x.remove());
      for (let i = 0; i < rows.length;) {
        if (rows[i].fold != null) { i++; continue; }
        let j = i;
        while (j < rows.length && rows[j].fold == null) j++;
        const a = rows[i].line, b = rows[i].blank ? a : rows[j - 1].line + 1;
        const ta = h('textarea.gm-edit', { spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', wrap: 'off', 'aria-label': t('Result'),
          dataset: { a, b }, style: { top: i * ROW + 'px', height: (j - i) * ROW + 'px' } });
        ta.value = s.result.slice(a, b).map(bare).join('\n');
        code.appendChild(ta);
        i = j;
      }
    }
    /** The shapes that tie a block's range in one pane to its range in the next. */
    function links() {
      const W = DIVIDER, curve = (y1, y2) => 'C' + W * 0.3 + ' ' + y1 + ' ' + W * 0.7 + ' ' + y2 + ' ' + W + ' ' + y2;
      [['L', 'M', 'L'], ['M', 'R', 'R']].forEach((d, n) => {
        const a = d[0], b = d[1], side = d[2];
        const ta = pane[a].scroll.scrollTop, tb = pane[b].scroll.scrollTop, H = panes.clientHeight || 4000;
        let out = '';
        s.chunks.forEach((k) => {
          if (!C.changed(k, side)) return;
          const ra = C.range(k, a), rb = C.range(k, b);
          let a0 = lay[a].y[ra[0]] - ta, a1 = lay[a].y[ra[1]] - ta, b0 = lay[b].y[rb[0]] - tb, b1 = lay[b].y[rb[1]] - tb;
          if (Math.max(a1, b1) < -4 || Math.min(a0, b0) > H + 4) return;
          if (a1 - a0 < 2) { a0 -= 1; a1 = a0 + 2; }   // an empty range narrows to a point (DividerPolygon.paint)
          if (b1 - b0 < 2) { b0 -= 1; b1 = b0 + 2; }
          const cls = 'k-' + C.kind(k) + (inner.get(k)[a] || inner.get(k)[b] ? ' soft' : '');
          if (C.sideDone(k, side)) out += '<path class="rs ' + cls + '" d="M0 ' + (a0 + 0.5) + curve(a0 + 0.5, b0 + 0.5) + 'M0 ' + (a1 - 0.5) + curve(a1 - 0.5, b1 - 0.5) + '"/>';
          else out += '<path class="' + cls + '" d="M0 ' + a0 + curve(a0, b0) + 'L' + W + ' ' + b1 + 'C' + W * 0.7 + ' ' + b1 + ' ' + W * 0.3 + ' ' + a1 + ' 0 ' + a1 + 'Z"/>';
        });
        Object.keys(lay[a].folds).forEach((r) => {   // a folded run's wavy line carries on across the divider
          if (lay[b].folds[r] == null) return;
          const y1 = lay[a].folds[r] - ta + ROW / 2, y2 = lay[b].folds[r] - tb + ROW / 2;
          out += '<path class="fold" d="M0 ' + y1 + curve(y1, y2) + '"/>';
        });
        dividers[n].innerHTML = out;
      });
    }
    /** Where a y of pane `p` lies in pane `q`: unchanged runs move together, inside a block the shorter side waits at its end. */
    function mapY(p, q, y) {
      let ep = 0, eq = 0;
      for (let i = 0; i < s.chunks.length; i++) {
        const rp = C.range(s.chunks[i], p), rq = C.range(s.chunks[i], q);
        const sp = lay[p].y[rp[0]], sq = lay[q].y[rq[0]], xp = lay[p].y[rp[1]], xq = lay[q].y[rq[1]];
        if (y < sp) return Math.min(eq + (y - ep), sq);
        if (y < xp) return Math.min(sq + (y - sp), xq);
        ep = xp; eq = xq;
      }
      return eq + (y - ep);
    }
    function follow(p) {
      const el = pane[p].scroll;
      if (prefs.sync) {
        const anchor = Math.floor(el.clientHeight / 3);
        ['L', 'M', 'R'].forEach((q) => {
          if (q === p) return;
          const other = pane[q].scroll;
          other.scrollTop = Math.max(0, mapY(p, q, el.scrollTop + anchor) - anchor);
          other.scrollLeft = el.scrollLeft;
          expect[q] = [other.scrollTop, other.scrollLeft];
        });
      }
      links();
    }
    function scrolled(p) {
      const el = pane[p].scroll, mine = expect[p];
      expect[p] = [-1, -1];
      if (Math.abs(el.scrollTop - mine[0]) < 1.5 && Math.abs(el.scrollLeft - mine[1]) < 1.5) links(); else follow(p);
    }

    // ---- input
    const chunkAt = (ev) => {
      const y = ev.clientY - pane.M.code.getBoundingClientRect().top, row = lay.M.rows[Math.floor(y / ROW)];
      return row ? row.chunk || row.edge || null : null;
    };
    panes.addEventListener('mousedown', (ev) => { if (hint && !hintEl.contains(ev.target)) { hint = false; hintEl.hidden = true; } });
    const press = (ev, forced) => {
      const b = ev.target.closest && ev.target.closest('[data-op]');
      if (!b) return false;
      const k = s.chunks[+b.dataset.k], side = b.dataset.side, all = forced || ev.ctrlKey || ev.metaKey;
      cur = k;
      act(() => { if (b.dataset.op === 'accept') C.accept(s, k, side, all); else if (b.dataset.op === 'ignore') C.ignore(s, k, side, all); else C.applyMagic(s, k); });
      return true;
    };
    panes.addEventListener('click', (ev) => {
      if (press(ev)) return;
      const f = ev.target.closest && ev.target.closest('[data-fold]');
      if (f) { s.expanded.add(+f.dataset.fold); render(); }
    });
    panes.addEventListener('contextmenu', (ev) => {
      if (ev.target.closest && ev.target.closest('[data-op]')) { ev.preventDefault(); if (ev.ctrlKey) press(ev, true); return; }   // macOS turns Ctrl+click into a context click
      if (!pane.M.code.contains(ev.target)) return;
      const k = chunkAt(ev), items = [];
      if (k && !C.done(k)) {
        const can = (side) => C.changed(k, side) && !C.sideDone(k, side);
        items.push({ label: t('Accept Left Side'), shortcut: '⌃⌘→', disabled: !can('L'), action: () => act(() => C.accept(s, k, 'L')) },
          { label: t('Accept Right Side'), shortcut: '⌃⌘←', disabled: !can('R'), action: () => act(() => C.accept(s, k, 'R')) });
        if (k.type === 'conflict') items.push({ label: t('Resolve using Left'), disabled: !can('L'), action: () => act(() => C.accept(s, k, 'L', true)) },
          { label: t('Resolve using Right'), disabled: !can('R'), action: () => act(() => C.accept(s, k, 'R', true)) });
        items.push({ label: t('Ignore'), action: () => act(() => C.ignore(s, k, 'L', true)) }, '-');
      }
      items.push({ label: t('Collapse Unchanged Fragments'), checked: prefs.collapse, action: () => toggle('collapse') },
        { label: t('Synchronize Scrolling'), checked: prefs.sync, action: () => toggle('sync') });
      Git.menu(ev, items);
    });
    pane.M.code.addEventListener('input', (ev) => { if (ev.target.tagName === 'TEXTAREA' && !ev.isComposing) typed(ev.target); });
    pane.M.code.addEventListener('compositionend', (ev) => { if (ev.target.tagName === 'TEXTAREA') typed(ev.target); });
    dlg.el.addEventListener('keydown', (ev) => {
      const mod = ev.metaKey || ev.ctrlKey;
      if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.dataset && ev.target.dataset.fold != null) { ev.preventDefault(); ev.stopPropagation(); s.expanded.add(+ev.target.dataset.fold); render(); }
      else if (ev.key === 'F7') { ev.preventDefault(); go(ev.shiftKey ? -1 : 1); }
      else if (mod && !ev.altKey && (ev.key === 'z' || ev.key === 'Z')) { ev.preventDefault(); step(!ev.shiftKey); }
      else if (ev.metaKey && ev.ctrlKey && (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft')) {
        const ta = document.activeElement;
        const line = ta && ta.tagName === 'TEXTAREA' ? +ta.dataset.a + (ta.value.slice(0, ta.selectionStart).match(/\n/g) || []).length : -1;
        const k = s.chunks.find((x) => !C.done(x) && line >= x.m0 && line < Math.max(x.m1, x.m0 + 1)) || (cur && !C.done(cur) ? cur : null);
        if (!k) return;
        ev.preventDefault();
        const side = ev.key === 'ArrowRight' ? 'L' : 'R';
        if (C.changed(k, side) && !C.sideDone(k, side)) act(() => C.accept(s, k, side));
      }
    });

    render();
    const first = s.chunks.find((k) => !C.done(k));
    setTimeout(() => { if (dlg.closed) return; if (first) { cur = first; reveal(first); } else links(); }, 0);
    return dlg;
  }
})();
