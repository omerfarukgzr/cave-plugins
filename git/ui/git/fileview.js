/* The read-only file view of the editor area (the standalone page's stand-in for the host's editor).
   Line numbers, syntax colors (vendored highlight.js), IntelliJ's change markers in the gutter for a locally changed file
   (added / modified lines and a deleted-lines mark, against HEAD) and, when on, the "Annotate with Git Blame" column
   (annotate.js). Only the lines in view are in the DOM (Git.vlist), so a 100 000 line file opens at once.
     Git.fileView.open(path, { line, annotate, rev }) -> tab id   'file:<path>' for the work tree file;
                                     'file:<path>@<rev>' for a committed version (no markers; its blame is of that revision)
                                     line: 1-based, shown in the middle and marked as the caret row
     Git.fileView.tab(key) -> the view { key, path, rev, lines, marks, blame, line, root, list } (key: path or path@rev) · .all()
     A click anywhere on a line or ↓ / ↑ (once there is one) moves the caret row (`line`); its inline blame: annotate-inline.js.
     Git.fileView.refresh(key)   redraw (annotate.js after a blame arrives) */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const views = new Map();   // key → view

  Git.addTR({
    'Cannot find file: {0}': 'Dosya bulunamadı: {0}', 'Binary file': 'İkili dosya', 'File is too large: {0}': 'Dosya çok büyük: {0}',
    'Annotate with Git Blame': 'Git Blame ile annotate et', 'Close Annotations': 'Annotation\'ları kapat',
    'Added lines': 'Eklenen satırlar', 'Modified lines': 'Değişen satırlar', 'Deleted lines': 'Silinen satırlar',
  });

  const MAX_SYNTAX = 2 * 1024 * 1024;   // larger files are shown without syntax colors
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  const keyOf = (path, rev) => (rev ? path + '@' + rev : path);
  const trackedNow = (path) => { const f = Git.localFile(path); return !f || (f.status !== '?' && f.status !== 'A'); };

  /** Change markers against HEAD: { line: { [index]: 'add' | 'mod' }, del: { [index]: true } (a deletion sits above line
      index), blocks: the change blocks in order ({ type, a0, a1, b0, b1 }: the marker popup's changes) }. */
  function marksOf(base, text) {
    const out = { line: {}, del: {}, blocks: [] };
    if (base == null || text == null || base === text) return out;
    let blocks;
    try { blocks = Git.diff.lines(base.replace(/\r\n/g, '\n'), text.replace(/\r\n/g, '\n')).blocks; } catch (e) { return out; }   // too big to diff
    blocks.forEach((b) => {
      if (b.type === 'ins') for (let i = b.b0; i < b.b1; i++) out.line[i] = 'add';
      else if (b.type === 'mod') for (let i = b.b0; i < b.b1; i++) out.line[i] = 'mod';
      else if (b.type === 'del') out.del[b.b0] = true;
      if (b.type !== 'eq') out.blocks.push(b);
    });
    return out;
  }

  function createView(path, rev) {
    const v = { key: keyOf(path, rev), path, rev: rev || null, root: null, list: null, lines: [], runs: [], marks: { line: {}, del: {} },
      blame: null, line: null, subs: [], slot: Git.content.slot() };
    let body = null, scroll = null;
    v.tracked = () => (v.rev ? true : trackedNow(path));

    function message(text) {
      Git.clear(v.root);
      if (v.list) { v.list.destroy(); v.list = null; }
      v.root.appendChild(h('div.fv-msg', { role: 'status' }, text));
    }
    function row(i) {
      const mark = v.marks.line[i], del = v.marks.del[i] || (i === v.lines.length - 1 && v.marks.del[i + 1]);
      const r = h('div.fv-row', { class: (v.line === i ? 'cur ' : '') + (mark ? 'm-' + mark : ''), dataset: { line: String(i + 1) } });
      const gutter = h('span.fv-gutter');
      gutter.appendChild(h('span.fv-num', String(i + 1)));
      if (v.blame && Git.annotate) gutter.appendChild(Git.annotate.cell(v, i));   // right of the line number (B §16.2)
      gutter.appendChild(h('span.fv-mark', { class: (mark || '') + (del ? ' del' + (v.marks.del[i] ? '' : ' below') : ''),
        title: mark === 'add' ? t('Added lines') : mark === 'mod' ? t('Modified lines') : del ? t('Deleted lines') : null }));
      r.appendChild(gutter);
      const code = h('span.fv-code', { html: Git.diffParts.lineHTML(v.runs[i], null) || ' ' });
      const inline = v.line === i && Git.inlineBlame ? Git.inlineBlame.el(v, i) : null;   // the caret line's blame (annotate-inline.js)
      if (inline) code.appendChild(inline);
      r.appendChild(code);
      return r;
    }
    function draw(keepScroll) {
      if (!v.root) return;
      const top = scroll ? scroll.scrollTop : 0, left = scroll ? scroll.scrollLeft : 0;
      if (!body) {
        Git.clear(v.root);
        scroll = h('div.fv-scroll', { tabIndex: 0 });
        body = h('div.fv-body', scroll);
        v.root.appendChild(body);
        scroll.addEventListener('contextmenu', onContext);
        scroll.addEventListener('mouseover', (e) => { if (Git.annotate) Git.annotate.hover(v, e); });
        scroll.addEventListener('mouseleave', () => { if (Git.annotate) Git.annotate.hover(v, null); });
        scroll.addEventListener('click', (e) => {
          const mark = e.target.closest && e.target.closest('.fv-mark.add, .fv-mark.mod, .fv-mark.del');
          if (mark && Git.fileMarker && !e.button) { const k = Git.fileMarker.blockAt(v, +mark.closest('.fv-row').dataset.line - 1); if (k >= 0) { Git.fileMarker.open(v, k); return; } }
          const inline = e.target.closest && e.target.closest('.fv-inline');
          if (inline && !e.button) { if (Git.actions.showInLog) Git.actions.showInLog(inline.dataset.id); return; }
          // a click anywhere on a line (its text, the space after it, its number) puts the caret on that line, as in an
          // editor (the inline blame follows the caret row); the annotation column keeps its own click
          const row = e.target.closest && e.target.closest('.fv-row');
          if (row && !e.button && !e.target.closest('.fv-blame')) { setCaret(+row.dataset.line - 1); return; }
          if (Git.annotate) Git.annotate.click(v, e);
        });
        scroll.addEventListener('keydown', (e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
          const d = e.key === 'ArrowDown' ? 1 : -1;
          if (e.ctrlKey && e.altKey && e.shiftKey) {           // ⌃⌥⇧↓ / ⌃⌥⇧↑: Next / Previous Change
            if (!Git.fileMarker) return;
            e.preventDefault();
            Git.fileMarker.step(v, d);
            return;
          }
          if (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey || v.line == null) return;   // no caret yet: the keys scroll
          e.preventDefault();                                   // ↓ / ↑: the caret moves a line
          setCaret(v.line + d, true);
        });
        v.list = Git.vlist({ el: scroll, rowHeight: () => parseFloat(getComputedStyle(v.root).getPropertyValue('--fv-line')) || 18, count: () => v.lines.length, render: row, overscan: 20 });
      }
      v.root.style.setProperty('--fv-digits', String(Math.max(2, String(Math.max(1, v.lines.length)).length)));
      v.root.classList.toggle('fv-annotated', !!v.blame);
      if (v.blame && Git.annotate) v.root.style.setProperty('--fv-blame', Git.annotate.width(v) + 'ch');
      v.list.refresh();
      if (keepScroll) { scroll.scrollTop = top; scroll.scrollLeft = left; }
    }
    v.draw = draw;
    /** The caret row (0-based); `reveal`: scrolled into view. The inline blame is read for it once (annotate-inline.js). */
    function setCaret(i, reveal) {
      if (!v.list || !v.lines.length) return;
      v.line = Math.max(0, Math.min(v.lines.length - 1, i));
      v.list.refresh();
      if (reveal) v.list.scrollTo(v.line, { align: 'nearest' });
      if (Git.inlineBlame) Git.inlineBlame.need(v);
    }
    v.goTo = function (line) {
      if (line == null || !v.list || !v.lines.length) return;
      v.line = Math.max(0, Math.min(v.lines.length - 1, line - 1));
      v.list.refresh();
      v.list.scrollTo(v.line, { align: 'center' });
      if (Git.inlineBlame) Git.inlineBlame.need(v);
    };

    /** Reads the file (and HEAD's version for the markers); keeps the scroll position when the content moves under it. */
    function load(keep) {
      if (!v.root) return;
      const head = Git.headId();
      const read = v.rev ? Promise.all([Git.content.file({ path, rev: v.rev }), Promise.resolve(null)])
        : Promise.all([Git.content.file({ path, worktree: true }), head && trackedNow(path) ? Git.content.file({ path, rev: head }).catch(() => null) : Promise.resolve(null)]);
      v.slot.run(() => read, {
        loading: () => { if (!body) { Git.clear(v.root); v.root.appendChild(Git.content.loading()); } },
        done: ([c, base]) => {
          if (!v.root) return;
          if (!c.exists) { body = null; message(t('Cannot find file: {0}', path)); return; }
          if (c.binary) { body = null; message(t('Binary file')); return; }
          if (c.tooLarge) { body = null; message(t('File is too large: {0}', mb(c.size))); return; }
          const text = c.text || '';
          const same = keep && v.text === text && v.baseId === (base && base.id);
          v.text = text;
          v.baseId = base && base.id;
          if (!same) {
            v.lines = Git.diff.split(text.replace(/\r\n/g, '\n'));
            v.eol = c.eol;   // Rollback Lines writes back with the file's own line ends (Git.changesModel.writeBack)
            v.runs = text.length <= MAX_SYNTAX ? Git.diffParts.syntax(v.lines, path) : v.lines.map((s) => (s ? [{ t: s, c: '' }] : []));
            const hasBase = base && base.exists && !base.binary && base.text != null;
            v.marks = hasBase ? marksOf(base.text, text) : { line: {}, del: {}, blocks: [] };
            v.baseText = hasBase ? base.text : null;
            v.baseEol = hasBase ? base.eol : null;
            v.baseLines = hasBase ? Git.diff.split(base.text.replace(/\r\n/g, '\n')) : null;
            if (Git.fileMarker) Git.fileMarker.close();
            draw(keep);
          }
          if (v.pendingLine != null) { v.goTo(v.pendingLine); v.pendingLine = null; }
          // the blame follows the text and HEAD (read again only when one of them moved)
          if (Git.annotate && Git.annotate.isOn(v.key)) {
            const key = (v.rev || Git.headId() || '') + ':' + Git.changesModel.textHash(text);
            if (key !== v.blameKey || !v.blame) { v.blameKey = key; Git.annotate.load(v); }
          }
          if (Git.inlineBlame) Git.inlineBlame.need(v);           // the caret line's blame, once per text (annotate-inline.js)
        },
        error: (e) => { if (!v.root) return; body = null; Git.clear(v.root); v.root.appendChild(Git.content.failed(e)); },
      });
    }
    v.load = load;

    function onContext(e) {
      if (!e.target.closest('.fv-gutter')) return;
      e.preventDefault();
      const on = Git.annotate && Git.annotate.isOn(v.key);
      // the annotation column has IntelliJ's annotation menu (annotate.js); the rest of the gutter offers Annotate
      if (on && v.blame && e.target.closest('.fv-blame') && Git.annotate.menu) { Git.annotate.menu(v, e); return; }
      Git.menu(e, [{ label: on ? t('Close Annotations') : t('Annotate with Git Blame'), disabled: !on && !v.tracked(), action: () => Git.annotate.toggle(path, v.rev ? { rev: v.rev } : null) }]
        .concat(Git.inlineBlame ? ['-', Git.inlineBlame.item()] : []));
    }

    v.mount = function (el) {
      v.unmount();
      views.set(v.key, v);
      v.root = h('div.g-root.fv-root', { role: 'group', 'aria-label': path, dataset: { path, rev: v.rev || '' } });
      Git.clear(el).appendChild(v.root);
      body = null; scroll = null; v.text = null;
      const mine = (ev) => !ev || !ev.paths || ev.paths.indexOf(path) >= 0;
      v.subs = v.rev ? [Git.on('skin', () => draw(true)), Git.on('look', () => draw(true))] : [
        Git.on('files', (ev) => { if (mine(ev)) load(true); }),
        Git.on('change', (ev) => { if (!ev || ev.reason === 'log') return; load(true); }),
        Git.on('skin', () => draw(true)),
        Git.on('look', () => draw(true)),
      ];
      load(false);
    };
    v.unmount = function () {
      v.subs.forEach((off) => off());
      v.subs = [];
      if (v.list) { v.list.destroy(); v.list = null; }
      if (Git.annotate) Git.annotate.hover(v, null);
      v.root = null;
      body = null; scroll = null;
      if (views.get(v.key) === v) views.delete(v.key);
    };
    return v;
  }

  Git.fileView = {
    open(path, o) {
      o = o || {};
      if (!path || !Git.tabs) return null;
      const rev = o.rev ? Git.refId(o.rev) || o.rev : null, key = keyOf(path, rev), id = 'file:' + key;
      let v = views.get(key);
      const fresh = !v;
      if (!v) v = createView(path, rev);
      v.pendingLine = o.line != null ? o.line : null;
      if (o.annotate && Git.annotate) Git.annotate.mark(key, true);
      Git.tabs.open({ id, title: Git.fileName(path) + (rev ? ' (' + Git.short(rev) + ')' : ''), icon: 'fileTypes/text', mount: (el) => v.mount(el), unmount: () => v.unmount() });
      if (!fresh && v.root) {
        if (v.pendingLine != null && v.lines.length) { v.goTo(v.pendingLine); v.pendingLine = null; }
        if (Git.annotate && Git.annotate.isOn(key) && !v.blame) Git.annotate.load(v);
      }
      return id;
    },
    tab: (key) => views.get(key) || null,
    all: () => Array.from(views.values()),
    keyOf,
    refresh(key) { const v = views.get(key); if (v && v.draw) v.draw(true); },
    marksOf,
  };
})();
