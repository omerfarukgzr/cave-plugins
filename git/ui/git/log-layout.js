/* The Log's three arrangements, chosen from the size of the Log root (L.arrangement in log-logic.js).
   - wide: IntelliJ's three columns (Branches | Commits | Changed Files over Commit Details); log.js lays it out.
   - medium (root class `medium`): the commits on top, under them a bottom pane with Changed Files at the left and
     Commit Details at the right; one splitter sets the bottom pane's height, one the files' width.
   - narrow (root class `narrow`): the commits on top (one-line rows, a compact date instead of Author and Date), under
     them Commit Details (their content's height, at most 58 % of the pane, until the line under them is dragged) over
     Changed Files; one splitter sets the bottom pane's height, one the details' height. Until one of the two is
     dragged the bottom pane takes its content's height while that fits (about one row over its share at most), so a
     list never scrolls a few pixels; dragged, the pane is as tall as it was dragged. A double click on a line gives
     its automatic size back.
   In narrow and medium the Branches pane is a drawer over the Log from the left, opened by the toolbar's Branches
   button (#gl-branches-open); it closes on the scrim, Escape, the pane's hide button and whenever the pane changes the
   Log. Opening or closing it never changes the wide arrangement's "show branches" choice (opts.branches).
   L.createLayout({ root, pane, right, files, details, left() }) → { update() → changed, pending(), mode(), stacked(),
   open(), close(focus), isOpen(), button }
   Until the root has had a size it carries the class `gl-unsized` (not painted) and no arrangement is chosen. */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = Git.t;
  const L = (Git.logUI = Git.logUI || {});
  const MIN_BOTTOM = 110, MIN_COMMITS = 150;       // the bottom pane and the commits above it keep at least this much
  const MIN_FILES = 120, MIN_DETAILS = 160;        // medium: the files' width and what it leaves to the details
  const MIN_DHEIGHT = 60, MIN_FHEIGHT = 90;        // narrow, once dragged: the details' height and what the files keep
  const SHARE = { medium: 0.38, narrow: 0.42 };    // the bottom pane's default share of the root's height
  const FILES = 1 / 2.25;                          // medium: files : details = 1 : 1.25
  const prefs = () => (Git.host && Git.host.prefs) || { get: (k, d) => d, set() {} };

  /** The wide arrangement's side panes. What each pane WANTS (the splitter's size, stored under its old key, else a
      default) is kept apart from what it GETS: every fit() computes the widths from the wanted ones for the root's width
      now, so a pane that had to give way grows back when there is room. Defaults: the right pane 26 % of the root
      (300–460 px), the branches pane 231 px. Minimums: right 280 px from a 1100 px root, 240 px from 960, 170 px
      below (the workbench's short wide Log); branches 150 px; a smaller stored size is raised. When the wanted sizes do
      not fit, the commits keep half of the root (at least 260 px): the branches pane gives way first, then the right one.
      L.wideSizes({ root, pane, right, strip, shown() (the branches pane is shown), onResize() }) → { split, fit(), sizes() } */
  L.wideSizes = function (o) {
    const { root, pane, right, strip } = o;
    const want = { branches: 0, right: 0 };                 // 0: the default
    const minRight = (W) => (W >= 1100 ? 280 : W >= 960 ? 240 : 170), MIN_BRANCHES = 150;
    const keep = (W) => Math.max(260, Math.round(W / 2));
    // the splitters' own minimums follow the root's width (Git.splitter reads `min` at every step)
    const bOpts = { target: pane, edge: 'right', min: MIN_BRANCHES, key: 'log-branches',
      max: () => (root.clientWidth ? Math.max(MIN_BRANCHES, root.clientWidth - right.offsetWidth - keep(root.clientWidth)) : 4000),
      onResize: (px) => { want.branches = px; o.onResize(); } };
    const rOpts = { target: right, edge: 'left', min: 170, key: 'log-right',
      max: () => (root.clientWidth ? Math.max(rOpts.min, root.clientWidth - (o.shown() ? pane.offsetWidth : 0) - keep(root.clientWidth)) : 4000),
      onResize: (px) => { want.right = px; o.onResize(); } };
    const split = Git.splitter(bOpts);
    root.insertBefore(split, strip);
    root.insertBefore(Git.splitter(rOpts), right);
    let got = { branches: 0, right: 0 };
    function fit() {
      const W = root.clientWidth;
      if (!W) return;
      const minR = (rOpts.min = minRight(W));
      let r = Math.max(minR, want.right || Math.min(460, Math.max(300, Math.round(W * 0.26))));
      let b = o.shown() ? Math.max(MIN_BRANCHES, want.branches || 231) : 0;
      const other = (o.shown() ? split.offsetWidth : strip.offsetWidth) + 1;   // the strip or the branches splitter, the right splitter
      let over = b + r + other + keep(W) - W;
      if (over > 0 && b) { const give = Math.min(over, b - MIN_BRANCHES); b -= give; over -= give; }
      if (over > 0) r -= Math.min(over, r - minR);
      if (b) { pane.style.width = b + 'px'; pane.style.flex = '0 0 auto'; }
      right.style.width = r + 'px';
      right.style.flex = '0 0 auto';
      got = { branches: b, right: r };
    }
    return { split, fit, sizes: () => Object.assign({ want: Object.assign({}, want) }, got) };
  };

  L.createLayout = function (o) {
    const { root, pane, right } = o;
    let mode = null, open = false;
    const sizes = { medium: 0, narrow: 0, files: 0, details: 0 };   // what the splitters were dragged to (0: the default)
    // Until the root has had a size once, no arrangement is guessed and nothing is painted (a frame that mounts the Log
    // before it is laid out, as Orca's re-created panel frame does, would otherwise show the wide one first).
    root.classList.add('gl-unsized');
    const stacked = () => mode === 'narrow' || mode === 'medium';

    // ---- splitters: a handle over the bottom pane per arrangement (each remembers its own height), one between the
    // files and the details in medium. They size CSS variables of the root, not the panes' inline styles, so the wide
    // arrangement's own sizes (log-right, log-files) stay what they are.
    // A line that was dragged stays where it was put, and a double click on it gives its default back.
    const proxy = (el) => ({ style: {}, getBoundingClientRect: () => el.getBoundingClientRect() });
    const bottomMax = () => (root.clientHeight ? Math.max(MIN_BOTTOM, root.clientHeight - MIN_COMMITS) : 4000);
    // The narrow pane's height was stored under `log-bottom-narrow` while a dragged height was only a share its content
    // was fitted into: what is stored there is not what was shown, so it is not read.
    const KEY = { medium: 'log-bottom-medium', narrow: 'log-bottom-narrow-fixed' };
    const bottom = (which) => {
      const split = Git.splitter({ target: proxy(right), edge: 'top', min: MIN_BOTTOM, max: bottomMax, key: KEY[which],
        onResize: (px) => { sizes[which] = px; if (mode === which) place(); },
        onReset: () => { sizes[which] = 0; if (mode === which) place(); } });
      split.classList.add('gl-hsplit', 'gl-hsplit-' + which);
      return split;
    };
    root.insertBefore(bottom('medium'), right);
    root.insertBefore(bottom('narrow'), right);
    if (o.files && o.details) {
      const fsplit = Git.splitter({ target: proxy(o.files), edge: 'right', min: MIN_FILES,
        max: () => (right.clientWidth ? Math.max(MIN_FILES, right.clientWidth - MIN_DETAILS) : 4000), key: 'log-files-medium',
        onResize: (px) => { sizes.files = px; if (mode === 'medium') place(); },
        onReset: () => { sizes.files = 0; if (mode === 'medium') place(); } });
      fsplit.classList.add('gl-fsplit');
      right.insertBefore(fsplit, o.files.nextSibling);
      // narrow: the line between Commit Details (above) and Changed Files. Not dragged yet: the details take their
      // content's height (at most 58 %); dragged: that height, kept inside the minimums.
      const dsplit = Git.splitter({ target: proxy(o.details), edge: 'bottom', min: MIN_DHEIGHT,
        max: () => (right.clientHeight ? Math.max(MIN_DHEIGHT, right.clientHeight - MIN_FHEIGHT - 1) : 4000), key: 'log-details-narrow',
        // A pane still sized by its content would follow the details' new height: the line would stay where it is and
        // the pane's top would move instead. So the pane keeps the height it has when this line is first moved.
        onStart: () => {
          if (mode !== 'narrow' || sizes.narrow) return;
          sizes.narrow = Math.round(right.getBoundingClientRect().height);
          prefs().set('size.' + KEY.narrow, sizes.narrow);
        },
        onResize: (px) => { sizes.details = px; if (mode === 'narrow') place(); },
        onReset: () => {
          sizes.details = 0;
          if (mode !== 'narrow') return;
          place();
          // Details dragged shorter than their text had a scrollbar, and beside it the text wrapped into more lines.
          // WebKit drops the scrollbar when the height is free again but keeps the lines as they were wrapped beside
          // it (a line too many, blank space under the text): the box is laid out anew, then placed for that height.
          const d = o.details;
          d.style.display = 'none';
          void d.offsetHeight;
          d.style.display = '';
          place();
        } });
      dsplit.classList.add('gl-dsplit');
      right.insertBefore(dsplit, o.details);
    }
    // ---- narrow: until its line is dragged, the bottom pane takes its content's height. A Changed Files list that
    // overflowed its share by a few pixels scrolled those few pixels and stopped, which felt stuck. So while the
    // details and the whole list fit in the default share plus about one row, and in the room above the commits'
    // minimum, the pane is as tall as its content (.gl-fit: the details show whole too); a list longer than that keeps
    // the share and scrolls by more than a row. An empty list (nothing selected yet) keeps the share. A dragged pane
    // (sizes.narrow) is exactly as tall as it was dragged: sized by its content, its line did not follow the pointer.
    const tree = o.files ? o.files.querySelector('.gl-ftree') : null;
    const borders = (el) => el.offsetHeight - el.clientHeight;
    /** The bottom pane's content height in narrow (0: not known, keep the share). */
    function content() {
      const inner = tree && tree.querySelector(':scope > .g-vlist');
      if (!inner || !inner.offsetHeight || o.files.hidden) return 0;
      const cs = getComputedStyle(tree);
      let c = o.files.offsetHeight - tree.offsetHeight + inner.offsetHeight + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + borders(tree);
      const d = o.details;
      if (d && !d.hidden && !right.classList.contains('no-details')) {
        const split = right.querySelector(':scope > .gl-dsplit');
        // dragged: the details keep that height and the files at least their minimum
        c = sizes.details ? Math.max(c, MIN_FHEIGHT + 1) + sizes.details : c + d.scrollHeight + borders(d);
        if (split) c += split.offsetHeight;
      }
      return Math.ceil(c + borders(right));
    }
    const rowH = () => (tree && parseFloat(getComputedStyle(tree).getPropertyValue('--g-row'))) || 24;
    if (tree && typeof MutationObserver === 'function') {
      // What changes the content's height: the list's row count (vlist.js sets its inner height), the details drawn
      // for a new selection, a note shown. Placed in the next frame, once per frame. Mutations, not a ResizeObserver
      // on the content: resizing the pane from such a callback resizes what it observes (a scrollbar comes or goes),
      // which the browser reports as a ResizeObserver loop. A change of width comes through the Log's own observer.
      let queued = 0;
      const later = () => {
        if (mode !== 'narrow' || queued) return;
        queued = requestAnimationFrame(() => { queued = 0; if (mode === 'narrow') place(); });
      };
      const watch = new MutationObserver(later);
      const inner = tree.querySelector(':scope > .g-vlist');
      if (inner) watch.observe(inner, { attributes: true, attributeFilter: ['style'] });
      watch.observe(o.files, { attributes: true, subtree: false, attributeFilter: ['hidden', 'class'] });
      for (const c of o.files.children) if (c !== tree) watch.observe(c, { attributes: true, attributeFilter: ['hidden'] });
      if (o.details) watch.observe(o.details, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
    }

    /** The sizes of the stacked arrangements as CSS variables, kept inside the minimums for the root's size now. */
    function place() {
      if (!stacked()) return;
      const H = root.clientHeight;
      let bottom = 0, fit = false;
      if (H) {
        const want = sizes[mode] || Math.round(H * SHARE[mode]);
        bottom = Math.max(MIN_BOTTOM, Math.min(want, H - MIN_COMMITS));
        if (mode === 'narrow' && !sizes.narrow) {
          const c = content();
          fit = c > 0 && c <= bottom + rowH() + 8 && c <= Math.max(MIN_BOTTOM, H - MIN_COMMITS);
          if (fit) bottom = Math.max(MIN_BOTTOM, c);
        }
        root.style.setProperty('--gl-bottom', bottom + 'px');
      }
      root.classList.toggle('gl-fit', fit);
      const W = right.clientWidth;
      if (mode === 'medium' && W) {
        const want = sizes.files || Math.round(W * FILES);
        root.style.setProperty('--gl-files-w', Math.max(MIN_FILES, Math.min(want, W - MIN_DETAILS)) + 'px');
      }
      root.classList.toggle('gl-dsized', mode === 'narrow' && sizes.details > 0);
      // the pane's inner height as just set (reading it back would give the height before this call)
      const RH = bottom ? bottom - borders(right) : right.clientHeight;
      // narrow, a list too long to fit: the details keep at most 58 % of the pane, unless they are only a little over
      // that (about a row) and the files keep their minimum; then they show whole instead of scrolling a few pixels
      let dmax = '';
      const d = o.details;
      if (mode === 'narrow' && !fit && !sizes.details && RH && d && !d.hidden) {
        const D = d.scrollHeight + borders(d), cap = 0.58 * RH;
        const split = right.querySelector(':scope > .gl-dsplit');
        if (D > cap && D <= cap + rowH() + 8 && RH - D - (split ? split.offsetHeight : 0) >= MIN_FHEIGHT) dmax = Math.ceil(D) + 'px';
      }
      // .gl-dwhole: no scrollbar either (D was measured with one; the text is not taller without it). A scrollbar that
      // goes away only after layout would resize the files a second time in the frame: a ResizeObserver loop.
      root.classList.toggle('gl-dwhole', !!dmax);
      if (dmax) root.style.setProperty('--gl-details-max', dmax); else root.style.removeProperty('--gl-details-max');
      if (mode === 'narrow' && sizes.details && RH) {
        root.style.setProperty('--gl-details-h', Math.max(MIN_DHEIGHT, Math.min(sizes.details, RH - MIN_FHEIGHT - 1)) + 'px');
      }
    }

    // ---- the Branches drawer
    const scrim = h('div.gl-scrim', { hidden: true, onclick: () => close(true) });
    root.appendChild(scrim);
    const button = Git.toolBtn({ icon: 'branch', title: t('Branches'), label: t('Branches'), id: 'gl-branches-open', onClick: () => (open ? close(true) : show()) });
    button.classList.add('gl-bopen');
    button.setAttribute('aria-expanded', 'false');
    function setOpen(on) {
      open = !!on && stacked();
      root.classList.toggle('drawer', open);
      scrim.hidden = !open;
      pane.inert = stacked() && !open;            // closed: neither visible nor focusable
      button.setAttribute('aria-expanded', String(open));
    }
    function show() {
      if (!stacked()) return;
      setOpen(true);
      const input = pane.querySelector('.gl-bsearch input');
      if (input) input.focus();
    }
    /** Closes the drawer; `focus`: the focus goes back to the Branches button. */
    function close(focus) {
      if (!open) return;
      const inside = pane.contains(document.activeElement);
      setOpen(false);
      if ((focus || inside) && button.isConnected) button.focus();
    }
    root.addEventListener('keydown', (e) => {
      if (!open || e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    });

    /** Picks the arrangement for the root's size now; returns true when it changed. */
    function update() {
      const prev = mode, w = root.clientWidth, h = root.clientHeight;
      if (!prev && !(w > 0 && h > 0)) return false;           // never laid out yet: no guess
      root.classList.remove('gl-unsized');
      mode = L.arrangement(w, h, prev);
      const changed = mode !== prev;
      if (changed) {
        root.classList.toggle('narrow', mode === 'narrow');
        root.classList.toggle('medium', mode === 'medium');
        setOpen(false);                            // the drawer starts closed in every arrangement
        if (!stacked()) pane.inert = false;
      }
      // the button lives at the left end of the commits toolbar, before the search field, and only while stacked
      const left = o.left();
      if (stacked() && left && button.parentNode !== left) left.insertBefore(button, left.firstChild);
      else if (!stacked() && button.parentNode) button.remove();
      place();
      return changed;
    }

    /** True when the root's size now asks for another arrangement than the one shown (or for the first one): the Log's
        ResizeObserver then applies it in the same callback, before that frame is painted. */
    function pending() {
      const w = root.clientWidth, h = root.clientHeight;
      if (!mode) return w > 0 && h > 0;
      return L.arrangement(w, h, mode) !== mode;
    }

    return { update, pending, button, mode: () => mode, stacked, isOpen: () => open, open: show, close };
  };
})();
