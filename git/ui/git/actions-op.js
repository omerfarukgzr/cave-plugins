/* The ongoing operation (a merge, rebase, cherry-pick or revert that stopped) and its conflicts. Owner: the
   branches / merge / rebase wave. Every write goes through A.run; the store follows the engine's `changed` event.
     opLabels() · opKey() · opSides() -> { flip, left: { name, side }, right: { name, side } } (IntelliJ shows a rebase
       reversed: the left/"Yours" column is the commit being applied = stage 3, the right/"Theirs" one the base = stage 2)
     settle(res, { done, title }) -> handles the outcome of merge / rebase / update / cherry-pick / rebase.apply
     resolveConflicts(done?) · continueOp() · abortOp() · skipCommit() · stoppedNotice()
     acceptSide(paths, 'yours'|'theirs') · resolveText(path, text, { encoding, bom }) · unresolve(path)
     rebaseInteractive({ base | onto, upstream, branch, entries, head }) (Rebasing Commits → Start Rebasing)
     resolvedPaths() (files resolved while this operation runs: the Conflicts dialog's "Resolved" group)
     conflictContext(ctx) / conflictContext() (what caused conflicts without an operation: { kind: 'unstash'|'merge', … }) */
(function () {
  'use strict';
  const Git = window.Git;
  const R = Git.repo;
  const t = (...a) => Git.t(...a);
  const A = Git.actions;
  const { ok, info, warn } = A;

  Git.addTR({
    'Rebase ended': 'Rebase sonlandırıldı', 'Merge ended': 'Merge sonlandırıldı', 'Cherry-pick ended': 'Cherry-pick sonlandırıldı', 'Revert ended': 'Revert sonlandırıldı',
    'You seem to have moved HEAD. Not rewinding, check your HEAD!': 'HEAD taşınmış görünüyor. Geri sarılmadı, HEAD\'i kontrol et!',
    'The commits made so far stay; nothing was thrown away.': 'Şimdiye kadar yapılan commit\'ler duruyor; hiçbir şey atılmadı.',
    'The commit {0} it had made was taken back: the branch is where it was before, its changes are local changes again.':
      'Yaptığı {0} commit\'i geri alındı: dal önceki yerinde, değişiklikleri yeniden yerel değişiklik.',
    'The local changes it had stashed are back in the working tree.': 'Stash\'e aldığı yerel değişiklikler çalışma kopyasına geri döndü.',
    'Conflict resolved: {0}': 'Çakışma çözüldü: {0}',
    'Revert aborted': 'Revert iptal edildi', 'Abort {0} in {1}?': '{1} içinde {0} iptal edilsin mi?',
    'Abort rebase in {0}?': '{0} içindeki rebase iptal edilsin mi?', 'Abort {0}{1}?': '{0}{1} iptal edilsin mi?',
    'merge': 'merge', 'rebase': 'rebase', 'cherry-pick': 'cherry-pick', 'revert': 'revert',
    'Rebase stopped for editing': 'Rebase düzenleme için durdu',
    'You can modify this commit using the context actions (such as Revert, Undo, Amend) before continuing the rebase.':
      'Rebase\'e devam etmeden önce bu commit\'i bağlam eylemleriyle (Revert, Undo, Amend gibi) değiştirebilirsin.',
    'All conflicts have been resolved. Do you want to continue rebase?': 'Bütün çakışmalar çözüldü. Rebase\'e devam edilsin mi?',
    'Cannot continue rebase': 'Rebase\'e devam edilemiyor', 'No rebase in progress': 'Süren bir rebase yok',
    'Revert successful': 'Revert tamamlandı', 'Interactive rebase failed': 'Interactive rebase başarısız oldu',
    'Rebasing Published Commit': 'Yayımlanmış commit rebase ediliyor',
    'You are trying to rebase some commits already pushed to a protected branch.': 'Korumalı bir dala push edilmiş commit\'leri rebase etmeye çalışıyorsun.',
    'Rebasing them would duplicate commits, which is not recommended and most likely unwanted.':
      'Onları rebase etmek commit\'leri çoğaltır; bu önerilmez ve büyük olasılıkla istenmeyen bir şeydir.',
    'Rebase Anyway': 'Yine de rebase et', 'Pending Unresolved conflicts': 'Bekleyen çözülmemiş çakışmalar',
    'There are pending unresolved conflicts.': 'Bekleyen çözülmemiş çakışmalar var.',
    'Commit Merge': 'Merge\'i commitle', 'Commit…': 'Commit…',
    'Cherry-pick failed': 'Cherry-pick başarısız oldu', 'Revert failed': 'Revert başarısız oldu',
    'Your local changes would be overwritten by {0}.': 'Yerel değişikliklerin {0} yüzünden kaybolurdu.',
    'Commit your changes or stash them to proceed.': 'Devam etmek için değişikliklerini commit et ya da stash\'le.',
    'However, {0} succeeded for the following commit:': 'Yine de şu commit için {0} yapıldı:',
    'However, {0} succeeded for the following commits:': 'Yine de şu commit\'ler için {0} yapıldı:',
    'You have uncommitted changes. Commit them (Amend changes the stopped commit) or roll them back, then continue the rebase.':
      'Commit\'lenmemiş değişikliklerin var. Önce onları commit et (Amend durdurulan commit\'i değiştirir) ya da geri al, sonra rebase\'e devam et.', 'Revert Conflict Resolution': 'Çakışma çözümünü geri al', 'Accept Yours': 'Seninkini al', 'Accept Theirs': 'Onlarınkini al',
  });

  const short = (id) => Git.short(id || '');
  /** A ref name pointing at `id` (local branch first, then remote, then tag), else its short hash. */
  function nameAt(id) {
    if (!id) return '';
    const refs = Git.refsAt ? Git.refsAt(id) || [] : [];
    const pick = (type) => refs.find((r) => r.type === type);
    const r = pick('local') || pick('remote') || pick('tag');
    return r ? r.name : short(id);
  }
  A.nameAt = nameAt;
  const labelOf = (l) => (l ? l.ref || nameAt(l.id) : '');

  /** Identifies the stopped step: resolutions and merge sessions belong to it and go when it moves on. */
  A.opKey = function () {
    const op = R.op;
    if (!op) return 'none:' + (noOp ? noOp.at : 0);
    return op.type + ':' + ((op.theirs && op.theirs.id) || '') + ':' + ((op.rebase && op.rebase.step) || '');
  };

  /** Branch and onto of the running rebase, the way the widget and the dialogs name them. */
  A.rebaseNames = function () {
    const op = R.op, rb = (op && op.rebase) || {};
    return { branch: rb.branch || (op && op.theirs && op.theirs.ref) || short(rb.origHead), onto: (op && op.yours && op.yours.ref) || nameAt(rb.onto), current: rb.current };
  };

  /** Widget text and the two buttons next to it while an operation is paused; null when idle. */
  A.opLabels = function () {
    const op = R.op;
    if (!op) return null;
    // what git left half-made (op.incomplete): in progress, but there is nothing to go on with — Abort only (no go/skip)
    if (op.incomplete) {
      const merge = op.type === 'merge';
      return { text: t(merge ? 'Unfinished merge' : 'Unfinished rebase'), tip: A.incompleteText(op.type), go: null, stop: t(merge ? 'Abort Merge' : 'Abort Rebase'),
        type: merge ? 'merge' : 'rebase', incomplete: true };
    }
    const conflicts = Git.conflicts().length > 0;
    if (op.type === 'merge') return { text: t('Merging {0}', labelOf(op.theirs)), go: conflicts ? t('Resolve Conflicts') : t('Commit Merge'), stop: t('Abort Merge'), type: 'merge' };
    if (op.type === 'rebase' || op.type === 'am') {
      return { text: t('Rebasing {0}', A.rebaseNames().branch), go: conflicts ? t('Resolve Conflicts') : t('Continue Rebase'), stop: t('Abort Rebase'), skip: t('Skip Commit'), type: 'rebase' };
    }
    // a sequence waiting before its next commit (op.pending: local changes were in its way) can also drop that commit
    const skip = op.pending ? t('Skip Commit') : undefined;
    if (op.type === 'revert') return { text: t('Reverting in {0}', A.current()), go: conflicts ? t('Resolve Conflicts') : t('Continue Revert'), stop: t('Abort Revert'), skip, type: 'revert' };
    return { text: t('Cherry-picking in {0}', A.current()), go: conflicts ? t('Resolve Conflicts') : t('Continue Cherry-Pick'), stop: t('Abort Cherry-Pick'), skip, type: 'cherry-pick' };
  };

  // ---------------------------------------------------------------- conflicts without an operation
  let noOp = null;
  /** Called by the commands that leave conflicts without an operation (smart checkout, update, squash merge…). */
  A.conflictContext = function (ctx) {
    if (ctx !== undefined) noOp = ctx ? Object.assign({ at: Date.now() }, ctx) : null;
    return R.op ? null : noOp;
  };

  /** Which stage each column shows. IntelliJ shows a rebase reversed: "Yours" is the commit being applied (stage 3). */
  A.opSides = function () {
    const op = R.op;
    if (op && op.type === 'rebase') {
      const n = A.rebaseNames();
      return { flip: true, left: { name: n.branch, side: 'theirs' }, right: { name: n.onto, side: 'yours' } };
    }
    if (op && (op.type === 'cherry-pick' || op.type === 'revert')) {
      return { flip: false, left: { name: A.current() === t('Detached HEAD') ? short(R.headId) : A.current(), side: 'yours' }, right: { name: short(op.theirs && op.theirs.id), side: 'theirs' } };
    }
    if (op) return { flip: false, left: { name: labelOf(op.yours) || A.current(), side: 'yours' }, right: { name: labelOf(op.theirs), side: 'theirs' } };
    const c = noOp || {};
    // stashed local changes that did not come back after an operation (IntelliJ's restore conflict, shown reversed:
    // left the stash = stage 3, right what the operation brought = stage 2)
    if (c.kind === 'restore') return { flip: true, left: { name: 'stash@{0}', side: 'theirs' }, right: { name: c.from || '', side: 'yours' } };
    return { flip: false, left: { name: c.left || '', side: 'yours' }, right: { name: c.right || '', side: 'theirs' } };
  };

  // ---------------------------------------------------------------- resolved files of this step
  const resolved = new Map();   // opKey -> Set(path)
  A.resolvedPaths = function () {
    const key = A.opKey();
    if (!resolved.has(key)) { resolved.clear(); resolved.set(key, new Set()); }
    const open = new Set(Git.conflicts().map((c) => c.path));
    return new Set(Array.from(resolved.get(key)).filter((p) => !open.has(p)));
  };
  const markResolved = (paths, key) => { const set = resolved.get(key) || new Set(); paths.forEach((p) => set.add(p)); resolved.set(key, set); };

  // ---------------------------------------------------------------- notices
  function stoppedNotice() {
    const op = R.op;
    if (!Git.conflicts().length) return;
    if (!op) {
      warn(t('Pending Unresolved conflicts'), t('There are pending unresolved conflicts.'), [{ label: t('Resolve…'), run: () => A.resolveConflicts() }]);
      return;
    }
    if (op.type === 'rebase') warn(t('Rebase stopped due to conflicts'), null, [
      { label: t('Resolve…'), run: () => A.resolveConflicts() }, { label: t('Continue'), run: () => A.continueOp() }, { label: t('Abort'), run: () => A.abortOp() }]);
    else if (op.type === 'merge') warn(t('{0} Merged with Conflicts', labelOf(op.theirs)), null, [{ label: t('Resolve…'), run: () => A.resolveConflicts() }]);
    else warn(op.type === 'revert' ? t('Revert') + ': ' + t('Conflicts') : t('Cherry-pick was performed with conflicts'), t('There are unresolved conflicts in the working tree.'), [
      { label: t('Resolve…'), run: () => A.resolveConflicts() }, { label: op.type === 'revert' ? t('Abort Revert') : t('Abort cherry-pick'), run: () => A.abortOp() }]);
  }
  A.stoppedNotice = stoppedNotice;
  /** apply__continue_rebase_notification.png: an information balloon, the title and two links (no text). */
  function editNotice() {
    Git.notify({ kind: 'info', title: t('Rebase stopped for editing'), sticky: true, whileOp: true,
      actions: [{ label: t('Continue'), run: () => A.continueOp() }, { label: t('Abort'), run: () => A.abortOp() }] });
  }
  A.editNotice = editNotice;
  /** The original commits a stopped sequence already applied: those before the waiting one (`current`), not skipped. */
  function applied(res) {
    const ids = res.ids || [], skipped = res.skipped || [], at = ids.indexOf(res.current);
    if (at >= 0) return ids.slice(0, at).filter((x) => skipped.indexOf(x) < 0);
    return res.created || [];
  }
  /**
   * A cherry-pick / revert of several commits met local changes after its first commit (`result: 'stopped'`, reason
   * 'would-overwrite'): IntelliJ's failure for local changes that would be overwritten, plus which commits were applied
   * (GitApplyChangesProcess: "However, {0} succeeded for the following commits:"). The sequence waits (op.pending):
   * Continue applies the waiting commit and the rest, Skip Commit drops it, Abort goes back to where it started.
   */
  A.sequenceStopped = function (type, res) {
    const revert = type === 'revert', what = t(revert ? 'revert' : 'cherry-pick');
    const done = applied(res);
    const line = (id) => short(id) + ' ' + ((Git.commit(id) || {}).subject || '');
    const text = overwriteLines(what, res);
    if (done.length) text.push(t(done.length === 1 ? 'However, {0} succeeded for the following commit:' : 'However, {0} succeeded for the following commits:', what), done.map(line).join('\n'));
    const labels = A.opLabels() || {};
    Git.notify({ kind: 'error', sticky: true, whileOp: true, title: t(revert ? 'Revert failed' : 'Cherry-pick failed'), text: text.join('\n'),
      actions: [{ label: labels.go || t(revert ? 'Continue Revert' : 'Continue Cherry-Pick'), run: () => A.continueOp() },
        { label: t('Skip Commit'), run: () => A.skipCommit() },
        { label: labels.stop || t(revert ? 'Abort Revert' : 'Abort Cherry-Pick'), run: () => A.abortOp() }] });
  };
  const listOf = (paths) => paths.slice(0, 10).join('\n') + (paths.length > 10 ? '\n…' : '');
  /** IntelliJ's lines for content in the way of `what` (a Would-overwrite answer): local changes of tracked files
      ("Your local changes would be overwritten by …") and content git does not track, ignored files included
      (GitUntrackedFilesHelper: "The following untracked working tree files would be overwritten by …"). */
  function overwriteLines(what, res) {
    const files = res.files || [], untracked = res.untracked || [];
    const text = [];
    if (files.length || !untracked.length) {
      text.push(t('Your local changes would be overwritten by {0}.', what), t('Commit your changes or stash them to proceed.'));
      if (files.length) text.push(listOf(files));
    }
    if (untracked.length) text.push(t('The following untracked working tree files would be overwritten by {0}:', what), listOf(untracked), t('Please move or remove them before you can {0}.', what));
    return text;
  }
  A.overwriteLines = overwriteLines;
  /** op.continue / op.skip of a rebase answered `stopped` with `reason: 'would-overwrite'`: the commits still ahead would
      overwrite content in the work tree; nothing ran (op.skip skipped nothing: `skippedId` null). The rebase waits. */
  function rebaseBlocked(res) {
    Git.notify({ kind: 'error', sticky: true, whileOp: true, title: t('Rebase failed'), text: overwriteLines(t('rebase'), res).join('\n'),
      actions: [{ label: t('Continue Rebase'), run: () => A.continueOp() }, { label: t('Abort Rebase'), run: () => A.abortOp() }] });
  }
  /** Continue at an edit stop with changes not committed (refused `uncommitted_changes`): what to do first. */
  function uncommittedNotice(err) {
    const paths = (err && err.data && err.data.paths) || [];
    Git.notify({ kind: 'error', title: t('Cannot continue rebase'),
      text: t('You have uncommitted changes. Commit them (Amend changes the stopped commit) or roll them back, then continue the rebase.')
        + (paths.length ? '\n' + paths.slice(0, 10).join('\n') + (paths.length > 10 ? '\n…' : '') : ''),
      actions: [{ label: t('Commit…'), run: () => { if (A.checkinProject) A.checkinProject(); } }] });
  }
  /** A "Restore" (Geri getir) action for a trash entry an operation saved first. */
  A.restoreAction = function (trash) {
    if (!trash || !trash.id) return null;
    return { label: t('Restore'), run: () => A.restoreTrash(trash) };   // one "Geri getir" for every area (actions-history.js)
  };
  const withRestore = (trash, list) => (list || []).concat(A.restoreAction(trash) ? [A.restoreAction(trash)] : []);

  /** An A.run `onError` that shows git's failure under IntelliJ's own title ("Could not checkout x"); other codes as usual. */
  A.failAs = (title) => (err) => {
    if (!err || err.code !== 'git_failed') return false;
    const text = String((err.data && err.data.stderr) || '').replace(/\s+$/, '').split('\n').slice(-8).join('\n');
    Git.notify({ kind: 'error', title, text: text || null });
    return true;
  };

  // ---------------------------------------------------------------- outcomes
  let pendingDone = null;
  /**
   * The outcome of a command that may stop half way. `o.done(res)` runs on success (now or after the conflicts are
   * resolved and the operation continued). Conflicts open the Conflicts dialog; an `edit` stop shows its notice.
   */
  A.settle = function (res, o) {
    o = typeof o === 'function' ? { done: o } : o || {};
    if (!res) return;
    if (res.result === 'conflicts') {
      if (o.context && !R.op) A.conflictContext(o.context);
      pendingDone = o.done || null;
      // the snapshot that lists the conflicts arrives with the engine's `changed` event; the "… with Conflicts"
      // notification comes when the dialog is closed with conflicts left (IntelliJ: "you will be prompted to resolve them")
      whenState(() => Git.conflicts().length > 0, () => A.resolveConflicts());
      return;
    }
    if (res.result === 'stopped') { pendingDone = o.done || null; editNotice(); return; }
    // done, but the local changes stashed for it may not have come back (`autostash: 'conflicts'`): said once, here
    if (o.done) o.done(res);
    A.autostashConflicts(res, { operation: o.operation, from: o.from });
  };
  /** Runs `fn` once `cond` holds after the store moved (or right away). */
  function whenState(cond, fn) {
    if (cond()) { fn(); return; }
    const off = Git.on('change', () => { if (cond()) { off(); clearTimeout(timer); fn(); } });
    const timer = setTimeout(off, 8000);
  }
  A.whenState = whenState;

  // ---------------------------------------------------------------- Conflicts dialog / continue / abort / skip
  A.resolveConflicts = function (done) {
    if (done) pendingDone = done;
    if (!Git.conflicts().length) { if (R.op) A.continueOp(); return; }
    if (Git.dialogs.conflicts) Git.dialogs.conflicts({ onClose: (finished) => { if (finished) afterResolved(); else stoppedNotice(); } });
    else stoppedNotice();
  };
  /** The last conflict is gone: an operation continues (IntelliJ proceeds after "Accept and Finish"). */
  function afterResolved() {
    if (Git.conflicts().length) { stoppedNotice(); return; }
    if (R.op) { A.continueOp(); return; }
    A.conflictContext(null);
    const done = pendingDone;
    pendingDone = null;
    if (done) done({ result: 'resolved' });
  }
  A.afterResolved = afterResolved;

  function opDone(type, res) {
    const done = pendingDone;
    pendingDone = null;
    if (done) { done(res); return; }
    if (type === 'rebase') ok(t('Rebase successful'), res.branch ? t('Rebased {0} on {1}', res.branch, nameAt(res.onto)) : null);
    else if (type === 'merge') ok(t('Merged {0} to {1}', res.source || '', A.current()));
    else if (type === 'revert') ok(t('Revert successful'));
    else ok(t('Cherry-pick successful'));
  }
  function onStep(type, res) {
    if (!res) return;
    if (res.result === 'conflicts') { whenState(() => Git.conflicts().length > 0, () => A.resolveConflicts()); return; }
    if (res.result === 'stopped') {
      // a cherry-pick / revert sequence that met local changes again; a rebase whose commits ahead would overwrite
      // content in the work tree (the work tree guard: nothing ran); a rebase at an edit stop
      if (res.reason === 'would-overwrite') {
        if (type === 'rebase' || type === 'am') rebaseBlocked(res); else A.sequenceStopped(type, res);
      } else editNotice();
      return;
    }
    opDone(type, res);
    A.autostashConflicts(res, { operation: type === 'merge' ? 'merge' : 'rebase', from: type === 'merge' ? res.source : nameAt(res.onto) || res.branch });
  }
  A.continueOp = function (o) {
    const op = R.op;
    if (!op) return null;
    if (op.incomplete) { A.incompleteNotice(op.type); return null; }
    if (Git.conflicts().length) { A.resolveConflicts(); return null; }
    const source = op.type === 'merge' ? labelOf(op.theirs) : null;
    const title = op.type === 'rebase' ? t('Continue Rebase') : op.type === 'merge' ? t('Commit') : op.type === 'revert' ? t('Continue Revert') : t('Continue Cherry-Pick');
    return A.run({ id: 'op', title, method: 'op.continue', params: o && o.message ? { message: o.message } : {},
      refused: (reason, err) => {
        if (reason === 'unresolved_conflicts') { A.resolveConflicts(); return true; }
        if (reason === 'no_operation') { info(t('No rebase in progress')); return true; }
        if (reason === 'uncommitted_changes') { uncommittedNotice(err); return true; }
        if (reason === 'incomplete_operation') { A.incompleteNotice((err.data && err.data.type) || op.type); return true; }
        return false;
      } })
      .then((res) => { if (res) onStep(op.type, Object.assign({ source }, res)); return res; });
  };
  const ABORTED = { rebase: 'Rebase aborted', merge: 'Merge aborted', 'cherry-pick': 'Cherry-pick aborted', revert: 'Revert aborted' };
  const ENDED = { rebase: 'Rebase ended', merge: 'Merge ended', 'cherry-pick': 'Cherry-pick ended', revert: 'Revert ended' };
  /** The notice for op.abort's result (PROTOCOL op.abort): `aborted` (HEAD back where the operation started), `ended`
      (git rewound nothing: HEAD had moved, "You seem to have moved HEAD"), what git had left half-made, the commit the
      operation itself had made and took back (`undone`: commit.fixup), and the local changes (autostash). */
  function abortedNotice(res) {
    const type = res.type || 'rebase';
    const lines = [];
    if (res.result === 'ended') lines.push(t('You seem to have moved HEAD. Not rewinding, check your HEAD!'), t('The commits made so far stay; nothing was thrown away.'));
    if (res.undone) lines.push(t('The commit {0} it had made was taken back: the branch is where it was before, its changes are local changes again.', short(res.undone)));
    if (res.incomplete && res.autostash === 'applied') lines.push(t('The local changes it had stashed are back in the working tree.'));
    const title = t((res.result === 'ended' ? ENDED : ABORTED)[type] || 'Rebase aborted');
    info(title, lines.join('\n') || null, withRestore(res.trash));
    // the local changes stashed for the operation: kept as stash@{0} (`stashed`) or back with conflicts (`conflicts`)
    A.autostashConflicts(res, { operation: type === 'merge' ? 'merge' : 'rebase', from: A.current() });
  }
  A.abortedNotice = abortedNotice;
  A.abortOp = function () {
    const op = R.op;
    if (!op) return;
    const labels = A.opLabels();
    // Every operation asks first (GitAbortOperationAction: "Abort {0}{1}?", the repository named only when there are
    // several; a rebase: GitAbortRebaseProcess "Abort rebase in {0}?").
    const rebase = op.type === 'rebase' || op.type === 'am';
    Git.confirm({ title: labels.stop, text: rebase ? t('Abort rebase in {0}?', R.name) : t('Abort {0}{1}?', t(op.type), ''), yes: t('Abort'),
      onYes: () => {
        pendingDone = null;
        A.run({ id: 'op', title: labels.stop, method: 'op.abort' }).then((res) => { if (res) abortedNotice(res); });
      } });
  };
  A.skipCommit = function () {
    const op = R.op;
    if (!op || op.type === 'merge') return null;
    if (op.incomplete) { A.incompleteNotice(op.type); return null; }
    return A.run({ id: 'op', title: t('Skip Commit'), method: 'op.skip',
      refused: (reason, err) => (reason === 'incomplete_operation' ? (A.incompleteNotice((err.data && err.data.type) || op.type), true) : false) })
      .then((res) => { if (res) onStep(res.type || op.type, res); return res; });
  };

  // ---------------------------------------------------------------- per-file resolution
  // A file counts as resolved before the answer comes: the `changed` event that drops it from the conflicts can arrive
  // first, and the Conflicts dialog must not take "no conflicts, nothing resolved" for "nothing to do".
  const unmark = (paths, key) => { const set = resolved.get(key); if (set) paths.forEach((p) => set.delete(p)); };
  A.acceptSide = function (paths, side) {
    const key = A.opKey();
    markResolved(paths, key);
    return A.run({ title: side === 'yours' ? t('Accept Yours') : t('Accept Theirs'), method: 'conflict.accept', params: { paths, side } })
      .then((res) => { if (!res) unmark(paths, key); return res; });
  };
  A.resolveText = function (path, text, o) {
    const key = A.opKey();
    const params = { path, text };
    if (o && o.encoding === 'latin1') params.encoding = 'latin1';
    if (o && o.bom) params.bom = true;
    markResolved([path], key);
    return A.run({ title: t('Apply'), method: 'conflict.resolve', params })
      .then((res) => {
        if (!res) { unmark([path], key); return res; }
        // what the file held (the markers, anything typed between them) was saved first: the way back
        if (res.trash && res.trash.id) info(t('Conflict resolved: {0}', Git.fileName(path)), null, withRestore(res.trash));
        return res;
      });
  };
  A.unresolve = function (path) {
    return A.run({ title: t('Revert Conflict Resolution'), method: 'conflict.unresolve', params: { path } })
      .then((res) => { if (res) { const set = resolved.get(A.opKey()); if (set) set.delete(path); } return res; });
  };

  // ---------------------------------------------------------------- interactive rebase
  /** "Rebasing Published Commit": asks, then runs `again()` with allowPushed. */
  A.confirmPublished = function (again) {
    Git.confirm({ title: t('Rebasing Published Commit'), width: 480, yes: t('Rebase Anyway'), no: t('Cancel'),
      text: t('You are trying to rebase some commits already pushed to a protected branch.'),
      detail: t('Rebasing them would duplicate commits, which is not recommended and most likely unwanted.'), onYes: again });
  };
  /** Start Rebasing of the Rebasing Commits dialog. `p`: { base, entries, head } or { onto, upstream, branch, entries,
      head } (`onto` / `upstream`: ref pairs or typed text, `branch`: a local branch); `head` is the commit the plan was
      made for (the engine refuses with head_moved when the branch moved meanwhile). */
  A.rebaseInteractive = function (p, allowPushed) {
    if (A.blockedByOp()) return Promise.resolve(null);
    const onto = p.onto != null;
    const params = onto ? { onto: A.wire(p.onto), upstream: A.wire(p.upstream || p.onto), entries: p.entries } : { base: p.base, entries: p.entries };
    if (onto && p.branch) params.branch = A.wire(A.localOf(p.branch));
    if (onto) (A.REBASE_FLAGS || []).forEach((k) => { if (p[k]) params[k] = true; });   // the Rebase dialog's options
    if (p.head) params.head = p.head;
    if (allowPushed) params.allowPushed = true;
    const branch = p.branch ? A.localOf(p.branch).name : A.current();
    return A.run({ id: 'rebase', title: t('Rebase'), method: onto ? 'rebase.applyOnto' : 'rebase.apply', params, onError: A.failAs(t('Interactive rebase failed')),
      refused: (reason) => {
        if (reason === 'pushed_to_protected') { A.confirmPublished(() => A.rebaseInteractive(p, true)); return true; }
        if (reason === 'op_in_progress' || reason === 'unmerged_files') { A.blockedByOp(); return true; }
        return false;
      } })
      .then((res) => {
        if (!res) return res;
        if (res.result === 'would-overwrite') { if (Git.dialogs.problem) Git.dialogs.problem({ op: 'Rebase', files: res.files, untracked: res.untracked }); return res; }
        A.settle(res, { done: () => ok(t('Rebase successful'), onto ? t('Rebased {0} on {1}', branch, A.refLabel(p.onto)) : null) });
        return res;
      });
  };
})();
