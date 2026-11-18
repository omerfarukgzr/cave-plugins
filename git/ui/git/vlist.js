/* Git: a virtual list for fixed-height rows. Only the rows in view (plus `overscan` above and below) exist in the DOM;
   a spacer gives the scroll container the full height, so 100 000 rows scroll like 100 000 rows.
     const list = Git.vlist({ el, rowHeight, count: () => n, render: (i) => element, overscan })
   `el` is the scroll container (overflow: auto, a height of its own, e.g. a flex child with min-height: 0). Rows are
   drawn in normal flow inside one moving window, so row CSS (margins, flex, :hover) works as in a plain list.
   `rowHeight` is a number or a function (read again on refresh and resize). `render(i)` returns a new element.
   `tall` (optional) `() => [index, height] | null`: one row of another height (an inline editor that pushes the rows
   below it down, as IntelliJ's Rebasing Commits editor does); read again on refresh.
     list.refresh()                       count or contents changed: re-reads count, redraws the rows in view
     list.update(i)                       redraws row i if it is in the DOM
     list.scrollTo(i, { align })          'nearest' (default) | 'start' | 'center' | 'end'; waits for a size if hidden
     list.visibleRange()                  { from, to }: rows intersecting the viewport, `to` exclusive
     list.rendered()                      { from, to }: rows in the DOM
     list.rowElement(i), list.each(fn(element, i))   rows in the DOM
     list.destroy()
   Neither refresh() nor update() moves the scroll position or takes focus; focus that was inside a row that goes
   away moves to `el` when `el` is focusable. No dependencies. */
(function () {
  'use strict';
  const Git = (window.Git = window.Git || {});

  Git.vlist = function (o) {
    const el = o.el;
    const overscan = o.overscan == null ? 12 : o.overscan;
    const inner = document.createElement('div');
    inner.className = 'g-vlist';
    inner.style.position = 'relative';
    const win = document.createElement('div');
    win.className = 'g-vlist-win';
    win.style.cssText = 'position: absolute; top: 0; left: 0; right: 0;';
    inner.appendChild(win);
    el.appendChild(inner);

    const mounted = new Map(); // index -> element; always one contiguous range [from, to)
    let from = 0, to = 0, count = 0, rh = 0, offset = 0, pending = null, dead = false;
    // One row may be taller than the others (`o.tall() -> [index, height] | null`: an inline editor that pushes the
    // rows below it down); every other row has `rowHeight`.
    let ti = -1, ex = 0;
    /** Top of row k inside the list, and the row at height y. */
    const top = (k) => k * rh + (ti >= 0 && k > ti ? ex : 0);
    const rowAt = (y) => (ti < 0 || y < ti * rh ? Math.floor(y / rh) : y < ti * rh + rh + ex ? ti : Math.floor((y - ex) / rh));
    const heightOf = (k) => rh + (k === ti ? ex : 0);

    function measure() {
      const h = typeof o.rowHeight === 'function' ? o.rowHeight() : o.rowHeight;
      if (h > 0) rh = h; else if (!rh) rh = 24;
      count = Math.max(0, o.count() | 0);
      const tall = o.tall ? o.tall() : null;
      ti = tall && tall[0] >= 0 && tall[0] < count ? tall[0] : -1;
      ex = ti >= 0 ? Math.max(0, (tall[1] || rh) - rh) : 0;
      inner.style.height = count * rh + ex + 'px';
      // where the rows start inside the scrolled content (padding, or something placed before the list)
      // (offsetTop, not client rects: it ignores scrolling and CSS zoom, like scrollTop)
      if (!inner.offsetParent) offset = 0;
      else if (inner.offsetParent === el) offset = inner.offsetTop;
      else offset = inner.offsetTop - el.offsetTop - el.clientTop;
    }
    function wanted() {
      const y = el.scrollTop - offset, view = el.clientHeight || 600; // hidden: draw a screenful so it shows at once
      const first = Math.max(0, rowAt(Math.max(0, y))), last = Math.min(count, rowAt(y + view) + 1);
      return [Math.max(0, Math.min(first, count) - overscan), Math.min(count, Math.max(last, first) + overscan)];
    }
    const holdsFocus = (node) => document.activeElement && document.activeElement !== document.body && node.contains(document.activeElement);
    function drop(node, lost) { if (holdsFocus(node)) lost.focus = true; node.remove(); }
    function restoreFocus(lost) {
      if (lost.focus && el.tabIndex >= 0 && el.isConnected) { try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } }
    }
    function build(a, b) {
      const frag = document.createDocumentFragment();
      for (let i = a; i < b; i++) { const node = o.render(i); mounted.set(i, node); frag.appendChild(node); }
      return frag;
    }
    /** Brings the DOM to the wanted range; `all` redraws every row. */
    function sync(all) {
      if (dead) return;
      const [a, b] = wanted();
      if (!all && a === from && b === to) return;
      const lost = {};
      if (all || b <= from || a >= to) {
        mounted.forEach((node) => drop(node, lost));
        mounted.clear();
        win.appendChild(build(a, b));
      } else {
        for (let i = from; i < Math.min(a, to); i++) { drop(mounted.get(i), lost); mounted.delete(i); }
        for (let i = Math.max(b, from); i < to; i++) { drop(mounted.get(i), lost); mounted.delete(i); }
        if (a < from) win.insertBefore(build(a, from), win.firstChild);
        if (b > to) win.appendChild(build(to, b));
      }
      from = a; to = b;
      win.style.transform = 'translateY(' + top(a) + 'px)';
      restoreFocus(lost);
    }
    function applyPending() {
      if (!pending || !el.clientHeight) return;
      const p = pending;
      pending = null;
      list.scrollTo(p.i, p.opts);
    }

    const onScroll = () => sync(false);
    el.addEventListener('scroll', onScroll, { passive: true });
    const watch = window.ResizeObserver ? new ResizeObserver(() => { if (dead) return; measure(); sync(false); applyPending(); }) : null;
    if (watch) watch.observe(el);

    const list = {
      el, inner,
      refresh() { if (dead) return list; measure(); sync(true); applyPending(); return list; },
      update(i) {
        const old = mounted.get(i);
        if (!old) return list;
        const node = o.render(i), lost = {};
        if (holdsFocus(old)) lost.focus = true;
        win.replaceChild(node, old);
        mounted.set(i, node);
        restoreFocus(lost);
        return list;
      },
      scrollTo(i, opts) {
        if (dead || !count) return list;
        i = Math.max(0, Math.min(count - 1, i | 0));
        const align = (opts && opts.align) || 'nearest';
        if (!el.clientHeight) { pending = { i, opts }; sync(false); return list; }
        const view = el.clientHeight, at = offset + top(i), hi = heightOf(i), cur = el.scrollTop;
        let next = cur;
        if (align === 'start') next = at;
        else if (align === 'end') next = at + hi - view;
        else if (align === 'center') next = at - (view - hi) / 2;
        else if (at < cur) next = at;
        else if (at + hi > cur + view) next = Math.min(at, at + hi - view);
        next = Math.max(0, Math.min(next, el.scrollHeight - view));
        if (next !== cur) el.scrollTop = next;
        sync(false); // the rows are there now, not only after the scroll event
        return list;
      },
      visibleRange() {
        const y = el.scrollTop - offset, view = el.clientHeight;
        if (!count || !view) return { from: 0, to: 0 };
        const a = Math.max(0, rowAt(Math.max(0, y)));
        const end = y + view, b = rowAt(end) + (top(rowAt(end)) < end ? 1 : 0);
        return { from: Math.min(a, count), to: Math.min(count, Math.max(a, b)) };
      },
      rendered: () => ({ from, to }),
      rowElement: (i) => mounted.get(i) || null,
      each(fn) { for (let i = from; i < to; i++) if (mounted.has(i)) fn(mounted.get(i), i); },
      rowHeight: () => rh,
      destroy() {
        if (dead) return;
        dead = true;
        el.removeEventListener('scroll', onScroll);
        if (watch) watch.disconnect();
        mounted.clear();
        inner.remove();
      },
    };
    measure();
    sync(true);
    return list;
  };
})();
