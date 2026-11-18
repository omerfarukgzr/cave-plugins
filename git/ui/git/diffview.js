/* The diff tab of the editor area (IntelliJ's Diff Viewer). What it shows is loaded by diffview-load.js; the
   model, the pane HTML and the shapes come from diffview-parts.js. The » arrows of a local change write the work tree
   (Git.actions.writeBlock → changes.write); { kind: 'file' } opens the read-only file view (fileview.js).
   Git.diffTab.open(spec)
     { kind: 'local',  path, files }             working tree against HEAD; tab "diff:local" (one tab, the file in it changes)
     { kind: 'commit', commit, path, files }     one file of a commit; tab "diff:commit"
     { kind: 'texts',  id, title, path, left: { title, text, locked? }, right: { title, text, locked? }, files?, openFile?(path) }
   `files`: the other paths of the same context, for Compare Previous / Next File (a `texts` caller opens them through `openFile`).
   A side whose text is missing (added or deleted file) gives IntelliJ's one-sided view.
   Git.diffTab.settings · Git.diffTab.set(name, value): viewer settings (mode: side|unified, ignore: none|trim|ws|ws-empty,
   highlight: lines|words|split|chars|none, collapse, sync, align), shared by every diff tab and remembered.
   The toolbar, the gear, the context menus and the keys are in diffview-bar.js. `spec.newTab`: a tab of its own
   ("Show Diff in a New Tab"). */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);

  const CONTEXT = 4;          // unchanged lines kept around a change when the rest is collapsed (IntelliJ's default "Context lines")
  const DIVIDER = 24;         // registry diff.divider.width
  const NARROW = 700;         // below this width a page shows the unified viewer (two panes do not fit)
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const tabs = new Map();   // tab id → controller
  const icon = (name) => (Git.ICONS || {})[name] || '';
  const L = Git.diffLoad;
  const { tabId, titleOf, alive, load, noteFor, signature, revTip, settings, setting } = L;
  /** Line ends are not differences (IntelliJ compares the text; a notice names separator-only changes): CRLF sides are
      compared as LF and a block written back gets the work tree file's CRLF again. */
  const lf = (s) => Git.changesModel.modelText(s);

  function createTab(id) {
    const c = { id, spec: null, root: null, dirty: true };
    let src = null, m = null, lay = null, syn = null, solo = null, off = false, mode = 'side', sig = '';
    let LH = 18, cur = -1, expanded = new Set(), start = 'first', again = 0;
    let scr = {}, svg = null, tb = {}, subs = [], ro = null, skip = {}, queued = false, placed = false, saved = null, hintTimer = 0, listed = '';
    /** A page of a single view (pages.js) narrower than NARROW draws the unified viewer whatever the setting says. */
    let forced = false;
    /** The pane the reader scrolled last (synchronized scrolling follows it; a redraw puts the other one in step again). */
    let master = 'R';
    const narrow = () => !!(c.root && c.root.closest('.wb-page') && c.root.clientWidth > 0 && c.root.clientWidth < NARROW);

    // ---------------------------------------------------------------- files of the same context
    /** Local changes are walked in the order the Commit view lists them; files no longer changed drop out. */
    function files() {
      const list = c.spec.files || [];
      if (c.spec.kind !== 'local') return list;
      const order = Git.views && Git.views.commit && Git.views.commit.order ? Git.views.commit.order() : [];
      const rank = (p) => { const i = order.indexOf(p); return i < 0 ? order.length + list.indexOf(p) : i; };
      return list.filter((p) => p === c.spec.path || Git.localFile(p)).sort((a, b) => rank(a) - rank(b));
    }
    const canSwitch = () => c.spec.kind !== 'texts' || typeof c.spec.openFile === 'function';
    function fileStep(d) {
      const list = files(), i = list.indexOf(c.spec.path) + d;
      if (!canSwitch() || i < 0 || i >= list.length || list.indexOf(c.spec.path) < 0) return;
      if (c.spec.openFile) c.spec.openFile(list[i]);
      else Git.diffTab.open(Object.assign({}, c.spec, { path: list[i], enter: d < 0 ? 'last' : 'first' }));
    }
    const hasFile = (d) => { const list = files(), i = list.indexOf(c.spec.path); return canSwitch() && i >= 0 && i + d >= 0 && i + d < list.length; };

    // ---------------------------------------------------------------- toolbar (diffview-bar.js)
    /** What diffview-bar.js needs from this tab. */
    const api = { spec: () => c.spec, src: () => src, m: () => m, lay: () => lay, mode: () => mode, solo: () => solo, off: () => off, cur: () => cur, narrow: () => forced,
      files, hasFile, fileStep, step: (d) => step(d), jump: () => jump(), canJump: () => canJump(), revert: (bi, append) => revert(bi, append),
      unfold: () => { expanded = new Set(); } };
    function toolbar() {
      listed = files().join('\n');
      const bar = Git.diffBar.toolbar(api);
      tb = bar.tb;
      return bar.el;
    }
    function nav() {
      const n = m.changes.length;
      tb.prev.disabled = !(cur > 0) && !hasFile(-1);
      tb.next.disabled = !(cur < n - 1) && !hasFile(1);
      tb.count.textContent = solo || m.note ? '' : off ? t('Differences highlighting is off') : n === 0 ? (src && L.allIgnored(src, m) ? t('Differences ignored') : t('No differences'))
        : n === 1 ? t('1 difference') : t('{0} differences', n);
    }
    const canJump = () => !!c.spec.path && !(c.spec.kind === 'local' && src && !src.right);
    /** Jump to Source: the file at the current difference's line (IntelliJ keeps the caret where it was). */
    function jump() {
      if (!canJump()) return;
      const k = m && cur >= 0 ? m.blocks[m.changes[cur]] : null;
      Git.actions.jumpToSource(c.spec.path, k ? { line: k.b0 + 1 } : {});
    }

    // ---------------------------------------------------------------- panes
    /** What the HTML builders of diffview-parts.js need from this tab. */
    const view = () => ({ m, lay, syn, solo, off, revert: !!src.revert, highlight: settings.highlight, align: !!settings.align && mode === 'side',
      labels: { fold: t('Collapsed unchanged lines'), revert: t('Revert'), append: t('Append'), eof: t('No newline at end of file') }, icon });
    const pane = (side) => Git.diffParts.paneHTML(view(), side);
    const unified = () => Git.diffParts.unifiedHTML(view());
    function head(info, second) {
      const el = h('div.gd-head', { class: second ? 'second' : '' });
      // the local change's right header: a checkbox for the whole file in the commit (A §5.3)
      if (info.worktree && c.spec.kind === 'local' && Git.diffBar.includeBox) { const box = Git.diffBar.includeBox(c.spec.path); if (box) el.appendChild(box); }
      if (info.locked) el.appendChild(Git.icon('general/locked'));
      if (info.rev && Git.commit(info.rev)) {
        el.appendChild(h('button.gd-rev', { type: 'button', title: revTip(info.rev), onclick: () => Git.actions.showInLog(info.rev) }, info.label));
      } else el.appendChild(h('span.gd-title', info.label));
      if (info.path) el.appendChild(h('span.gd-path', info.path));
      return el;
    }
    function paneEl(cls, heads, html, key, gutterFirst) {
      const gutter = h('div.gd-gutter', { html: html.gutter }), code = h('div.gd-code', { html: html.code });
      const scroll = h('div.gd-scroll', h('div.gd-content', gutterFirst ? [gutter, code] : [code, gutter]));
      scr[key] = scroll;
      scroll.addEventListener('scroll', () => onScroll(key), { passive: true });
      return h('div.gd-pane.' + cls, h('div.gd-heads', heads), scroll, cls === 'left' ? null : h('div.gd-stripe', { 'aria-hidden': 'true' }));
    }
    function body() {
      scr = {}; svg = null;
      const digits = Math.max(2, String(Math.max(m.a.length, m.b.length, 1)).length);
      const el = h('div.gd-body.' + mode, { style: { '--gd-digits': String(digits) } });
      if (mode === 'side') {
        svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('class', 'gd-links');
        svg.setAttribute('width', DIVIDER);
        svg.setAttribute('aria-hidden', 'true');
        el.appendChild(paneEl('left', [head(src.left)], pane('L'), 'L', false));
        el.appendChild(h('div.gd-divider', h('div.gd-head'), h('div.gd-divider-body', svg)));
        el.appendChild(paneEl('right', [head(src.right)], pane('R'), 'R', true));
      } else if (mode === 'unified') {
        el.appendChild(paneEl('uni', [head(src.left), head(src.right, true)], unified(), 'U', true));
      } else el.appendChild(paneEl('solo', [head(src.right || src.left)], pane('R'), 'R', true));
      const same = !solo && !off ? L.sameNote(src, m) : null;
      if (same) el.appendChild(h('div.gd-note', { role: 'status' }, same));
      return el;
    }

    // ---------------------------------------------------------------- scrolling
    function setTop(key, y) {
      const el = scr[key];
      if (!el) return;
      const before = el.scrollTop;
      el.scrollTop = Math.max(0, Math.round(y));
      if (el.scrollTop !== before) skip[key] = true;      // the scroll event this causes is ours, not the user's
    }
    /** The line of the other side that stands for `line` (SyncScrollSupport's transfer). */
    function transfer(side, line) {
      const left = side === 'L';
      for (let i = 0; i < m.blocks.length; i++) {
        const k = m.blocks[i], s0 = left ? k.a0 : k.b0, s1 = left ? k.a1 : k.b1, o0 = left ? k.b0 : k.a0, o1 = left ? k.b1 : k.a1;
        if (line >= s0 && line < s1) return o0 + Math.min(line - s0, o1 - o0);
      }
      return left ? m.b.length : m.a.length;
    }
    /** Synchronized scrolling: the line a third down the scrolled pane sits at the same height in the other one.
        Aligned panes ("Align Changes") have the same rows, so they scroll as one. */
    function follow(master) {
      const other = master === 'L' ? 'R' : 'L', from = scr[master], to = scr[other], rows = lay[master];
      if (!rows.length) return;
      if (lay.align) {
        const left = to.scrollLeft;
        setTop(other, from.scrollTop);
        to.scrollLeft = from.scrollLeft;
        if (to.scrollLeft !== left) skip[other] = true;
        return;
      }
      const pivot = Math.floor(from.clientHeight / 3), y = from.scrollTop + pivot;
      let ri = Math.min(rows.length - 1, Math.floor(y / LH));
      while (ri > 0 && rows[ri].pad) ri--;                      // an aligned change's empty row stands for the line above it
      const row = rows[ri];
      const line = row.fold ? row.fold[master === 'L' ? 'a' : 'b'][0] : row.pad ? 0 : row.line;
      const before = to.scrollLeft;
      setTop(other, lay.lineRow[other][transfer(master, line)] * LH - pivot + (y % LH));
      to.scrollLeft = from.scrollLeft;
      if (to.scrollLeft !== before) skip[other] = true;
    }
    function positions() {
      const out = {};
      Object.keys(scr).forEach((k) => { out[k] = scr[k].scrollTop; });
      return out;
    }
    function onScroll(key) {
      if (scr[key] && scr[key].clientHeight) saved = positions();
      if (skip[key]) skip[key] = false;
      else if (mode === 'side' && settings.sync) { master = key; follow(key); }
      schedule();
    }
    function schedule() {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; links(); });
    }

    /** The shapes in the strip between the panes: one per changed block, and the wave of each folded stretch. */
    function links() {
      if (!svg || !scr.L || !c.root) return;
      const P = Git.diffParts, H = scr.L.clientHeight, tl = scr.L.scrollTop, tr = scr.R.scrollTop, row = lay.lineRow;
      let out = '';
      if (settings.highlight !== 'none') {
        m.blocks.forEach((k, bi) => {
          if (k.type === 'eq') return;
          const br = lay.blockRow[bi];
          const a0 = br.L[0] * LH - tl, a1 = br.L[1] * LH - tl, b0 = br.R[0] * LH - tr, b1 = br.R[1] * LH - tr;
          if (Math.max(a1, b1) < -2 || Math.min(a0, b0) > H + 2) return;
          out += '<path class="' + k.type + '" d="' + P.trapezium(DIVIDER, a0, a1, b0, b1) + '"/>';
        });
      }
      lay.folds.forEach((f) => {
        const y1 = row.L[f.a[0]] * LH - tl + LH / 2, y2 = row.R[f.b[0]] * LH - tr + LH / 2;
        if (Math.max(y1, y2) > -LH && Math.min(y1, y2) < H + LH) out += '<path class="wave" d="' + P.wave(DIVIDER, y1, y2) + '"/>';
      });
      svg.setAttribute('height', H);
      svg.setAttribute('viewBox', '0 0 ' + DIVIDER + ' ' + Math.max(1, H));
      svg.innerHTML = out;
    }
    /** Marks of the changes along the scrollbar (the error stripe). */
    function stripes() {
      const key = scr.U ? 'U' : 'R', el = scr[key], host = c.root && c.root.querySelector('.gd-stripe');
      if (!el || !host) return;
      const total = Math.max(el.scrollHeight, 1);
      let out = '';
      if (settings.highlight !== 'none' || solo) {
        m.blocks.forEach((k, bi) => {
          if (k.type === 'eq') return;
          const br = lay.blockRow[bi].R;
          const top = (key === 'U' ? lay.blockRowU[bi] : br[0]) * LH;
          const size = (key === 'U' ? (k.a1 - k.a0) + (k.b1 - k.b0) : br[1] - br[0]) * LH;
          out += '<i class="' + k.type + '" style="top:' + (top / total * 100).toFixed(2) + '%;height:' + (size / total * 100).toFixed(2) + '%"></i>';
        });
      }
      host.innerHTML = out;
    }

    // ---------------------------------------------------------------- differences
    function mark() {
      if (!c.root) return;
      const bi = cur >= 0 ? m.changes[cur] : -1;
      c.root.querySelectorAll('.gd-gl.cur').forEach((el) => el.classList.remove('cur'));
      if (bi >= 0) c.root.querySelectorAll('.gd-gl[data-b="' + bi + '"]').forEach((el) => el.classList.add('cur'));
      nav();
    }
    /** Makes difference `i` the current one, a third down the view. `lazy` leaves the view alone when the block already shows. */
    function goTo(i, lazy) {
      cur = i;
      const bi = m.changes[i], k = m.blocks[bi], br = lay.blockRow[bi];
      const spans = mode === 'side' ? [['R', br.R[0], br.R[1]], ['L', br.L[0], br.L[1]]]
        : [['U', lay.blockRowU[bi], lay.blockRowU[bi] + (k.a1 - k.a0) + (k.b1 - k.b0)]];
      const shows = ([key, from, to]) => from * LH >= scr[key].scrollTop && to * LH <= scr[key].scrollTop + scr[key].clientHeight;
      if (!lazy || !spans.every(shows)) spans.forEach(([key, from]) => setTop(key, from * LH - Math.floor(scr[key].clientHeight / 3)));
      mark();
      schedule();
    }
    function hint(text) {
      const old = c.root.querySelector('.gd-hint');
      if (old) old.remove();
      clearTimeout(hintTimer);
      if (!text) return;
      const el = h('div.gd-hint', { role: 'status' }, text);
      c.root.appendChild(el);
      hintTimer = setTimeout(() => { el.remove(); again = 0; }, 2600);
    }
    /** Next / previous difference; past the last one a second press goes on to the next changed file. */
    function step(d) {
      const i = cur + d;
      if (!solo && i >= 0 && i < m.changes.length) { again = 0; hint(null); goTo(i); return; }
      if (!hasFile(d)) return;
      if (again === d) { again = 0; hint(null); fileStep(d); return; }
      again = d;
      hint(t(d > 0 ? 'Press again to go to the next file' : 'Press again to go to the previous file'));
    }
    /** The » arrow: the work tree file gets the block's left lines (or, `append`, the left lines below its own), written
        over exactly the content this tab shows (changes.write refuses when the file changed meanwhile). */
    function revert(bi, append) {
      const k = m.blocks[bi];
      if (!k || k.type === 'eq' || !src.revert || !src.left || !src.right) return null;
      const text = Git.changesModel.writeBack(m, k, append ? 'append' : 'revert', src.right, src.left);
      return Git.actions.writeBlock(c.spec.path, text, Git.changesModel.expectOf(src.right.text), append ? 'append' : 'revert');
    }
    c.revert = revert;

    // ---------------------------------------------------------------- loading
    const slot = Git.content.slot();
    let shownKey = null;
    const specKey = (spec) => [spec.kind, spec.path, spec.commit || '', spec.parent || '', spec.id || ''].join('\u0000');
    /** Reads the spec's contents again (cached ones answer at once) and draws when they changed or the spec is new. */
    function reload(keep) {
      if (!c.root) return;
      if (!alive(c.spec)) { close(); return; }
      const key = specKey(c.spec);
      c.dirty = false;
      slot.run(() => load(c.spec), {
        loading: () => { if (shownKey !== key && c.root) { Git.clear(c.root); c.root.appendChild(Git.content.loading()); src = null; } },
        done: (next) => {
          if (!c.root) return;
          if (!next) { close(); return; }
          if (src && shownKey === key && signature(next) === sig) {
            if (files().join('\n') !== listed) { c.root.replaceChild(toolbar(), c.root.firstChild); nav(); }
            return;
          }
          src = next;
          shownKey = key;
          draw(keep);
        },
        error: (e) => { if (!c.root) return; Git.clear(c.root); c.root.appendChild(Git.content.failed(e)); src = null; shownKey = null; },
      });
    }

    // ---------------------------------------------------------------- drawing
    /** `keep`: 'scroll' keeps the scroll offsets (the content changed under the reader), 'cur' returns to the current difference. */
    function draw(keep) {
      if (!c.root) return;
      if (!src) { reload(keep); return; }
      const P = Git.diffParts;
      const old = keep === 'scroll' && placed ? positions() : keep === 'scroll' ? saved : null;
      sig = signature(src); c.dirty = false;
      LH = parseFloat(getComputedStyle(c.root).getPropertyValue('--gd-line')) || 18;
      forced = narrow();
      solo = !src.left ? 'ins' : !src.right ? 'del' : null;
      const only = solo ? src.right || src.left : null;
      let note = noteFor(src);
      if (!note && !src.left && !src.right) note = t('Cannot find file: {0}', c.spec.path);
      if (!note) {
        try {
          m = P.compute(solo ? '' : lf(src.left), solo ? lf(only) : lf(src.right), { ignore: solo ? 'none' : settings.ignore, highlight: settings.highlight });
        } catch (e) {
          if (!e || e.code !== 'too_big') throw e;
          note = t('Unable to calculate diff. File is too big and there are too many changes.');
        }
      }
      if (note) {
        m = { a: [], b: [], blocks: [], changes: [], note: true };   // a message instead of the diff: the counter claims nothing
        cur = -1; scr = {}; svg = null;
        Git.clear(c.root);
        c.root.setAttribute('aria-label', src.title);
        c.root.appendChild(toolbar());
        c.root.appendChild(h('div.gd-body.gd-msgbody', h('div.gd-msg', { role: 'status' }, note)));
        nav();
        return;
      }
      c.root.classList.toggle('gd-plain', !!src.plain);
      if (solo) m.blocks.forEach((k) => { k.type = solo; });
      if (src.plain) m.changes = [];
      off = !solo && settings.highlight === 'none';       // "Do not highlight": nothing is marked, so there is nothing to step through
      if (off) m.changes = [];
      mode = solo ? 'solo' : settings.mode === 'unified' || forced ? 'unified' : 'side';
      lay = P.layout(m, { collapse: settings.collapse && !solo && !off, context: CONTEXT, expanded, align: !!settings.align && mode === 'side' });
      syn = { a: solo ? [] : P.syntax(m.a, src.left.path || c.spec.path), b: P.syntax(m.b, c.spec.path || (only || src.right).path) };
      if (solo || !m.changes.length) cur = -1; else if (keep) cur = Math.min(Math.max(cur, 0), m.changes.length - 1);
      Git.clear(c.root);
      c.root.setAttribute('aria-label', src.title);
      c.root.appendChild(toolbar());
      c.root.appendChild(body());
      placed = false;
      saved = old;
      place(keep);
    }
    /** Room below the last line of both panes (side by side, when the file does not fit the view): the same on both sides, so their
        ends meet at the bottom, and enough for the last difference to stand a third down the view. At least IntelliJ's 5 lines. */
    function fit() {
      if (mode !== 'side') return;
      const H = scr.R.clientHeight, third = Math.floor(H / 3), hL = lay.L.length * LH, hR = lay.R.length * LH;
      const last = m.changes.length ? lay.blockRow[m.changes[m.changes.length - 1]] : null;
      let pad = 0;
      if (Math.max(hL, hR) > H) {
        pad = 5 * LH;
        if (last) pad = Math.max(pad, last.L[0] * LH - third - hL + H, last.R[0] * LH - third - hR + H);
        pad = Math.min(pad, H - third);
      }
      [scr.L, scr.R].forEach((el) => el.style.setProperty('--gd-pad', pad + 'px'));
    }
    /** Scroll positions need a laid-out tab; a hidden one is placed when it shows. */
    function place(keep) {
      const main = scr.R || scr.U;
      nav();
      if (!main || !main.clientHeight) return;
      placed = true;
      fit();
      if (keep === 'scroll' && saved) {
        Object.keys(scr).forEach((k) => { if (saved[k] != null) setTop(k, saved[k]); });
        // the offsets were kept, the rows under them may not have been (a line added above the view, a fold opened):
        // the other pane follows the reader's again, as a scroll would make it
        if (mode === 'side' && settings.sync && scr[master]) follow(master);
        mark();
      }
      else if (!solo && m.changes.length) goTo(start === 'last' ? m.changes.length - 1 : Math.max(cur, 0), !keep);
      start = 'first';
      stripes();
      links();
    }
    function resized() {
      const main = scr.R || scr.U;
      if (!main) return;
      if (src && c.root.clientWidth > 0 && narrow() !== forced) { draw('cur'); return; }   // crossed the page's narrow width
      if (!main.clientHeight) { placed = false; return; }
      if (!placed) place(saved ? 'scroll' : null); else { fit(); stripes(); schedule(); }
    }
    function close() {
      if (Git.tabs) Git.tabs.close(c.id);
    }

    function onKey(e) { Git.diffBar.key(api, e); }
    function onContext(e) { if (src && m && !Git.diffBar.contextMenu(api, e)) e.preventDefault(); }
    function onClick(e) {
      const fold = e.target.closest('[data-fold]'), rev = e.target.closest('[data-revert]');
      if (fold) { expanded.add(fold.dataset.fold); draw('scroll'); }
      else if (rev) revert(+rev.dataset.revert, (e.metaKey || e.ctrlKey) && !!rev.closest('.gd-pane.left'));
    }
    /** ⌘ / Ctrl held: the » arrows show as Append. */
    function modKey(e) { if (c.root) c.root.classList.toggle('gd-append', !!(e.metaKey || e.ctrlKey)); }
    function release() {
      subs.forEach((stop) => stop());
      subs = [];
      if (ro) { ro.disconnect(); ro = null; }
      window.removeEventListener('resize', resized);
      window.removeEventListener('keydown', modKey, true);
      window.removeEventListener('keyup', modKey, true);
      clearTimeout(hintTimer);
      placed = false;
      c.root = null;
    }

    c.set = function (spec) {
      const same = c.spec && spec.kind !== 'texts' && c.spec.kind === spec.kind && c.spec.path === spec.path && c.spec.commit === spec.commit;
      c.spec = spec;
      c.dirty = true;
      if (!same) { cur = -1; expanded = new Set(); start = spec.enter || 'first'; saved = null; again = 0; }
      c.same = !!same;
    };
    c.redraw = () => reload(c.same ? 'scroll' : null);
    c.settle = resized;
    c.focus = () => { if (c.root) c.root.focus({ preventScroll: true }); };
    /** The repository or a file on disk changed: closes the tab when its file is no longer changed, redraws when the
        contents differ (work tree contents were dropped from the cache by the store; committed ones never change). */
    c.update = function (ev) {
      if (!c.root) return;
      if (ev && ev.paths && c.spec.path && ev.paths.indexOf(c.spec.path) < 0 && (!c.spec.kind || c.spec.kind !== 'local')) return;
      reload('scroll');
    };
    c.mount = function (el) {
      release();                                          // the test page mounts again on every open; the shell mounts once
      tabs.set(id, c);
      if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
      c.root = h('div.g-root.g-diff', { tabIndex: 0, role: 'group' });
      c.root.addEventListener('keydown', onKey);
      c.root.addEventListener('click', onClick);
      c.root.addEventListener('contextmenu', onContext);
      Git.clear(el);
      el.appendChild(c.root);
      const live = (ev) => { if (c.spec && (c.spec.kind === 'local' || c.spec.kind === 'file')) c.update(ev); };
      subs = [Git.on('change', (ev) => { if (ev && ev.reason === 'log') return; live(null); }), Git.on('files', live),
        Git.on('diff-settings', (name) => { draw(name === 'sync' ? 'scroll' : 'cur'); if (name === 'sync' && settings.sync && mode === 'side' && scr.R) follow('R'); }),
        Git.on('skin', () => draw('cur')), Git.on('look', () => draw('cur')), Git.on('lang', () => { if (src) src.title = titleOf(c.spec); draw('scroll'); }),
        Git.on('included', () => { const box = c.root && c.root.querySelector('.gd-include input'); if (box && Git._commit) box.checked = Git._commit.S.included.has(c.spec.path); })];
      window.addEventListener('resize', resized);
      window.addEventListener('keydown', modKey, true);
      window.addEventListener('keyup', modKey, true);
      if (window.ResizeObserver) { ro = new ResizeObserver(resized); ro.observe(c.root); }
      src = null; shownKey = null;
      reload(c.same ? 'scroll' : null);
    };
    c.unmount = function () {
      release();
      if (tabs.get(id) === c) tabs.delete(id);
    };
    return c;
  }

  Git.diffTab = {
    /** Opens (or brings forward and refills) the diff tab for `spec`. */
    open(spec) {
      if (spec && spec.kind === 'file' && Git.fileView) return Git.fileView.open(spec.path, { line: spec.line });   // the read-only file view
      if (!spec || !alive(spec) || !Git.tabs) return null;
      const id = tabId(spec);
      let c = tabs.get(id);
      if (!c) { c = createTab(id); tabs.set(id, c); }
      c.set(spec);
      // `plain`: a diff of a commit's file or a local change (its heads name it; pages.js shows no extra title line for it)
      Git.tabs.open({ id, title: titleOf(spec), icon: spec.kind === 'file' ? 'fileTypes/text' : 'vcs/diff', plain: spec.kind === 'commit' || spec.kind === 'local',
        mount: (el) => c.mount(el), unmount: () => c.unmount() });
      if (c.dirty && c.root) c.redraw();                  // the tab area keeps a mounted tab and only brings it forward
      else c.settle();                                    // … and mounts a new one before it shows it
      if (!spec.preview) c.focus();                       // a preview (ui/git/centre.js) leaves the focus in the list
      return id;
    },
    /** The controller of an open tab (tests, other views): { spec, root } */
    tab: (id) => tabs.get(id) || null,
    settings,
    set: setting,
  };
})();
