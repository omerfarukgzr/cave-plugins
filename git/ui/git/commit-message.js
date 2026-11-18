/* The lower half of the Commit view — what the user typed and switched on (commit.js draws it).
   Shared state of the Commit view: Git._commit (C.S); this file owns the message, Amend, the Commit Message History,
   the merge message and the commit checks; commit.js owns the tree and the drawing.
     C.setMessage(text) · C.setAmend(on) · C.amendMenu(anchor) · C.messages() · C.historyPopup(anchor)
     C.follow()  (keeps the message of a merge being concluded and the amend state in step with the snapshot)
     C.problem() (IntelliJ's reason for not committing yet) · C.commitNow(push, { anyway }) */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const R = Git.repo;
  const C = (Git._commit = Git._commit || {});
  const prefs = () => Git.host.prefs;
  const HISTORY_KEY = 'commit.messages';

  Git.addTR({
    'Commit Message History': 'Commit mesajı geçmişi', 'last commit': 'son commit', 'Amend': 'Amend',
    'Select files to commit': 'Commit için dosya seç', 'Specify commit message': 'Commit mesajı yaz',
    'Select files to commit and specify commit message': 'Commit için dosya seç ve commit mesajı yaz',
    'The repository is in the detached HEAD state: {0}': '{0} deposu ayrık HEAD durumunda (detached HEAD)',
    'Rebase in progress in the repository: {0}. Committing during rebase may lead to the commit loss.':
      '{0} deposunda rebase sürüyor. Rebase sırasında commit etmek commit\'in kaybolmasına yol açabilir.',
    'Commit Anyway': 'Yine de commit et', 'Commit and Push Anyway': 'Yine de commit ve Push et',
    'Loading amended commit…': 'Amend edilecek commit yükleniyor…', 'Files have unresolved conflicts': 'Dosyalarda çözülmemiş çakışmalar var',
  });

  const S = (C.S = C.S || {
    included: new Set(),                      // paths ticked for the commit
    group: String(prefs().get('commit-group', '0')) === '1',
    amend: false, saved: '',                  // `saved`: what the field held before Amend replaced it
    amendInfo: null,                          // { id, subject, files, loading } of the commit Amend changes
    message: '', error: null,                 // `error`: the key of IntelliJ's reason under the field
    check: null,                              // a commit check that asks first: { kind: 'detached', push }
    mergeMessage: null,                       // the message a merge being concluded put into the field
    underMerge: null,                         // what the field showed before that message replaced it (it comes back)
    kept: null,                               // the message kept after a commit: not the user's draft until edited
    conflictsSeen: new Set(),                 // conflicts of the running operation (resolved ones get ticked)
  });
  if (!('kept' in S)) { S.kept = null; S.underMerge = null; }

  // ---------------------------------------------------------------- message
  // Three kinds of text in the field: a draft (what the user typed or picked from the history), the message kept after
  // a commit (IntelliJ leaves the committed message in the field; S.kept), and a message git prepared (op.message /
  // pendingMessage; S.mergeMessage). A prepared message replaces an empty field or a kept message, never a draft; when
  // it goes away untouched, the field shows again what it showed before (S.underMerge).
  /** `draft`: the text is the user's (typed, picked from the history, Undo Commit's message); otherwise it is kept as
      it was (the caller sets S.kept / S.mergeMessage). */
  C.setMessage = function (text, draft) {
    S.message = text || '';
    if (draft) S.kept = null;
    if (C.ui) C.ui.msg.value = S.message;
  };
  /** The field was edited by the user: a kept or prepared message becomes the user's draft. */
  C.typed = function (text) {
    S.message = text || '';
    S.kept = null;
  };
  const isKept = () => S.kept != null && S.message === S.kept;
  const headCommit = () => Git.commit(Git.headId());
  const fullMessage = (d) => d.subject + (d.body ? '\n\n' + d.body : '');
  C.headCommit = headCommit;

  // ---------------------------------------------------------------- Amend: the last commit's message and its files
  C.setAmend = function (on) {
    if (on === S.amend || (on && !headCommit())) { C.updateBottom(); return; }
    S.amend = on;
    if (on) {
      // Amend shows the amended commit's message (IntelliJ loads it), whatever the field held; Amend off brings that back
      S.saved = S.message; S.savedKept = S.kept;
      const c = headCommit();
      S.amendInfo = { id: c.id, subject: c.subject, files: [], loading: true };
      C.setMessage(fullMessage(c));
      // the list has subjects only; the body and the files come with commit.details
      Git.content.details(c.id).then((d) => {
        if (!S.amend || !S.amendInfo || S.amendInfo.id !== d.id) return;
        if (S.message === fullMessage(c)) C.setMessage(fullMessage(d));
        const entry = (d.changes || [])[0];
        S.amendInfo = { id: d.id, subject: d.subject, files: entry ? entry.files : [], loading: false };
        C.refresh();
      }, () => { if (S.amendInfo) { S.amendInfo.loading = false; C.refresh(); } });
    } else {
      S.amendInfo = null;
      C.setMessage(S.saved);
      S.kept = S.savedKept == null ? null : S.savedKept;
    }
    S.check = null;
    C.refresh();
  };
  /** HEAD moved under Amend (the engine refused with head_moved): the files and id follow the new last commit; the
      message the user has in the field stays. */
  C.reloadAmend = function (fromSnapshot) {
    if (!S.amend) return;
    const after = () => {
      // the new last commit may not be in the Log's list yet (the snapshot comes first): its id is enough here
      const id = Git.headId(), c = headCommit();
      if (!id) { S.amend = false; S.amendInfo = null; C.refresh(); return; }
      S.amendInfo = { id, subject: c ? c.subject : '', files: [], loading: true };
      C.refresh();
      Git.content.details(id).then((d) => {
        if (!S.amend || !S.amendInfo || S.amendInfo.id !== d.id) return;
        const entry = (d.changes || [])[0];
        S.amendInfo = { id: d.id, subject: d.subject, files: entry ? entry.files : [], loading: false };
        C.refresh();
      }, () => { if (S.amendInfo) { S.amendInfo.loading = false; C.refresh(); } });
    };
    // the snapshot may not show the new HEAD yet: read it again first
    if (fromSnapshot) { after(); return; }
    Promise.resolve(Git.store && Git.store.refresh ? Git.store.refresh() : null).then(after, after);
  };
  C.amendMenu = function (anchor) {
    const c = headCommit();
    if (c) Git.menu(anchor, [{ label: c.subject, shortcut: Git.short(c.id), checked: S.amend, action: () => C.setAmend(true) }]);
  };

  // ---------------------------------------------------------------- Commit Message History
  const stored = () => { const v = prefs().get(HISTORY_KEY, []); return Array.isArray(v) ? v : []; };
  C.remember = function (message) { prefs().set(HISTORY_KEY, Git.changesModel.remember(stored(), message)); };
  /** The stored messages (newest first), then my recent commits on the current branch along the first-parent chain. */
  C.messages = function () {
    const seen = new Set(), out = [];
    const add = (m) => { m = String(m || '').replace(/\s+$/, ''); if (m.trim() && !seen.has(m.trim())) { seen.add(m.trim()); out.push(m); } };
    stored().forEach(add);
    let c = headCommit(), steps = 0;
    while (c && out.length < 25 && steps++ < 300) {
      if (Git.isMine(c) && c.parents.length < 2) add(c.subject);
      c = Git.commit(c.parents[0]);
    }
    return out.slice(0, 25);
  };
  C.historyPopup = function (anchor) {
    const list = h('div.gc-history', { role: 'listbox', 'aria-label': t('Commit Message History') });
    let pop = null;
    C.messages().forEach((m) => list.appendChild(h('button.gc-history-item', { type: 'button', role: 'option', title: m,
      onclick: () => { pop.close(); C.setMessage(m, true); C.updateBottom(); C.ui.msg.focus(); } }, m.split('\n')[0])));
    pop = Git.popup({ anchor, placement: 'above', width: Math.min(340, window.innerWidth - 24), className: 'gc-history-pop',
      content: [h('div.gc-history-title', t('Commit Message History')), list] });
  };

  // ---------------------------------------------------------------- following the snapshot
  C.follow = function () {
    const alive = new Set();
    R.local.forEach((f) => { alive.add(f.path); if (f.oldPath) alive.add(f.oldPath); });
    const conflicts = Git.conflicts();
    conflicts.forEach((c) => { alive.add(c.path); S.conflictsSeen.add(c.path); });
    // A conflict resolved during the operation comes back as a change: it is part of the commit that concludes it.
    if (R.op) S.conflictsSeen.forEach((p) => { if (!conflicts.some((c) => c.path === p) && Git.localFile(p)) S.included.add(p); });
    else S.conflictsSeen.clear();
    Array.from(S.included).forEach((p) => { if (!alive.has(p)) S.included.delete(p); });
    // The message git prepared, as IntelliJ's commit field takes it from MERGE_MSG / SQUASH_MSG: of the merge,
    // cherry-pick or revert being concluded (op.message), or without an operation after a squash merge or
    // `cherry-pick -n` (pendingMessage). Read defensively.
    const prepared = R.op ? (/^(merge|cherry-pick|revert)$/.test(R.op.type) ? R.op.message : null) : R.pendingMessage;
    const auto = (typeof prepared === 'string' ? prepared.replace(/\s+$/, '') : '') || null;
    if (auto && auto !== S.mergeMessage) {
      // the prepared message replaces an empty field, an earlier prepared one and the message kept after a commit —
      // never the user's draft (A §3.6: the field takes MERGE_MSG / SQUASH_MSG)
      if (!S.message.trim() || S.message === S.mergeMessage || isKept()) {
        if (S.mergeMessage == null || S.message !== S.mergeMessage) S.underMerge = { message: S.message, kept: S.kept };
        C.setMessage(auto);
      }
      S.mergeMessage = auto;
    } else if (!auto && S.mergeMessage != null) {
      // gone untouched: the field shows again what it showed before (the kept message stays "kept")
      if (S.message === S.mergeMessage) { const u = S.underMerge || { message: '', kept: null }; C.setMessage(u.message); S.kept = u.kept; }
      S.mergeMessage = null; S.underMerge = null;
    }
    // no last commit any more (unborn): Amend goes off; a new last commit the Log has not listed yet is followed by id
    if (S.amend && !Git.headId()) { S.amend = false; S.amendInfo = null; }
    else if (S.amend && S.amendInfo && S.amendInfo.id !== Git.headId() && !S.amendInfo.loading) C.reloadAmend(true);   // follows the new last commit
  };

  // ---------------------------------------------------------------- committing
  const merging = () => !!(R.op && R.op.type === 'merge');
  /** IntelliJ's reason for not committing yet, or null. Amend and a merge being concluded need no ticked file. */
  C.problem = function () {
    // VcsBundle before.checkin.error.unresolved.merge.conflicts (the unresolved-merge commit check)
    if (Git.conflicts().length) return 'Files have unresolved conflicts';
    const noFiles = !C.commitPaths().length && !S.amend && !merging(), noMessage = !S.message.trim();
    return noFiles && noMessage ? 'Select files to commit and specify commit message' : noFiles ? 'Select files to commit' : noMessage ? 'Specify commit message' : null;
  };
  C.commitNow = function (push, o) {
    S.error = C.problem();
    if (S.error) {
      S.check = null;
      C.updateBottom();
      if (S.error === 'Specify commit message') C.ui.msg.focus();
      return null;
    }
    // Commit checks that ask first ("Warn when committing in detached HEAD"): the warning, then "Commit Anyway".
    // GitDetachedHeadCommitCheck: a rebase in progress (an edit stop: HEAD is detached there) has its own warning
    // (a rebase git left half-made is no rebase to lose commits in: the engine refuses the commit, the notice says why)
    const rebasing = !!(R.op && !R.op.incomplete && (R.op.type === 'rebase' || R.op.type === 'am'));
    if ((rebasing || R.head.detached) && !(o && o.anyway)) { S.check = { kind: rebasing ? 'rebase' : 'detached', push: !!push }; C.updateBottom(); return null; }
    S.check = null;
    const paths = C.commitPaths(), message = S.message.replace(/\s+$/, ''), amend = S.amend;
    const mergeCount = merging() ? Git.localChanges().length : 0;
    // the prepared message is the user's now: the snapshot after the commit (no MERGE_MSG) must not clear it
    S.mergeMessage = null; S.underMerge = null;
    C.updateBottom();
    const expectHead = amend && S.amendInfo ? S.amendInfo.id : null;
    return Git.actions.commit(paths, message, { amend, push, mergeCount, expectHead, onHeadMoved: () => C.reloadAmend() }).then((res) => {
      if (!res) return null;                  // refused or failed: the field keeps the message
      C.remember(message);
      paths.forEach((p) => S.included.delete(p));
      S.amend = false; S.amendInfo = null; S.saved = ''; S.savedKept = null; S.error = null; S.mergeMessage = null; S.underMerge = null;
      // IntelliJ keeps the committed message in the field (A §3.6 E, §3.8 step 7; "Clear initial commit message" is off by
      // default); typing or picking from Commit Message History replaces it, and a message git prepares later (a squash
      // merge, cherry-pick -n) replaces it as long as it was not edited (S.kept)
      if (S.message.replace(/\s+$/, '') === message) S.kept = S.message;
      C.refresh();
      return res;
    });
  };
  /** The commit check row under the field (the detached HEAD warning with its "Commit Anyway" link). */
  C.checkRow = function () {
    if (!S.check) return null;
    const label = S.check.push ? t('Commit and Push Anyway') : t('Commit Anyway');
    return h('div.gc-check', { role: 'alert' }, Git.icon('balloonWarning'),
      h('span.gc-check-text', S.check.kind === 'rebase' ? t('Rebase in progress in the repository: {0}. Committing during rebase may lead to the commit loss.', R.name)
        : t('The repository is in the detached HEAD state: {0}', R.name)),
      h('button.g-link#gc-anyway', { type: 'button', onclick: () => { const push = S.check.push; S.check = null; C.commitNow(push, { anyway: true }); } }, label));
  };
})();
