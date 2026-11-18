/* The diff preview of File History and of the Log (Show Diff Preview): one file of one revision against its
   previous version, read only. Its toolbar is IntelliJ's diff toolbar as the History tab shows it: Previous / Next
   Difference, Jump to Source, the viewer [Side-by-side viewer | Unified viewer ▾], Ignore and Highlight (the diff tab's
   own settings), the count of differences. Moved out of log-history.js; the viewer choice is remembered in the tabs'
   options (`tabs.opts.viewer`).
   L.diffPreview() → { el, show({ id, path, oldPath, status, parent } | null), stop() } */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = Git.t;
  const A = Git.actions;
  const L = (Git.logUI = Git.logUI || {});
  const T = Git.logTabs;

  Git.addTR({
    'Show Diff Preview': 'Diff önizlemesini göster', 'Select commit to view changes': 'Değişiklikleri görmek için bir commit seç',
    'Previous Difference': 'Önceki fark', 'Next Difference': 'Sonraki fark', 'Jump to Source': 'Kaynağa git', 'Diff': 'Diff',
    'No differences': 'Fark yok', '1 difference': '1 fark', '{0} differences': '{0} fark', 'Differences highlighting is off': 'Fark vurgulama kapalı',
    'Files are too large to compare': 'Dosyalar karşılaştırılamayacak kadar büyük', 'Files contents are different': 'Dosya içerikleri farklı',
    'Side-by-side viewer': 'Yan yana görünüm', 'Unified viewer': 'Birleşik görünüm',
  });

  const IGNORE = [['none', 'Do not ignore'], ['trim', 'Trim whitespaces'], ['ws', 'Ignore whitespaces'], ['ws-empty', 'Ignore whitespaces and empty lines']];
  const HIGHLIGHT = [['words', 'Highlight words'], ['lines', 'Highlight lines'], ['none', 'Do not highlight']];
  const VIEWER = [['side', 'Side-by-side viewer'], ['unified', 'Unified viewer']];

  L.diffPreview = function () {
    const root = h('div.g-diff', { tabIndex: 0, role: 'group', 'aria-label': t('Show Diff Preview') });
    const slot = Git.content.slot();
    let spec = null, shown = '', m = null, lay = null, scroll = null, stripe = null, tb = {}, cur = -1, LH = 18, placed = false, solo = null, pair = null;
    let blockRow = null;                                    // block index → its first row in the shown viewer
    const settings = () => (Git.diffTab && Git.diffTab.settings) || { ignore: 'none', highlight: 'words' };
    const viewer = () => (T.opts.viewer === 'side' ? 'side' : 'unified');

    function nav() {
      if (!tb.count || !m) return;
      const n = m.changes.length;
      tb.prev.disabled = !(cur > 0);
      tb.next.disabled = !(cur < n - 1);
      tb.count.textContent = solo ? '' : settings().highlight === 'none' ? t('Differences highlighting is off') : n === 0 ? t('No differences') : n === 1 ? t('1 difference') : t('{0} differences', n);
    }
    function goTo(i) {
      cur = i;
      const bi = m.changes[i];
      scroll.scrollTop = Math.max(0, blockRow[bi] * LH - Math.floor(scroll.clientHeight / 3));
      root.querySelectorAll('.gd-gl.cur').forEach((x) => x.classList.remove('cur'));
      root.querySelectorAll('.gd-gl[data-b="' + bi + '"]').forEach((x) => x.classList.add('cur'));
      nav();
    }
    const step = (d) => { if (m && cur + d >= 0 && cur + d < m.changes.length) goTo(cur + d); };
    function marks() {
      if (!scroll || !stripe || !m) return;
      const total = Math.max(scroll.scrollHeight, 1);
      stripe.innerHTML = m.changes.map((bi) => {
        const k = m.blocks[bi], top = blockRow[bi] * LH, size = (viewer() === 'side' && !solo ? Math.max(k.a1 - k.a0, k.b1 - k.b0) : k.a1 - k.a0 + k.b1 - k.b0) * LH;
        return '<i class="' + k.type + '" style="top:' + (top / total * 100).toFixed(2) + '%;height:' + (size / total * 100).toFixed(2) + '%"></i>';
      }).join('');
    }
    function place() {
      nav();
      if (!scroll || !scroll.clientHeight) return;
      placed = true;
      LH = parseFloat(getComputedStyle(root).getPropertyValue('--gd-line')) || 18;
      if (m.changes.length) goTo(0);
      marks();
    }
    function toolbar() {
      const set = settings(), sep = () => h('span.g-toolbar-sep');
      const drop = (options, now, pick, disabled) => {
        const cur = options.find((x) => x[0] === now) || options[0];
        const btn = h('button.gd-drop', { type: 'button', 'aria-haspopup': 'menu', disabled: !!disabled, title: t(cur[1]),
          onclick: () => Git.menu(btn, options.map((x) => ({ label: t(x[1]), checked: x[0] === now, action: () => pick(x[0]) }))) },
          h('span', t(cur[1])), Git.icon('chevronDownSmall', 12));
        return btn;
      };
      const setting = (options, name) => drop(options, set[name], (v) => Git.diffTab.set(name, v), !!solo || !Git.diffTab);
      tb = { prev: Git.toolBtn({ icon: 'general/up', title: t('Previous Difference') + '  ⇧F7', onClick: () => step(-1) }),
        next: Git.toolBtn({ icon: 'general/down', title: t('Next Difference') + '  F7', onClick: () => step(1) }),
        count: h('span.gd-count', { role: 'status' }) };
      const viewerDrop = drop(VIEWER, viewer(), (v) => { T.opts.viewer = v; T.saveOpts(); if (pair) paint(pair); }, !!solo);
      viewerDrop.classList.add('gd-viewer');
      return h('div.gd-bar', h('div.g-toolbar.gd-toolbar', { role: 'toolbar', 'aria-label': t('Diff') }, tb.prev, tb.next, sep(),
        Git.toolBtn({ icon: 'general/edit', title: t('Jump to Source') + '  F4', onClick: () => A.jumpToSource(spec.path) }), sep(),
        viewerDrop, setting(IGNORE, 'ignore'), setting(HIGHLIGHT, 'highlight'), h('span.g-spacer'), tb.count));
    }
    const message = (text) => h('div.glt-pempty.gd-msg', text);
    const num = (v) => '<span class="gd-n">' + (v != null ? v + 1 : '') + '</span>';
    const head = (rev, file, second) => h('div.gd-head', { class: second ? 'second' : '' }, Git.icon('general/locked'),
      rev ? h('button.gd-rev', { type: 'button', title: (Git.commit(rev) || {}).subject || rev, onclick: () => A.showInLog(rev) }, Git.short(rev)) : null,
      file ? h('span.gd-path', file) : null);
    /** One pane's HTML from rows of { line?, block, pad? } (side by side: `side` 'a' or 'b'). */
    function paneHTML(rows, side, syn, on) {
      let gutter = '', code = '';
      rows.forEach((row) => {
        const k = m.blocks[row.block], changed = k && k.type !== 'eq' && on;
        if (row.pad || row.fold) {
          gutter += '<div class="gd-gl' + (changed ? ' ' + k.type : '') + '"></div>';
          code += '<div class="gd-ln pad' + (changed ? ' ' + k.type : '') + '"></div>';
          return;
        }
        const words = changed && k.words ? (side === 'a' ? k.words.a[row.line - k.a0] : k.words.b[row.line - k.b0]) : null;
        const cls = changed ? ' ' + k.type + (k.words ? ' soft' : '') : '';
        gutter += '<div class="gd-gl' + cls + '"' + (changed ? ' data-b="' + row.block + '"' : '') + '>' + num(row.line) + '</div>';
        code += '<div class="gd-ln' + cls + '">' + Git.diffParts.lineHTML(syn[row.line], words) + '</div>';
      });
      return { gutter, code };
    }
    function paint(p) {
      const P = Git.diffParts;
      pair = p;
      Git.clear(root);
      scroll = stripe = m = null; tb = {}; cur = -1; placed = false;
      solo = spec.status === 'A' || !p.left.exists ? 'ins' : spec.status === 'D' || !p.right.exists ? 'del' : null;
      if (!P) { root.appendChild(message(t('Select commit to view changes'))); return; }
      root.appendChild(toolbar());
      if (p.left.tooLarge || p.right.tooLarge) { root.appendChild(message(t('Files are too large to compare'))); return; }
      if (p.left.binary || p.right.binary) { root.appendChild(message(t('Files contents are different'))); return; }
      const base = p.left.exists ? p.left.text : '', current = p.right.exists ? p.right.text : '';
      const set = settings();
      m = P.compute(solo ? '' : base, solo === 'del' ? base : current, { ignore: solo ? 'none' : set.ignore, highlight: set.highlight });
      const on = !!solo || set.highlight !== 'none';
      if (solo || !on) m.changes = [];
      const side = viewer() === 'side' && !solo;
      lay = P.layout(m, { collapse: false, context: 0, expanded: new Set(), align: side });
      const syn = { a: solo ? [] : P.syntax(m.a, spec.oldPath || spec.path), b: P.syntax(m.b, spec.path) };
      const digits = { '--gd-digits': String(Math.max(2, String(Math.max(m.a.length, m.b.length, 1)).length)) };
      if (side) {
        blockRow = [];
        lay.R.forEach((row, i) => { if (row.block != null && blockRow[row.block] == null) blockRow[row.block] = i; });
        const a = paneHTML(lay.L, 'a', syn.a, on), b = paneHTML(lay.R, 'b', syn.b, on);
        const left = h('div.gd-scroll', h('div.gd-content', h('div.gd-gutter', { html: a.gutter }), h('div.gd-code', { html: a.code })));
        scroll = h('div.gd-scroll', h('div.gd-content', h('div.gd-gutter', { html: b.gutter }), h('div.gd-code', { html: b.code })));
        scroll.addEventListener('scroll', () => { left.scrollTop = scroll.scrollTop; });
        left.addEventListener('scroll', () => { if (Math.abs(left.scrollTop - scroll.scrollTop) > 1) scroll.scrollTop = left.scrollTop; });
        stripe = h('div.gd-stripe', { 'aria-hidden': 'true' });
        root.appendChild(h('div.gd-body.side', { style: digits },
          h('div.gd-pane.left', h('div.gd-heads', head(spec.parent, spec.oldPath || spec.path)), left),
          h('div.gd-pane.right', h('div.gd-heads', head(spec.id, spec.path)), scroll, stripe)));
        place();
        return;
      }
      blockRow = lay.blockRowU;
      let gutter = '', code = '';
      lay.U.forEach((row) => {
        const k = m.blocks[row.block], del = row.type === 'del', type = row.type === 'eq' ? 'eq' : solo || row.type;
        const changed = type !== 'eq' && on;
        const frags = changed && k.words ? (del ? k.words.a[row.a - k.a0] : k.words.b[row.b - k.b0]) : null;
        const cls = changed ? ' ' + type + (k.words ? ' soft' : '') : '';
        gutter += '<div class="gd-gl' + cls + '"' + (changed ? ' data-b="' + row.block + '"' : '') + '>' + (solo ? '' : num(row.a)) + num(row.b) + '</div>';
        code += '<div class="gd-ln' + cls + '">' + P.lineHTML(del ? syn.a[row.a] : syn.b[row.b], frags) + '</div>';
      });
      const heads = solo ? [head(solo === 'del' ? spec.parent : spec.id, spec.path)] : [head(spec.parent, spec.oldPath || spec.path), head(spec.id, null, true)];
      scroll = h('div.gd-scroll', h('div.gd-content', h('div.gd-gutter', { html: gutter }), h('div.gd-code', { html: code })));
      stripe = h('div.gd-stripe', { 'aria-hidden': 'true' });
      root.appendChild(h('div.gd-body.unified', { style: digits }, h('div.gd-pane.' + (solo ? 'solo' : 'uni'), h('div.gd-heads', heads), scroll, stripe)));
      place();
    }
    function draw() {
      if (!spec) { slot.cancel(); Git.clear(root).appendChild(message(t('Select commit to view changes'))); m = null; pair = null; return; }
      const left = spec.status === 'A' || !spec.parent ? null : { path: spec.oldPath || spec.path, rev: spec.parent };
      const right = spec.status === 'D' ? null : { path: spec.path, rev: spec.id };
      slot.run(() => Git.content.pair(left, right), {
        loading: () => { Git.clear(root).appendChild(Git.content.loading()); m = null; },
        done: paint,
        error: (err) => { Git.clear(root).appendChild(Git.content.failed(err)); m = null; },
      });
    }
    root.addEventListener('keydown', (e) => {
      if (e.key === 'F7') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
      else if (e.key === 'F4' && spec) { e.preventDefault(); A.jumpToSource(spec.path); }
    });
    const watch = window.ResizeObserver ? new ResizeObserver(() => { if (!m) return; if (!placed) place(); else marks(); }) : null;
    if (watch) watch.observe(root);
    return {
      el: h('div.glt-preview', root),
      /** Draws only when the revision, the file or a viewer setting is not what is already shown (a revision never changes). */
      show(next) {
        const set = settings(), key = next ? [next.id, next.path, next.status, next.parent, set.ignore, set.highlight].join('|') : '-';
        spec = next;
        if (key === shown) return;
        shown = key;
        draw();
      },
      stop() { if (watch) watch.disconnect(); slot.cancel(); },
    };
  };
})();
