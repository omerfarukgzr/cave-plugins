/* The command core. Every button and menu item calls a Git.actions.<name>(…) command (actions-changes.js,
   actions-history.js, actions-branches.js); a command that talks to the engine goes through A.run:

     A.run({ id?, title, method, params, quiet?, failTitle?, cancelTitle?, onError?(err) -> true when handled, refused?(reason, err) })
       -> Promise<result | null>   (`cancelTitle`: IntelliJ's own "… canceled" info for a `cancelled` error)
       - the same command (method + params) again while it runs returns the running promise (a second click);
         another command under the same explicit `id` while one runs is turned away (notice "Another Git operation
         is running", null) — await a command before starting the next of its group; without `id` different
         commands run independently (the engine queues mutating calls)
       - while it runs: Git.emit('busy'), and a progress balloon for the engine's job/progress events once a job runs
         longer than A.JOB_DELAY (Cancel while the job is cancellable: job.cancel)
       - on failure: IntelliJ's error notification for the error `code` (never the message text) and null; content a
         failed / cancelled operation saved (`data.trash`: Restore) or stashed (`data.autostash`) is added to that
         notification here, for every command (a command that shows none gets a notice of its own); the store
         refreshes from the `changed` event that follows a mutating method, so commands never patch Git.repo
     A.running() -> [ids] · A.mountGuarded(view, el, arg, name)
     A.errorNotice(err, title, failTitle?) · A.errorText(err) · A.blockedByOp() · A.current() (current branch or "Detached HEAD") · A.ok/info/warn
     A.autostashConflicts(res, { operation, from }) (the one notice for `autostash: 'conflicts'` and 'stashed')
     A.incompleteText(type) · A.incompleteNotice(type) (an operation git left half-made: snapshot `op.incomplete`)
     Refs: A.ref(kind, name) · A.typed(text) · A.asRef(x) · A.wire(ref) (the one way to a full ref) · A.refLabel(ref) ·
     A.sameRef · A.refId · A.currentRef() · favorites: A.isFavorite(ref) · A.favKey(ref) · A.favorites() · A.sequence(items, fn)

   Exclusive groups (the `id` of A.run): an explicit id is a group whose commands must not overlap, because a second one
   would act on the state the first is changing: 'op' (continue / abort / skip), 'checkout', 'merge', 'rebase',
   'update', 'fetch', 'push' (branch, tag, push.upTo, push.commits), 'reset', 'cherryPick', 'revert', 'commit.*' and
   'rebase.apply' (history edits), 'changes.commit', 'undo-edit', 'changes.applyFromCommit', 'changes.getFromRevision',
   'changes.revertFromCommit', 'rebase.planOnto'. Per-object ids ('changes.write:<path>', 'conflict.read:<path>',
   'branch.setFavorite:<kind>:<name>', 'trash.restore:<id>') only stop a double run of the same thing. Commands on
   independent objects carry NO id (branch.create / delete / rename, tag.create / delete / deleteRemote, conflict.accept
   / resolve / unresolve): two of them may run together, the engine queues them. Rule for callers: a loop or a chain
   over one group (several branches, several remotes, update → push, fetch → merge) awaits each command before the
   next (A.sequence) and reports ONE outcome for the whole loop. */
(function () {
  'use strict';
  const Git = window.Git;
  const R = Git.repo;
  const t = (...a) => Git.t(...a);
  const A = (Git.actions = Git.actions || {});
  Git.dialogs = Git.dialogs || {};
  Git.views = Git.views || {};

  Git.addTR({
    '{0} file committed: {1}': '{0} dosya commitlendi: {1}', '{0} files committed: {1}': '{0} dosya commitlendi: {1}',
    'Amended commit: {0}': 'Commit düzeltildi (amend): {0}', 'Checked out {0}': 'Checkout yapıldı: {0}', 'Rollback': 'Geri al',
    'Branch {0} was created': '{0} dalı oluşturuldu', 'Branch {0} was renamed to {1}': '{0} dalının adı {1} oldu',
    'Deleted Branch: {0}': 'Dal silindi: {0}', 'Unmerged commits were discarded': 'Birleştirilmemiş commit\'ler atıldı',
    'Restore': 'Geri getir', 'View Commits': 'Commit\'leri göster', 'Delete Tracked Branch': 'İzlenen uzak dalı da sil',
    'Deleted remote branch {0}': 'Uzak dal silindi: {0}', 'Merged {0} to {1}': '{0}, {1} içine merge edildi', 'Delete {0}': '{0} dalını sil',
    'Already up to date': 'Zaten güncel', '{0} Merged with Conflicts': '{0} çakışmalarla merge edildi', 'Resolve…': 'Çöz…',
    'Rebase successful': 'Rebase tamamlandı', 'Rebased {0} on {1}': '{0}, {1} üzerine rebase edildi',
    'Checked out {0} and rebased it on {1}': '{0} checkout yapıldı ve {1} üzerine rebase edildi', '{0} is up-to-date with {1}': '{0}, {1} ile zaten güncel',
    'Rebase stopped due to conflicts': 'Rebase çakışma yüzünden durdu', 'Continue': 'Devam et', 'Abort': 'İptal et',
    'Rebase aborted': 'Rebase iptal edildi', 'Merge aborted': 'Merge iptal edildi', 'Cherry-pick aborted': 'Cherry-pick iptal edildi',
    'Cherry-pick successful': 'Cherry-pick tamamlandı', 'Cherry-pick was performed with conflicts': 'Cherry-pick çakışmalarla yapıldı',
    'There are unresolved conflicts in the working tree.': 'Çalışma kopyasında çözülmemiş çakışmalar var.', 'Abort cherry-pick': 'Cherry-pick\'i iptal et',
    'Revert successful': 'Revert tamamlandı', 'Reset successful': 'Reset tamamlandı', 'Fetch successful': 'Fetch tamamlandı',
    'All files are up-to-date': 'Bütün dosyalar güncel',
    '{0} file updated in {1} commit': '{0} dosya {1} commit ile güncellendi', '{0} files updated in {1} commit': '{0} dosya {1} commit ile güncellendi',
    '{0} file updated in {1} commits': '{0} dosya {1} commit ile güncellendi', '{0} files updated in {1} commits': '{0} dosya {1} commit ile güncellendi',
    'Pushed {0} commit to {1}': '{0} commit {1} dalına push edildi', 'Pushed {0} commits to {1}': '{0} commit {1} dalına push edildi',
    'Pushed {0} to new branch {1}': '{0}, yeni {1} dalına push edildi', 'Everything is up to date': 'Her şey güncel',
    'Push rejected': 'Push reddedildi', 'Push successful': 'Push tamamlandı', 'Tag {0} created': '{0} etiketi oluşturuldu',
    'Deleted tag {0}': 'Etiket silindi: {0}', 'Commit message changed': 'Commit mesajı değişti',
    'Merging {0}': 'Merge: {0}', 'Rebasing {0}': 'Rebase: {0}', 'Cherry-picking in {0}': 'Cherry-pick: {0}', 'Reverting in {0}': 'Revert: {0}',
    'Resolve Conflicts': 'Çakışmaları çöz', 'Continue Rebase': 'Rebase\'e devam et', 'Continue Cherry-Pick': 'Cherry-pick\'e devam et',
    'Continue Revert': 'Revert\'e devam et', 'Abort Merge': 'Merge\'i iptal et', 'Abort Rebase': 'Rebase\'i iptal et',
    'Abort Cherry-Pick': 'Cherry-pick\'i iptal et', 'Abort Revert': 'Revert\'i iptal et', 'Skip Commit': 'Commit\'i atla',
    'Cannot checkout because of unmerged files': 'Birleştirilmemiş dosyalar yüzünden checkout yapılamıyor',
    'You need to resolve all merge conflicts before checkout.': 'Checkout\'tan önce bütün çakışmaları çözmen gerekiyor.',
    'Resolve conflicts…': 'Çakışmaları çöz…', 'Copied {0}': '{0} kopyalandı', 'Detached HEAD': 'Ayrık HEAD', 'Changes': 'Değişiklikler',
    'Nothing to cherry-pick': 'Cherry-pick edilecek bir şey yok', 'History: {0}': 'Geçmiş: {0}',
    // the command core
    '{0} failed': '{0} başarısız oldu', '{0} cancelled': '{0} iptal edildi', '{0} canceled': '{0} iptal edildi', 'Commit canceled': 'Commit iptal edildi', '{0} timed out': '{0} zaman aşımına uğradı',
    'Not a Git repository': 'Git deposu değil', 'Cannot reach the {0} server': '{0} sunucusuna ulaşılamıyor',
    'Not found': 'Bulunamadı', 'Another Git operation is running': 'Başka bir Git işlemi sürüyor', 'Cancel': 'Vazgeç',
    'Git operation': 'Git işlemi',
  });

  // ---------------------------------------------------------------- small notices
  A.ok = (title, text, actions) => Git.notify({ kind: 'success', title, text, actions });
  A.info = (title, text, actions) => Git.notify({ kind: 'info', title, text, actions });
  A.warn = (title, text, actions) => Git.notify({ kind: 'warning', title, text, actions, sticky: true, whileOp: true });
  A.plural = (n, one, many) => (n === 1 ? one : many);
  A.current = () => R.head.branch || t('Detached HEAD');

  // ---------------------------------------------------------------- refs (docs/PROTOCOL.md Ref names)
  // Inside the UI a ref is a pair { kind: 'local'|'remote'|'tag', name } from the moment it is read from the snapshot (a
  // row of the Branches popup or of the Log's pane, a ref label, a menu, a chooser's list) until the engine call. `name`
  // is the snapshot's key (R.branches / R.remotes / R.tags) and nothing is ever read from it: a local branch named
  // `refs/heads/x`, `refs/remotes/origin/main`, `origin/main`, `-x` or `HEAD` is that local branch. A revision that is
  // no ref (a commit id, `main~2`) is { kind: 'revision', name }. A.wire(ref) is the ONE function that turns a pair
  // into what the engine gets (`refs/heads/` + name, …). A string handed to a command is text the user typed (or an id)
  // and is resolved once, against the snapshot (A.typed): a local branch of that name, else a remote branch, else a
  // tag, else a revision sent exactly as typed. No function takes "a name that may already be a full ref".
  const own = (map, k) => Object.prototype.hasOwnProperty.call(map || {}, k);
  const PREFIX = { local: 'refs/heads/', remote: 'refs/remotes/', tag: 'refs/tags/' };
  A.ref = (kind, name) => ({ kind, name: String(name) });
  /** Typed text -> a pair: local, then remote, then tag, else { kind: 'revision', name: text } (sent as typed). */
  A.typed = function (text) {
    const v = String(text == null ? '' : text).trim();
    if (own(R.branches, v)) return A.ref('local', v);
    if (own(R.remotes, v)) return A.ref('remote', v);
    if (own(R.tags, v)) return A.ref('tag', v);
    return A.ref('revision', v);
  };
  const isPair = (x) => !!x && typeof x === 'object' && typeof x.kind === 'string' && typeof x.name === 'string';
  /** A pair as it is; a string is typed text (A.typed). */
  A.asRef = (x) => (isPair(x) ? x : A.typed(x));
  /** THE wire form: 'refs/heads/<name>' | 'refs/remotes/<name>' | 'refs/tags/<name>' | the revision as typed. */
  A.wire = (x) => { const r = A.asRef(x); return own(PREFIX, r.kind) ? PREFIX[r.kind] + r.name : r.name; };
  /** A command that only works on a local branch (update, push, rename, Checkout and Update) takes its pair or its
      name: the name is the local branch's, never a full ref. */
  A.localOf = (x) => (isPair(x) ? x : A.ref('local', String(x)));
  /** How a ref is named on screen: its name; a commit id shortened. */
  A.refLabel = (x) => { const r = A.asRef(x); return r.kind === 'revision' && /^[0-9a-f]{40}$/.test(r.name) ? Git.short(r.name) : r.name; };
  A.sameRef = (a, b) => !!a && !!b && A.wire(a) === A.wire(b);
  /** The commit a ref names now (null when it is gone). Git.refId reads full refs exactly. */
  A.refId = (x) => Git.refId(A.wire(x));
  /** The current branch as a pair (null on a detached HEAD). */
  A.currentRef = () => (R.head.branch ? A.ref('local', R.head.branch) : null);
  // Favorites: branch.setFavorite keeps plain strings and stores a local branch by its short name. A remote branch is
  // stored as `.remotes/<name>`: no local branch name can start with '.' (git check-ref-format), so a local `origin/x`
  // and the remote `origin/x` never share a star.
  const FAV_REMOTE = '.remotes/';
  A.favKey = (ref) => (ref.kind === 'remote' ? FAV_REMOTE + ref.name : ref.name);
  A.isFavorite = (ref) => !!ref && (ref.kind === 'local' || ref.kind === 'remote') && !!R.favorites && R.favorites.has(A.favKey(ref));
  /** The favorites that still exist, as pairs (local ones first, in the stored order). */
  A.favorites = function () {
    const out = [];
    (R.favorites ? Array.from(R.favorites) : []).forEach((k) => {
      const r = k.indexOf(FAV_REMOTE) === 0 ? A.ref('remote', k.slice(FAV_REMOTE.length)) : A.ref('local', k);
      if ((r.kind === 'local' ? own(R.branches, r.name) : own(R.remotes, r.name))) out.push(r);
    });
    return out.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'local' ? -1 : 1));
  };
  // A dialog built from the snapshot acts later: it sends what it showed (ids, refs) and, when what it showed is no
  // longer so, says so instead of acting on something else.
  /** What is current: the branch, or (detached) the commit. */
  A.headMark = () => ({ branch: R.head.branch || null, id: R.head.branch ? null : R.headId || null });
  /** True while `mark` (A.headMark() when the dialog opened) is still current; otherwise a notice and false. */
  A.stillCurrent = function (mark, what) {
    if (!mark) return true;
    const now = A.headMark();
    if (now.branch === mark.branch && now.id === mark.id) return true;
    const was = mark.branch || Git.short(mark.id || ''), is = now.branch || Git.short(now.id || '');
    Git.notify({ kind: 'warning', title: t('{0} cancelled', what || t('Git operation')),
      text: t('The current branch changed after the dialog opened ({0} → {1}). Nothing was done.', was, is) });
    return false;
  };
  /** Runs `fn(item)` for each item one after another (a group's commands must not overlap; see A.run) -> results. */
  A.sequence = async function (items, fn) {
    const out = [];
    for (const x of items) out.push(await fn(x));
    return out;
  };
  A.blockedByOp = function () {
    if (!R.op) return false;
    if (R.op.incomplete) { A.incompleteNotice(R.op.type); return true; }
    Git.notify({ kind: 'error', title: t('Cannot checkout because of unmerged files'), text: t('You need to resolve all merge conflicts before checkout.'),
      actions: [{ label: t('Resolve conflicts…'), run: () => A.resolveConflicts() }] });
    return true;
  };
  // ---------------------------------------------------------------- an operation git left half-made (op.incomplete)
  /** The sentence for a rebase / merge git left half-made (snapshot `op.incomplete`; refusals `incomplete_operation`
      and `op_in_progress` with `data.incomplete`): only Abort applies, and it brings the stashed local changes back. */
  A.incompleteText = (type) => t(type === 'merge' ? 'Git left an unfinished merge behind: only the local changes it stashed are there, nothing was merged. Abort it to get the local changes back.'
    : 'Git left an unfinished rebase behind: only the local changes it stashed are there, no commit was rebased. Abort it to get the local changes back.');
  A.incompleteNotice = function (type) {
    Git.notify({ kind: 'warning', sticky: true, whileOp: true, title: t(type === 'merge' ? 'Unfinished merge' : 'Unfinished rebase'), text: A.incompleteText(type),
      actions: A.abortOp ? [{ label: t('Abort'), run: () => A.abortOp() }] : null });
  };
  Git.addTR({
    'Unfinished merge': 'Yarım kalmış merge', 'Unfinished rebase': 'Yarım kalmış rebase',
    'Git left an unfinished merge behind: only the local changes it stashed are there, nothing was merged. Abort it to get the local changes back.':
      'Git yarım kalmış bir merge bıraktı: yalnızca stash\'e aldığı yerel değişiklikler duruyor, hiçbir şey merge edilmedi. Yerel değişiklikleri geri almak için iptal et.',
    'Git left an unfinished rebase behind: only the local changes it stashed are there, no commit was rebased. Abort it to get the local changes back.':
      'Git yarım kalmış bir rebase bıraktı: yalnızca stash\'e aldığı yerel değişiklikler duruyor, hiçbir commit rebase edilmedi. Yerel değişiklikleri geri almak için iptal et.',
  });
  /** Mounts a tool window view: a throw while it builds becomes a visible state, not a blank tab. */
  A.mountGuarded = function (view, el, arg, name) {
    try { return view.mount(el, arg); } catch (e) { Git.clear(el).appendChild(Git.content.failed(e, t('{0} failed', name || t('Git operation')))); return null; }
  };

  // ---------------------------------------------------------------- local changes stashed for an operation
  /**
   * The one notice for `autostash: 'conflicts'` (docs/PROTOCOL.md Autostash): the operation itself succeeded, but the
   * local changes stashed for it could not be put back — they stay in the stash and the work tree has conflicts. Every
   * command whose result carries `autostash` calls this after its own success notice: update, merge (Smart), rebase,
   * rebase.apply / applyOnto, the history edits (reword, drop, fixup, squash), op.continue / op.skip and the commit that
   * concludes a merge. IntelliJ's restore conflict (GitPreservingProcess): the Conflicts dialog opens by itself with
   * "Uncommitted changes that were saved before {0} have conflicts with files from {1}"; the balloon keeps Resolve….
   * `o`: { operation: 'update'|'merge'|'rebase', from: what the operation brought in (a branch name) }. True when shown.
   */
  A.autostashConflicts = function (res, o) {
    if (res && res.autostash === 'stashed') return A.autostashKept(o);
    if (!res || res.autostash !== 'conflicts') return false;
    o = o || {};
    const operation = o.operation || 'rebase', from = o.from || A.current();
    if (A.conflictContext) A.conflictContext({ kind: 'restore', operation, from });
    const resolve = () => { if (A.resolveConflicts) A.resolveConflicts(); };
    Git.notify({ kind: 'warning', sticky: true, title: t('Local changes were not restored'),
      text: t('Uncommitted changes that were saved before {0} have conflicts with files from {1}', t(operation), from) + '\n' + t('They are kept in {0}.', 'stash@{0}'),
      actions: [{ label: t('Resolve…'), run: resolve }].concat(viewSaved(o.stash)) });
    // the snapshot that lists the conflicted files arrives with the engine's `changed` event
    if (A.whenState) A.whenState(() => Git.conflicts().length > 0, resolve);
    return true;
  };
  /** `autostash: 'stashed'`: the local changes are in the stash list, NOT applied (the work tree had other changes by
      then, so nothing was put over them; no conflict markers). The stash is kept as stash@{0}; there is no stash UI
      The notice names the entry and offers IntelliJ's "View saved changes…" (the Stash tab: Pop brings them back). */
  A.autostashKept = function (o) {
    Git.notify({ kind: 'warning', sticky: true, title: t('Local changes were not restored'),
      text: t('They are kept in {0}.', 'stash@{0}') + '\n' + t('The working tree has other changes now, so they were not applied over them. Run {0} to get them back.', 'git stash pop'),
      actions: viewSaved(o && o.stash) });
    return true;
  };
  /** IntelliJ's "View saved changes…" (GB stash.unstash.unresolved.conflict.warning.notification.show.stash.action). */
  const viewSaved = (id) => (A.showStashes ? [{ label: t('View saved changes…'), run: () => A.showStashes(id || null) }] : []);
  Git.addTR({
    'The working tree has other changes now, so they were not applied over them. Run {0} to get them back.':
      'Çalışma kopyasında artık başka değişiklikler var; onların üzerine uygulanmadılar. Geri almak için {0} çalıştır.',
    'Local changes were not restored': 'Yerel değişiklikler geri getirilemedi',
    'Uncommitted changes that were saved before {0} have conflicts with files from {1}': 'Commit\'lenmemiş değişiklikler {0} öncesinde saklanmıştı; {1} dosyalarıyla çakışıyorlar',
    'They are kept in {0}.': '{0} içinde duruyorlar.',
  });

  // ---------------------------------------------------------------- errors
  const tail = (s, n) => String(s || '').replace(/\s+$/, '').split('\n').slice(-n).join('\n');
  /** IntelliJ's error notification for an engine error. Decides by `code` only. `title` names the command ("{0}
      failed", "{0} cancelled"); `failed`, when given, is the whole failure title ("Revert failed", "Could not Drop
      Commits": A.run's `failTitle`), used as it is. */
  A.errorNotice = function (err, title, failed) {
    const code = (err && err.code) || 'internal', data = (err && err.data) || {};
    const what = title || t('Git operation');
    const fail = failed || t('{0} failed', what);
    if (code === 'cancelled') return A.info(t('{0} cancelled', what));
    if (code === 'git_failed') return Git.notify({ kind: 'error', title: fail, text: tail(data.stderr, 8) || null });
    if (code === 'timeout') return Git.notify({ kind: 'error', title: t('{0} timed out', what), text: data.command || null });
    if (code === 'not_a_repo') return Git.notify({ kind: 'error', title: t('Not a Git repository'), text: data.path || null });
    if (code === 'unreachable' || code === 'transport') return Git.notify({ kind: 'error', title: t('Cannot reach the {0} server', Git.product()),
      actions: [{ label: t('Retry'), run: () => { if (Git.backend.reconnect) Git.backend.reconnect(); } }] });
    if (code === 'not_found') return Git.notify({ kind: 'error', title: fail, text: A.errorText(err) });
    if (code === 'busy') return Git.notify({ kind: 'warning', title: t('Another Git operation is running') });
    if (code === 'refused') return Git.notify({ kind: 'warning', title: fail, text: A.errorText(err) });
    return Git.notify({ kind: 'error', title: fail, text: A.errorText(err) });
  };
  /** A sentence for an error no command gave its own text for: never the bare code (`head_moved`, `invalid_params`). */
  const list = (paths) => (paths || []).slice(0, 5).join(', ') + ((paths || []).length > 5 ? ', …' : '');
  const REASONS = {
    op_in_progress: (d) => (d.incomplete ? [A.incompleteText(d.type)] : ['Another Git operation is in progress: {0}', d.type || '']),
    incomplete_operation: (d) => [A.incompleteText(d.type)],
    special_file: (d) => ['{0}: a FIFO, socket or device file is in the way. It cannot be saved to the trash, so nothing was changed. Remove it yourself, then try again.', list(d.paths)],
    not_ignorable: (d) => ['{0}: a file name with a line break cannot be written to .gitignore. Nothing was added.', list(d.paths)],
    unmerged_files: () => ['There are unmerged files. Resolve the conflicts first.'],
    unresolved_conflicts: () => ['There are unmerged files. Resolve the conflicts first.'],
    unborn: () => ['The branch has no commits yet'],
    detached: () => ['HEAD is detached'],
    exists: (d) => ['{0} already exists', d.branch || d.tag || d.name || ''],
    current_branch: (d) => ['{0} is the current branch', d.branch || ''],
    checked_out_elsewhere: (d) => ['{0} is checked out in another worktree: {1}', d.branch || '', d.path || ''],
    no_remotes: () => ['No remotes'],
    no_operation: () => ['No operation is in progress'],
    head_moved: () => ['The repository has changed in the meantime. Try again.'],
    uncommitted_changes: () => ['You have uncommitted changes. Commit them (Amend changes the stopped commit) or roll them back, then continue the rebase.'],
    merge_commit: () => ['The commit has more than one parent'],
    not_in_current_branch: () => ['The commit is not in the current branch'],
    changed_on_disk: (d) => ['{0} has changed on disk. Try again.', d.path || ''],
    nothing_to_commit: () => ['Nothing to commit'],
    nothing_to_amend: () => ['There is no commit to amend yet'],
    empty_message: () => ['Empty commit message'],
    nothing_left: () => ['Dropping every commit of the branch would leave it empty'],
    not_in_branch: () => ['The commit is not in the current branch'],
    protected_branch: (d) => ['Force push to the protected branch {0} is not allowed', d.target || ''],
    // engine errors a user can meet through a field: a name or revision typed in New Branch / Tag / Rename / Push
    // target / Checkout revision, a revision or path that is not there (the engine's English sentence is the last resort)
    not_found: (d) => (d.path && !d.rev ? ['Cannot find file: {0}', d.path] : d.rev ? ['Revision not found: {0}', d.rev] : ['Not found']),
    invalid_params: (d) => (d.reason === 'invalid ref name' ? ['This is not a valid branch or tag name']
      : /revision/.test(d.reason || '') ? ['Revision not found'] : d.reason === 'escapes' || /path/.test(d.reason || '') || d.param === 'path' || d.param === 'paths' ? ['The path is not valid']
        : null),
  };
  A.errorText = function (err) {
    const code = (err && err.code) || 'internal', data = (err && err.data) || {};
    const key = code === 'refused' ? data.reason : code;
    const reason = key && Object.prototype.hasOwnProperty.call(REASONS, key) ? REASONS[key](data) : null;
    if (reason) return t(...reason);
    // the engine's own sentence (English) is still better than a code; a code alone is the last resort, made readable
    const msg = err && typeof err.message === 'string' ? err.message.trim() : '';
    if (msg && msg !== code && msg !== key) return msg.charAt(0).toUpperCase() + msg.slice(1);
    const words = String(key || code).replace(/_/g, ' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
  };
  Git.addTR({
    'Retry': 'Yeniden dene',
    '{0}: a FIFO, socket or device file is in the way. It cannot be saved to the trash, so nothing was changed. Remove it yourself, then try again.':
      '{0}: yolda bir FIFO, soket ya da aygıt dosyası var. Çöp kutusuna saklanamadığı için hiçbir şey değiştirilmedi. Onu kendin kaldır, sonra yeniden dene.',
    '{0}: a file name with a line break cannot be written to .gitignore. Nothing was added.':
      '{0}: satır sonu içeren bir dosya adı .gitignore\'a yazılamaz. Hiçbir şey eklenmedi.',
    'The content it had already thrown away was saved first.': 'Attığı içerik önce saklanmıştı.',
    'Your local changes are kept in {0}.': 'Yerel değişikliklerin {0} içinde duruyor.',
    'Committing': 'Commit ediliyor', 'Amending': 'Amend ediliyor', 'Merging': 'Merge ediliyor', 'Updating': 'Güncelleniyor',
    'Rebasing': 'Rebase ediliyor', 'Cherry-picking': 'Cherry-pick ediliyor', 'Reverting': 'Revert ediliyor', 'Checking out': 'Checkout yapılıyor',
    'Another Git operation is in progress: {0}': 'Başka bir Git işlemi sürüyor: {0}',
    'There are unmerged files. Resolve the conflicts first.': 'Birleştirilmemiş dosyalar var. Önce çakışmaları çöz.',
    'The branch has no commits yet': 'Dalda henüz commit yok', 'HEAD is detached': 'HEAD ayrık durumda',
    '{0} already exists': '{0} zaten var', '{0} is the current branch': '{0} geçerli dal',
    '{0} is checked out in another worktree: {1}': '{0} başka bir worktree\'de açık: {1}',
    'No operation is in progress': 'Süren bir işlem yok',
    'The repository has changed in the meantime. Try again.': 'Depo bu arada değişti. Yeniden dene.',
    'The commit has more than one parent': 'Commit\'in birden fazla ebeveyni var',
    '{0} has changed on disk. Try again.': '{0} diskte değişti. Yeniden dene.',
    'Revision not found: {0}': 'Böyle bir dal, etiket ya da commit yok: {0}', 'This is not a valid branch or tag name': 'Bu ad geçerli bir dal ya da etiket adı değil',
    'The path is not valid': 'Yol geçerli değil',
    'The current branch changed after the dialog opened ({0} → {1}). Nothing was done.': 'Pencere açıldıktan sonra geçerli dal değişti ({0} → {1}). Hiçbir şey yapılmadı.',
  });

  // ---------------------------------------------------------------- the one way to the engine
  const runs = new Map();       // id -> { p, key, title }
  const jobs = new Map();       // engine job id -> balloon
  A.running = () => Array.from(runs.keys());
  A.run = function (o) {
    // The same command again while it runs (a second click, Enter held) is one run with one result. Another command
    // is never answered with a running one's result: under an explicit `id` (a group that must not overlap: 'op',
    // 'push', 'update'…) it is turned away with a notice and null; without an `id` it simply runs (the engine queues).
    const key = o.method + '\n' + JSON.stringify(o.params || {});
    const id = o.id || key;
    const cur = runs.get(id);
    if (cur) {
      if (cur.key === key) return cur.p;
      if (!o.quiet) Git.notify({ kind: 'warning', title: t('Another Git operation is running'), text: cur.title || null });
      return Promise.resolve(null);
    }
    const p = (async () => {
      Git.emit('busy', { running: A.running().concat(id) });
      try {
        return await Git.backend.call(o.method, Object.assign({ repo: R.root }, o.params || {}));
      } catch (err) {
        // What a failed or cancelled operation had already saved (data.trash) or stashed (data.autostash) is offered on
        // whatever notification the command shows for the error: once, here, for every command.
        extras = savedExtras(err);
        try {
          if (o.refused && err && err.code === 'refused' && o.refused(err.data && err.data.reason, err)) return null;
          if (err && err.code === 'cancelled' && o.cancelTitle) { A.info(o.cancelTitle); return null; }
          if (o.onError && o.onError(err)) return null;
          if (!o.quiet) A.errorNotice(err, o.title, o.failTitle);
          return null;
        } finally {
          // the command showed nothing (quiet, or a handler without a notice): the saved content still gets its own
          const left = extras;
          extras = null;
          if (left) Git.notify({ kind: 'warning', sticky: true, title: t(err && err.code === 'cancelled' ? '{0} cancelled' : '{0} failed', o.title || t('Git operation')), text: left.text, actions: left.actions });
        }
      } finally {
        runs.delete(id);
        Git.emit('busy', { running: A.running() });
      }
    })();
    runs.set(id, { p, key, title: o.title || null });
    return p;
  };

  // ---------------------------------------------------------------- saved content on a failure
  let extras = null;            // set while A.run handles an error: { text, actions } for the notification it shows
  /** What a `git_failed` / `cancelled` error says was kept (docs/PROTOCOL.md Errors): `data.trash` (Restore) and
      `data.autostash` ('stashed' | 'conflicts': the local changes are stash@{0}). Null when neither. */
  function savedExtras(err) {
    const d = (err && (err.code === 'git_failed' || err.code === 'cancelled' || err.code === 'timeout') && err.data) || null;
    if (!d) return null;
    const lines = [], actions = [];
    if (d.trash && d.trash.id) { lines.push(t('The content it had already thrown away was saved first.')); actions.push({ label: t('Restore'), run: () => A.restoreTrash(d.trash) }); }
    if (d.autostash === 'stashed' || d.autostash === 'conflicts') { lines.push(t('Your local changes are kept in {0}.', 'stash@{0}')); actions.push(...viewSaved(d.stash)); }
    return lines.length ? { text: lines.join('\n'), actions } : null;
  }
  const baseNotify = Git.notify;
  Git.notify = function (n) {
    if (extras && n && !n.progress && /^(error|warning|info)$/.test(n.kind || 'info')) {
      const x = extras;
      extras = null;
      n.text = n.text ? n.text + '\n' + x.text : x.text;
      n.actions = (n.actions || []).concat(x.actions);
      n.sticky = true;
    }
    return baseNotify(n);
  };

  // ---------------------------------------------------------------- progress of engine jobs
  // A balloon per job while a command waits for it (fetch, push, update, commit with hooks…), with Cancel while the job
  // is cancellable (job.cancel). It appears only when the job is still running after JOB_DELAY: a fast command shows no
  // flash (IntelliJ shows a task's progress only for a task that takes a while). The engine sends `running` again when
  // `cancellable` changes: Cancel comes and goes with it.
  const JOB_DELAY = 400;
  const cancelJob = (job) => () => Git.backend.call('job.cancel', { job }).catch(() => null);
  function showJob(id) {
    const j = jobs.get(id);
    if (!j || j.n || j.ended) return;
    j.n = Git.notify({ kind: 'info', title: t(j.title || 'Git operation'), progress: true, sticky: true,
      actions: j.cancellable ? [{ label: t('Cancel'), keep: true, run: cancelJob(id) }] : null });
  }
  Git.on('job', (ev) => {
    if (!ev) return;
    let j = jobs.get(ev.job);
    if (ev.state === 'running') {
      if (!j && !runs.size) return;
      if (!j) { j = { title: ev.title, cancellable: !!ev.cancellable, n: null, timer: null }; jobs.set(ev.job, j); j.timer = setTimeout(() => showJob(ev.job), JOB_DELAY); return; }
      // became cancellable: the balloon gets its Cancel; no longer cancellable (git's own work is done, the engine
      // finishes up): the balloon stays as it is, a late Cancel is answered `cancelled: false` and the result follows
      if (!j.cancellable && ev.cancellable) {
        j.cancellable = true;
        if (j.n) { j.n.close(); j.n = null; showJob(ev.job); }
      } else j.cancellable = !!ev.cancellable;
      return;
    }
    if (!j) return;
    j.ended = true;
    clearTimeout(j.timer);
    if (j.n) j.n.close();
    jobs.delete(ev.job);
  });
  Git.on('progress', (ev) => {
    const j = ev && jobs.get(ev.job);
    if (j && j.n && j.n.update) j.n.update(ev.text || '', ev.fraction == null ? null : ev.fraction);
  });
  A.JOB_DELAY = JOB_DELAY;
})();
