/* Fetch, Update Project, Update of one branch, Push (split from actions-branches.js). Owner: the branches +
   remote + merge/rebase wave. Outcomes come from `result` / `reason` fields; git's own text (stderr, `message`) is
   shown, never parsed.
     fetch(remote?) · updateProject() · update(branch?, method?) -> Promise · push(branch?) (opens the Push dialog)
     pushNow(branch, { force, target, remote, tags }) -> Promise · pushRejected(branch, res) */
(function () {
  'use strict';
  const Git = window.Git;
  const R = Git.repo;
  const t = (...a) => Git.t(...a);
  const A = Git.actions;
  const { ok, info, plural } = A;
  const prefs = () => Git.host.prefs;

  Git.addTR({
    'Fetch failed': 'Fetch başarısız oldu', 'No remotes': 'Uzak depo yok', 'Push failed': 'Push başarısız oldu', 'Update failed': 'Güncelleme başarısız oldu',
    "Can't Update": 'Güncellenemiyor',
    "No tracked branch configured for branch {0} or the branch doesn't exist.": '{0} dalı için izlenen bir dal ayarlanmamış ya da o dal yok.',
    'To make your branch track a remote branch call, for example, git branch --set-upstream-to={1} {0}':
      'Dalının bir uzak dalı izlemesi için örneğin şunu çalıştır: git branch --set-upstream-to={1} {0}',
    'Update skipped: detached HEAD': 'Güncelleme atlandı: ayrık HEAD',
    'Force pushed {0} to {1}': '{0}, {1} dalına force push edildi',
    ', and tag {0} to {1}': '; {0} etiketi de {1} deposuna gönderildi', ', and {0} tags to {1}': '; {0} etiket de {1} deposuna gönderildi',
    'Pushed tag {0} to {1}': '{0} etiketi {1} deposuna push edildi', 'Pushed {0} tags to {1}': '{0} etiket {1} deposuna push edildi',
    'Tag was not pushed': 'Etiket gönderilmedi', 'Tags were not pushed': 'Etiketler gönderilmedi',
    'Force push to the protected branch {0} is not allowed': 'Korumalı {0} dalına force push yapılamaz',
    'Push of the current branch is not possible in the detached HEAD state': 'Ayrık HEAD durumunda geçerli dal push edilemez',
    'Updated {0}': '{0} güncellendi', "Branch {0} can't be fast-forwarded to {1}": '{0} dalı {1} dalına fast-forward edilemiyor',
    'View Commits': 'Commit\'leri göster', '{0} is up-to-date': '{0} zaten güncel',
  });

  const busy = () => A.blockedByOp() || (Git.conflicts().length > 0 && A.blockedReason('unmerged_files'));
  const noRemotes = (title) => (reason) => {
    if (reason !== 'no_remotes') return false;
    Git.notify({ kind: 'error', title, text: t('No remotes') });
    return true;
  };

  // ---------------------------------------------------------------- fetch
  A.fetch = function (remote) {
    return A.run({ id: 'fetch', title: t('Fetch'), method: 'fetch', params: remote ? { remote } : {}, onError: A.failAs(t('Fetch failed')), refused: noRemotes(t('Fetch failed')) })
      .then((res) => { if (res) ok(t('Fetch successful')); return res; });
  };

  // ---------------------------------------------------------------- update
  A.updateProject = function () {
    const method = prefs().get('update.method', null);
    if (method || !Git.dialogs.updateProject) return A.update(null, method || 'merge');
    Git.dialogs.updateProject();
    return Promise.resolve(null);
  };
  /** "{0} files updated in {1} commits" + View Commits, as IntelliJ's update notification. */
  function updatedNotice(res) {
    const files = (res.files || []).length, commits = res.commits || (res.incoming || []).length;
    const key = plural(files, '{0} file', '{0} files') + ' updated in ' + plural(commits, '{1} commit', '{1} commits');
    const newest = (res.incoming || [])[0];
    ok(t(key, files, commits), null, newest ? [{ label: t('View Commits'), run: () => A.showInLog(newest) }] : null);
  }
  /**
   * Update Project for the current branch (`branch` other than the current one: a fast-forward of that branch from
   * its upstream, the popup's Update). `o.onConflicts` replaces the success notice when the update stopped on conflicts.
   */
  A.update = function (branch, method, o) {
    o = o || {};
    const mine = branch ? A.localOf(branch) : null;   // a local branch: its pair or its name
    if (mine && mine.name !== Git.currentBranch()) return updateOther(mine, o);
    if (busy()) return Promise.resolve(null);
    const current = Git.currentBranch();
    return A.run({ id: 'update', title: t('Update Project'), method: 'update', params: { method: method || 'merge' }, onError: A.failAs(t('Update failed')),
      refused: (reason, err) => {
        if (reason === 'detached') { Git.notify({ kind: 'error', title: t("Can't Update"), text: t('Update skipped: detached HEAD') }); return true; }
        return A.blockedReason(reason, err);
      } })
      .then((res) => {
        if (!res) return null;
        if (res.result === 'no-tracked-branch') {
          const b = res.branch || current;
          Git.notify({ kind: 'error', title: t("Can't Update"), text: t("No tracked branch configured for branch {0} or the branch doesn't exist.", b) + '\n' +
            t('To make your branch track a remote branch call, for example, git branch --set-upstream-to={1} {0}', b, R.remoteName + '/' + b) });
          return res;
        }
        if (res.result === 'would-overwrite') { Git.dialogs.problem({ op: 'Update', files: res.files, untracked: res.untracked }); return res; }
        const unstash = res.result !== 'conflicts' && res.autostash === 'conflicts';
        const stopped = res.result === 'conflicts' || unstash;
        // a push waiting for this update goes on only when nothing stopped (IntelliJ cancels it otherwise); the stash
        // that did not come back is the shared notice of the command core (settle → A.autostashConflicts)
        A.settle(res, { operation: 'update', from: res.upstream || null,
          done: () => { if (res.result === 'up-to-date') info(t('All files are up-to-date')); else if (o.onDone && !stopped) o.onDone(res); else updatedNotice(res); } });
        if (stopped && o.onConflicts) o.onConflicts(res);
        return res;
      });
  };
  /**
   * Update Project ▸ "Reset to the Remote Branch" ("Checks out the corresponding remote branch"; local commits are
   * dropped): fetches the upstream's remote, then checks the remote branch out over the local one (git checkout -B,
   * local changes are kept or go through Smart / Force Checkout), or, when the names differ, `reset --keep` to it.
   */
  A.resetToRemote = function (branch) {
    branch = branch || Git.currentBranch();
    const up = branch && Git.upstream(branch);
    if (!up || busy()) return Promise.resolve(null);
    const upRef = A.ref('remote', up);   // the upstream is a remote branch (a local branch called `origin/x` is not it)
    const remote = (R.remoteNames || []).filter((n) => up.indexOf(n + '/') === 0).sort((a, b) => b.length - a.length)[0];
    return A.run({ id: 'fetch', title: t('Fetch'), method: 'fetch', params: remote ? { remote } : {}, onError: A.failAs(t('Fetch failed')) }).then((f) => {
      if (!f) return null;
      const same = remote && up.slice(remote.length + 1) === branch;
      const go = (extra) => A.run({ id: 'reset', title: t('Reset to the Remote Branch'), onError: A.failAs(t('Update failed')),
        method: same ? 'checkout' : 'reset', params: same ? Object.assign({ target: A.wire(upRef), overwriteLocal: true }, extra) : { to: A.wire(upRef), mode: 'keep' } })
        .then((res) => {
          if (res && res.result === 'would-overwrite' && Git.dialogs.problem) {
            Git.dialogs.problem({ op: same ? 'Checkout' : 'Reset', files: res.files, untracked: res.untracked, force: same,
              onSmart: same ? () => go({ smart: true }) : null, onForce: same ? () => go({ force: true }) : null });
          } else if (res) ok(t('Reset to the Remote Branch'), branch + ' → ' + up, A.restoreAction(res.trash) ? [A.restoreAction(res.trash)] : null);
          return res;
        });
      return go({});
    });
  };
  /** Popup ▸ <branch> ▸ Update for a branch that is not checked out: fast-forward from its upstream (engine: branch.update).
      `o.quiet`: no notification (A.updateBranches reports the loop); the answer is { res } or { fail }. */
  function updateOther(ref, o) {
    const branch = ref.name;
    let fail = null;
    const failed = (err) => { fail = err && err.code === 'git_failed' && err.data && err.data.stderr ? String(err.data.stderr).trim().split('\n').slice(-3).join('\n') : A.errorText(err); return true; };
    return A.run({ id: 'update', title: t('Update'), method: 'branch.update', params: { name: A.wire(ref) },
      onError: o && o.quiet ? failed : A.failAs(t('Update failed')), refused: o && o.quiet ? (reason, err) => failed(err) : undefined }).then((res) => {
      if (o && o.quiet) return res ? { ref, res } : { ref, fail: fail || t('Update failed') };
      if (!res) return null;
      if (res.result === 'no-tracked-branch') Git.notify({ kind: 'error', title: t("Can't Update"), text: t("No tracked branch configured for branch {0} or the branch doesn't exist.", branch) });
      else if (res.result === 'diverged') Git.notify({ kind: 'error', title: t('Update failed'), text: t("Branch {0} can't be fast-forwarded to {1}", branch, res.upstream) });
      else if (res.result === 'up-to-date') info(t('All files are up-to-date'));
      else ok(t('Updated {0}', branch), null, res.after ? [{ label: t('View Commits'), run: () => A.showInLog(res.after) }] : null);
      return res;
    });
  }
  /** Update Selected of the Log's branches pane: the branches (not the current one) one after another, ONE notification. */
  A.updateBranches = async function (refs) {
    const list = refs.map(A.localOf);
    if (list.length === 1) return [await A.update(list[0])];
    const outs = await A.sequence(list, (r) => updateOther(r, { quiet: true }));
    const by = (pred) => outs.filter(pred).map((x) => x.ref.name);
    const updated = by((x) => x.res && (x.res.result === 'fast-forward')), same = by((x) => x.res && x.res.result === 'up-to-date');
    const bad = outs.filter((x) => !x.res || x.res.result === 'diverged' || x.res.result === 'no-tracked-branch');
    const lines = [];
    if (updated.length) lines.push(t('Updated {0}', updated.join(', ')));
    if (same.length) lines.push(t('{0} is up-to-date', same.join(', ')));
    bad.forEach((x) => lines.push(!x.res ? x.ref.name + ': ' + x.fail : x.res.result === 'diverged' ? t("Branch {0} can't be fast-forwarded to {1}", x.ref.name, x.res.upstream)
      : t("No tracked branch configured for branch {0} or the branch doesn't exist.", x.ref.name)));
    Git.notify({ kind: bad.length ? (updated.length || same.length ? 'warning' : 'error') : 'success', sticky: bad.length > 0,
      title: bad.length ? t('Update failed') : updated.length ? t('Updated {0}', updated.join(', ')) : t('All files are up-to-date'),
      text: bad.length ? lines.join('\n') : updated.length && same.length ? t('{0} is up-to-date', same.join(', ')) : null });
    return outs.map((x) => x.res || null);
  };

  // ---------------------------------------------------------------- push
  /** `branch`: a local branch (pair or name; default the current one). */
  A.push = function (branch) {
    const mine = branch ? A.localOf(branch) : A.currentRef();
    if (!mine) { Git.notify({ kind: 'error', title: t('Push failed'), text: t('Push of the current branch is not possible in the detached HEAD state') }); return; }
    if (Git.dialogs.push) Git.dialogs.push(mine); else A.pushNow(mine);
  };
  /** `ref`: the local branch (pair or name); `o`: { force, target (branch name on the remote), remote, tags (--follow-tags) }. */
  A.pushNow = function (ref, o) {
    o = o || {};
    const mine = ref ? A.localOf(ref) : null, branch = mine ? mine.name : null;
    const params = mine ? { branch: A.wire(mine) } : {};
    if (o.force) params.force = true;
    if (o.target) params.target = o.target;
    if (o.remote) params.remote = o.remote;
    if (o.allTags) params.allTags = true;
    else if (o.tags) params.tags = true;
    // "…, and tag v1 to origin" / "…, and 3 tags to origin", as IntelliJ's push notification ends
    const withTags = (text, res) => {
      const sent = res.tags || [];
      if (!sent.length) return text;
      return text + (sent.length === 1 ? t(', and tag {0} to {1}', sent[0], res.remote) : t(', and {0} tags to {1}', sent.length, res.remote));
    };
    const tagsRefused = (res) => {
      const list = res.tagsRejected || [];
      if (!list.length) return;
      Git.notify({ kind: 'warning', title: t(plural(list.length, 'Tag was not pushed', 'Tags were not pushed')),
        text: list.map((x) => x.tag + ': ' + (x.message || x.reason)).join('\n') });
    };
    return A.run({ id: 'push', title: t('Push'), method: 'push', params, onError: A.failAs(t('Push failed')),
      refused: (reason, err) => {
        const d = (err && err.data) || {};
        if (reason === 'protected_branch') { Git.notify({ kind: 'error', title: t('Push rejected'), text: t('Force push to the protected branch {0} is not allowed', d.target || o.target || branch) }); return true; }
        if (reason === 'detached') { Git.notify({ kind: 'error', title: t('Push failed'), text: t('Push of the current branch is not possible in the detached HEAD state') }); return true; }
        return noRemotes(t('Push failed'))(reason);
      } })
      .then((res) => {
        if (!res) return null;
        const target = res.target || o.target, pushedName = res.branch || branch;
        if (res.result === 'rejected') {
          if ((res.reason === 'non-fast-forward' || res.reason === 'fetch-first') && !o.force) A.pushRejected(mine || A.currentRef(), res, o);
          else Git.notify({ kind: 'error', title: t('Push rejected'), text: res.message || null });
          return res;
        }
        const sentTags = (res.tags || []).length;
        if (res.result === 'up-to-date' && !sentTags) info(t('Everything is up to date'));
        else if (res.result === 'up-to-date') ok(t('Push successful'), sentTags === 1 ? t('Pushed tag {0} to {1}', res.tags[0], res.remote) : t('Pushed {0} tags to {1}', sentTags, res.remote));
        else if (res.result === 'created') ok(t('Push successful'), withTags(t('Pushed {0} to new branch {1}', pushedName, target), res));
        else if (res.result === 'forced') ok(t('Push successful'), withTags(t('Force pushed {0} to {1}', pushedName, target), res));
        else ok(t('Push successful'), withTags(t(plural(res.count, 'Pushed {0} commit to {1}', 'Pushed {0} commits to {1}'), res.count, target), res));
        tagsRefused(res);
        return res;
      });
  };
  /** A rejected push: the Push Rejected dialog (or the remembered method), update, then push again unless it stopped. */
  /** `ref`: the local branch whose push was rejected. The update, then (awaited, from its outcome) the push again. */
  A.pushRejected = function (ref, res, o) {
    const mine = ref ? A.localOf(ref) : A.currentRef(), branch = mine ? mine.name : null;
    const again = (method) => A.update(branch === Git.currentBranch() ? null : mine, method, {
      onDone: () => A.pushNow(mine, o),
      onConflicts: () => Git.notify({ kind: 'warning', title: t('Push rejected'),
        text: t('Push was canceled, because there were conflicts during the update. Check that conflicts were resolved correctly, and invoke push again.') }),
    });
    const remembered = prefs().get('push.updateMethod', null);
    if (remembered && branch === Git.currentBranch()) { again(remembered); return; }
    if (Git.dialogs.pushRejected) {
      Git.dialogs.pushRejected(branch, { target: res && res.target, onUpdate: again,
        onForce: () => A.pushNow(mine, Object.assign({}, o, { force: true })) });   // --force-with-lease, as the dialog's Force Push does
    }
    else Git.notify({ kind: 'error', title: t('Push rejected'), text: (res && res.message) || null });
  };
})();
