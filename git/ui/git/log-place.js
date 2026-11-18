/* Where the user was in the Log, kept across a re-created page (Orca destroys a panel's frame when another
   sidebar tab is chosen and builds it again on return). Per repository root: the selected commit ids (with anchor and
   lead) and the table's scroll offset, in localStorage with the time it was written (a place older than MAX_AGE is
   forgotten), in memory when the storage throws. Not sessionStorage: measured in the running Orca (1.4.255), a
   re-created panel frame starts with an empty sessionStorage while localStorage is kept. log.js restores the place on
   mount when those commits are still in the log, without taking the focus; a reveal that arrives first (showInLog) wins.
   L.place = { read(root) → { sel, anchor, lead, top } | null, write(root, patch) } */
(function () {
  'use strict';
  const Git = (window.Git = window.Git || {});
  const L = (Git.logUI = Git.logUI || {});
  // the host's storage prefix (ui/host/product.js) + 'log.place:' + root, read when used
  const key = (root) => Git.storagePrefix() + 'log.place:' + root;
  const MAX_IDS = 200;
  const MAX_AGE = 12 * 3600 * 1000;                // a working day: yesterday's place is not brought back
  const memory = new Map();

  const storage = () => { try { return window.localStorage || null; } catch (e) { return null; } };
  function read(root) {
    if (!root) return null;
    let text = null;
    try { const s = storage(); text = s ? s.getItem(key(root)) : null; } catch (e) { text = null; }
    if (text == null) text = memory.has(root) ? memory.get(root) : null;
    if (!text) return null;
    try {
      const v = JSON.parse(text);
      if (!v || typeof v !== 'object') return null;
      if (!Number.isFinite(v.at) || Date.now() - v.at > MAX_AGE || v.at > Date.now() + 60000) return null;
      const ids = Array.isArray(v.sel) ? v.sel.filter((x) => typeof x === 'string' && /^[0-9a-f]{4,64}$/.test(x)) : [];
      const one = (x) => (typeof x === 'string' && ids.indexOf(x) >= 0 ? x : null);
      return { sel: ids, anchor: one(v.anchor), lead: one(v.lead), top: Number.isFinite(v.top) && v.top > 0 ? v.top : 0 };
    } catch (e) { return null; }
  }
  function write(root, patch) {
    if (!root) return;
    const next = Object.assign(read(root) || { sel: [], anchor: null, lead: null, top: 0 }, patch);
    next.sel = (next.sel || []).slice(0, MAX_IDS);
    next.at = Date.now();
    const text = JSON.stringify(next);
    memory.set(root, text);
    try { const s = storage(); if (s) s.setItem(key(root), text); } catch (e) { /* full or refused: memory keeps it */ }
  }
  /** What a fresh mount restores from `saved` (read()) for a view whose rows are `index` (Map id → row): 'wait' while
      some saved commits are missing and the log is not `settled` (complete, no filter answer pending); null when there
      is nothing (no saved place, or its commits are gone); else { sel (in row order), anchor, lead, top }. */
  function pick(saved, index, settled) {
    if (!saved) return null;
    const ids = saved.sel.filter((id) => index.has(id));
    if (ids.length < saved.sel.length && !settled) return 'wait';
    if (saved.sel.length && !ids.length) return null;
    ids.sort((a, b) => index.get(a) - index.get(b));
    const anchor = saved.anchor && ids.indexOf(saved.anchor) >= 0 ? saved.anchor : ids[0] || null;
    return { sel: ids, anchor, lead: saved.lead && ids.indexOf(saved.lead) >= 0 ? saved.lead : anchor, top: saved.top || 0 };
  }
  /** Remembers `table`'s scroll offset under root() at most once a frame, while ready() says the place was restored. */
  function watchScroll(table, ready, root) {
    let queued = false;
    table.addEventListener('scroll', () => {
      if (queued || !ready()) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; if (ready() && root()) write(root(), { top: Math.round(table.scrollTop) }); });
    });
  }
  L.place = { read, write, pick, watchScroll };
})();
