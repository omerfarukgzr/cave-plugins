/* The Log's commit menu commands that open a dialog or a tab first (split out of actions-history.js).
     A.fixupInto(id, 'fixup'|'squash')   Fixup… / Squash Into…: Commit Changes dialog (files + message) → A.doFixup
     A.squashCommits(ids)                Squash Commits…: "Squashed Commit Message" → A.doSquash (rebase.apply)
     A.pushUpTo(id)                      Push All up to Here…: Push Commits dialog → push.upTo
     A.pushCommitsTo(ids, selected)      Push Selected Commits… (the branch's push target) / Add Commits to Remote
                                         Branch… (a remote branch to choose) → push.commits
     A.showRepositoryAt(id) · A.compareVersions(a, b) · A.showAllAffected(id)   tabs and a dialog of log-revisions.js
   Texts: GitBundle rebase.log.*, action.Git.*; the Push dialog's title is IntelliJ's "Push Commits to {0}". */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const A = Git.actions;
  const R = Git.repo;
  const L = () => Git.logUI || {};

  Git.addTR({
    'Commit Changes': 'Değişiklikleri commit et', 'Commit and Rebase': 'Commit et ve rebase et', 'Changes': 'Değişiklikler', 'Commit Message': 'Commit mesajı',
    'Squashed Commit Message': 'Squash edilen commit\'in mesajı', 'Edit message for squashed commit': 'Squash edilen commit için mesajı düzenle',
    'Push Commits to {0}': 'Commit\'leri push et: {0}', 'Push': 'Push', 'Cancel': 'Vazgeç', 'OK': 'Tamam', 'Push failed': 'Push başarısız oldu',
    'Push rejected': 'Push reddedildi',
    'Everything is up to date': 'Her şey güncel', 'Target branch:': 'Hedef dal:',
    'Commits to push:': 'Push edilecek commit\'ler:', "The commit is already pushed to protected branch '{0}'": "Commit korumalı '{0}' dalına zaten push edilmiş",
    'Loading…': 'Yükleniyor…', 'No remote branches': 'Uzak dal yok', 'Show Repository at Revision': 'Deponun bu sürümünü göster',
    '{0} at {1}': '{0} @ {1}', 'Changes Between {0} and {1}': '{0} ile {1} arasındaki değişiklikler',
  });

  const short = (id) => Git.short(id);
  const subjectOf = (id) => (Git.commit(id) || {}).subject || '';
  const commitLine = (id) => h('div.gla-commit', h('span.gla-hash', short(id)), ' ', subjectOf(id));
  /** IntelliJ refuses history edits of a commit on a protected remote branch (origin/main, origin/master) up front. */
  async function protectedHolder(id) {
    try { const res = await Git.content.containing(id); return (res.remotes || []).find((r) => /^[^/]+\/(main|master)$/.test(r)) || null; } catch (e) { return null; }
  }
  function blocked(key, ids, title) {
    const s = L().menuState ? L().menuState(ids, L().menuFacts())[key] : null;
    if (!s || s.on) return false;
    if (s.why) Git.notify({ kind: 'error', title, text: t(...s.why) });
    return true;
  }

  // ---------------------------------------------------------------- Fixup… / Squash Into…
  A.fixupInto = async function (id, mode) {
    const squash = mode === 'squash';
    const title = t(squash ? 'Cannot Create Squash Commit' : 'Cannot Create Fixup Commit');
    if (blocked(squash ? 'squashInto' : 'fixup', [id], title)) return null;
    const holder = await protectedHolder(id);
    if (holder) { Git.notify({ kind: 'error', title, text: t("The commit is already pushed to protected branch '{0}'", holder) }); return null; }
    // the files: those ticked in the Commit view (its public API), else every tracked change
    const local = (R.local || []).filter((c) => c.status !== '?');
    const commitView = Git.views.commit && Git.views.commit.included ? Array.from(Git.views.commit.included() || []) : [];
    const ticked = new Set(commitView.length ? commitView : local.map((c) => c.path));
    const list = h('div.gla-files');
    (R.local || []).forEach((c) => list.appendChild(h('div.gla-file', Git.checkbox({ checked: ticked.has(c.path), label: c.path,
      onChange: (on) => { if (on) ticked.add(c.path); else ticked.delete(c.path); update(); } }))));
    const message = Git.field({ id: 'gla-fixup-message', multiline: true, rows: squash ? 6 : 3, mono: true, label: t('Commit Message'),
      value: (squash ? 'squash! ' : 'fixup! ') + subjectOf(id) + (squash ? '\n\n' : ''), onInput: () => update() });
    const dlg = Git.dialog({ title: t('Commit Changes'), width: 560, className: 'gla-fixup',
      content: [h('div.g-label', t('Changes')), list, h('div.g-label', t('Commit Message')), message],
      buttons: [{ label: t('Cancel') }, { label: t('Commit and Rebase'), primary: true, id: 'gla-fixup-ok',
        onClick: () => { A.doFixup(id, mode, Array.from(ticked), message.input.value.replace(/\s+$/, '')); } }] });
    function update() { dlg.buttons['gla-fixup-ok'].disabled = !ticked.size || !message.input.value.trim(); }
    update();
    return dlg;
  };

  // ---------------------------------------------------------------- Squash Commits…
  A.squashCommits = async function (ids) {
    const title = t('Could not Squash Commits');
    if (blocked('squash', ids, title)) return null;
    const index = (x) => R.log.order.indexOf(x);
    const sorted = ids.slice().sort((a, b) => index(b) - index(a));              // oldest first
    const holder = await protectedHolder(sorted[0]);
    if (holder) { Git.notify({ kind: 'error', title, text: t("The commit is already pushed to protected branch '{0}'", holder) }); return null; }
    let details;
    try { details = await Promise.all(sorted.map((x) => Git.content.details(x))); } catch (err) { A.errorNotice(err, title); return null; }
    // IntelliJ's squashed message: the commits' whole messages in history order (oldest first), a blank line between.
    // commit.details names a message by `subject` (%s: a multi-line first paragraph folded into one line) and `body`;
    // `message` (the raw %B) is used when the engine sends it.
    const whole = (d) => (typeof d.message === 'string' ? d.message.replace(/\s+$/, '') : d.subject + (d.body ? '\n\n' + d.body : ''));
    const joined = details.map(whole).join('\n\n');
    const field = Git.field({ id: 'gla-squash-message', multiline: true, rows: 10, mono: true, label: t('Commit Message'), value: joined,
      onInput: (v) => { dlg.buttons['gla-squash-ok'].disabled = !v.trim(); } });
    const run = async () => {
      let plan;
      try { plan = await Git.content.rebasePlan(sorted[0]); } catch (err) { A.errorNotice(err, title); return; }
      const picked = new Set(sorted), message = field.input.value.replace(/\s+$/, '');
      // the dialog's commits must still be in the branch the plan is read from (HEAD may have moved meanwhile)
      if (sorted.some((x) => !plan.entries.some((e) => e.id === x))) { A.errorNotice({ code: 'refused', data: { reason: 'head_moved' } }, title, title); return; }
      // Untouched, the message is left to git: every picked commit after the oldest is a `squash`, and the engine joins
      // the commits' own messages (%B) in plan order — exactly IntelliJ's text, line breaks of a first paragraph kept.
      // Edited, the oldest keeps its place with the typed message and the others follow it as fixups.
      const untouched = field.input.value === joined;
      const entries = [];
      plan.entries.forEach((e) => {
        if (!picked.has(e.id)) { entries.push({ id: e.id, action: 'pick' }); return; }
        if (e.id !== sorted[0]) return;
        entries.push(untouched ? { id: e.id, action: 'pick' } : { id: e.id, action: 'pick', message });
        plan.entries.filter((x) => picked.has(x.id) && x.id !== sorted[0]).forEach((x) => entries.push({ id: x.id, action: untouched ? 'squash' : 'fixup' }));
      });
      A.doSquash(plan.base, entries, plan.head);
    };
    const dlg = Git.dialog({ title: t('Squashed Commit Message'), width: 560, className: 'gla-squash',
      content: [h('div.g-label', t('Edit message for squashed commit')), field],
      buttons: [{ label: t('Cancel') }, { label: t('OK'), primary: true, id: 'gla-squash-ok', onClick: () => { run(); } }] });
    field.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); dlg.buttons['gla-squash-ok'].click(); } });
    return dlg;
  };

  // ---------------------------------------------------------------- Push All up to Here…, Push Selected Commits…, Add Commits to Remote Branch…
  /** IntelliJ's push notifications for a push.upTo / push.commits result. */
  function pushed(res) {
    if (res.result === 'rejected') { Git.notify({ kind: 'error', title: t('Push rejected'), text: res.message || null }); return; }
    if (res.result === 'up-to-date' || res.result === 'nothing') { A.info(t('Everything is up to date')); return; }
    A.ok(t('Push successful'), t(res.count === 1 ? 'Pushed {0} commit to {1}' : 'Pushed {0} commits to {1}', res.count, res.target));
  }
  const pushRefused = (reason, err) => {
    Git.notify({ kind: 'error', title: t('Push failed'), text: A.reasonText ? A.reasonText(reason, err && err.data, 'push') : reason });
    return true;
  };
  /** `o`: { ids, target, disabled, run(dlg), watch?(dlg, redraw) -> off }: `watch` keeps the dialog true to the repository. */
  function pushDialog(o) {
    const list = h('div.gla-commits', o.ids.map(commitLine));
    const targetEl = h('span.gla-target-value', o.target);
    const dlg = Git.dialog({ title: t('Push Commits to {0}', R.name), width: 560, className: 'gla-push',
      content: [h('div.gla-target', h('span.g-label', t('Target branch:')), ' ', targetEl), h('div.g-label', t('Commits to push:')), list],
      buttons: [{ label: t('Cancel') }, { label: t('Push'), primary: true, id: 'gla-push-ok', disabled: !!o.disabled, onClick: () => { o.run(dlg); } }],
      onClose: () => { if (off) off(); } });
    const redraw = (ids, target, disabled) => {
      Git.clear(list); ids.forEach((x) => list.appendChild(commitLine(x)));
      Git.clear(targetEl).append(...[].concat(target));
      dlg.buttons['gla-push-ok'].disabled = !!disabled;
    };
    const off = o.watch ? o.watch(dlg, redraw) : null;
    return dlg;
  }
  /** Push All up to Here…: the dialog is built for the branch current when it opened and pushes THAT branch up to `id`;
      when the repository changes under it the list is read again, and when the branch is gone or no longer holds the
      commit the dialog closes and says so. */
  A.pushUpTo = async function (id) {
    if (blocked('pushUpTo', [id], t('Push failed'))) return null;
    const mine = A.currentRef();
    if (!mine) return null;
    const read = async () => {
      const out = await Git.content.outgoing(mine);
      const reach = Git.closure(id);
      const ids = (out.ids || []).filter((x) => reach.has(x));
      const target = [h('b', mine.name), ' → ', h('b', (out.remote || 'origin') + ' : ' + ((out.target || '').replace(/^[^/]+\//, '') || mine.name))];
      return { out, ids, target };
    };
    let shown = null;
    try { shown = await read(); } catch (err) { A.errorNotice(err, t('Push')); return null; }
    // the branch is gone, or holds the commit no more (a tip the Log has not loaded yet is left to the engine: not_in_branch)
    const gone = () => { const tip = A.refId(mine); return !tip || (!!Git.commit(tip) && !Git.isAncestor(id, tip)); };
    return pushDialog({ ids: shown.ids, target: shown.target, disabled: false,
      watch: (dlg, redraw) => Git.on('change', (ev) => {
        if (dlg.closed || !ev || ev.reason === 'log') return;
        if (gone()) { dlg.close(); Git.notify({ kind: 'warning', title: t('Push failed'), text: t('The commit is not in the current branch') + ': ' + mine.name }); return; }
        read().then((s) => { if (!dlg.closed) { shown = s; redraw(s.ids, s.target, false); } }, () => null);
      }),
      run: (dlg) => {
        if (gone()) { dlg.close(); Git.notify({ kind: 'warning', title: t('Push failed'), text: t('The commit is not in the current branch') + ': ' + mine.name }); return null; }
        dlg.close();
        // the branch the dialog was built for, as its full ref (push.upTo takes `refs/heads/…`, PROTOCOL Ref names)
        return A.run({ id: 'push', title: t('Push'), method: 'push.upTo', params: { id, branch: A.wire(mine) }, failTitle: t('Push failed'), refused: pushRefused })
          .then((res) => { if (res) pushed(res); return res; });
      } });
  };
  A.pushCommitsTo = async function (ids, selected) {
    if (blocked(selected ? 'pushSelected' : 'addToRemote', ids, t('Push failed'))) return null;
    const sorted = ids.slice().sort((a, b) => R.log.order.indexOf(b) - R.log.order.indexOf(a));
    const branches = Git.remoteBranches().filter((n) => !/\/HEAD$/.test(n));
    let target = null;
    if (selected) {
      let out = null;
      try { out = await Git.content.outgoing(Git.currentBranch()); } catch (err) { A.errorNotice(err, t('Push')); return null; }
      target = out.target || ((out.remote || 'origin') + '/' + Git.currentBranch());
    } else target = branches.find((n) => n === Git.upstream(Git.currentBranch())) || branches[0] || null;
    const pick = selected ? h('b', target) : h('select.g-input.gla-remote', { id: 'gla-push-target', onchange: (e) => { target = e.target.value; } },
      branches.map((n) => h('option', { value: n, selected: n === target }, n)));
    return pushDialog({ ids: sorted, target: pick, disabled: !target,
      run: () => {
        const slash = target.indexOf('/');
        return A.run({ id: 'push', title: t('Push'), method: 'push.commits', params: { ids: sorted, remote: target.slice(0, slash), target: target.slice(slash + 1) },
          failTitle: t('Push failed'), refused: pushRefused }).then((res) => { if (res) pushed(res); return res; });
      } });
  };

  // ---------------------------------------------------------------- tabs of log-revisions.js
  A.showRepositoryAt = function (id) { Git.open('repoAt', { rev: id }); };
  Git.openers.define('repoAt', ({ rev: id }) => {
    if (!Git.frame || !Git.views.repoAt || !id) return;
    Git.frame.openTab({ id: 'repo-at:' + id, title: () => t('{0} at {1}', R.name, short(id)), closable: true,
      mount: (el) => A.mountGuarded(Git.views.repoAt, el, { rev: id }, t('Show Repository at Revision')) });
  });
  A.compareVersions = function (a, b) { Git.open('versions', { a, b }); };
  Git.openers.define('versions', ({ a, b }) => {
    if (!Git.frame || !Git.views.versions || !a || !b) return;
    Git.frame.openTab({ id: 'versions:' + a + '..' + b, title: () => t('Changes Between {0} and {1}', short(a), short(b)), closable: true,
      mount: (el) => A.mountGuarded(Git.views.versions, el, { a, b }, t('Changes Between {0} and {1}', short(a), short(b))) });
  });
})();
