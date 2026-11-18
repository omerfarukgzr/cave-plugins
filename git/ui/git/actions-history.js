/* Log / history commands. Owner: the Log + history wave. Every write goes through A.run and decides by the
   result's `result` and a refusal's `data.reason` (docs/PROTOCOL.md "Mutating methods"), never by message text.
   The ongoing operation's commands (resolveConflicts, continueOp, abortOp, skipCommit, settle) live in actions-op.js.
     cherryPick(ids) · revert(ids) · undoCommit(id) · reset(id) → doReset(id, mode) · editMessage(id) → doEditMessage(id, msg)
     drop(ids) → doDrop(ids) · interactiveRebase(id) → applyRebasePlan(base, entries, { head, allowPushed })
     applySelectedChanges(commitId, paths) · getFromRevision(rev, paths) · restoreTrash(trash)
     copyHash(ids) · showInLog(id) · showHistory(path, { rev }) · showFileAt(path, rev) · annotate(path, { rev })
   Write commands return a Promise of the engine's result (null when it failed or was refused; the notice is shown). */
(function () {
  'use strict';
  const Git = window.Git;
  const t = (...a) => Git.t(...a);
  const A = Git.actions;
  const R = Git.repo;
  const { ok, info } = A;
  const L = () => Git.logUI || {};

  Git.addTR({
    'Cherry-pick failed': 'Cherry-pick başarısız oldu', 'Revert failed': 'Revert başarısız oldu', 'Nothing to cherry-pick': 'Cherry-pick edilecek bir şey yok',
    'Nothing to revert': 'Revert edilecek bir şey yok', 'All changes from {0} have already been cherry-picked': '{0} commit\'inin bütün değişiklikleri zaten uygulanmış',
    'All changes from {0} have already been reverted': '{0} commit\'inin bütün değişiklikleri zaten geri alınmış',
    '{0} was skipped, because all changes have already been cherry-picked.': '{0} atlandı, bütün değişiklikleri zaten uygulanmış.',
    '{0} were skipped, because all changes have already been cherry-picked.': '{0} atlandı, bütün değişiklikleri zaten uygulanmış.',
    '{0} was skipped, because all changes have already been reverted.': '{0} atlandı, bütün değişiklikleri zaten geri alınmış.',
    '{0} were skipped, because all changes have already been reverted.': '{0} atlandı, bütün değişiklikleri zaten geri alınmış.',
    'Revert was performed with conflicts': 'Revert çakışmalarla yapıldı', 'Abort revert': 'Revert\'i iptal et',
    'Cannot Undo Commit': 'Commit geri alınamıyor', 'Undo commit failed': 'Commit geri alınamadı', 'Reset failed': 'Reset başarısız oldu',
    'Could not Edit Commit Message': 'Commit mesajı düzenlenemedi', 'Could not Drop Commits': 'Commit\'ler drop edilemedi',
    'Cannot Start Rebase': 'Rebase başlatılamıyor', 'Interactive rebase failed': 'Interactive rebase başarısız oldu',
    'Dropped {0} commit': '{0} commit drop edildi', 'Dropped {0} commits': '{0} commit drop edildi', 'Commit message changed': 'Commit mesajı değişti',
    "The commit is already pushed to protected branch '{0}'": "Commit korumalı '{0}' dalına zaten push edilmiş",
    'Commits from current branch have already been pushed to protected branch {0}': 'Geçerli dalın commit\'leri korumalı {0} dalına zaten push edilmiş',
    'Commit {0} has {1} parents': '{0} commit\'inin {1} ebeveyni var', 'The repository has no commits yet':'Depoda henüz commit yok', 'Dropping every commit of the branch would leave it empty': 'Dalın bütün commit\'lerini drop etmek dalı boş bırakır',
    'There are unresolved conflicts in the working tree.': 'Çalışma kopyasında çözülmemiş çakışmalar var.', 'Empty commit message': 'Commit mesajı boş',
    'Your local changes would be overwritten by {0}.': 'Yerel değişikliklerin {0} yüzünden kaybolurdu.', 'Commit your changes or stash them to proceed.': 'Devam etmek için değişikliklerini commit et ya da stash\'le.',
    'Undo': 'Geri al', 'Repository has already been changed': 'Depo bu arada değişti', 'Cannot undo commit message edit': 'Commit mesajı değişikliği geri alınamıyor',
    'Cannot undo drop': 'Drop geri alınamıyor', 'Restore': 'Geri getir', 'Local changes were saved before {0}': 'Yerel değişiklikler {0} öncesinde saklandı',
    'Rebase stopped for editing': 'Rebase düzenleme için durdu', 'Changes applied': 'Değişiklikler uygulandı', 'Get from Revision': 'Bu sürümden al',
    'Got {0} from {1}': '{0}, {1} sürümünden alındı', 'Restored {0}': 'Geri getirildi: {0}', 'History: {0}': 'Geçmiş: {0}',
    'Nothing was restored': 'Hiçbir şey geri getirilemedi', 'The content these files had was saved first.': 'Bu dosyaların o anki içeriği önce saklandı.',
    'Partly restored: {0}': 'Bir kısmı geri getirildi: {0}', 'Not restored:': 'Geri getirilemeyenler:',
    '{0}: a folder is where the file goes': '{0}: dosyanın yerinde bir klasör var',
    '{0}: the file {1} is where its folder goes': '{0}: klasörünün yerinde {1} dosyası var',
    '{0}: {1} is in its place': '{0}: yerinde {1} var', '{0}: it was restored before': '{0}: daha önce geri getirildi',
    'Cherry-pick': 'Cherry-pick', 'revert': 'revert', 'cherry-pick': 'cherry-pick', 'reset': 'reset', 'rebase': 'rebase',
    'Cannot Create Fixup Commit': 'Fixup commit\'i oluşturulamadı', 'Cannot Create Squash Commit': 'Squash commit\'i oluşturulamadı',
    'Could not Squash Commits': 'Commit\'ler squash edilemedi', 'Squashing…': 'Squash ediliyor…', 'Commits Squashed': 'Commit\'ler squash edildi',
    'Cannot Undo Squash': 'Squash geri alınamıyor', 'Revert Selected Changes': 'Seçili değişiklikleri geri al', 'Changes reverted': 'Değişiklikler geri alındı',
    'Fixup…': 'Fixup…', 'Squash Into…': 'Bunun içine squash et…', 'Nothing to commit': 'Commit edilecek bir şey yok',
    'No remotes': 'Uzak depo yok', 'Commit {0} does not apply to {1}': '{0} commit\'i {1} üzerine uygulanamıyor',
    'The commit has no message and the squash adds none. Nothing was committed.': 'Commit\'in mesajı yok ve squash da bir mesaj eklemiyor. Hiçbir şey commit edilmedi.',
    '{0}: a FIFO, socket or device file is in its place': '{0}: yerinde bir FIFO, soket ya da aygıt dosyası var',
    '{0}: the folder {1} that stood there was moved aside (Undo brings it back)': '{0}: orada duran {1} klasörü kenara alındı (Geri al onu geri getirir)',
    '{0}: the file {1} that stood there was moved aside (Undo brings it back)': '{0}: orada duran {1} dosyası kenara alındı (Geri al onu geri getirir)',
  });
  const OP = { 'cherry-pick': 'Cannot {0} during cherry-pick', merge: 'Cannot {0} during merge', rebase: 'Cannot {0} during rebase', am: 'Cannot {0} during rebase',
    revert: 'Cannot {0} during revert' };

  // ---------------------------------------------------------------- shared notices
  const commitLine = (id) => Git.short(id) + ' ' + ((Git.commit(id) || {}).subject || '');
  /** The text of a refusal, from its reason and data (IntelliJ's own sentences). */
  function reasonText(reason, data, what) {
    data = data || {};
    switch (reason) {
      case 'merge_commit': return data.ids && data.ids.length ? t('Commit {0} has {1} parents', Git.short(data.ids[0]), (Git.commit(data.ids[0]) || { parents: [0, 0] }).parents.length)
        : t('Selected commit has {0} parents', 2);
      case 'root_commit': return t('Selected commit has {0} parents', 0);
      case 'not_in_current_branch': return t('The commit is not in the current branch');
      case 'not_last_commit': return t('The selected commit is not the last in the current branch');
      case 'pushed_to_protected': return what === 'undo commit' ? t('Commits from current branch have already been pushed to protected branch {0}', (data.branches || [])[0] || '')
        : t("The commit is already pushed to protected branch '{0}'", (data.branches || [])[0] || '');
      case 'op_in_progress': return data.incomplete ? A.incompleteText(data.type) : t(OP[data.type] || 'Cannot {0}', what || '');
      case 'unmerged_files': case 'unresolved_conflicts': return t('There are unresolved conflicts in the working tree.');
      case 'unborn': return t('The repository has no commits yet');
      case 'nothing_left': return t('Dropping every commit of the branch would leave it empty');
      // commit.fixup squash: the target has no message and the squash adds none (refused before anything was committed)
      case 'empty_message': return what === 'squash' ? t('Empty commit message') + '\n' + t('The commit has no message and the squash adds none. Nothing was committed.') : t('Empty commit message');
      case 'does_not_apply': return t('Your local changes would be overwritten by {0}.', what === t('revert') ? t('revert') : t('cherry-pick')) + '\n' + (data.paths || []).join('\n');
      case 'nothing_to_commit': return t('Nothing to commit');
      case 'not_in_branch': return t('The commit is not in the current branch');
      case 'no_remotes': return t('No remotes');
      case 'conflicts': return t('Commit {0} does not apply to {1}', Git.short(data.id || ''), data.target || '');
      // every other reason as the command core words it (never the bare code: special_file, incomplete_operation…)
      default: return A.errorText({ code: 'refused', data: Object.assign({}, data, { reason }) });
    }
  }
  A.reasonText = reasonText;
  /** A refusal handler for A.run: IntelliJ's error notification with the reason's sentence. */
  const refusal = (title, what) => (reason, err) => {
    Git.notify({ kind: 'error', title, text: reasonText(reason, err && err.data, what), refused: reason });
    return true;
  };
  /** Local changes in the way (a Would-overwrite result): IntelliJ's "local changes would be overwritten" problem. */
  /** `res.untracked` (content git does not track, ignored files included) and `res.files` (tracked local changes) are
      worded apart (A.overwriteLines): IntelliJ's untracked-files text is not its local-changes text. Nothing was changed. */
  function localChanges(title, res, what) {
    const onlyUntracked = !(res.files || []).length && (res.untracked || []).length > 0;
    const Op = String(what || '').charAt(0).toUpperCase() + String(what || '').slice(1);
    Git.notify({ kind: 'error', title: onlyUntracked ? t('Untracked Files Prevent {0}', Op) : title, text: A.overwriteLines(what, res).join('\n') });
  }
  /** Runs `fn` once the store's snapshot shows what `ready()` waits for: a result arrives before the `changed` event
      that brings the new state (the operation in progress, the unmerged files) to Git.repo. */
  function whenStore(ready, fn) {
    if (ready()) { fn(); return; }
    let off = null;
    const timer = setTimeout(() => { if (off) off(); fn(); }, 10000);
    off = Git.on('change', () => { if (!ready()) return; off(); clearTimeout(timer); fn(); });
  }
  /** Conflicts of a cherry-pick, revert or history edit: the operation's own Resolve flow (actions-op.js). */
  function conflicts(done) {
    whenStore(() => !!R.op && Git.conflicts().length > 0, () => {
      if (A.resolveConflicts) A.resolveConflicts(done);
      else if (A.stoppedNotice) A.stoppedNotice();
    });
  }
  /** "Geri getir": writes back what an operation saved before it threw content away. */
  A.restoreTrash = function (trash) {
    if (!trash || !trash.id) return Promise.resolve(null);
    return A.run({ id: 'trash.restore:' + trash.id, title: t('Restore'), method: 'trash.restore', params: { id: trash.id } }).then((res) => {
      if (!res) return null;
      // a restore can leave the snapshot as it was (nothing is published): refresh open work tree contents ourselves
      if (A.touched) A.touched(res.files);
      const files = res.files || [];
      const names = (list) => list.map(Git.fileName).slice(0, 5).join(', ') + (list.length > 5 ? ', …' : '');
      // What could not be written back, and why (`blocked`: { path, reason, by }); never announced as restored.
      const blocked = res.blocked || [];
      const listed = new Set(blocked.map((b) => b.path));
      const why = blocked.map(blockedText).concat((res.skipped || []).filter((p) => !listed.has(p))).slice(0, 8);
      const missed = why.length ? why.join('\n') + (blocked.length > 8 ? '\n…' : '') : null;
      if (!files.length) {
        Git.notify({ kind: 'warning', title: t('Nothing was restored'), text: missed });
        return res;
      }
      // What the restore overwrote was saved first (res.trash): a file edited again since can be taken back.
      const back = res.trash && res.trash.id ? [{ label: t('Undo'), run: () => A.restoreTrash(res.trash) }] : null;
      // what Restore removed to make room (`replaced`: the folder / file the operation had put there) is in res.trash
      const moved = (res.replaced || []).slice(0, 8).map((x) => t(x.kind === 'folder' ? '{0}: the folder {1} that stood there was moved aside (Undo brings it back)' : '{0}: the file {1} that stood there was moved aside (Undo brings it back)', x.path, x.by || x.path));
      const saved = back ? moved.concat(t('The content these files had was saved first.')).join('\n') : null;
      if (res.complete === false || missed) {
        Git.notify({ kind: 'warning', title: t('Partly restored: {0}', names(files)), text: [t('Not restored:'), missed, saved].filter(Boolean).join('\n'), actions: back });
        return res;
      }
      ok(t('Restored {0}', names(files)), saved, back);
      return res;
    });
  };
  /** One line for a path Restore could not write (trash.restore `blocked`). */
  function blockedText(b) {
    if (b.reason === 'folder') return t('{0}: a folder is where the file goes', b.path);
    if (b.reason === 'file') return t('{0}: the file {1} is where its folder goes', b.path, b.by || '');
    if (b.reason === 'exists') return t('{0}: {1} is in its place', b.path, b.by || b.path);
    if (b.reason === 'gone') return t('{0}: it was restored before', b.path);
    if (b.reason === 'special') return t('{0}: a FIFO, socket or device file is in its place', b.path);
    return b.path;
  }
  const restoreAction = (trash) => (trash && trash.id ? [{ label: t('Restore'), run: () => A.restoreTrash(trash) }] : null);
  /** Undo of a history edit (reword, drop): back to `before` with reset --keep, only while HEAD is still `after`. */
  const undoAction = (res, notAllowed) => ({ label: t('Undo'), run: () => {
    if (Git.headId() !== res.after) { Git.notify({ kind: 'error', title: notAllowed, text: t('Repository has already been changed') }); return; }
    A.run({ id: 'undo-edit', title: t('Undo'), method: 'reset', params: { to: res.before, mode: 'keep' } }).then((r) => { if (r && r.result === 'would-overwrite') localChanges(notAllowed, r, t('reset')); });
  } });
  /** A reworded commit gets a new id: once the Log has it, the selection that was on the old one moves there. */
  function follow(oldId, newId) {
    if (!Git.log || !Git.log.selected || Git.log.selected().indexOf(oldId) < 0) return;
    let off = null;
    const tryMove = () => {
      if (!Git.commit(newId) || R.log.order.indexOf(newId) < 0) return false;
      if (off) off();
      setTimeout(() => { const sel = Git.log.selected(); if (!sel.length || (sel.length === 1 && sel[0] === oldId)) Git.log.reveal(newId); }, 0);
      return true;
    };
    if (!tryMove()) { off = Git.on('log', tryMove); setTimeout(() => { if (off) off(); }, 15000); }
  }
  const facts = () => (L().menuFacts ? L().menuFacts() : { headId: Git.headId(), op: R.op, commit: Git.commit, inHead: (x) => Git.isAncestor(x, Git.headId()) });
  /** A command the menu would show disabled (keyboard, toolbar or a stale menu): IntelliJ's reason, nothing runs. */
  function blocked(key, ids, title) {
    if (!L().menuState) return false;
    const s = L().menuState(ids, facts())[key];
    if (!s || s.on) return false;
    if (s.why) Git.notify({ kind: 'error', title, text: t(...s.why) });
    return true;
  }
  /** IntelliJ checks "pushed to a protected branch" before it opens a dialog: a remote main/master holding the commit. */
  async function protectedHolder(id) {
    try {
      const res = await Git.content.containing(id);
      return (res.remotes || []).find((r) => /^[^/]+\/(main|master)$/.test(r)) || null;
    } catch (e) { return null; }
  }

  // ---------------------------------------------------------------- cherry-pick, revert
  function appliedNotice(kind, res, ids) {
    const revert = kind === 'revert';
    if (res.result === 'would-overwrite') { localChanges(t(revert ? 'Revert failed' : 'Cherry-pick failed'), res, t(kind)); return; }
    // local changes in the way of a later commit: the ones before it were made, the sequence waits (op.pending)
    if (res.result === 'stopped') { A.sequenceStopped(kind, res); return; }
    const done = () => {
      const skipped = res.skipped || [];
      if (res.result === 'nothing') {
        info(t(revert ? 'Nothing to revert' : 'Nothing to cherry-pick'), t(revert ? 'All changes from {0} have already been reverted' : 'All changes from {0} have already been cherry-picked', ids.map(Git.short).join(', ')));
        return;
      }
      const lines = (res.ids || ids).filter((x) => skipped.indexOf(x) < 0).map(commitLine);
      const skip = skipped.length ? t(skipped.length === 1 ? '{0} was skipped, because all changes have already been ' + (revert ? 'reverted.' : 'cherry-picked.')
        : '{0} were skipped, because all changes have already been ' + (revert ? 'reverted.' : 'cherry-picked.'), skipped.map(Git.short).join(', ')) : '';
      ok(t(revert ? 'Revert successful' : 'Cherry-pick successful'), lines.join('\n') + (skip ? '\n' + skip : ''));
    };
    if (res.result === 'conflicts') { conflicts(done); return; }
    done();
  }
  A.cherryPick = function (ids) {
    ids = Array.isArray(ids) ? ids : [ids];
    if (!ids.length || A.blockedByOp()) return Promise.resolve(null);
    return A.run({ id: 'cherryPick', title: t('Cherry-Pick'), method: 'cherryPick', params: { ids }, failTitle: t('Cherry-pick failed'), cancelTitle: t('{0} canceled', 'Cherry-pick'),
      refused: refusal(t('Cherry-pick failed'), t('cherry-pick')) }).then((res) => { if (res) appliedNotice('cherry-pick', res, ids); return res; });
  };
  A.revert = function (ids) {
    ids = Array.isArray(ids) ? ids : [ids];
    if (!ids.length || A.blockedByOp()) return Promise.resolve(null);
    return A.run({ id: 'revert', title: t('Revert Commit'), method: 'revert', params: { ids }, failTitle: t('Revert failed'), cancelTitle: t('{0} canceled', 'Revert'),
      refused: refusal(t('Revert failed'), t('revert')) }).then((res) => { if (res) appliedNotice('revert', res, ids); return res; });
  };

  // ---------------------------------------------------------------- undo, reset
  /** Undo Commit: the last commit goes back into local changes; its message goes to the Commit view. */
  A.undoCommit = function (id) {
    id = id || Git.headId();
    if (blocked('undo', [id], t('Cannot Undo Commit'))) return Promise.resolve(null);
    return A.run({ id: 'commit.undo', title: t('Undo Commit…'), method: 'commit.undo', params: { id }, failTitle: t('Undo commit failed'),
      refused: refusal(t('Cannot Undo Commit'), 'undo commit') }).then((res) => {
      if (!res) return null;
      Git.emit('commit-message', res.message);
      if (Git.frame && Git.workbench && Git.workbench.mode !== 'single') Git.frame.showRight('commit');
      return res;
    });
  };
  A.reset = function (id) {
    if (blocked('reset', [id], t('Reset failed'))) return;
    if (Git.dialogs.reset) Git.dialogs.reset(id);
  };
  /** `o.into`: A.headMark() of the dialog (the branch it named): refused, with a notice, when another one is current. */
  A.doReset = function (id, mode, o) {
    if (o && !A.stillCurrent(o.into, 'Git Reset')) return Promise.resolve(null);
    return A.run({ id: 'reset', title: 'Git Reset', method: 'reset', params: { to: id, mode }, failTitle: t('Reset failed'), refused: refusal(t('Reset failed'), t('reset')) }).then((res) => {
      if (!res) return null;
      if (res.result === 'would-overwrite') { localChanges(t('Reset failed'), res, t('reset')); return res; }
      ok(t('Reset successful'), res.trash && res.trash.files && res.trash.files.length ? t('Local changes were saved before {0}', t('reset')) : null, restoreAction(res.trash));
      return res;
    });
  };

  // ---------------------------------------------------------------- edit message, drop, interactive rebase
  A.editMessage = async function (id) {
    const title = t('Could not Edit Commit Message');
    if (blocked('reword', [id], title)) return null;
    const holder = await protectedHolder(id);
    if (holder) { Git.notify({ kind: 'error', title, text: t("The commit is already pushed to protected branch '{0}'", holder) }); return null; }
    const c = Git.commit(id);
    const open = () => (Git.dialogs.editMessage ? Git.dialogs.editMessage(id) : null);
    if (c && !c.parents.length && Git.dialogs.initialCommit) return Git.dialogs.initialCommit(open);
    return open();
  };
  A.doEditMessage = function (id, message) {
    const title = t('Could not Edit Commit Message');
    return A.run({ id: 'commit.editMessage', title: t('Edit Commit Message'), method: 'commit.editMessage', params: { id, message }, failTitle: title,
      refused: refusal(title, 'reword') }).then((res) => {
      if (!res) return null;
      if (res.result === 'would-overwrite') { localChanges(title, res, 'reword'); return res; }
      const done = () => ok(t('Commit message changed'), null, [undoAction(res, t('Cannot undo commit message edit'))]);
      if (res.result === 'conflicts') conflicts(done); else { done(); stash(res); }
      if (res.result === 'reworded' && res.id) follow(id, res.id);
      return res;
    });
  };
  A.drop = async function (ids) {
    ids = Array.isArray(ids) ? ids : [ids];
    const title = t('Could not Drop Commits');
    if (blocked('drop', ids, title)) return null;
    for (const id of ids) {
      const holder = await protectedHolder(id);
      if (holder) { Git.notify({ kind: 'error', title, text: t("The commit is already pushed to protected branch '{0}'", holder) }); return null; }
    }
    const into = A.headMark();   // the dialog names the current branch: the drop is refused when another one is current then
    if (Git.dialogs.dropCommits) return Git.dialogs.dropCommits(ids, () => A.doDrop(ids, { into }));
    return A.doDrop(ids);
  };
  A.doDrop = function (ids, o) {
    const title = t('Could not Drop Commits');
    if (o && !A.stillCurrent(o.into, t('Drop Commits'))) return Promise.resolve(null);
    return A.run({ id: 'commit.drop', title: t('Drop Commits'), method: 'commit.drop', params: { ids }, failTitle: title, refused: refusal(title, 'drop') }).then((res) => {
      if (!res) return null;
      if (res.result === 'would-overwrite') { localChanges(title, res, 'drop'); return res; }
      const n = res.count || ids.length;
      const done = () => ok(t(n === 1 ? 'Dropped {0} commit' : 'Dropped {0} commits', n), null, [undoAction(res, t('Cannot undo drop'))]);
      if (res.result === 'conflicts') conflicts(done); else { done(); stash(res); }
      return res;
    });
  };
  A.interactiveRebase = async function (id) {
    if (A.blockedByOp()) return null;
    const title = t('Cannot Start Rebase');
    if (blocked('rebase', [id], title)) return null;
    return Git.dialogs.interactiveRebase(id);   // merge-rebase.js (always loaded)
  };
  /** Interactive rebase dialog → Start Rebasing. `o`: { head, allowPushed }. Asks IntelliJ's "Rebase Anyway" for
      commits on a protected branch and repeats with allowPushed. */
  A.applyRebasePlan = function (base, entries, o) {
    o = o || {};
    const params = Object.assign({ base, entries }, o.head ? { head: o.head } : {}, o.allowPushed ? { allowPushed: true } : {});
    let again = null;
    return A.run({ id: 'rebase.apply', title: t('Rebase'), method: 'rebase.apply', params, failTitle: t('Interactive rebase failed'),
      refused: (reason, err) => {
        if (reason === 'pushed_to_protected' && !o.allowPushed) {
          again = new Promise((resolve) => {
            const dlg = Git.confirm({ title: t('Rebasing Published Commit'), width: 460,
              text: t('You are trying to rebase some commits already pushed to a protected branch.') + '\n' + t('Rebasing them would duplicate commits, which is not recommended and most likely unwanted.'),
              yes: t('Rebase Anyway'), onYes: () => resolve(A.applyRebasePlan(base, entries, Object.assign({}, o, { allowPushed: true }))) });
            const close = dlg.close; dlg.close = () => { close(); resolve(null); };
          });
          return true;
        }
        return refusal(t('Interactive rebase failed'), t('rebase'))(reason, err);
      } }).then((res) => {
      if (again) return again;
      if (!res) return null;
      settleEdit(res, t('Interactive rebase failed'), () => ok(t('Rebase successful')));
      return res;
    });
  };

  // ---------------------------------------------------------------- Fixup… / Squash Into…, Squash Commits… (dialogs: log-actions.js)
  /** A history edit's result: conflicts → the Resolve flow, then `done`; stopped (an edit stop) → "Rebase stopped for
      editing" (an information balloon: Continue / Abort); else `done`, then the shared notice when the stash of the
      local changes could not be put back (`autostash: 'conflicts'`). */
  function settleEdit(res, title, done) {
    if (res.result === 'would-overwrite') localChanges(title, res, t('rebase'));
    else if (res.result === 'conflicts') conflicts(done);
    else if (res.result === 'stopped') A.editNotice();
    else { done(); stash(res); }
  }
  /** A history edit rewrites the current branch with a rebase: its stash came back, or the shared notice says it did not. */
  const stash = (res) => A.autostashConflicts(res, { operation: 'rebase', from: res.branch || A.current() });
  A.doFixup = function (id, mode, paths, message) {
    const title = t(mode === 'squash' ? 'Cannot Create Squash Commit' : 'Cannot Create Fixup Commit');
    return A.run({ id: 'commit.fixup', title: t(mode === 'squash' ? 'Squash Into…' : 'Fixup…'), method: 'commit.fixup',
      params: Object.assign({ id, paths, mode }, message ? { message } : {}), failTitle: title, refused: refusal(title, mode) }).then((res) => {
      if (!res) return null;
      if (A.touched) A.touched(res.files || paths);
      settleEdit(res, title, () => ok(t('Rebase successful')));
      return res;
    });
  };
  A.doSquash = function (base, entries, head) {
    const title = t('Could not Squash Commits');
    return A.run({ id: 'rebase.apply', title: t('Squashing…'), method: 'rebase.apply', params: Object.assign({ entries, head }, base ? { base } : {}),
      failTitle: title, refused: refusal(title, 'squash') }).then((res) => {
      if (!res) return null;
      settleEdit(res, title, () => ok(t('Commits Squashed'), null, [undoAction(res, t('Cannot Undo Squash'))]));
      return res;
    });
  };
  /** Changed Files ▸ Revert Selected Changes: those files' changes of the commit are undone in the work tree. */
  A.revertSelectedChanges = function (commitId, paths, parent) {
    const title = t('Revert failed');
    return A.run({ id: 'changes.revertFromCommit', title: t('Revert Selected Changes'), method: 'changes.revertFromCommit',
      params: Object.assign({ id: commitId, paths }, parent ? { parent } : {}), failTitle: title, refused: refusal(title, t('revert')) }).then((res) => {
      if (!res) return null;
      if (A.touched) A.touched(res.paths);
      if (res.result === 'nothing') info(t('Nothing to revert'));
      else if (res.result === 'conflicts') {
        whenStore(() => Git.conflicts().length > 0, () => { if (Git.dialogs.conflicts && Git.conflicts().length) Git.dialogs.conflicts({}); });
      } else {
        ok(t('Changes reverted'), (res.paths || paths).map(Git.fileName).join(', '), restoreAction(res.trash));
        if (Git.frame && Git.workbench && Git.workbench.mode !== 'single') Git.frame.showRight('commit');
      }
      return res;
    });
  };

  // ---------------------------------------------------------------- changes of a commit, revisions of a file
  /** Changed Files pane → Cherry-Pick Selected Changes: brings those files' changes into the working tree. */
  A.applySelectedChanges = function (commitId, paths) {
    const title = t('Cherry-pick failed');
    return A.run({ id: 'changes.applyFromCommit', title: t('Cherry-Pick Selected Changes'), method: 'changes.applyFromCommit', params: { id: commitId, paths }, failTitle: title,
      refused: refusal(title, t('cherry-pick')) }).then((res) => {
      if (!res) return null;
      if (res.result === 'nothing') info(t('Nothing to cherry-pick'));
      else if (res.result === 'conflicts') {
        // no operation stops here (the changes were merged three-way into the work tree): the Conflicts dialog itself
        whenStore(() => Git.conflicts().length > 0, () => {
          if (Git.dialogs.conflicts && Git.conflicts().length) Git.dialogs.conflicts({});
          else Git.notify({ kind: 'warning', sticky: true, title: t('Cherry-pick was performed with conflicts'), text: t('There are unresolved conflicts in the working tree.'), actions: restoreAction(res.trash) });
        });
      } else {
        // what those files held was saved first (res.trash): the way back
        ok(t('Cherry-pick successful'), (res.paths || paths).map(Git.fileName).join(', '), restoreAction(res.trash));
        if (Git.frame && Git.workbench && Git.workbench.mode !== 'single') Git.frame.showRight('commit');
      }
      return res;
    });
  };
  /** Get from Branch / Get / Get from Revision: those files as they are in `rev` (the old content goes to the trash). */
  A.getFromRevision = function (rev, paths) {
    const title = t('{0} failed', t('Get from Revision'));
    return A.run({ id: 'changes.getFromRevision', title: t('Get from Revision'), method: 'changes.getFromRevision', params: { rev, paths }, failTitle: title,
      refused: refusal(title, 'get') }).then((res) => {
      if (!res) return null;
      if (res.result === 'got') ok(t('Got {0} from {1}', res.paths.map(Git.fileName).slice(0, 5).join(', ') + (res.paths.length > 5 ? ', …' : ''), Git.refId(rev) === rev ? Git.short(rev) : rev),
        null, restoreAction(res.trash));
      return res;
    });
  };

  // ---------------------------------------------------------------- read / navigate
  A.copyHash = function (ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    Git.copy(list.join(' '));
  };
  A.showInLog = function (id) {
    // a single view has no Log of its own: the host decides (a host places the Log elsewhere)
    const hooks = (Git.host && Git.host.hooks) || {};
    if (Git.workbench && Git.workbench.mode === 'single' && Git.workbench.view !== 'log' && hooks.showInLog) { hooks.showInLog(id); return; }
    if (Git.frame) { Git.frame.toggleGit(true); Git.frame.selectTab('log'); }
    if (Git.log && Git.log.reveal) Git.log.reveal(id);
  };
  /** History: <file> (History Up to Here passes the commit as `rev`). */
  A.showHistory = function (path, o) { Git.open('history', { path, rev: o && o.rev ? o.rev : null }); };
  Git.openers.define('history', ({ path, rev }) => {
    if (!Git.views.history || !Git.frame || !path) return;
    Git.frame.openTab({ id: 'history:' + path + (rev ? '@' + rev : ''), title: () => t('History: {0}', Git.fileName(path)), closable: true,
      mount: (el) => A.mountGuarded(Git.views.history, el, { path, rev }, t('History: {0}', Git.fileName(path))) });
  });
  /** The file as it is in a revision, read-only (Open Repository Version): the working tree area's file view. */
  A.showFileAt = function (path, rev) {
    A.showFile(path, { rev: Git.refId(rev) || rev });
  };
  A.annotate = function (path, o) {
    if (!Git.annotate) return;
    if (o && o.rev && Git.annotate.open) Git.annotate.open(path, o);
    else if (Git.annotate.toggle) Git.annotate.toggle(path);
  };
})();
