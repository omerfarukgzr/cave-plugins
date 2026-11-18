/* Drag and drop in the Commit view's tree (IntelliJ's ChangesDnDSupport for the two nodes this view has):
     Unversioned Files → Changes   Add to VCS (changes.add, as the menu's Add to VCS)
     Changes → Unversioned Files   an added file leaves the index and stays on disk (changes.unversion); taken only when
                                   every dragged file is newly added (A §3.7.1: an added file goes back to
                                   Unversioned Files by Rollback without deleting; A and D say nothing about this drop)
   Pointer events, captured once the pointer moved a few pixels (a press and release without movement, a double click,
   a checkbox, the context menu and the wheel stay the tree's). The drag holds paths, never rows: the tree redraws when
   the repository changes, so the files are looked up again and the node under the pointer is found again on every move
   and at the release. Esc, a lost capture, a window blur or a move with no button down end it without a drop.
   Git._commit.dragDrop(treeEl, tree) is called by commit.js whenever it builds the tree. */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const C = (Git._commit = Git._commit || {});

  const SLOP = 4;                                         // px the pointer moves before a press becomes a drag
  /** The root node a row belongs to: 'changes' (its files, folders and the conflicts under it), 'unversioned', or null. */
  const rootOf = (id) => {
    if (id == null) return null;
    if (id === 'changes' || id === 'conflicts' || /^(f|c):/.test(id) || /^d:f:/.test(id)) return 'changes';
    if (id === 'unversioned' || /^u:/.test(id) || /^d:u:/.test(id)) return 'unversioned';
    return null;
  };
  const isRoot = (id) => id === 'changes' || id === 'unversioned';
  const countText = (n) => (n === 1 ? t('1 file') : t('{0} files', n));

  /** The files a drag of these nodes stands for: { from, paths } or null (nothing that can be dragged between the two). */
  function draggedFiles(list) {
    const seen = new Set(), paths = [];
    let set = null;
    for (const n of list) {
      if (isRoot(n.id) || !rootOf(n.id)) continue;
      for (const f of (n.data && n.data.files) || []) {
        if (f.set !== 'f' && f.set !== 'u') return null;   // a conflict (resolved with Merge…), never dragged
        if (set && f.set !== set) return null;            // files of both nodes at once: no single target
        set = f.set;
        if (!seen.has(f.path)) { seen.add(f.path); paths.push(f.path); }
      }
    }
    return paths.length ? { from: set === 'u' ? 'unversioned' : 'changes', paths } : null;
  }
  /** The dragged paths that still are what they were when the drag began (a refresh may have changed them). */
  function current(d) {
    return d.paths.filter((p) => { const f = C.local(p); return f && (d.from === 'unversioned' ? f.status === '?' : f.status !== '?'); });
  }
  /** Whether `target` takes the drop of `d` now. */
  function accepts(d, target) {
    if (!target || target === d.from) return false;
    const paths = current(d);
    if (!paths.length) return false;
    if (target === 'changes') return true;
    return paths.every((p) => C.local(p).status === 'A');   // only a newly added file can become unversioned again
  }

  C.dragDrop = function (treeEl, tree) {
    let press = null, drag = null;

    function rowAt(x, y) {
      const e = document.elementFromPoint(x, y);
      const row = e && e.closest ? e.closest('.g-row') : null;
      return row && treeEl.contains(row) ? row : null;
    }
    const targetAt = (x, y) => { const row = rowAt(x, y); return row ? rootOf(row.dataset.id) : null; };

    // ---------------------------------------------------------------- feedback
    /** The highlight covers the target node's rows on screen (its header and every row beneath it). */
    function placeArea() {
      if (!drag) return;
      const root = drag.ok ? drag.target : null;
      let top = Infinity, bottom = -Infinity;
      if (root) {
        treeEl.querySelectorAll('.g-row').forEach((row) => {
          if (rootOf(row.dataset.id) !== root) return;
          const r = row.getBoundingClientRect();
          if (r.height) { top = Math.min(top, r.top); bottom = Math.max(bottom, r.bottom); }
        });
      }
      const box = treeEl.getBoundingClientRect();
      top = Math.max(top, box.top);
      bottom = Math.min(bottom, box.top + treeEl.clientHeight);
      if (!(bottom > top)) { drag.area.hidden = true; return; }
      Object.assign(drag.area.style, { left: box.left + 'px', width: treeEl.clientWidth + 'px', top: top + 'px', height: bottom - top + 'px' });
      drag.area.hidden = false;
    }
    function update(x, y) {
      drag.x = x; drag.y = y;
      drag.target = targetAt(x, y);
      drag.ok = accepts(drag.files, drag.target);
      treeEl.dataset.drop = drag.ok ? drag.target : '';
      document.body.classList.toggle('gc-no-drop', !drag.ok);
      const lw = drag.label.offsetWidth || 0;
      drag.label.style.left = Math.max(0, Math.min(x + 14, window.innerWidth - lw - 4)) + 'px';
      drag.label.style.top = Math.min(y + 12, window.innerHeight - 26) + 'px';
      placeArea();
    }
    function labelFor(files) {
      const one = files.paths.length === 1 ? files.paths[0] : null;
      return h('div.gc-drag-label', { role: 'presentation' }, one ? Git.fileIcon(one) : null, h('span.gc-drag-name', one ? Git.fileName(one) : countText(files.paths.length)));
    }

    // ---------------------------------------------------------------- the gesture
    function start(e) {
      const pressedId = press.id;
      let nodes = tree.selected();
      if (!nodes.some((n) => n.id === pressedId)) {           // a row outside the selection is dragged alone, and selected
        tree.select(pressedId);
        nodes = tree.selected();
      }
      const files = draggedFiles(nodes);
      if (!files) { stop(); return; }
      tree.keepSelection();
      drag = { files, pointerId: press.pointerId, target: null, ok: false, x: e.clientX, y: e.clientY,
        label: document.body.appendChild(labelFor(files)), area: document.body.appendChild(h('div.gc-drop-area', { hidden: true })) };
      try { treeEl.setPointerCapture(press.pointerId); } catch (err) { /* a synthetic or already released pointer */ }
      document.body.classList.add('gc-dragging');
      // the tree redraws when the repository changes (and while it scrolls): the highlight follows its rows
      drag.watch = new MutationObserver(() => { if (drag) { drag.ok = accepts(drag.files, drag.target); treeEl.dataset.drop = drag.ok ? drag.target : ''; document.body.classList.toggle('gc-no-drop', !drag.ok); placeArea(); } });
      drag.watch.observe(treeEl, { childList: true, subtree: true });
      treeEl.addEventListener('scroll', placeArea);
      treeEl.addEventListener('lostpointercapture', lost);
      window.addEventListener('blur', cancel);
      document.addEventListener('keydown', key, true);
      update(e.clientX, e.clientY);
    }
    function move(e) {
      if (!press || e.pointerId !== press.pointerId) return;
      if (e.buttons === 0) { stop(); return; }                // released where this document did not see it
      if (!drag) {
        if (Math.abs(e.clientX - press.x) < SLOP && Math.abs(e.clientY - press.y) < SLOP) return;
        start(e);
        return;
      }
      e.preventDefault();
      update(e.clientX, e.clientY);
    }
    function up(e) {
      if (!press || (e.pointerId !== undefined && e.pointerId !== press.pointerId)) return;
      const d = drag;
      if (d) {
        // the node under the pointer now, the files as they are now
        const target = targetAt(e.clientX, e.clientY);
        const ok = accepts(d.files, target);
        const paths = ok ? current(d.files) : [];
        stop(true);
        if (ok) drop(target, paths);
      } else stop();
    }
    const cancel = () => stop(!!drag);
    const lost = () => { if (drag) stop(true); };
    function key(e) {
      if (e.key !== 'Escape' || !drag) return;
      e.preventDefault();
      e.stopPropagation();
      stop(true);
    }
    /** Ends the gesture the same way every time; `dragged`: a drag was on, so the click its release makes is not one. */
    function stop(dragged) {
      document.removeEventListener('pointermove', move, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', cancel, true);
      const d = drag;
      press = null;
      drag = null;
      if (!d) return;
      d.watch.disconnect();
      treeEl.removeEventListener('scroll', placeArea);
      treeEl.removeEventListener('lostpointercapture', lost);
      window.removeEventListener('blur', cancel);
      document.removeEventListener('keydown', key, true);
      try { if (treeEl.hasPointerCapture && treeEl.hasPointerCapture(d.pointerId)) treeEl.releasePointerCapture(d.pointerId); } catch (err) { /* gone */ }
      d.label.remove();
      d.area.remove();
      delete treeEl.dataset.drop;
      document.body.classList.remove('gc-dragging', 'gc-no-drop');
      if (dragged) {
        const eat = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
        window.addEventListener('click', eat, true);
        setTimeout(() => window.removeEventListener('click', eat, true), 0);
      }
    }

    /** The drop: the engine moves the files; the rows follow with the snapshot and stay selected where they land. */
    function drop(target, paths) {
      const A = Git.actions;
      const run = target === 'changes' ? A.addToVcs(paths)
        : A.run({ title: t('Rollback'), method: 'changes.unversion', params: { paths } }).then((res) => { if (res) A.touched(res.paths); return res; });
      const prefix = target === 'changes' ? 'f:' : 'u:';
      Promise.resolve(run).then((res) => {
        if (!res) return;
        let tries = 0;
        const reselect = () => {
          const ids = paths.map((p) => prefix + p).filter((id) => tree.rows().some((n) => n.id === id));
          if (ids.length || ++tries > 40) { if (ids.length) tree.select(ids); return; }
          setTimeout(reselect, 50);
        };
        reselect();
      });
    }

    treeEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.pointerType === 'touch' || press || e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (e.target.closest('.g-check, .g-row-chev, button, input, a')) return;
      const row = e.target.closest('.g-row');
      if (!row || !treeEl.contains(row)) return;
      const id = row.dataset.id;
      if (isRoot(id) || !rootOf(id)) return;                  // the two nodes are targets; amend, ignored: not dragged
      press = { id, pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      document.addEventListener('pointermove', move, true);
      document.addEventListener('pointerup', up, true);
      document.addEventListener('pointercancel', cancel, true);
    });
  };
})();
