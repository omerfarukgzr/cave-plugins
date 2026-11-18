/* The plan of the Rebasing Commits dialog without DOM (split from merge-rebase.js; tested in
   test/ui/merge-plan.test.js). Entries are in the order they will be applied (oldest first):
   { id, action: 'pick'|'edit'|'squash'|'fixup'|'drop', message: null | string (a new message for a commit that stays) }.
   Git.rebasePlanModel.create(ids) · isChild(e) · isRoot(e) · rootBefore(entries, i) · settle(entries)
   move(entries, from, to) -> new index · setAction(entries, i, action, messageOf) -> id of the commit whose message to
   edit next, or null · modified(entries, ids) · toEngine(entries) -> rebase.apply's `entries` */
(function () {
  'use strict';
  const Git = (window.Git = window.Git || {});
  const M = (Git.rebasePlanModel = {});

  M.create = (ids) => ids.map((id) => ({ id, action: 'pick', message: null }));
  M.isChild = (e) => e.action === 'squash' || e.action === 'fixup';
  M.isRoot = (e) => !M.isChild(e) && e.action !== 'drop';
  /** The commit a squash / fixup at `i` melts into: the nearest kept commit above it. */
  M.rootBefore = function (entries, i) {
    for (let k = i - 1; k >= 0; k--) if (M.isRoot(entries[k])) return entries[k];
    return null;
  };
  /** A squash or fixup needs a commit above it to melt into; one left without it goes back to pick. */
  M.settle = function (entries) {
    entries.forEach((e, i) => { if (M.isChild(e) && !M.rootBefore(entries, i)) e.action = 'pick'; });
    return entries;
  };
  /** Moves the entry at `from` to `to` (drag, ⌥↑ / ⌥↓); returns its new index. */
  M.move = function (entries, from, to) {
    if (from < 0 || from >= entries.length) return from;
    to = Math.max(0, Math.min(entries.length - 1, to));
    if (to === from) return from;
    const [e] = entries.splice(from, 1);
    entries.splice(to, 0, e);
    M.settle(entries);
    return to;
  };
  /**
   * Sets the action of the entry at `i`. Squash joins the two messages, Fixup keeps only the upper commit's; either
   * way the joined commit's message is edited next (the returned id). `messageOf(entry)` is the message a commit has now.
   */
  M.setAction = function (entries, i, action, messageOf) {
    const e = entries[i];
    if (!e) return null;
    if (action === 'squash' || action === 'fixup') {
      const root = M.rootBefore(entries, i);
      if (!root) return null;
      if (action === 'squash') root.message = messageOf(root) + '\n\n' + messageOf(e);
      e.action = action;
      e.message = null;
      return root.id;
    }
    e.action = action;
    if (action !== 'edit') e.message = null;
    M.settle(entries);
    return null;
  };
  M.modified = (entries, ids) => entries.some((e, i) => e.id !== ids[i] || e.action !== 'pick' || e.message != null);
  /** The plan as rebase.apply / rebase.applyOnto take it: a kept commit with a new message is a reword. */
  M.toEngine = function (entries) {
    return entries.map((e) => {
      if (!M.isRoot(e)) return { id: e.id, action: e.action };
      const action = e.action === 'pick' && e.message != null ? 'reword' : e.action;
      return e.message != null ? { id: e.id, action, message: e.message } : { id: e.id, action };
    });
  };
})();
