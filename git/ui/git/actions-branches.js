/* Branches, tags and the merge / rebase entry points. Owner: the branches + remote + merge/rebase wave.
   Every write goes through A.run (actions.js); outcomes are read from `result` / `data.reason`, never from git's text.
   A `ref` below is a pair { kind, name } (A.ref) or typed text (A.typed resolves it); it reaches the engine as A.wire(ref).
     dialogs: newBranch(from?, label?) · renameBranch(ref) · newTag(id) · checkoutTagOrRevision()
     checkout(ref, { smart, force, overwriteLocal, ignoreOtherWorktrees, label }) · checkoutRevision(id)
     createBranch(name, from, { checkout, overwrite, onProblem }) -> Promise<result|null> · doRenameBranch(ref, to, o)
     deleteBranch(ref) · deleteBranches(refs) · toggleFavorite(ref) · doNewTag(name, at, { message, force, onProblem })
     deleteTag(ref) · pushTag(ref) · merge(ref, o) · rebaseOnto(ref, o) · checkoutAndRebase(ref) · pullInto(ref, method)
     compareWithCurrent(ref) · showDiffWithWorkingTree(ref | id) (the Log wave's views)
   Remote (fetch, update, push): actions-remote.js. The ongoing operation: actions-op.js. */
(function () {
  'use strict';
  const Git = window.Git;
  const R = Git.repo;
  const t = (...a) => Git.t(...a);
  const A = Git.actions;
  const { ok, info } = A;
  const D = () => Git.dialogs;

  Git.addTR({
    'Checked out new branch {0} from {1}': '{1} üzerinden yeni {0} dalı oluşturuldu ve checkout yapıldı',
    'New commits may be lost because the current commit is not on any branch. Check out a branch to avoid that.':
      'Geçerli commit hiçbir dalda olmadığı için yeni commit\'ler kaybolabilir. Bunu önlemek için bir dala checkout yap.',
    'Could not checkout {0}': '{0} checkout yapılamadı', 'Could not create branch {0}': '{0} dalı oluşturulamadı',
    'Could not rename branch {0}': '{0} dalı yeniden adlandırılamadı', "Branch {0} wasn't deleted": '{0} dalı silinmedi',
    'Could not Restore {0}': '{0} geri getirilemedi', 'Restored tag {0}': '{0} etiketi geri getirildi',
    'Created tag {0} successfully.': '{0} etiketi oluşturuldu.', 'Could not create tag {0}': '{0} etiketi oluşturulamadı',
    'Delete remote branch {0}?': '{0} uzak dalı silinsin mi?', 'Delete tracking local branch {0} as well': '{0} yerel dalını da sil',
    'Deleted branch {0}': '{0} dalı silindi', 'Also deleted local branch: {0}': 'Yerel dal da silindi: {0}', 'Also deleted local branches: {0}': 'Yerel dallar da silindi: {0}',
    'Could Not Merge {0}': '{0} merge edilemedi',
    'Your local changes were stashed: git puts them back when the merge is committed or aborted.': 'Yerel değişikliklerin stash\'e alındı: git onları merge commit edildiğinde ya da iptal edildiğinde geri koyar.',
    'Not possible to fast-forward, aborting.': 'Fast-forward yapılamıyor, durduruldu.',
    'refusing to merge unrelated histories': 'ilgisiz geçmişler merge edilmiyor',
    'Rebase is not possible in the detached HEAD state': 'Ayrık HEAD durumunda rebase yapılamaz', 'Rebase failed': 'Rebase başarısız oldu',
    "Branch '{0}' is checked out in another worktree": "'{0}' dalı başka bir worktree'de checkout edilmiş",
    'Changes from {0}': '{0} dalından gelen değişiklikler',
    'Push to {0}': '{0} uzak deposuna push et', 'Tag push failed': 'Etiket push\'u başarısız oldu',
    'Deleted Branch:': 'Dal silindi:', 'Deleted Tag:': 'Etiket silindi:', 'Delete on Remote': 'Uzakta da sil', 'Delete on Remotes': 'Uzaklarda da sil',
    'Deleted Tag on Remote:': 'Etiket uzakta silindi:', 'Deleted Tag on Remotes:': 'Etiket uzaklarda silindi:',
    "Tag Doesn't Exist on Remote:": 'Etiket uzakta yok:', "Tag Doesn't Exist on Remotes:": 'Etiket uzaklarda yok:',
    'Failed to delete tag {0} on Remote': '{0} etiketi uzakta silinemedi', 'Failed to delete tag {0} on Remotes': '{0} etiketi uzaklarda silinemedi', 'Checkout and Update': 'Checkout yap ve güncelle', 'Rollback failed': 'Geri alma başarısız oldu', 'Branch {0} has changed since it was created; it was left as it is.': '{0} dalı oluşturulduktan sonra değişti; olduğu gibi bırakıldı.', 'Branch {0} no longer exists.': '{0} dalı artık yok.',
  });

  const short = (id) => Git.short(id || '');
  const isHash = (s) => /^[0-9a-f]{40}$/.test(s || '');
  const shown = (ref) => (isHash(ref) ? short(ref) : ref);
  const localOf = A.localOf;
  /** "Cannot … because of unmerged files" for the refusals that name a stopped operation or unmerged files. */
  function blocked(reason, err) {
    if (reason !== 'op_in_progress' && reason !== 'unmerged_files') return false;
    // what git left half-made (data.incomplete): no conflicts to resolve, only Abort applies
    const d = (err && err.data) || {};
    if (reason === 'op_in_progress' && (d.incomplete || (R.op && R.op.incomplete))) { A.incompleteNotice(d.type || (R.op && R.op.type)); return true; }
    Git.notify({ kind: 'error', title: t('Cannot checkout because of unmerged files'), text: t('You need to resolve all merge conflicts before checkout.'),
      actions: [{ label: t('Resolve conflicts…'), run: () => A.resolveConflicts() }] });
    return true;
  }
  A.blockedReason = blocked;
  const busy = () => A.blockedByOp() || (Git.conflicts().length > 0 && blocked('unmerged_files'));

  // ---------------------------------------------------------------- dialogs (open only)
  /** `from`: a ref pair, a commit id or null (HEAD); `label`: how the dialog names it. */
  A.newBranch = function (from, label) { if (D().newBranch) D().newBranch({ from: from == null ? null : A.asRef(from), label: label || null }); };
  A.newBranchFrom = function (id) { A.newBranch(A.ref('revision', id)); };
  /** `ref`: a local branch (pair, or its name). */
  A.renameBranch = function (ref) { if (D().renameBranch) D().renameBranch(localOf(ref)); };
  A.newTag = function (id) { if (D().newTag) D().newTag(id); };
  /** Git ▸ New Tag… (Git.Tag): the "Tag" dialog; the Log's New Tag… on a commit is newTag(id) (Git.CreateNewTag). */
  A.tag = function (o) { if (D().tag) D().tag(o); };
  A.checkoutTagOrRevision = function () { if (D().checkoutRevision) D().checkoutRevision(); };
  A.compareWithCurrent = function (ref) {
    const a = A.asRef(ref);
    // the current branch as a pair (a branch `-x`, a tag named like it); a detached HEAD is the revision HEAD
    const b = A.currentRef() || A.ref('revision', 'HEAD');
    Git.open('compare', { a, b, title: A.refLabel(a) + ' ↔ ' + (R.head.branch ? A.refLabel(b) : A.current()) });
  };
  Git.openers.define('compare', ({ a, b, title }) => {
    if (!Git.views.compare || !Git.frame || !a || !b) return;
    Git.frame.openTab({ id: 'compare:' + A.wire(a), title, closable: true,
      mount: (el) => A.mountGuarded(Git.views.compare, el, { a, b }, title) });
  });
  /** `ref`: a ref pair, or a commit id (the Log's Compare with Local). */
  A.showDiffWithWorkingTree = function (ref) { Git.open('branchDiff', { ref: A.asRef(ref) }); };
  Git.openers.define('branchDiff', ({ ref }) => {
    if (!Git.views.branchDiff || !Git.frame || !ref) return;
    const r = A.asRef(ref), label = A.refLabel(r);
    Git.frame.openTab({ id: 'branchdiff:' + A.wire(r), title: () => t('Changes') + ': ' + label, closable: true,
      mount: (el) => A.mountGuarded(Git.views.branchDiff, el, { branch: r }, t('Changes') + ': ' + label) });
  });

  // ---------------------------------------------------------------- checkout
  A.checkout = function (target, o) {
    o = o || {};
    if (busy()) return Promise.resolve(null);
    const ref = A.asRef(target), name = A.refLabel(ref);
    const params = { target: A.wire(ref) };
    ['smart', 'force', 'overwriteLocal', 'ignoreOtherWorktrees'].forEach((k) => { if (o[k]) params[k] = true; });
    const again = (extra) => A.checkout(ref, Object.assign({}, o, extra));
    return A.run({ id: 'checkout', title: t('Checkout'), method: 'checkout', params, onError: A.failAs(t('Could not checkout {0}', o.label || name)),
      refused: (reason, err) => {
        const d = (err && err.data) || {};
        if (reason === 'local_branch_exists') {
          // the engine names the local branch by its short name: that is the local one
          D().localBranchExists({ branch: d.branch, remote: o.label || name, onDrop: () => again({ overwriteLocal: true }),
            onRebase: () => A.rebaseOnto(ref, { branch: A.ref('local', d.branch), checkedOut: true }) });
          return true;
        }
        if (reason === 'checked_out_elsewhere') {
          // the page can show that worktree in place (ui/git/worktrees.js): offered first, nothing is checked out
          const onShow = Git.worktrees && typeof Git.worktrees.show === 'function' && d.path ? () => Git.worktrees.show(d.path) : null;
          D().worktreeConflict({ branch: d.branch, path: d.path, onAnyway: () => again({ ignoreOtherWorktrees: true }), onShow });
          return true;
        }
        return blocked(reason, err);
      } })
      .then((res) => {
        if (!res) return null;
        if (res.result === 'would-overwrite') {
          // a Smart Checkout that stopped after its push and could not bring every change back: they are in the stash
          if (res.smart && res.smart.unstash === 'conflicts') { A.autostashConflicts({ autostash: 'conflicts' }, { operation: 'checkout', from: A.current(), stash: res.smart.stash }); return res; }
          if (res.smart) { A.autostashKept({ stash: res.smart.stash }); return res; }
          D().problem({ op: 'Checkout', files: res.files, untracked: res.untracked, force: true, onSmart: () => again({ smart: true }), onForce: () => again({ force: true }) });
          return res;
        }
        const prev = res.previous || {};
        const back = prev.branch || prev.id;
        const actions = [];
        // results name branches by their short name: a local branch (Rollback goes back to the branch, not to a tag of its name)
        if (back && (prev.branch !== res.branch || prev.id !== res.id)) actions.push({ label: t('Rollback'), run: () => A.checkout(prev.branch ? A.ref('local', prev.branch) : A.ref('revision', prev.id), { label: prev.branch || null }) });
        if (A.restoreAction(res.trash)) actions.push(A.restoreAction(res.trash));
        const title = res.created ? t('Checked out new branch {0} from {1}', res.branch, o.label || name) : t('Checked out {0}', res.branch || o.label || (res.kind === 'tag' ? name : shown(res.id)));
        const text = res.detached ? t('New commits may be lost because the current commit is not on any branch. Check out a branch to avoid that.') : null;
        ok(title, text, actions);
        // Smart Checkout whose stash did not come back: the shared notice (the stash stays, the files conflict)
        if (res.smart && res.smart.unstash === 'conflicts') A.autostashConflicts({ autostash: 'conflicts' }, { operation: 'checkout', from: res.branch || o.label || name, stash: res.smart.stash });
        // not put back (could not be told apart, or did not apply): the changes are kept in the stash
        if (res.smart && res.smart.unstash === 'kept') A.autostashKept({ stash: res.smart.stash });
        return res;
      });
  };
  A.checkoutRevision = function (id) { return A.checkout(A.ref('revision', id)); };
  /**
   * "Checkout and Update" (GitCheckoutWithUpdateAction): "Checkout {0}, fetch its tracked branch {1}, and update it in
   * one step". The branch is fast-forwarded from its upstream while it is not checked out (branch.update fetches
   * first), then checked out; when it has diverged, the checkout is followed by the update of the current branch.
   * `ref`: a local branch. The three commands run one after another (update, checkout, update).
   */
  A.checkoutAndUpdate = function (ref) {
    if (busy()) return Promise.resolve(null);
    const local = localOf(ref);
    return A.run({ id: 'update', title: t('Checkout and Update'), method: 'branch.update', params: { name: A.wire(local) }, onError: A.failAs(t('Update failed')) })
      .then((up) => {
        if (!up) return null;
        return A.checkout(local, { label: local.name }).then((res) => {
          if (res && res.result === 'checked-out' && up.result === 'diverged') return A.update(null, Git.host.prefs.get('update.method', null) || 'merge');
          return res;
        });
      });
  };

  // ---------------------------------------------------------------- create / rename / delete / favorite
  /** Called by the New Branch dialog; `name` is the new branch's name (not a ref), `from` a ref pair, an id or null
      (HEAD); `o.onProblem(reason)` shows a refusal in the dialog. Resolves to the result or null. */
  A.createBranch = function (name, from, o) {
    o = o || {};
    if (o.checkout && busy()) return Promise.resolve(null);
    const params = { name, checkout: !!o.checkout };
    const start = from == null ? null : A.asRef(from);
    if (start) params.from = A.wire(start);
    const mine = A.ref('local', name);
    if (o.overwrite) params.overwrite = true;
    const refused = (reason, err) => (o.onProblem && (reason === 'exists' || reason === 'current_branch') ? (o.onProblem(reason), true) : blocked(reason, err));
    const run = (p) => A.run({ title: t('New Branch'), method: 'branch.create', params: p, onError: A.failAs(t('Could not create branch {0}', name)), refused });
    return run(params).then((res) => {
      if (!res) return null;
      if (res.result === 'would-overwrite') {
        // IntelliJ creates the branch, then checks it out with the Smart / Force question.
        return run(Object.assign({}, params, { checkout: false })).then((made) => { if (made) { announce(made, false); A.checkout(mine); } return made; });
      }
      announce(res, res.checkedOut);
      return res;
    });
    function announce(res, checkedOut) {
      const prev = res.previous || {};
      // Rollback undoes the creation only while nothing happened to the branch since: once it moved (commits made on
      // it, a reset), deleting or resetting it would throw that work away.
      const rollback = async () => {
        const now = A.refId(mine);
        if (now !== res.id) {
          Git.notify({ kind: 'error', title: t('Rollback failed'), text: now ? t('Branch {0} has changed since it was created; it was left as it is.', name)
            : t('Branch {0} no longer exists.', name) });
          return;
        }
        if (checkedOut && (prev.branch || prev.id)) {
          const back = await A.checkout(prev.branch ? A.ref('local', prev.branch) : A.ref('revision', prev.id));
          if (!back || back.result !== 'checked-out') return;
        }
        // the branch just made, by its pair: a branch called `refs/heads/x` is not `x`
        if (res.overwritten) A.run({ title: t('Rollback'), method: 'branch.create', params: { name, from: res.overwritten, checkout: false, overwrite: true } });
        else A.run({ title: t('Rollback'), method: 'branch.delete', params: { name: A.wire(mine) } });
      };
      ok(checkedOut ? t('Checked out new branch {0} from {1}', name, start ? A.refLabel(start) : shown(prev.branch || prev.id)) : t('Branch {0} was created', name), null,
        [{ label: t('Rollback'), run: rollback }]);
    }
  };
  /** `ref`: the local branch (pair or name); `to`: the new name. */
  A.doRenameBranch = function (ref, to, o) {
    o = o || {};
    const from = localOf(ref);
    const params = { from: A.wire(from), to };
    if (o.unsetUpstream) params.unsetUpstream = true;
    return A.run({ title: t('Rename…'), method: 'branch.rename', params, onError: A.failAs(t('Could not rename branch {0}', from.name)),
      refused: (reason) => (reason === 'exists' && o.onProblem ? (o.onProblem(reason), true) : false) })
      .then((res) => {
        if (res) ok(t('Branch {0} was renamed to {1}', from.name, to), null, [{ label: t('Rollback'), run: () => A.doRenameBranch(A.ref('local', to), from.name) }]);
        return res;
      });
  };
  /** Restore of a deleted local branch from branch.delete's result `res`: the same head, and the same upstream by its
      FULL ref (`upstreamRef`: a local branch literally named `origin/x` beside the remote `origin/x` is not it). */
  A.restoreBranch = function (name, res) {
    const params = { name, from: res.head, checkout: false };
    if (res.upstreamRef) params.upstream = res.upstreamRef;
    return A.run({ title: t('Restore'), method: 'branch.create', params, onError: A.failAs(t('Could not Restore {0}', name)) });
  };
  /** `ref`: the branch as listed ({ kind: 'local' | 'remote', name }); a string is typed text (A.typed). */
  A.deleteBranch = function (ref) {
    const r = A.asRef(ref);
    if (r.kind === 'remote') return deleteRemote(r);
    return deleteLocal(localOf(r.kind === 'local' ? r : r.name)).then((out) => {
      if (!out.res) return null;
      announceDeleted([out]);
      return out.res;
    });
  };
  /** Delete Branches (the Log's branches pane): one after another, ONE notification for all of them. */
  A.deleteBranches = async function (refs) {
    const locals = [], remotes = [];
    refs.map(A.asRef).forEach((r) => (r.kind === 'remote' ? remotes : locals).push(r));
    const outs = await A.sequence(locals, (r) => deleteLocal(r));
    announceDeleted(outs);
    for (const r of remotes) await deleteRemote(r);   // each asks first (IntelliJ's question names the remote branch)
    return outs.map((o) => o.res);
  };
  /** One local branch, no notification: -> { ref, res } or { ref, fail: text }. */
  function deleteLocal(ref) {
    let fail = null;
    return A.run({ title: t('Delete'), method: 'branch.delete', params: { name: A.wire(ref) },
      refused: (reason, err) => {
        const d = (err && err.data) || {};
        fail = reason === 'checked_out_elsewhere' ? t("Branch '{0}' is checked out in another worktree", ref.name) + (d.path ? ': ' + d.path : '') : A.errorText(err);
        return true;
      },
      onError: (err) => { fail = (err && err.code === 'git_failed' && err.data && err.data.stderr) ? String(err.data.stderr).trim().split('\n').slice(-4).join('\n') : A.errorText(err); return true; } })
      .then((res) => (res ? { ref, res } : { ref, fail: fail || t("Branch {0} wasn't deleted", ref.name) }));
  }
  /** "<b>Deleted Branch:</b> a, b" with Restore (all of them), View Commits (unmerged ones), Delete Tracked Branch (one
      branch); the branches that were not deleted are one error notification. `outs`: deleteLocal's answers. */
  function announceDeleted(outs) {
    const done = outs.filter((o) => o.res), failed = outs.filter((o) => !o.res);
    if (failed.length) {
      Git.notify({ kind: 'error', title: t("Branch {0} wasn't deleted", failed.map((o) => o.ref.name).join(', ')),
        text: failed.map((o) => (failed.length > 1 ? o.ref.name + ': ' : '') + o.fail).join('\n') + (done.length ? '\n' + t('Deleted branch {0}', done.map((o) => o.ref.name).join(', ')) : '') });
    }
    if (!done.length) return;
    const names = done.map((o) => o.ref.name).join(', ');
    const restore = () => A.sequence(done, (o) => A.restoreBranch(o.ref.name, o.res));
    const unmerged = done.filter((o) => o.res.unmerged);
    const actions = [{ label: t('Restore'), run: restore }];
    if (unmerged.length === 1) {
      const o = unmerged[0];
      actions.push({ label: t('View Commits'), keep: true, run: () => D().notFullyMerged({ branch: o.ref.name, base: A.current(), ids: o.res.unmergedIds, onRestore: () => A.restoreBranch(o.ref.name, o.res) }) });
    }
    const up = done.length === 1 ? done[0].res.upstream : null;
    // the engine names the upstream by its short name under refs/remotes (`origin/x`): the remote branch
    if (up && Git.isRemote(up)) actions.push({ label: t('Delete Tracked Branch'), run: () => deleteRemote(A.ref('remote', up), true) });
    // branches__deleted_branch_notification.png: "Deleted Branch:" bold, the name plain (<b>Deleted Branch:</b> {0})
    Git.notify({ kind: 'info', title: boldTitle(t('Deleted Branch:'), names), text: unmerged.length ? t('Unmerged commits were discarded') : null, actions, sticky: unmerged.length > 0 });
  }
  /** Delete of a remote branch: IntelliJ asks first, and offers to delete the local branches tracking it. Resolves once
      the question is answered and everything ran: the remote branch first, then the local ones one after another; one
      notification ("Deleted remote branch {0}", "Also deleted local branches: …"). */
  function deleteRemote(ref, asked) {
    const name = ref.name;
    const tracking = Git.localBranches().filter((b) => (Git.isLocal(b) && R.branches[b].upstream === name) && b !== Git.currentBranch()).map((b) => A.ref('local', b));
    let alsoLocal = false;
    const run = async () => {
      const res = await A.run({ title: t('Delete'), method: 'branch.delete', params: { name: A.wire(ref), remote: true }, onError: A.failAs(t("Branch {0} wasn't deleted", name)) });
      if (!res) return null;
      const outs = alsoLocal ? await A.sequence(tracking, (r) => deleteLocal(r)) : [];
      const done = outs.filter((o) => o.res), failed = outs.filter((o) => !o.res);
      const lines = [];
      if (done.length) lines.push(t(done.length === 1 ? 'Also deleted local branch: {0}' : 'Also deleted local branches: {0}', done.map((o) => o.ref.name).join(', ')));
      failed.forEach((o) => lines.push(t("Branch {0} wasn't deleted", o.ref.name) + ': ' + o.fail));
      const restore = done.length ? [{ label: t('Restore'), run: () => A.sequence(done, (o) => A.restoreBranch(o.ref.name, o.res)) }] : null;
      Git.notify({ kind: failed.length ? 'warning' : 'info', title: t('Deleted remote branch {0}', name), text: lines.join('\n') || null, actions: restore, sticky: failed.length > 0 });
      return res;
    };
    if (asked) return run();
    return new Promise((resolve) => {
      const check = tracking.length ? Git.checkbox({ id: 'gb-del-tracking', label: t('Delete tracking local branch {0} as well', tracking.map((r) => r.name).join(', ')), onChange: (v) => { alsoLocal = v; } }) : null;
      let started = false;
      Git.dialog({ title: t('Delete'), width: 440, className: 'g-confirm', content: Git.h('div.g-confirm-text', t('Delete remote branch {0}?', name), check),
        buttons: [{ label: t('Cancel'), id: 'gb-del-cancel' }, { label: t('Delete'), primary: true, id: 'gb-del-ok', onClick: () => { started = true; run().then(resolve); } }],
        onClose: () => { if (!started) resolve(null); } });
    });
  }
  /** Mark/Unmark As Favorite of the ref as listed (A.favKey: a remote branch has a key of its own). */
  A.toggleFavorite = function (ref) {
    const r = A.asRef(ref);
    if (r.kind !== 'local' && r.kind !== 'remote') return Promise.resolve(null);
    // a local branch goes as its full ref (the engine stores its short name); a remote one as its own key
    const name = r.kind === 'local' ? A.wire(r) : A.favKey(r);
    return A.run({ id: 'branch.setFavorite:' + r.kind + ':' + r.name, title: t('Mark/Unmark As Favorite'), method: 'branch.setFavorite',
      params: { name, favorite: !A.isFavorite(r) } });
  };

  // ---------------------------------------------------------------- tags
  A.doNewTag = function (name, at, o) {
    o = o || {};
    const params = { name };
    if (at) params.at = at;
    if (o.message && o.message.trim()) params.message = o.message;
    if (o.force) params.force = true;
    return A.run({ title: t('New Tag…'), method: 'tag.create', params, onError: A.failAs(t('Could not create tag {0}', name)),
      refused: (reason) => (reason === 'exists' && o.onProblem ? (o.onProblem(reason), true) : false) })
      .then((res) => { if (res) ok(t('Created tag {0} successfully.', name)); return res; });
  };
  /** IntelliJ's titles with a bold label: "<b>Deleted Tag:</b> v1" (the balloon title is a node). */
  const boldTitle = (label, name) => [Git.h('b', label), ' ', name];
  A.boldTitle = boldTitle;
  /** "<b>Deleted Tag:</b> v1" + Restore, and "Delete on Remote" when a remote has the tag (tag.remotes, git ls-remote). */
  /** `ref`: the tag (pair or its name; a tag name is never anything else here). */
  const tagOf = (x) => (x && typeof x === 'object' ? x : A.ref('tag', String(x)));
  A.deleteTag = function (ref) {
    const tag = tagOf(ref), name = tag.name;
    // tag.remotes / tag.deleteRemote take the tag's name (they only know tags)
    const where = R.remoteNames.length ? Git.backend.call('tag.remotes', { repo: R.root, name }).then((r) => r.remotes, () => []) : Promise.resolve([]);
    return Promise.all([A.run({ title: t('Delete'), method: 'tag.delete', params: { name: A.wire(tag) } }), where]).then(([res, remotes]) => {
      if (!res) return null;
      const actions = [{ label: t('Restore'), run: () => A.run({ title: t('Restore'), method: 'tag.create', params: { name, at: res.object },
        onError: A.failAs(t('Could not Restore {0}', name)) }).then((r) => { if (r) ok(t('Restored tag {0}', name)); }) }];
      if (remotes.length) actions.push({ label: t(remotes.length === 1 ? 'Delete on Remote' : 'Delete on Remotes'), run: () => deleteTagOnRemotes(name, remotes) });
      info(boldTitle(t('Deleted Tag:'), name), null, actions);
      return res;
    });
  };
  /** Delete on Remotes: one remote after another, ONE notification (deleted on / did not exist on / failed on). */
  async function deleteTagOnRemotes(name, remotes) {
    const outs = await A.sequence(remotes, (remote) => {
      let fail = null;
      return A.run({ title: t('Delete on Remote'), method: 'tag.deleteRemote', params: { name, remote },
        refused: (reason, err) => { fail = A.errorText(err); return true; },
        onError: (err) => { fail = err && err.code === 'git_failed' && err.data && err.data.stderr ? String(err.data.stderr).trim().split('\n').slice(-3).join('\n') : A.errorText(err); return true; } })
        .then((res) => ({ remote, res, fail: res ? (res.result === 'rejected' ? res.message || t('Push rejected') : null) : fail || t('Failed to delete tag {0} on Remote', name) }));
    });
    const done = outs.filter((o) => o.res && o.res.result === 'deleted'), gone = outs.filter((o) => o.res && o.res.result === 'missing'), failed = outs.filter((o) => o.fail);
    const many = remotes.length > 1, names = (list) => list.map((o) => o.remote).join(', ');
    const lines = [];
    if (done.length && (gone.length || failed.length)) lines.push(t('Deleted Tag on Remotes:') + ' ' + names(done));
    if (gone.length && (done.length || failed.length)) lines.push(t("Tag Doesn't Exist on Remotes:") + ' ' + names(gone));
    failed.forEach((o) => lines.push(o.remote + ': ' + o.fail));
    if (failed.length) {
      Git.notify({ kind: 'error', sticky: true, title: t(failed.length === 1 ? 'Failed to delete tag {0} on Remote' : 'Failed to delete tag {0} on Remotes', name), text: lines.join('\n') });
      return outs;
    }
    const label = done.length ? (done.length === 1 && !many ? 'Deleted Tag on Remote:' : 'Deleted Tag on Remotes:') : (gone.length === 1 && !many ? "Tag Doesn't Exist on Remote:" : "Tag Doesn't Exist on Remotes:");
    info(boldTitle(t(label), name), lines.join('\n') || (many ? names(done.length ? done : gone) : null));
    return outs;
  }
  /** Tag ▸ Push to origin (engine: tag.push, core/ops/extra-branches.js). */
  A.pushTag = function (ref, remote) {
    const tag = tagOf(ref), name = tag.name;
    remote = remote || R.remoteName;
    return A.run({ id: 'push', title: t('Push to {0}', remote), method: 'tag.push', params: { name: A.wire(tag), remote }, onError: A.failAs(t('Tag push failed')) })
      .then((res) => {
        if (!res) return null;
        if (res.result === 'rejected') Git.notify({ kind: 'error', title: t('Push rejected'), text: res.message || null });
        else if (res.result === 'up-to-date') info(t('Everything is up to date'));
        else ok(t('Push successful'), t('Pushed tag {0} to {1}', name, remote));
        return res;
      });
  };

  // ---------------------------------------------------------------- merge / rebase entry points
  /** `ref`: what is merged (pair, or typed text); `o`: { noFf, ffOnly, squash, noCommit, message, noVerify,
      allowUnrelatedHistories, smart } (the Merge dialog's options), `into` (the branch the dialog showed: refused when
      another one is current now). */
  A.merge = function (ref, o) {
    o = o || {};
    if (busy() || !A.stillCurrent(o.into)) return Promise.resolve(null);
    const target = A.current();
    const from = A.asRef(ref), source = A.refLabel(from);
    const params = { rev: A.wire(from) };
    ['noFf', 'ffOnly', 'squash', 'noCommit', 'noVerify', 'allowUnrelatedHistories', 'smart'].forEach((k) => { if (o[k]) params[k] = true; });
    if (o.message && o.message.trim()) params.message = o.message;
    const fail = (text) => Git.notify({ kind: 'error', title: t('Could Not Merge {0}', source), text });
    return A.run({ id: 'merge', title: t('Merge'), method: 'merge', params, onError: A.failAs(t('Could Not Merge {0}', source)),
      refused: (reason, err) => {
        if (reason === 'not_fast_forward') { fail(t('Not possible to fast-forward, aborting.')); return true; }
        if (reason === 'unrelated_histories') { fail(t('refusing to merge unrelated histories')); return true; }
        return blocked(reason, err);
      } })
      .then((res) => {
        if (!res) return null;
        if (res.result === 'would-overwrite') {
          D().problem({ op: 'Merge', files: res.files, untracked: res.untracked, onSmart: () => A.merge(from, Object.assign({}, o, { smart: true })) });
          return res;
        }
        if (res.result === 'up-to-date') { info(t('Already up to date')); return res; }
        // a Smart merge with --no-commit: git holds the stashed local changes back until the merge is committed or aborted
        const held = res.autostash === 'pending' ? t('Your local changes were stashed: git puts them back when the merge is committed or aborted.') : null;
        const done = () => {
          ok(t('Merged {0} to {1}', source, target), held, from.kind === 'local' && from.name !== Git.currentBranch() ? [{ label: t('Delete {0}', source), run: () => A.deleteBranch(from) }] : null);
          if ((res.result === 'squashed' || res.result === 'no-commit') && Git.frame) Git.frame.showRight('commit');
        };
        // conflicts without a merge in progress: a squash merge's; a Smart Merge that completed but whose stash did not
        // come back is `autostash: 'conflicts'` on its outcome (settle shows the shared notice)
        A.settle(res, { done, operation: 'merge', from: source, context: { kind: 'merge', left: target, right: source } });
        return res;
      });
  };
  /** The Rebase dialog's options as the engine's `rebase` / `rebase.applyOnto` take them. */
  A.REBASE_FLAGS = ['rebaseMerges', 'keepEmpty', 'root', 'updateRefs', 'autosquash', 'noAutosquash'];
  /** `ref`: the new base (pair, or typed text). `o`: { branch (a local branch, checked out first), upstream (old base:
      --onto; pair or typed), checkedOut, allowPushed, into (A.headMark() of the dialog), …A.REBASE_FLAGS }. */
  A.rebaseOnto = function (ref, o) {
    o = o || {};
    if (busy() || (!o.branch && !A.stillCurrent(o.into, t('Rebase')))) return Promise.resolve(null);
    const onto = A.asRef(ref), target = A.refLabel(onto);
    const mine = o.branch ? localOf(o.branch) : null;
    const branch = mine ? mine.name : Git.currentBranch();
    const params = { onto: A.wire(onto) };
    if (mine && mine.name !== Git.currentBranch()) params.branch = A.wire(mine);
    if (o.upstream) params.upstream = A.wire(o.upstream);
    A.REBASE_FLAGS.concat('allowPushed').forEach((k) => { if (o[k]) params[k] = true; });
    return A.run({ id: 'rebase', title: t('Rebase'), method: 'rebase', params, onError: A.failAs(t('Rebase failed')),
      refused: (reason, err) => {
        if (reason === 'pushed_to_protected') { A.confirmPublished(() => A.rebaseOnto(onto, Object.assign({}, o, { allowPushed: true, into: null }))); return true; }
        if (reason === 'detached') { Git.notify({ kind: 'error', title: t('Rebase failed'), text: t('Rebase is not possible in the detached HEAD state') }); return true; }
        if (reason === 'checked_out_elsewhere') { Git.notify({ kind: 'error', title: t('Rebase failed'), text: t("Branch '{0}' is checked out in another worktree", (err.data || {}).branch || branch) }); return true; }
        return blocked(reason, err);
      } })
      .then((res) => {
        if (!res) return null;
        if (res.result === 'would-overwrite') { D().problem({ op: 'Rebase', files: res.files, untracked: res.untracked }); return res; }
        const name = res.branch || branch;
        if (res.result === 'up-to-date') { info(t('{0} is up-to-date with {1}', name, shown(target))); return res; }
        A.settle(res, { operation: 'rebase', from: shown(target),
          done: () => ok(t('Rebase successful'), t(res.checkedOut || o.checkedOut ? 'Checked out {0} and rebased it on {1}' : 'Rebased {0} on {1}', name, shown(target))) });
        return res;
      });
  };
  /** The remote a remote branch belongs to (the longest configured remote name that prefixes it: `team/x` of `team`). */
  const remoteOf = (name) => (R.remoteNames || []).filter((r) => name.indexOf(r + '/') === 0).sort((a, b) => b.length - a.length)[0] || null;
  /** "Checkout and Rebase onto 'current'": `ref` is checked out and rebased onto the branch that was current. */
  A.checkoutAndRebase = function (ref) {
    if (busy()) return Promise.resolve(null);
    const onto = A.currentRef();
    if (!onto) return Promise.resolve(null);
    const r = A.asRef(ref);
    if (r.kind === 'local') return A.rebaseOnto(onto, { branch: r, checkedOut: true });
    // A remote branch without a local one: IntelliJ silently creates the tracked local branch first.
    const remote = remoteOf(r.name);
    const local = A.ref('local', remote ? r.name.slice(remote.length + 1) : r.name.replace(/^[^/]+\//, ''));
    const ready = Git.isLocal(local.name) ? Promise.resolve(true)
      : A.run({ title: t('New Branch'), method: 'branch.create', params: { name: local.name, from: A.wire(r), checkout: false } });
    return ready.then((ok2) => (ok2 ? A.rebaseOnto(onto, { branch: local, checkedOut: true }) : null));
  };
  /** Remote branch ▸ Pull into 'current' Using Merge / Rebase: fetches that branch's remote, then (awaited) merges or rebases. */
  A.pullInto = function (ref, method) {
    if (busy() || !Git.currentBranch()) return Promise.resolve(null);
    const r = A.asRef(ref), remote = remoteOf(r.name) || r.name.split('/')[0];
    return A.run({ id: 'fetch', title: t('Fetch'), method: 'fetch', params: { remote } })
      .then((res) => (res ? (method === 'rebase' ? A.rebaseOnto(r) : A.merge(r)) : null));
  };
})();
