/* Stash commands (IntelliJ's Stash dialog, Stash tab, Unstash dialogs; docs/spec-stash.md). Every command addresses a
   stash by its commit id (the engine finds its place in the list itself); the list comes from stash.list.
     A.stashList() -> Promise<[stash]> (the last answer is A.stashes())   A.stashChanges() (the Stash dialog)
     A.unstashChanges() (the Unstash Changes dialog)                        A.unstashAs(stash) (Unstash… of the tab)
     A.stashApply(stash, { index })  A.stashPop(stash, { index, branch })  A.stashDrop(stash)  A.stashClear()
     A.showStashes(id?) (View saved changes…: the Stash tab, that stash selected)
     A.stashMessage(text, o) (the Stash dialog's Create Stash)            A.stashRef(stash) / A.stashTitle(stash) */
(function () {
  'use strict';
  const Git = window.Git;
  const R = Git.repo;
  const t = (...a) => Git.t(...a);
  const A = (Git.actions = Git.actions || {});

  // git terms (Stash, Pop, Drop, Unstash, index) stay as they are in Turkish
  Git.addTR({
    'Stash': 'Stash', 'Unstash': 'Unstash', 'Stash Changes…': 'Değişiklikleri stash\'le…', 'Unstash Changes…': 'Stash\'ten geri al…', 'Uncommitted Changes': 'Commit edilmemiş değişiklikler',
    'Files stashed successfully': 'Dosyalar stash\'e alındı', 'View Git stashes': 'Git stash\'lerini göster', 'Failed to stash {0}': '{0} stash\'lenemedi',
    'Stash successfully applied': 'Stash uygulandı', 'Unstash failed': 'Unstash başarısız oldu',
    'Unstash failed due to an index conflict': 'Unstash, index çakışması yüzünden başarısız oldu',
    'Conflicts in index. Try without Reinstate index.': 'Index\'te çakışma var. Reinstate index olmadan dene.',
    'Local changes': 'Yerel değişiklikler', 'Changes from stash': 'Stash\'teki değişiklikler',
    'Conflicts were not resolved during unstash': 'Unstash sırasında çakışmalar çözülmedi',
    'Unstash is not complete, you have unresolved merges in your working tree.': 'Unstash tamamlanmadı, çalışma kopyasında çözülmemiş merge\'ler var.',
    'Resolve conflicts…': 'Çakışmaları çöz…', 'unstash': 'unstash', 'View saved changes…': 'Saklanan değişiklikleri göster…',
    'Dropped {0}': '{0} silindi', 'All stashes were removed': 'Bütün stash\'ler silindi',
    'The stash is kept for 14 days: Restore puts it back.': 'Stash 14 gün saklanır: Geri getir onu geri koyar.',
    'The stashes are kept for 14 days: Restore puts them back.': 'Stash\'ler 14 gün saklanır: Geri getir onları geri koyar.',
    'Nothing to stash': 'Stash\'lenecek bir şey yok', 'No local changes to save': 'Saklanacak yerel değişiklik yok',
    'The stash list changed in the meantime. Nothing was removed.': 'Stash listesi bu arada değişti. Hiçbir şey silinmedi.',
    'The stash was applied, but it is still listed: the stash list changed in the meantime.': 'Stash uygulandı ama listede duruyor: stash listesi bu arada değişti.',
    'The stash was applied, but it could not be removed from the list.': 'Stash uygulandı ama listeden kaldırılamadı.',
    'Staged changes could not be put back as they were; they are in the working tree.': 'Index\'teki değişiklikler eski haline konamadı; çalışma kopyasında duruyorlar.',
    'There are no stashes': 'Hiç stash yok', 'Stash created, but another one was made at the same moment: check the Stash tab.': 'Stash oluşturuldu ama aynı anda bir tane daha yapıldı: Stash sekmesine bak.',
  });

  let last = [];
  let seq = 0;
  A.stashes = () => last;
  /** stash.list: every stash with its files (the Stash tab and the Unstash Changes dialog). */
  A.stashList = function () {
    const my = ++seq, root = R.root;
    if (!root) return Promise.resolve([]);
    return Git.backend.call('stash.list', { repo: root }).then((res) => {
      if (my === seq && root === R.root) { last = res.stashes || []; Git.emit('stashes', last); }
      return res.stashes || [];
    }, () => last);
  };
  A.stashRef = (s) => 'stash@{' + s.index + '}';
  /** "Stash@{0}" (GB stash.editor.diff.preview.id.change.title capitalizes the name). */
  A.stashTitle = (s) => 'Stash@{' + s.index + '}';
  const shownBranch = () => R.head.branch || A.current();

  /** View saved changes… / View Git stashes: the Stash tab with that stash selected. */
  A.showStashes = function (id) { if (Git.stashTab) Git.stashTab.show(id || null); };

  // ---------------------------------------------------------------- Stash Changes…
  A.stashChanges = function () { if (Git.dialogs.stash) Git.dialogs.stash(); };
  /** The Stash dialog's Create Stash (GitStash.perform → runStashInBackground). */
  A.stashMessage = function (message, o) {
    o = o || {};
    return A.run({ id: 'stash', title: t('Stash'), method: 'stash.save', params: { message, keepIndex: !!o.keepIndex, includeUntracked: !!o.includeUntracked },
      failTitle: t('Failed to stash {0}', R.name),
      refused: (reason) => {
        if (reason !== 'nothing_to_stash') return false;
        Git.notify({ kind: 'info', title: t('Nothing to stash'), text: t('No local changes to save') });
        return true;
      } }).then((res) => {
      if (!res) return null;
      if (res.result === 'would-overwrite') { Git.notify({ kind: 'error', sticky: true, title: t('Failed to stash {0}', R.name), text: A.overwriteLines(t('Stash'), res).join('\n') }); return null; }
      const view = [{ label: t('View Git stashes'), run: () => A.showStashes(res.id) }];
      if (!res.id && res.candidates && res.candidates.length) Git.notify({ kind: 'warning', title: t('Files stashed successfully'), text: t('Stash created, but another one was made at the same moment: check the Stash tab.'), actions: view });
      else Git.notify({ kind: 'info', title: t('Files stashed successfully'), actions: view });
      A.stashList();
      return res;
    });
  };

  // ---------------------------------------------------------------- unstash
  A.unstashChanges = function () { if (Git.dialogs.unstash) Git.dialogs.unstash(); };
  A.unstashAs = function (s) { if (Git.dialogs.unstashAs) Git.dialogs.unstashAs(s); };

  /** What IntelliJ shows for an unstash's outcome (GitStashOperations.unstash). Returns the result or null. */
  function outcome(s, res) {
    if (!res) return null;
    A.stashList();
    if (res.result === 'conflicts') {
      // the merge dialog: left the local changes (stage 2), right the stash (stage 3)
      if (A.conflictContext) A.conflictContext({ kind: 'unstash', left: t('Local changes'), right: t('Changes from stash') });
      const resolve = () => { if (A.resolveConflicts) A.resolveConflicts(); };
      Git.notify({ kind: 'warning', sticky: true, title: t('Conflicts were not resolved during unstash'),
        text: t('Unstash is not complete, you have unresolved merges in your working tree.'), actions: [{ label: t('Resolve conflicts…'), run: resolve }] });
      if (A.whenState) A.whenState(() => Git.conflicts().length > 0, resolve);
      return res;
    }
    if (res.result === 'index-conflict') {
      Git.notify({ kind: 'error', title: t('Unstash failed due to an index conflict'), text: t('Conflicts in index. Try without Reinstate index.') });
      return res;
    }
    if (res.result === 'would-overwrite') {
      const text = A.overwriteLines(t('unstash'), res).concat(res.index === 'unstaged' ? [t('Staged changes could not be put back as they were; they are in the working tree.')] : []);
      Git.notify({ kind: 'error', sticky: true, title: t('Unstash failed'), text: text.join('\n') });
      return res;
    }
    // a pop whose drop could not be done: applied, and the stash is still listed (never a failure after the apply)
    const kept = res.dropped === false && res.reason ? t(res.reason === 'stash_moved' ? 'The stash was applied, but it is still listed: the stash list changed in the meantime.'
      : 'The stash was applied, but it could not be removed from the list.') : null;
    Git.notify({ kind: 'info', title: t('Stash successfully applied'), text: kept });
    return res;
  }
  const stashMoved = (reason) => {
    if (reason !== 'stash_moved') return false;
    Git.notify({ kind: 'warning', title: t('Unstash failed'), text: t('The stash list changed in the meantime. Nothing was removed.') });
    A.stashList();
    return true;
  };
  const unstashFailed = (err) => {
    if (!err || err.code !== 'not_found') return false;
    Git.notify({ kind: 'warning', title: t('Unstash failed'), text: t('The stash list changed in the meantime. Nothing was removed.') });
    A.stashList();
    return true;
  };
  A.stashApply = function (s, o) {
    return A.run({ id: 'stash', title: t('Unstash'), method: 'stash.apply', params: { id: s.id, index: !!(o && o.index) },
      failTitle: t('Unstash failed'), onError: unstashFailed }).then((res) => outcome(s, res));
  };
  A.stashPop = function (s, o) {
    o = o || {};
    const params = { id: s.id, index: !!o.index };
    if (o.branch) params.branch = o.branch;
    return A.run({ id: 'stash', title: t('Unstash'), method: 'stash.pop', params, failTitle: t('Unstash failed'), onError: unstashFailed,
      refused: (reason, err) => (reason === 'exists' ? (Git.notify({ kind: 'error', title: t('Unstash failed'), text: A.errorText(err) }), true) : stashMoved(reason)) })
      .then((res) => outcome(s, res));
  };

  // ---------------------------------------------------------------- Drop / Clear (asked first: stash-dialogs.js)
  /** Restore of a dropped / cleared stash: trash.restore puts the stashes back on the list. */
  A.restoreStashes = function (trash) {
    if (!trash || !trash.id) return Promise.resolve(null);
    return A.run({ id: 'trash.restore:' + trash.id, title: t('Restore'), method: 'trash.restore', params: { id: trash.id } }).then((res) => {
      if (!res) return null;
      A.stashList();
      const back = res.stashes || [];
      if (back.length) Git.notify({ kind: 'info', title: t('Restored {0}', back.length === 1 ? 'stash@{0}' : back.length + ' stashes') });
      return res;
    });
  };
  A.stashDrop = function (s) {
    return A.run({ id: 'stash', title: t('Drop'), method: 'stash.drop', params: { id: s.id }, onError: unstashFailed, refused: stashMoved }).then((res) => {
      if (!res) return null;
      A.stashList();
      Git.notify({ kind: 'info', title: t('Dropped {0}', A.stashRef(s)), text: t('The stash is kept for 14 days: Restore puts it back.'),
        actions: [{ label: t('Restore'), run: () => A.restoreStashes(res.trash) }] });
      return res;
    });
  };
  A.stashClear = function () {
    const top = last[0];
    if (!top) return Promise.resolve(null);
    return A.run({ id: 'stash', title: t('Clear'), method: 'stash.clear', params: { expect: top.id },
      refused: (reason) => (reason === 'no_stashes' ? (A.stashList(), true) : stashMoved(reason)) }).then((res) => {
      if (!res) return null;
      A.stashList();
      Git.notify({ kind: 'info', title: t('All stashes were removed'), text: t('The stashes are kept for 14 days: Restore puts them back.'),
        actions: [{ label: t('Restore'), run: () => A.restoreStashes(res.trash) }] });
      return res;
    });
  };
  A.stashBranchLabel = shownBranch;
})();
