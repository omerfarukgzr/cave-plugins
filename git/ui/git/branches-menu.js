/* The action menu of one ref, as the Branches popup's submenu and the Log's branches pane show it (split from
   branches.js). IntelliJ's Git.Branch group (D-kaynak §6.3, "Dal alt menüsü: hangi öğe hangi dalda"):
   Git.branches.menuFor(name, kind) -> Git.menu items for a local / remote branch or a tag.
   `kind` ('local' | 'remote' | 'tag') comes from where the ref is listed: a name can be all three at once (a local
   branch `team/x` next to the remote `team`, a tag named like a branch, a local branch literally named `refs/heads/x`),
   so every action gets the pair A.ref(kind, name) and A.wire makes the full ref. Without `kind` (old callers) the name
   is resolved like typed text (A.typed: local, then remote, then tag). */
(function () {
  'use strict';
  const Git = window.Git;
  const t = (...a) => Git.t(...a);
  const R = Git.repo, A = Git.actions;
  const B = (Git.branches = Git.branches || {});

  Git.addTR({ 'Checkout and Update': 'Checkout yap ve güncelle', 'Checkout {0}, fetch its tracked branch {1}, and update it in one step':
    '{0} dalına checkout yap, izlediği {1} dalını fetch et ve tek adımda güncelle', 'Tracked branch is not configured for {0}': '{0} için izlenen dal ayarlanmamış' });

  const isTag = (name) => Object.prototype.hasOwnProperty.call(R.tags, name);
  B.isTag = isTag;
  /** The kind of a ref named without one: local, then remote, then tag (null: none of them). */
  B.kindOf = (name) => { const r = A.typed(name); return r.kind === 'revision' ? null : r.kind; };

  /** Items of a ref's action menu (the popup's submenu and the Log's branches pane), in IntelliJ's order: `Git.menu` items. */
  B.menuFor = function (name, kind) {
    kind = kind || B.kindOf(name);
    if (!kind) return [];
    const cur = Git.currentBranch();
    const onto = cur || 'HEAD';
    // the clicked ref as a pair: every action below reaches the engine as A.wire(ref) (docs/PROTOCOL.md Ref names)
    const ref = A.ref(kind, name);
    const into = A.headMark();
    const merge = { label: t("Merge '{0}' into '{1}'", name, onto), disabled: kind === 'tag' && !cur, action: () => A.merge(ref, { into }) };
    const diff = { label: t('Show Diff with Working Tree'), disabled: !Git.views.branchDiff, action: () => A.showDiffWithWorkingTree(ref) };
    if (kind === 'tag') {
      // §5.4 of the spec (tags__tags_in_branches_popup.png)
      return [
        { label: t('Checkout'), action: () => A.checkout(ref, { label: name }) },
        '-', diff, '-', merge, '-',
        { label: t('Push to {0}', R.remoteName), disabled: !R.remoteNames.length, action: () => A.pushTag(ref) },
        '-',
        { label: t('Delete'), action: () => A.deleteTag(ref) },
      ];
    }
    const local = kind === 'local';
    // the dialog gets the pair (a tag or another kind of the same name is not it) and the name to show
    const newBranch = { label: t("New Branch from '{0}'…", name), action: () => A.newBranch(ref, name) };
    const up = local ? Git.upstream(name) : null;
    const own = [
      { label: t('Update'), disabled: !up, action: () => A.update(ref) },
      { label: t('Push…'), shortcut: local && name === cur ? '⇧⌘K' : null, action: () => A.push(ref) },
    ];
    // the snapshot names an upstream by its name under refs/remotes: it is the remote branch
    if (up) own.push({ label: t("Tracked Branch '{0}'", up), children: B.menuFor(up, 'remote') });
    const rename = { label: t('Rename…'), shortcut: 'F2', action: () => A.renameBranch(ref) };
    if (local && name === cur) return [newBranch, '-', diff, '-'].concat(own, ['-', rename]);

    const head = [
      { label: t('Checkout'), action: () => A.checkout(ref, { label: name }) },
      newBranch,
      { label: t("Checkout and Rebase onto '{0}'", onto), disabled: !cur, action: () => A.checkoutAndRebase(ref) },
    ];
    // Git.Checkout.Update: local branches of a repository with a remote; dimmed without a tracked branch
    if (local && R.remoteNames.length) {
      head.push({ label: t('Checkout and Update'), disabled: !up, action: () => A.checkoutAndUpdate(ref),
        title: up ? t('Checkout {0}, fetch its tracked branch {1}, and update it in one step', name, up) : t('Tracked branch is not configured for {0}', name) });
    }
    head.push('-',
      { label: t("Compare with '{0}'", onto), disabled: !Git.views.compare, action: () => A.compareWithCurrent(ref) },
      diff,
      '-',
      { label: t("Rebase '{0}' onto '{1}'", onto, name), disabled: !cur, action: () => A.rebaseOnto(ref, { into }) },
      merge,
      '-');
    if (local) return head.concat(own, ['-', rename, { label: t('Delete'), action: () => A.deleteBranch(ref) }]);
    const guarded = /^[^/]+\/(main|master)$/.test(name);   // IntelliJ's default protected branches: their remote can't be deleted
    return head.concat([
      { label: t("Pull into '{0}' Using Rebase", onto), disabled: !cur, action: () => A.pullInto(ref, 'rebase') },
      { label: t("Pull into '{0}' Using Merge", onto), disabled: !cur, action: () => A.pullInto(ref, 'merge') },
      '-',
      { label: t('Delete'), disabled: guarded, action: () => A.deleteBranch(ref) },
    ]);
  };
})();
