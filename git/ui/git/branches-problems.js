/* The questions IntelliJ asks when a branch operation cannot go ahead as it is (texts from git4idea's
   bundle, see the prototype's arastirma/D-kaynak.md):
   Git.dialogs.problem({ op, files, untracked, smart?, force?, onSmart, onForce })   "Git Checkout Problem" (Smart / Force / Don't)
     and "Untracked Files Prevent Checkout"
   Git.dialogs.worktreeConflict({ branch, path, onAnyway })                          "Worktree Conflict" (Checkout Anyway)
   Git.dialogs.localBranchExists({ branch, remote, onDrop, onRebase })               Drop Local Commits / Rebase onto Remote
   Git.dialogs.notFullyMerged({ branch, base, ids, onRestore })                     "Branch Was Not Fully Merged" */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const D = (Git.dialogs = Git.dialogs || {});

  Git.addTR({
    'Git {0} Problem': 'Git {0} sorunu',
    'Your local changes to the following files would be overwritten by {0}.': 'Aşağıdaki dosyalardaki yerel değişikliklerin {0} yüzünden kaybolacak.',
    '{1} can stash the changes, {0} and unstash them after that.': '{1} değişiklikleri stash\'e alabilir, {0} yapıp ardından geri getirebilir.',
    'Smart {0}': 'Akıllı {0}', "Don't {0}": '{0} yapma', 'Force Checkout': 'Zorla checkout yap',
    'Untracked Files Prevent {0}': 'Takip edilmeyen dosyalar {0} işlemini engelliyor',
    'The following untracked working tree files would be overwritten by {0}:': 'Aşağıdaki takip edilmeyen dosyaların üzerine {0} yazacak:',
    'Please move or remove them before you can {0}.': '{0} yapabilmek için önce onları taşı ya da sil.',
    'Please move or remove them before you can {0}, or force it: what is overwritten is saved to the trash first.':
      '{0} yapabilmek için önce onları taşı ya da sil, ya da zorla: üzerine yazılan içerik önce çöp kutusuna saklanır.',
    'Files marked ignored are listed too: git itself would overwrite them without asking.': 'Yok sayılan olarak işaretli dosyalar da listede: git onların üzerine sormadan yazardı.',
    'ignored': 'yok sayılan',
    'checkout': 'checkout', 'merge': 'merge', 'rebase': 'rebase', 'update': 'güncelleme', 'cherry-pick': 'cherry-pick',
    'Checkout': 'Checkout', 'Merge': 'Merge', 'Rebase': 'Rebase', 'Update': 'Güncelle', 'Cherry-Pick': 'Cherry-Pick',
    'Worktree Conflict': 'Worktree çakışması',
    "Branch '{0}' is already checked out in a worktree at:": "'{0}' dalı şu worktree'de zaten checkout edilmiş:",
    'Checkout Anyway': 'Yine de checkout yap', 'Show Worktree': 'Worktree\'yi göster',
    'Show Worktree shows that worktree\'s changes and Log here. Nothing is checked out.': 'Worktree\'yi göster, o worktree\'nin değişikliklerini ve Log\'unu burada gösterir. Hiçbir şey checkout edilmez.',
    "Local branch '{0}' has commits that do not exist in '{1}'. Rebase '{0}' onto '{1}', or drop local commits?":
      "'{0}' yerel dalında '{1}' içinde olmayan commit'ler var. '{0}' dalı '{1}' üzerine rebase edilsin mi, yoksa yerel commit'ler atılsın mı?",
    'Drop Local Commits': 'Yerel commit\'leri at', 'Rebase onto Remote': 'Uzak dalın üzerine rebase et', 'Checkout {0}': '{0} checkout',
    'Branch Was Not Fully Merged': 'Dal tamamen merge edilmemişti',
    'The branch {0} was not fully merged to {1}. Below is the list of unmerged commits.':
      '{0} dalı {1} içine tamamen merge edilmemişti. Merge edilmemiş commit\'ler aşağıda.',
    'Restore': 'Geri getir', 'Close': 'Kapat', 'Cancel': 'Vazgeç',
  });

  /** The list of files under a question (paths as git names them, grey folder after the name). A folder (`dir/`: an
      untracked folder, or one standing where a tracked file was) shows the folder icon and its own name. */
  function fileList(paths, ignored) {
    return h('div.gb-problem-files.g-scroll', { role: 'list' }, paths.map((p) => h('div.gb-problem-file', { role: 'listitem', title: p, class: ignored && ignored.has(p) ? 'ignored' : '' },
      /\/$/.test(p) ? Git.folderIcon(p) : Git.fileIcon(p), h('span.gb-problem-name', Git.fileName(p)), h('span.g-dim', Git.dirName(p)),
      ignored && ignored.has(p) ? h('span.g-dim.gb-problem-ignored', t('ignored')) : null)));
  }
  /** Which of `untracked` are ignored files: the snapshot lists every untracked path that is not ignored (`?`, a whole
      untracked folder as `dir/`); a path in the way that it does not list is ignored (git itself would overwrite it). */
  function ignoredOf(untracked) {
    const shown = (Git.repo.local || []).filter((f) => f.status === '?').map((f) => f.path);
    const listed = (p) => shown.some((s) => s === p || (/\/$/.test(s) && p.indexOf(s) === 0));
    return new Set(untracked.filter((p) => !listed(p)));
  }

  /**
   * IntelliJ's GitSmartOperationDialog / GitUntrackedFilesHelper. `op` is the English operation name ('Checkout',
   * 'Merge', 'Rebase', 'Update', 'Cherry-Pick'); `smart` offers Smart <op>, `force` offers Force Checkout.
   */
  D.problem = function (o) {
    const Op = t(o.op), op = t(o.op.toLowerCase());
    if (o.untracked && o.untracked.length) {
      // ignored files are listed too (the engine refuses to overwrite them; git would do it silently: README deviations)
      const ignored = ignoredOf(o.untracked);
      const buttons = [{ label: t('Close'), primary: !o.force, id: 'gb-problem-close' }];
      // Force Checkout overwrites them too; what it removes is saved to the trash first (the notice offers Restore)
      if (o.force && o.onForce) buttons.push({ label: t('Force Checkout'), id: 'gb-problem-force', onClick: () => o.onForce() });
      return Git.dialog({ title: t('Untracked Files Prevent {0}', Op), width: 520, className: 'gb-problem-dlg', id: 'gb-untracked',
        content: [h('div.gb-problem-text', t('The following untracked working tree files would be overwritten by {0}:', op)), fileList(o.untracked, ignored),
          ignored.size ? h('div.gb-problem-text.g-dim', t('Files marked ignored are listed too: git itself would overwrite them without asking.')) : null,
          (o.files || []).length ? h('div.gb-problem-text', t('Your local changes to the following files would be overwritten by {0}.', op)) : null,
          (o.files || []).length ? fileList(o.files) : null,
          h('div.gb-problem-text.g-dim', o.force && o.onForce ? t('Please move or remove them before you can {0}, or force it: what is overwritten is saved to the trash first.', op)
            : t('Please move or remove them before you can {0}.', op))],
        buttons });
    }
    const buttons = [{ label: t("Don't {0}", Op), id: 'gb-problem-dont' }];
    if (o.force) buttons.push({ label: t('Force Checkout'), id: 'gb-problem-force', danger: false, onClick: () => { if (o.onForce) o.onForce(); } });
    if (o.smart !== false && o.onSmart) buttons.push({ label: t('Smart {0}', Op), id: 'gb-problem-smart', primary: true, onClick: () => o.onSmart() });
    const text = [h('div', t('Your local changes to the following files would be overwritten by {0}.', op))];
    if (o.onSmart) text.push(h('div', t('{1} can stash the changes, {0} and unstash them after that.', op, Git.product())));
    return Git.dialog({ title: t('Git {0} Problem', Op), width: 560, className: 'gb-problem-dlg',
      content: [h('div.gb-problem-text', text), o.files && o.files.length ? fileList(o.files) : null], buttons });
  };

  /** `onShow` (when the page can show another worktree in place, ui/git/worktrees.js): "Show Worktree" is the first
      choice then. Who asks for a branch that lives in another worktree mostly wants to see its work, and that needs no
      checkout (the owner, 16 Nov 2026: "I wanted to see that branch's changes and got this warning"). */
  D.worktreeConflict = function (o) {
    const buttons = [{ label: t('Cancel'), id: 'gb-wt-cancel' }, { label: t('Checkout Anyway'), primary: !o.onShow, id: 'gb-wt-anyway', onClick: () => o.onAnyway() }];
    if (o.onShow) buttons.push({ label: t('Show Worktree'), primary: true, id: 'gb-wt-show', onClick: () => o.onShow() });
    return Git.dialog({ title: t('Worktree Conflict'), width: 480, className: 'g-confirm',
      content: h('div.g-confirm-text', t("Branch '{0}' is already checked out in a worktree at:", o.branch), h('div.g-confirm-detail.g-mono', o.path || ''),
        o.onShow ? h('div.g-confirm-detail.g-dim#gb-wt-hint', t('Show Worktree shows that worktree\'s changes and Log here. Nothing is checked out.')) : null),
      buttons });
  };

  D.localBranchExists = function (o) {
    return Git.dialog({ title: t('Checkout {0}', o.remote), width: 520, className: 'g-confirm',
      content: h('div.g-confirm-text', t("Local branch '{0}' has commits that do not exist in '{1}'. Rebase '{0}' onto '{1}', or drop local commits?", o.branch, o.remote)),
      buttons: [{ label: t('Cancel'), id: 'gb-lbe-cancel' },
        { label: t('Drop Local Commits'), id: 'gb-lbe-drop', onClick: () => o.onDrop() },
        { label: t('Rebase onto Remote'), primary: true, id: 'gb-lbe-rebase', onClick: () => o.onRebase() }] });
  };

  /** "View Commits" of the Deleted Branch notification: the commits the deleted branch had that nothing else has. */
  D.notFullyMerged = function (o) {
    const list = h('div.gb-problem-files.gb-unmerged.g-scroll', { role: 'list' });
    const dlg = Git.dialog({ title: t('Branch Was Not Fully Merged'), width: 620, className: 'gb-problem-dlg',
      content: [h('div.gb-problem-text', t('The branch {0} was not fully merged to {1}. Below is the list of unmerged commits.', o.branch, o.base)), list],
      buttons: [{ label: t('Close'), id: 'gb-nfm-close' }, { label: t('Restore'), primary: true, id: 'gb-nfm-restore', onClick: () => o.onRestore() }] });
    (o.ids || []).slice(0, 200).forEach((id) => {
      const row = h('div.gb-problem-file', { role: 'listitem', dataset: { id } }, h('span.g-mono.g-dim', Git.short(id)), h('span.gb-problem-name', ''));
      list.appendChild(row);
      const c = Git.commit(id);
      if (c) { row.lastChild.textContent = c.subject; return; }
      Git.content.details(id).then((d) => { row.lastChild.textContent = d.subject; }, () => null);
    });
    return dlg;
  };
})();
