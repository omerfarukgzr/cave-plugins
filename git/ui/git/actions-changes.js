/* Working tree commands (the working tree wave). Every one reaches the engine through A.run.
   Read/navigate: showLocalDiff(path) · showCommitDiff(commitId, path, { parent, files }) · jumpToSource(path, { line })
     · showFile(path, { line, annotate })
   Write: commit(paths, message, { amend, push, mergeCount }) -> Promise<result|null> · rollback(paths) (dialog)
     · doRollback(paths, deleteAdded) · addToVcs(paths) · addToIgnore(paths, 'gitignore'|'exclude') (changes.ignore)
     · deleteFiles(paths) (asks first: Git.dialogs.deleteFiles)
   Commit view: checkinProject() (⌘K: open it, tick every change) · commitFiles(paths) (Commit File…) · showDiffInNewTab(path)
     · doDelete(paths) · writeBlock(path, text, expect, mode) (the diff's Revert / Append of one block: changes.write)
   touched(paths): drops cached work tree contents of `paths` and emits `files` (a write that leaves the snapshot as it
   was publishes no event). Every result that carries `trash` shows its notification with "Restore" ("Geri getir"),
   which writes the bytes back (trash.restore) and refreshes what shows them (docs/ARCHITECTURE.md §3.5). */
(function () {
  'use strict';
  const Git = window.Git;
  const R = Git.repo;
  const t = (...a) => Git.t(...a);
  const A = Git.actions;
  const { ok, plural } = A;

  Git.addTR({
    '1 file committed': '1 dosya commitlendi', '{0} files committed': '{0} dosya commitlendi', 'No files committed': 'Hiç dosya commitlenmedi',
    'Commit failed': 'Commit başarısız oldu', 'Nothing to Commit': 'Commit edilecek bir şey yok', 'No changes detected': 'Değişiklik bulunamadı',
    'There is no commit to amend yet': 'Amend edilecek bir commit henüz yok', 'Commit Message Is Empty': 'Commit mesajı boş',
    'Add a summary of your changes in the commit message field': 'Commit mesajı alanına değişikliklerin bir özetini yaz',
    'Committing is not possible because you have unmerged files.': 'Merge edilmemiş dosyalar olduğu için commit yapılamıyor',
    'HEAD moved after Amend loaded the last commit. Amend now shows the new last commit: check it and commit again.':
      'Amend son commit\'i yükledikten sonra HEAD değişti. Amend şimdi yeni son commit\'i gösteriyor: kontrol edip yeniden commit et',
    'Cannot Delete': 'Silinemiyor', 'Cannot Roll Back': 'Geri alınamıyor',
    'Add to .gitignore': '.gitignore\'a ekle',
    'A {0} is in progress. Finish it with Continue or Abort.': 'Süren bir {0} var. Devam et ya da İptal et ile bitir.',
    'Edit Commit Message…': 'Commit mesajını düzenle…', 'Commit message changed': 'Commit mesajı değişti',
    '{0} file rolled back': '{0} dosya geri alındı', '{0} files rolled back': '{0} dosya geri alındı',
    "Not rolled back: {0}. Rollback does not change a submodule's checkout.": 'Geri alınmadı: {0}. Geri alma bir submodule\'ün checkout\'unu değiştirmez.',
    'Nothing was rolled back': 'Hiçbir şey geri alınmadı',
    '{0} file deleted': '{0} dosya silindi', '{0} files deleted': '{0} dosya silindi',
    'Restored {0}': 'Geri getirildi: {0}',
    'Change reverted': 'Değişiklik geri alındı', 'Change appended': 'Değişiklik eklendi', 'Restore': 'Geri getir',
    'Rollback': 'Geri al', 'Delete': 'Sil', 'Add to VCS': 'Git\'e ekle', 'Revert': 'Geri al',
    'The file changed on disk': 'Dosya diskte değişti', 'The diff was refreshed. Try again on the new content.': 'Diff yenilendi. Yeni içerik üzerinde yeniden dene.',
    'The file cannot hold these characters in its encoding': 'Dosyanın kodlaması bu karakterleri tutamıyor',
    'Continue': 'Devam et', 'Abort': 'İptal et', 'Resolve…': 'Çöz…',
  });

  // ---------------------------------------------------------------- read / navigate
  /** `o.preview`: the selection of a list moved while a diff shows in the centre (ui/git/centre.js): the diff follows and
      the focus stays in the list. */
  A.showLocalDiff = function (path, o) {
    // Previous/next file follows the order the Commit view shows.
    const order = Git.views.commit && Git.views.commit.order ? Git.views.commit.order() : null;
    const files = order && order.length ? order : Git.localChanges().concat(Git.unversioned()).map((f) => f.path);
    Git.open('diff', Object.assign({ kind: 'local', path, files }, o && o.preview ? { preview: true } : null));
  };
  /** One file of a commit. `o.parent`: which parent's change (merge commits); `o.files`: the paths for Next/Previous File. */
  A.showCommitDiff = function (commitId, path, o) {
    o = o || {};
    Git.open('diff', Object.assign({ kind: 'commit', commit: commitId, path, parent: o.parent || null, files: o.files || null }, o.preview ? { preview: true } : null));
  };
  /** The host's editor when it has one; the standalone page shows the work tree file in the read-only file view. */
  A.jumpToSource = function (path, o) {
    if (Git.host && Git.host.openFile && Git.host.openFile(path, o || {})) return;
    A.showFile(path, o);
  };
  A.showFile = function (path, o) {
    o = o || {};
    Git.open('file', { path, rev: o.rev || null, line: o.line != null ? o.line : null });
  };

  // ---------------------------------------------------------------- the trash ("Geri getir")
  /** Refreshes what shows work tree contents of `paths` (a write that leaves the snapshot as it was publishes nothing). */
  function touched(paths) {
    if (Git.content && Git.content.dropWorktree) Git.content.dropWorktree(paths && paths.length ? paths : null);
    Git.emit('files', { paths: paths && paths.length ? paths : null });
  }
  A.touched = touched;
  // One "Geri getir" for every area: A.restoreTrash (actions-history.js) restores, refreshes through A.touched, notifies.
  const restore = (trash) => A.restoreTrash(trash);
  const withRestore = (trash, more) => [trash && trash.id ? { label: t('Restore'), run: () => restore(trash) } : null].concat(more || []).filter(Boolean);

  // ---------------------------------------------------------------- commit
  const tail = (s, n) => String(s || '').replace(/\s+$/, '').split('\n').slice(-n).join('\n');
  function commitRefused(reason, err) {
    const data = (err && err.data) || {};
    if (reason === 'empty_message') {
      Git.notify({ kind: 'error', title: t('Commit Message Is Empty'), text: t('Add a summary of your changes in the commit message field') });
    } else if (reason === 'nothing_to_commit') {
      Git.notify({ kind: 'warning', title: t('Nothing to Commit'), text: t('No changes detected') });
    } else if (reason === 'nothing_to_amend') {
      Git.notify({ kind: 'warning', title: t('Nothing to Commit'), text: t('There is no commit to amend yet') });
    } else if (reason === 'unresolved_conflicts') {
      // GitBundle error.commit.cant.commit.with.unmerged.paths under "Commit failed"
      Git.notify({ kind: 'error', title: t('Commit failed'), text: t('Committing is not possible because you have unmerged files.') });
    } else if (reason === 'op_in_progress' && (data.incomplete || (R.op && R.op.incomplete))) {
      A.incompleteNotice(data.type || R.op.type);   // git left it half-made: nothing to continue, only Abort
    } else if (reason === 'op_in_progress') {
      Git.notify({ kind: 'error', title: t('Commit failed'), text: t('A {0} is in progress. Finish it with Continue or Abort.', data.type || ''),
        actions: [A.continueOp && { label: t('Continue'), run: () => A.continueOp() }, A.abortOp && { label: t('Abort'), run: () => A.abortOp() }].filter(Boolean) });
    } else return false;
    return true;
  }
  function resolve() {
    if (Git.dialogs.conflicts) Git.dialogs.conflicts({});
    else if (A.resolveConflicts) A.resolveConflicts();
  }
  A.resolveFromCommitView = resolve;
  /** Commits the checked paths. Resolves with the engine's result, or null (refused / failed: already notified). */
  A.commit = function (paths, message, o) {
    o = o || {};
    const amend = !!o.amend;
    const params = { paths, message, amend };
    // Amend names the commit it loaded: the engine refuses (head_moved) when HEAD moved meanwhile (QA #4)
    if (amend && o.expectHead) params.expectHead = o.expectHead;
    const mergedFrom = R.op && R.op.type === 'merge' && R.op.theirs ? R.op.theirs.ref || Git.short(R.op.theirs.id) : null;
    // a commit whose hook hangs is a cancellable job ("Committing"): Cancel ends it, IntelliJ's "Commit canceled" info
    return A.run({ id: 'changes.commit', title: t('Commit'), method: 'changes.commit', params, cancelTitle: t('Commit canceled'),
      refused: (reason, err) => {
        if (reason === 'head_moved') {
          Git.notify({ kind: 'warning', title: t('Commit failed'), text: t('HEAD moved after Amend loaded the last commit. Amend now shows the new last commit: check it and commit again.') });
          if (o.onHeadMoved) o.onHeadMoved();
          return true;
        }
        return commitRefused(reason, err);
      },
      // a failing hook: its whole output, as IntelliJ's "Commit failed" balloon shows it
      onError: (err) => {
        if (!err || err.code !== 'git_failed') return false;
        Git.notify({ kind: 'error', title: t('Commit failed'), text: tail((err.data && err.data.stderr) || err.message, 20) || null });
        return true;
      } }).then((res) => {
      if (!res) return null;
      const n = res.merge ? Math.max(res.files.length, o.mergeCount || 0) : res.files.length;
      const title = !n && res.amended ? t('Commit message changed')
        : n === 0 ? t('No files committed') : n === 1 ? t('1 file committed') : t('{0} files committed', n);
      const actions = [];
      if (A.editMessage && Git.dialogs.editMessage) actions.push({ label: t('Edit Commit Message…'), run: () => A.editMessage(res.id) });
      ok(title, res.subject, actions);
      // the commit that concludes a Smart merge: its stash may not have come back
      A.autostashConflicts(res, { operation: 'merge', from: mergedFrom });
      if (o.push) {
        if (Git.dialogs.push && R.head.branch) Git.dialogs.push(R.head.branch);
        else if (A.push) A.push();
      }
      return res;
    });
  };

  // ---------------------------------------------------------------- rollback, add, delete
  A.rollback = function (paths) {
    if (Git.dialogs.rollback) { Git.dialogs.rollback(paths); return; }
    A.doRollback(paths, false);
  };
  /** Called by the Rollback Changes dialog. */
  A.doRollback = function (paths, deleteAdded) {
    return A.run({ title: t('Rollback'), method: 'changes.rollback', params: { paths, deleteAdded: !!deleteAdded }, refused: refusedAs('Cannot Roll Back') }).then((res) => {
      if (!res) return null;
      touched(res.restored.concat(res.deleted));
      // a listed change the engine could not roll back (a submodule whose checkout moved) is `skipped`: never counted
      const skipped = new Set(res.skipped || []);
      const kept = res.paths.filter((p) => skipped.has(p));
      const n = res.paths.length - kept.length;
      const note = kept.length ? t("Not rolled back: {0}. Rollback does not change a submodule's checkout.", kept.join(', ')) : null;
      if (n || res.trash) Git.notify({ kind: kept.length ? 'warning' : 'success', title: t(plural(n, '{0} file rolled back', '{0} files rolled back'), n), text: note, actions: withRestore(res.trash) });
      else if (kept.length) Git.notify({ kind: 'warning', title: t('Nothing was rolled back'), text: note });
      return res;
    });
  };
  A.addToVcs = function (paths) {
    return A.run({ title: t('Add to VCS'), method: 'changes.add', params: { paths } });
  };
  /** Add to .gitignore ▸ .gitignore | .git/info/exclude (changes.ignore). */
  A.addToIgnore = function (paths, target) {
    return A.run({ title: t('Add to .gitignore'), method: 'changes.ignore', params: { paths, target: target === 'exclude' ? 'exclude' : 'gitignore' } }).then((res) => {
      if (res) Git.emit('ignored', { paths });
      return res;
    });
  };
  /** ⌘K / "Commit…" (CheckinProject): the Commit view opens with every change of the (only) changelist ticked. */
  A.checkinProject = function () {
    if (Git.frame && Git.frame.showRight && Git.workbench && Git.workbench.mode !== 'single') Git.frame.showRight('commit');
    const C = Git._commit;
    if (C && C.S) { Git.localChanges().forEach((f) => C.S.included.add(f.path)); if (C.refresh) C.refresh(); if (C.ui) C.ui.msg.focus(); }
  };
  /** Commit File… (CheckinFiles): exactly these files ticked, the message field focused. */
  A.commitFiles = function (paths) {
    if (Git.frame && Git.frame.showRight && Git.workbench && Git.workbench.mode !== 'single') Git.frame.showRight('commit');
    const C = Git._commit;
    if (!C || !C.S) return;
    C.S.included.clear();
    paths.forEach((p) => { if (Git.localFile(p)) C.S.included.add(p); });
    if (C.refresh) C.refresh();
    Git.emit('included');
    if (C.ui) C.ui.msg.focus();
  };
  let newTabs = 0;
  /** Show Diff in a New Tab: the local diff in a tab of its own (the shared "Commit: <file>" tab stays as it is). */
  A.showDiffInNewTab = function (path) {
    const order = Git.views.commit && Git.views.commit.order ? Git.views.commit.order() : [];
    Git.open('diff', { kind: 'local', path, files: order.length ? order : [path], tabId: 'diff:local#' + (++newTabs) });
  };
  /** Asks first (IntelliJ's Delete confirmation), then deletes. */
  A.deleteFiles = function (paths) {
    if (Git.dialogs.deleteFiles) Git.dialogs.deleteFiles(paths); else A.doDelete(paths);
  };
  /** A refusal of delete / rollback, under the command's own title, as a sentence (never the bare code). The engine
      saves a nested repository whole (trash `trees`), so it refuses nothing of the kind any more. */
  const refusedAs = (title) => (reason, err) => {
    Git.notify({ kind: 'error', title: t(title), text: A.errorText(err) });
    return true;
  };
  A.doDelete = function (paths) {
    return A.run({ title: t('Delete'), method: 'changes.delete', params: { paths }, refused: refusedAs('Cannot Delete') }).then((res) => {
      if (!res) return null;
      touched(res.deleted);
      const n = res.deleted.length;
      Git.notify({ kind: 'success', title: t(plural(n, '{0} file deleted', '{0} files deleted'), n), actions: withRestore(res.trash) });
      return res;
    });
  };

  // ---------------------------------------------------------------- one block of a local diff
  /** `mode` 'revert' (the » arrow) or 'append' (the arrow with ⌘/Ctrl held). Resolves with the result or null. */
  A.writeBlock = function (path, text, expect, mode) {
    return A.run({ id: 'changes.write:' + path, title: t('Revert'), method: 'changes.write', params: { path, text, expect },
      refused: (reason) => {
        if (reason === 'changed_on_disk') { touched([path]); Git.notify({ kind: 'warning', title: t('The file changed on disk'), text: t('The diff was refreshed. Try again on the new content.') }); return true; }
        if (reason === 'unencodable') { Git.notify({ kind: 'error', title: t('The file cannot hold these characters in its encoding') }); return true; }
        return false;
      } }).then((res) => {
      if (!res) return null;
      touched([path]);
      if (res.trash) A.info(t(mode === 'append' ? 'Change appended' : 'Change reverted'), path, withRestore(res.trash));
      return res;
    });
  };
  /** Kept for callers of the prototype's name: `text` is written over the content the diff showed (`expect`). */
  A.revertBlock = function (path, text, expect) { return A.writeBlock(path, text, expect, 'revert'); };
  void R;
})();
