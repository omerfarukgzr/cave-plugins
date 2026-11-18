/* The Log's decisions that need no DOM (tested in test/ui/log-logic.test.js).
   L.zipChanges(details)            the Changed Files of several commits as one list (IntelliJ's CommittedChangesTreeBrowser
                                    .zipChanges): a path changed by several commits becomes one change from before the
                                    oldest of them to after the newest; added then deleted disappears; renames chain.
   L.keepSelection(sel, anchor, lead, index)   the selection after the commit list changed: commits that are still there
   L.menuState(ids, facts)          which commit menu items are enabled and why not (IntelliJ's update() rules); facts:
                                    { headId, op, commit(id), inHead(id), localChanges?, hasRemotes?, detached? }
   L.parseRange(text)               'main..feature' → { base, tip } (Branch filter "Select…"), else null
   L.arrangement(w, h, prev)        'narrow' | 'medium' | 'wide' for a Log root of that size (log-layout.js)
   L.compactDate(ms, now, order, yesterday)  the narrow arrangement's short date ("14:05", "Dün 14:05", "14.11 14:05")
   L.reflowBody(text)               a hard-wrapped commit body with its paragraphs' lines joined again (Commit Details) */
(function () {
  'use strict';
  const Git = (window.Git = window.Git || {});
  const L = (Git.logUI = Git.logUI || {});

  /** `details`: commit.details answers, any order is fine as long as `order(id)` (log index, newest first = smaller) is
      given; merges are left out (their pane is drawn on its own). Each result entry:
      { path, status, oldPath?, before: { path, rev } | null, after: { path, rev } | null, commits: [ids oldest first],
        commitId (the newest commit that touched it), parent (that commit's first parent), single (one commit only),
        kind, oldId, newId } */
  L.zipChanges = function (details, order) {
    const list = details.filter((d) => d && !d.merge && d.changes && d.changes.length);
    const pos = order || ((id) => list.findIndex((d) => d.id === id));
    list.sort((a, b) => pos(b.id) - pos(a.id));                 // oldest first
    const byPath = new Map();
    list.forEach((d) => {
      const entry = d.changes[0];
      const parent = entry.parent || null;
      entry.files.forEach((ch) => {
        let e = byPath.get(ch.path) || null;
        if (!e && ch.oldPath && byPath.has(ch.oldPath)) { e = byPath.get(ch.oldPath); byPath.delete(ch.oldPath); }
        if (!e) {
          e = { before: ch.status === 'A' ? null : { path: ch.oldPath || ch.path, rev: parent }, commits: [], oldId: ch.oldId || null };
        }
        e.after = ch.status === 'D' ? null : { path: ch.path, rev: d.id };
        e.commits.push(d.id);
        e.commitId = d.id;
        e.parent = parent;
        e.kind = ch.kind || 'file';
        e.newId = ch.newId || null;
        e.last = ch;
        byPath.set(ch.path, e);
      });
    });
    const out = [];
    byPath.forEach((e) => {
      if (!e.before && !e.after) return;                         // added and deleted again: no change at all
      const path = e.after ? e.after.path : e.before.path;
      const status = !e.before ? 'A' : !e.after ? 'D' : e.before.path !== e.after.path ? 'R' : 'M';
      const single = e.commits.length === 1;
      const item = Object.assign({}, single ? e.last : {}, { path, status, before: e.before, after: e.after, commits: e.commits,
        commitId: e.commitId, parent: e.parent, single, kind: e.kind, oldId: e.oldId, newId: e.newId });
      if (status === 'R') item.oldPath = e.before.path; else delete item.oldPath;
      if (!single) { delete item.similarity; delete item.copiedFrom; }
      out.push(item);
    });
    return out;
  };

  /** The selection kept across a change of the list: ids still shown, in list order; anchor and lead follow. */
  L.keepSelection = function (sel, anchor, lead, index) {
    const kept = sel.filter((id) => index.has(id)).sort((a, b) => index.get(a) - index.get(b));
    return { sel: kept, anchor: index.has(anchor) ? anchor : kept[0] || null, lead: index.has(lead) ? lead : kept[kept.length - 1] || null };
  };

  /** 'a..b' (IntelliJ's two-dot range of the Branch filter): commits of b that a lacks. */
  L.parseRange = function (text) {
    const m = /^\s*([^.\s](?:[^\s]*[^.\s])?)\.\.([^.\s][^\s]*)\s*$/.exec(text || '');
    return m ? { base: m[1], tip: m[2] } : null;
  };

  const OP_NAME = { 'cherry-pick': 'Cannot {0} during cherry-pick', merge: 'Cannot {0} during merge', rebase: 'Cannot {0} during rebase',
    am: 'Cannot {0} during rebase', revert: 'Cannot {0} during revert' };
  /** IntelliJ's enabled states of the commit menu (VcsLogAction / GitCommitEditingActionBase update() checks that need
      no engine call; pushed-to-protected is checked when the action runs). `f`: { headId, op: { type } | null,
      commit(id) → { parents }, inHead(id) → bool }. Returns { key: { on, why: [english, …args] | null } }.
      Reasons are IntelliJ's texts (GitBundle: rebase.log.*, git.undo.action.description). */
  L.menuState = function (ids, f) {
    const one = ids.length === 1, id = ids[0], c = id ? f.commit(id) : null;
    const res = {};
    const set = (key, on, why) => { res[key] = { on: !!on, why: on ? null : why || null }; };
    const busy = (what) => (f.op ? [OP_NAME[f.op.type] || 'Cannot {0}', what] : null);
    const notInHead = ids.find((x) => !f.inHead(x));
    const merge = ids.find((x) => { const k = f.commit(x); return k && k.parents.length > 1; });
    const headless = !f.headId;
    const parentsWhy = (x) => ['Selected commit has {0} parents', f.commit(x).parents.length];
    const inHeadWhy = notInHead ? (one ? ['The commit is not in the current branch'] : ['Commit {0} is not in the current branch', (notInHead || '').slice(0, 8)]) : null;
    set('copy', ids.length > 0);
    set('cherryPick', ids.length > 0 && !f.op && !headless && !ids.every((x) => f.inHead(x)), f.op ? busy('cherry-pick') : null);
    set('checkout', one);
    set('compareLocal', one);
    set('reset', one && !headless && !f.op, busy('reset'));
    set('revert', ids.length > 0 && !f.op && !notInHead && !merge, f.op ? busy('revert') : notInHead ? inHeadWhy : merge ? parentsWhy(merge) : null);
    // Undo Commit: the last commit of the current branch, with exactly one parent
    const undoWhy = !one ? null : f.op ? busy('undo commit') : id !== f.headId ? ['The selected commit is not the last in the current branch']
      : c && c.parents.length !== 1 ? parentsWhy(id) : null;
    set('undo', one && !undoWhy, undoWhy);
    // Edit Commit Message: a commit of the current branch, not a merge (the initial commit asks first)
    const rewordWhy = !one ? null : f.op ? busy('reword') : !f.inHead(id) ? inHeadWhy : c && c.parents.length > 1 ? parentsWhy(id) : null;
    set('reword', one && !rewordWhy, rewordWhy);
    const dropWhy = f.op ? busy('drop') : notInHead ? inHeadWhy : merge ? parentsWhy(merge) : null;
    set('drop', ids.length > 0 && !dropWhy, dropWhy);
    const rebaseWhy = !one ? null : f.op ? busy('rebase') : !f.inHead(id) ? inHeadWhy : c && c.parents.length > 1 ? parentsWhy(id) : null;
    set('rebase', one && !rebaseWhy, rebaseWhy);
    set('newBranch', one);
    set('newTag', one);
    set('showRepo', one);
    set('compareVersions', ids.length === 2);
    // Fixup… / Squash Into…: a commit of the current branch, not a merge, and local changes to commit
    // (GitAutoSquashCommitAction; "Nothing to commit" is action.Git.Fixup.To.Commit.description.nothing.to.commit)
    const intoWhy = (what) => (!one ? null : f.op ? busy(what) : !f.inHead(id) ? inHeadWhy : c && c.parents.length > 1 ? parentsWhy(id)
      : f.localChanges === false ? ['Nothing to commit'] : null);
    set('fixup', one && !intoWhy('fixup'), intoWhy('fixup'));
    set('squashInto', one && !intoWhy('squash'), intoWhy('squash'));
    // Squash Commits…: two or more commits of the current branch, no merge among them
    const squashWhy = ids.length < 2 ? null : f.op ? busy('squash') : notInHead ? inHeadWhy : merge ? parentsWhy(merge) : null;
    set('squash', ids.length > 1 && !squashWhy, squashWhy);
    // the push items need a remote; Push All up to Here… a commit of the current branch
    const noRemote = f.hasRemotes === false ? ['No remotes'] : null;
    const upToWhy = !one ? null : noRemote || (f.detached ? ['HEAD is detached'] : !f.inHead(id) ? inHeadWhy : null);
    set('pushUpTo', one && !upToWhy, upToWhy);
    const pickWhy = noRemote || (merge ? parentsWhy(merge) : null);
    set('addToRemote', ids.length > 0 && !pickWhy, pickWhy);
    set('pushSelected', ids.length > 0 && !pickWhy && !f.detached, pickWhy || (f.detached ? ['HEAD is detached'] : null));
    return res;
  };

  // ---------------------------------------------------------------- the Log's three arrangements (log-layout.js)
  const pickArrangement = (w, h) => (w < 520 ? 'narrow' : w < 600 ? 'medium' : w < 960 && h >= 520 ? 'medium' : 'wide');
  const STICKY = 6;                                             // px a size must move past a border before the arrangement flips
  /** The arrangement for a Log root of `w` × `h` px: 'narrow' (< 520), 'medium' (520–599, or 600–959 when at least 520
      tall: a tall side panel), else 'wide'. `prev` stays while the size is within STICKY px of a border that would flip
      it (no flip-flopping while a scroll bar comes and goes); a size of 0 (a hidden tab) keeps `prev`. */
  L.arrangement = function (w, h, prev) {
    if (!(w > 0)) return prev || 'wide';
    if (prev) {
      for (const dw of [0, -STICKY, STICKY]) for (const dh of [0, -STICKY, STICKY]) if (pickArrangement(w + dw, h + dh) === prev) return prev;
    }
    return pickArrangement(w, h);
  };

  /** The narrow arrangement's date at the right end of a row: today "14:05", yesterday "Yesterday 14:05" (`yesterday`
      is the translated word; `order` the language's short date order, Git.dateOrder()), this year "14.11 14:05" (en "11/14 14:05"), other years "14.11.2025" (en "11/14/25"). */
  L.compactDate = function (ms, now, order, yesterday) {
    const d = new Date(ms), n = new Date(now);
    const p = (x) => String(x).padStart(2, '0');
    const time = p(d.getHours()) + ':' + p(d.getMinutes());
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(n) - day(d)) / 86400000);
    if (diff === 0) return time;
    if (diff === 1) return yesterday + ' ' + time;
    const tr = order === 'dmy';
    if (d.getFullYear() === n.getFullYear()) return (tr ? p(d.getDate()) + '.' + p(d.getMonth() + 1) : d.getMonth() + 1 + '/' + d.getDate()) + ' ' + time;
    return tr ? p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() : d.getMonth() + 1 + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(2);
  };

  // ---------------------------------------------------------------- message reflow (Commit Details)
  const LIST_ITEM = /^(?:[-*+•] |\d+[.)] )/;
  const TRAILER = /^[A-Za-z][A-Za-z0-9-]*: /;
  const STARTS_TEXT = /^[\p{L}\p{N}"'“”‘’«»„([{]/u;
  const MIN_WRAP = 40;                                          // a body whose longest line is shorter was not wrapped by an editor
  const len = (s) => Array.from(s).length;
  /** A commit body hard-wrapped at about 72 columns, with the lines of each paragraph joined again so that a narrow pane
      wraps it itself. Conservative: the break between line A and the next line B becomes one space only when both have
      text, B starts with a letter, digit, quote or opening bracket and is not a list item, neither starts with
      whitespace or looks like a trailer ("Co-authored-by: …"), and the first word of B would not have fit on A within the
      body's longest line W (the editor wrapped it). Blank lines stay; CRLF becomes LF. Not applied when W < MIN_WRAP. */
  L.reflowBody = function (text) {
    if (typeof text !== 'string' || !text) return text;
    const lines = text.split(/\r?\n/);
    const W = lines.reduce((m, s) => Math.max(m, len(s)), 0);
    if (lines.length < 2 || W < MIN_WRAP) return lines.join('\n');
    const plain = (s) => s.trim() !== '' && !/^\s/.test(s) && !TRAILER.test(s);
    const out = [lines[0]];
    for (let i = 1; i < lines.length; i++) {
      const a = lines[i - 1], b = lines[i];
      const join = plain(a) && plain(b) && STARTS_TEXT.test(b) && !LIST_ITEM.test(b) && len(a.replace(/\s+$/, '')) + 1 + len(b.split(/\s/)[0]) > W;
      if (join) out[out.length - 1] = out[out.length - 1].replace(/\s+$/, '') + ' ' + b;
      else out.push(b);
    }
    return out.join('\n');
  };
})();
