/* The menus the Commit view and the Files tool window share (IntelliJ's ChangesViewPopupMenu additions and
   the Git ▸ submenu, D §6.1 / §6.14: Git.ContextMenu = Git.FileActions, Show Current Revision, Rollback…, then
   GitRepositoryActions). Repository actions open the other areas' dialogs (Git.dialogs.*, Git.actions.*); nothing is
   re-implemented here.
     Git.changesMenus.gitItems(sel) -> menu items of Git ▸   sel: { file, tracked, deleted, conflict, changed, unversioned,
                                                              history (path or null), annotated }
     .copyPath(at, paths) · .ignoreItems(paths) · .compareWithRevision(path) · .compareWithBranch(at, path)
     .showCurrentRevision(at, path) · .compareWith(path, ref, label) */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const R = Git.repo;
  const M = (Git.changesMenus = {});

  Git.addTR({
    'Commit File…': 'Dosyayı commit et…', 'Add': 'Ekle', 'Add to .gitignore': '.gitignore\'a ekle', 'Annotate with Git Blame': 'Git Blame ile annotate et',
    'Close Annotations': 'Annotation\'ları kapat', 'Compare with Revision…': 'Bir revizyonla karşılaştır…', 'Compare with Branch or Tag…': 'Bir dal ya da etiketle karşılaştır…',
    'Show Current Revision': 'Geçerli revizyonu göster', 'Push…': 'Push…', 'Pull…': 'Pull…', 'Fetch': 'Fetch', 'Merge…': 'Merge…', 'Rebase…': 'Rebase…',
    'Branches…': 'Dallar…', 'New Branch…': 'Yeni dal…', 'New Tag…': 'Yeni etiket…', 'Reset HEAD…': 'HEAD\'i reset et…',
    'Copy Path/Reference…': 'Yolu/referansı kopyala…', 'Absolute Path': 'Tam yol', 'File Name': 'Dosya adı', 'Path From Content Root': 'Kök klasöre göre yol',
    'Local': 'Yerel', 'Remote': 'Uzak', 'Tags': 'Etiketler', 'Current version': 'Geçerli sürüm', 'No revisions': 'Revizyon yok',
    'Author: {0}': 'Yazar: {0}', 'Date: {0}': 'Tarih: {0}', 'commit {0}': 'commit {0}', 'Show in Git Log': 'Git Log\'da göster',
  });

  // ---------------------------------------------------------------- Git ▸ (Git.ContextMenu)
  M.gitItems = function (s) {
    const A = Git.actions, op = !!R.op, head = Git.headId();
    const one = s.file && !s.conflict ? s.file : null;
    const items = [
      { label: t('Commit File…'), disabled: !(s.changed.length || s.unversioned.length), action: () => A.commitFiles(s.changed.concat(s.unversioned)) },
      { label: t('Add'), shortcut: '⌥⌘A', disabled: !s.unversioned.length, action: () => A.addToVcs(s.unversioned) },
      { label: t('Add to .gitignore'), disabled: !s.unversioned.length, children: M.ignoreItems(s.unversioned) },
      '-',
      { label: s.annotated ? t('Close Annotations') : t('Annotate with Git Blame'), disabled: !(one && s.tracked && !s.deleted), action: () => Git.annotate.toggle(one) },
      { label: t('Show Diff'), shortcut: '⌘D', disabled: !(one && (s.changed.indexOf(one) >= 0 || s.unversioned.indexOf(one) >= 0)), action: () => A.showLocalDiff(one) },
      { label: t('Compare with Revision…'), disabled: !(one && s.tracked), action: () => M.compareWithRevision(one) },
      { label: t('Compare with Branch or Tag…'), disabled: !(one && head), action: (e) => M.compareWithBranch(e || null, one) },
      { label: t('Show History'), disabled: !s.history || !A.showHistory, action: () => A.showHistory(s.history) },
      { label: t('Show Current Revision'), disabled: !(one && s.tracked), action: () => M.showCurrentRevision(null, one) },
      { label: t('Rollback…'), shortcut: '⌥⌘Z', disabled: !s.changed.length, action: () => A.rollback(s.changed) },
      '-',
      { label: t('Push…'), shortcut: '⇧⌘K', disabled: !A.push, action: () => A.push() },
      // no Pull dialog in the branches area yet (Git.dialogs.pull): the item is shown, disabled
      { label: t('Pull…'), disabled: !Git.dialogs.pull, action: () => Git.dialogs.pull() },
      { label: t('Fetch'), disabled: !A.fetch, action: () => A.fetch() },
      '-',
      { label: t('Merge…'), disabled: op || !Git.dialogs.merge, action: () => Git.dialogs.merge() },
      { label: t('Rebase…'), disabled: op || !Git.dialogs.rebase, action: () => Git.dialogs.rebase() },
      '-',
      { label: t('Branches…'), shortcut: '⇧⌘`', disabled: !Git.branches, action: () => Git.branches.open(document.getElementById('g-widget')) },
      { label: t('New Branch…'), shortcut: '⌥⌘N', disabled: !A.newBranch, action: () => A.newBranch() },
      // Git ▸ New Tag… is IntelliJ's "Tag" dialog (Git.Tag); the Log's New Tag… on a commit is A.newTag(id)
      { label: t('New Tag…'), disabled: !head || !(A.tag || A.newTag), action: () => (A.tag ? A.tag() : A.newTag(head)) },
      { label: t('Reset HEAD…'), disabled: !head || !A.reset, action: () => A.reset(head) },
      '-',
      // Git ▸ Stash Changes… / Unstash Changes… (Git.MainMenu.LocalChanges: GitStash, GitUnstash)
      { label: t('Stash Changes…'), disabled: !head || op || !A.stashChanges, action: () => A.stashChanges() },
      { label: t('Unstash Changes…'), disabled: !head || !A.unstashChanges, action: () => A.unstashChanges() },
    ];
    return items;
  };

  /** Add to .gitignore ▸: the repository's .gitignore and .git/info/exclude. */
  M.ignoreItems = function (paths) {
    return [
      { label: '.gitignore', action: () => Git.actions.addToIgnore(paths, 'gitignore') },
      { label: '.git/info/exclude', action: () => Git.actions.addToIgnore(paths, 'exclude') },
    ];
  };

  /** Copy Path/Reference…: IntelliJ's CopyReferencePopupGroup (the entries a web page can offer). */
  M.copyPath = function (at, paths) {
    const join = (f) => paths.map(f).join('\n');
    Git.menu(at, [
      { label: t('Absolute Path'), shortcut: '⇧⌘C', action: () => Git.copy(join((p) => R.root + '/' + p)) },
      { label: t('File Name'), action: () => Git.copy(join((p) => Git.fileName(p))) },
      { label: t('Path From Content Root'), shortcut: '⌥⇧⌘C', action: () => Git.copy(join((p) => p)) },
    ]);
  };

  /** The file at `ref` (a ref pair, or a commit id) against the work tree file, in a diff tab of its own. */
  M.compareWith = function (path, ref, label) {
    const r = Git.actions.asRef(ref), rev = Git.actions.refId(r) || Git.actions.wire(r);
    Git.open('texts', { id: 'diff:with:' + path, title: Git.fileName(path) + ' (' + label + ')', path, what: 'Compare with Revision…',
      left: { title: label, at: { path, rev }, locked: true, nullIfMissing: true },
      right: { title: t('Current version'), at: { path, worktree: true }, nullIfMissing: true } });
  };
  /** Compare with Revision…: the file's revisions (log.fileHistory), newest first; the chosen one against the work tree. */
  M.compareWithRevision = function (path) {
    Git.content.fileHistory(path).then((res) => {
      const list = (res.entries || []).slice(0, 60);
      const at = M.lastPoint || { x: 200, y: 160 };
      Git.menu(at, list.length ? list.map((e) => {
        const c = Git.commit(e.id);
        return { label: Git.short(e.id) + '  ' + (c ? c.subject : ''), shortcut: c ? Git.formatDate(c.time, false) : '', action: () => M.compareWith(e.path, e.id, Git.short(e.id)) };
      }) : [{ label: t('No revisions'), disabled: true }]);
    }, (e) => Git.actions.errorNotice(e, t('Compare with Revision…')));
  };
  /** Compare with Branch or Tag…: local branches, remote branches, tags. */
  M.compareWithBranch = function (at, path) {
    // each entry is the ref of its group (a local `origin/x` and the remote `origin/x` are two entries)
    const group = (title, kind, names) => (names.length ? [{ header: t(title), label: t(title), disabled: true }]
      .concat(names.map((n) => ({ label: n, action: () => M.compareWith(path, Git.actions.ref(kind, n), n) }))) : []);
    Git.menu(at || M.lastPoint || { x: 200, y: 160 }, group('Local', 'local', Git.localBranches()).concat(group('Remote', 'remote', Git.remoteBranches()), group('Tags', 'tag', Git.tagNames())));
  };
  /** Show Current Revision: the last commit that changed the file, as the annotation's hover card shows a commit. */
  M.showCurrentRevision = function (at, path) {
    Git.content.fileHistory(path).then((res) => {
      const e = (res.entries || [])[0];
      if (!e) return;
      const c = Git.commit(e.id), author = c ? Git.author(c.author) : { name: '', email: '' };
      let pop = null;
      const msg = h('div.fv-tip-msg', c ? c.subject : '');
      pop = Git.popup({ x: (at || M.lastPoint || {}).x || 200, y: (at || M.lastPoint || {}).y || 160, className: 'gc-revision',
        content: h('div.gc-revision-card', { role: 'dialog', 'aria-label': t('Show Current Revision') },
          h('div', t('commit {0}', ''), h('button.g-link.g-mono#gc-revision-commit', { type: 'button', title: t('Show in Git Log'), onclick: () => { pop.close(); Git.actions.showInLog(e.id); } }, e.id)),
          c ? h('div', t('Author: {0}', author.name + ' <' + author.email + '>')) : null,
          c ? h('div', t('Date: {0}', Git.formatDate(c.time))) : null, msg) });
      Git.content.details(e.id).then((d) => { if (msg.isConnected) msg.textContent = d.subject + (d.body ? '\n\n' + d.body : ''); }, () => null);
    }, (err) => Git.actions.errorNotice(err, t('Show Current Revision')));
  };
  // where the last context menu opened: the menus opened from a menu item appear there
  document.addEventListener('contextmenu', (e) => { M.lastPoint = { x: e.clientX, y: e.clientY }; }, true);
})();
