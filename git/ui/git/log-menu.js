/* The context menu of a commit in the Log (IntelliJ's Vcs.Log.ContextMenu with Dvcs.Log.ContextMenu,
   Git.Log.ContextMenu.CheckoutBrowse and Git.Log.ContextMenu, D §6.2.2), split out of log.js. Order: Copy Revision Number,
   Cherry-Pick | Checkout, Show Repository at Revision, Compare Versions (two commits), Compare with Local | Reset, Revert,
   Undo | Edit Commit Message…, Fixup…, Squash Into…, Drop Commits, Squash Commits…, Interactively Rebase from Here…, Push
   All up to Here…, Add Commits to Remote Branch…, Push Selected Commits… | Branch/Tag submenus, New Branch…, New Tag… |
   Go to Child / Parent. Which ones are enabled, and why not, is L.menuState (log-logic.js); a disabled item shows the
   reason under its label (menu.js `why`). Create Patch and Open on GitHub are not built.
   L.commitMenu(ids, id) → menu items · L.menuFacts() → the facts L.menuState decides on · L.canCherryPick(ids) */
(function () {
  'use strict';
  const Git = window.Git;
  const t = Git.t;
  const R = Git.repo, A = Git.actions;
  const L = (Git.logUI = Git.logUI || {});
  const C = () => L.core;

  Git.addTR({
    'Copy Revision Number': 'Commit hash\'ini kopyala', "Checkout Revision '{0}'": "'{0}' revizyonuna checkout yap",
    "Revision '{0}'": "'{0}' revizyonu", 'Checkout': 'Checkout', 'Compare with Local': 'Yerel sürümle karşılaştır',
    'Reset Current Branch to Here…': 'Geçerli dalı buraya reset et…', 'Revert Commit': 'Commit\'i revert et', 'Revert Commits': 'Commit\'leri revert et',
    'Undo Commit…': 'Commit\'i geri al…', 'Edit Commit Message…': 'Commit mesajını düzenle…', 'Drop Commits': 'Commit\'leri drop et',
    'Interactively Rebase from Here…': 'Buradan itibaren interactive rebase…', "Branch '{0}'": "'{0}' dalı", 'Branches': 'Dallar',
    "Tag '{0}'": "'{0}' etiketi", 'Delete': 'Sil', 'New Branch…': 'Yeni dal…', 'New Tag…': 'Yeni etiket…',
    'Go to Child Commit': 'Çocuk commit\'e git', 'Go to Parent Commit': 'Ebeveyn commit\'e git', 'Rename…': 'Yeniden adlandır…',
    // reasons of a disabled item (IntelliJ shows them in the status bar)
    'Cannot {0} during cherry-pick': 'Cherry-pick sürerken {0} yapılamaz', 'Cannot {0} during merge': 'Merge sürerken {0} yapılamaz',
    'Cannot {0} during rebase': 'Rebase sürerken {0} yapılamaz', 'Cannot {0} during revert': 'Revert sürerken {0} yapılamaz', 'Cannot {0}': '{0} yapılamaz',
    'The commit is not in the current branch': 'Commit geçerli dalda değil', 'Commit {0} is not in the current branch': '{0} commit\'i geçerli dalda değil',
    'Selected commit has {0} parents': 'Seçili commit\'in {0} ebeveyni var', 'The selected commit is not the last in the current branch': 'Seçili commit geçerli daldaki son commit değil',
    'Show Repository at Revision': 'Deponun bu sürümünü göster', 'Compare Versions': 'Sürümleri karşılaştır', 'Fixup…': 'Fixup…',
    'Squash Into…': 'Bunun içine squash et…', 'Squash Commits…': 'Commit\'leri squash et…', 'Push All up to Here…': 'Buraya kadar hepsini push et…',
    'Add Commits to Remote Branch…': 'Commit\'leri uzak dala ekle…', 'Push Selected Commits…': 'Seçili commit\'leri push et…',
    'Nothing to commit': 'Commit edilecek bir şey yok', 'No remotes': 'Uzak depo yok',
  });

  /** What L.menuState decides on, read from the repository now. */
  /** Is `x` in the current branch. Right after an operation moved HEAD the snapshot is newer than the commit list
      (the new HEAD is not loaded yet): then nothing is known, the command stays available and the engine decides. */
  function inHead(x) {
    const h = Git.headId();
    if (!h) return false;
    if (!Git.commit(h)) return true;
    return Git.isAncestor(x, h);
  }
  L.menuFacts = () => ({ headId: Git.headId(), op: R.op, commit: (x) => Git.commit(x), inHead,
    localChanges: (R.local || []).length > 0, hasRemotes: (R.remoteNames || []).length > 0, detached: !!(R.head && R.head.detached) });
  L.canCherryPick = (ids) => L.menuState(ids, L.menuFacts()).cherryPick.on;
  /** The reason of a disabled item: shown under it and as its tooltip (menu.js `why`). */
  const why = (s) => (s && s.why ? t(...s.why) : undefined);

  L.commitMenu = function (ids, id) {
    const one = ids.length === 1, short = Git.short(id);
    const s = L.menuState(ids, L.menuFacts());
    const item = (key, label, action, extra) => Object.assign({ label, disabled: !s[key].on, why: s[key].on ? undefined : why(s[key]), action }, extra || {});
    const newest = ids[0], oldest = ids[ids.length - 1];
    const branches = Git.refsAt(id).filter((r) => r.type === 'local' || r.type === 'remote');
    const tags = Git.refsAt(id).filter((r) => r.type === 'tag');
    const others = branches.filter((r) => !r.current);
    const revision = () => A.checkoutRevision(id);
    const items = [
      item('copy', t('Copy Revision Number'), () => A.copyHash(ids), { shortcut: '⌥⇧⌘C' }),
      item('cherryPick', t('Cherry-Pick'), () => A.cherryPick(ids)),
      '-',
      others.length
        ? { label: t('Checkout'), disabled: !one, children: others.map((r) => ({ label: r.name, action: () => A.checkout(A.ref(r.type, r.name), { label: r.name }) })).concat([{ label: t("Revision '{0}'", short), action: revision }]) }
        : item('checkout', t("Checkout Revision '{0}'", short), revision),
      item('showRepo', t('Show Repository at Revision'), () => A.showRepositoryAt(id)),
      ids.length === 2 ? item('compareVersions', t('Compare Versions'), () => A.compareVersions(oldest, newest)) : null,
      item('compareLocal', t('Compare with Local'), () => A.showDiffWithWorkingTree(A.ref('revision', id))),
      '-',
      item('reset', t('Reset Current Branch to Here…'), () => A.reset(id)),
      item('revert', t(ids.length > 1 ? 'Revert Commits' : 'Revert Commit'), () => A.revert(ids)),
      item('undo', t('Undo Commit…'), () => A.undoCommit(id)),
      '-',
      item('reword', t('Edit Commit Message…'), () => A.editMessage(id), { shortcut: 'F2' }),
      item('fixup', t('Fixup…'), () => A.fixupInto(id, 'fixup')),
      item('squashInto', t('Squash Into…'), () => A.fixupInto(id, 'squash')),
      item('drop', t('Drop Commits'), () => A.drop(ids)),
      item('squash', t('Squash Commits…'), () => A.squashCommits(ids)),
      item('rebase', t('Interactively Rebase from Here…'), () => A.interactiveRebase(id)),
      item('pushUpTo', t('Push All up to Here…'), () => A.pushUpTo(id)),
      item('addToRemote', t('Add Commits to Remote Branch…'), () => A.pushCommitsTo(ids, false)),
      item('pushSelected', t('Push Selected Commits…'), () => A.pushCommitsTo(ids, true)),
      '-',
    ].filter(Boolean);
    if (one && branches.length === 1) items.push({ label: t("Branch '{0}'", branches[0].name), children: L.branchMenu(branches[0].name, branches[0].type) });
    else if (one && branches.length > 1) items.push({ label: t('Branches'), children: branches.map((r) => ({ label: r.name, children: L.branchMenu(r.name, r.type) })) });
    if (one) tags.forEach((r) => items.push({ label: t("Tag '{0}'", r.name), children: [{ label: t('Delete'), danger: true, disabled: !A.deleteTag, action: () => A.deleteTag(A.ref('tag', r.name)) }] }));
    const child = one ? C().childOf(id) : null, parent = one ? C().parentOf(id) : null;
    return items.concat([
      item('newBranch', t('New Branch…'), () => A.newBranchFrom(id), { shortcut: '⌥⌘N' }),
      item('newTag', t('New Tag…'), () => A.newTag(id)),
      '-',
      { label: t('Go to Child Commit'), shortcut: '←', disabled: !child, action: () => C().select([child], child) },
      { label: t('Go to Parent Commit'), shortcut: '→', disabled: !parent, action: () => C().select([parent], parent) },
    ]);
  };
})();
