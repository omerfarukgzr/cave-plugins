/* IntelliJ's "Push Commits to <project>" dialog (split from branches-dialogs.js). Left: "branch → origin :
   target" with the commits the push sends (push.outgoing); the target branch name is a link that turns into a field;
   right: the files of the selected commit (of all of them on the top row) and its details (commit.details).
   Push is a split button whose arrow holds Force Push (--force-with-lease), absent for a protected target.
   Git.dialogs.push(branch) */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const R = Git.repo, A = Git.actions;
  const D = (Git.dialogs = Git.dialogs || {});

  Git.addTR({
    'Push Commits to {0}': 'Commit\'leri push et: {0}', 'New': 'Yeni', 'Push': 'Push', 'Force Push': 'Force Push',
    "You're going to force push to {0}. It may overwrite commits at the remote. Are you sure you want to proceed?":
      '{0} dalına force push yapmak üzeresin. Uzaktaki commit\'lerin üzerine yazabilir. Devam edilsin mi?',
    'No commits selected': 'Seçili commit yok', 'No differences': 'Fark yok', 'Select to show commit details': 'Ayrıntısını görmek için bir commit seç',
    '{0} file': '{0} dosya', '{0} files': '{0} dosya', '{0}  {1}  by {2}': '{0}  {1}  {2}', 'Push tags:': 'Etiketleri push et:', 'Current Branch': 'Geçerli dal',
    'Edit target': 'Hedefi düzenle', 'Loading…': 'Yükleniyor…', 'Nothing to push': 'Push edilecek bir şey yok',
    "Push will be rejected, branch '{0}' has diverged from the remote: {1} remote commits are not in your local branch.":
      "Push reddedilecek: '{0}' dalı uzaktakinden ayrıldı, uzaktaki {1} commit yerel dalında yok.",
    'Update project…': 'Projeyi güncelle…', 'Show Diff': 'Diff\'i göster', 'Edit Source': 'Kaynağı düzenle', 'Show Details': 'Ayrıntıları göster',
    'View Options': 'Görünüm seçenekleri', 'Group By': 'Grupla', 'Directory': 'Klasör', 'Expand All': 'Tümünü aç', 'Collapse All': 'Tümünü kapat',
  });
  // DvcsBundle push.divergence.banner.diverged / .no.force, with the choice formats spelled out
  const DIVERGED = "Push will be rejected, branch '{0}' has diverged from the remote: {1} remote commits are not in your local branch. To keep them, update the project first. To replace them, use Force Push.";
  const DIVERGED_1 = "Push will be rejected, branch '{0}' has diverged from the remote: {1} remote commit is not in your local branch. To keep it, update the project first. To replace it, use Force Push.";
  const DIVERGED_NO_FORCE = "Push will be rejected, branch '{0}' has diverged from the remote: {1} remote commits are not in your local branch. The target branch is protected, so update the project first.";
  const DIVERGED_NO_FORCE_1 = "Push will be rejected, branch '{0}' has diverged from the remote: {1} remote commit is not in your local branch. The target branch is protected, so update the project first.";
  Git.addTR({
    [DIVERGED]: "Push reddedilecek: '{0}' dalı uzaktakinden ayrıldı, uzaktaki {1} commit yerel dalında yok. Onları korumak için önce projeyi güncelle. Yerlerine yazmak için Force Push kullan.",
    [DIVERGED_1]: "Push reddedilecek: '{0}' dalı uzaktakinden ayrıldı, uzaktaki {1} commit yerel dalında yok. Onu korumak için önce projeyi güncelle. Yerine yazmak için Force Push kullan.",
    [DIVERGED_NO_FORCE]: "Push reddedilecek: '{0}' dalı uzaktakinden ayrıldı, uzaktaki {1} commit yerel dalında yok. Hedef dal korumalı, önce projeyi güncelle.",
    [DIVERGED_NO_FORCE_1]: "Push reddedilecek: '{0}' dalı uzaktakinden ayrıldı, uzaktaki {1} commit yerel dalında yok. Hedef dal korumalı, önce projeyi güncelle.",
  });

  const PROTECTED = ['main', 'master'];   // IntelliJ's default protected branches (the engine refuses a force push there)

  /** `ref`: the local branch (its pair or its name; default the current one). The dialog sends that branch, whatever is
      current when Push is pressed; when the branch moved under the open dialog the list is read again first. */
  D.push = function (ref) {
    const mine = ref ? A.localOf(ref) : A.currentRef();
    if (!mine || !Git.isLocal(mine.name)) return null;
    const branch = mine.name;
    let out = null, commits = [], chosen = 'root', menu = null, targetName = null, tags = false;
    const detailsOf = new Map();

    // Left: "branch → origin : branch" with the commits that will go under it.
    const targetEl = h('span.gb-push-target');
    const leftEl = h('div.gb-push-commits.g-grow', { 'aria-label': t('Push Commits to {0}', R.name) });
    const banner = h('div.gb-push-banner', { hidden: true, role: 'status' });
    const remoteName = () => (out && out.remote) || R.remoteName;
    const target = () => targetName || (out && out.target ? out.target.slice(remoteName().length + 1) : branch);
    const isNew = () => (out ? !Git.isRemote(remoteName() + '/' + target()) : false);
    function drawTarget() {
      Git.clear(targetEl);
      const link = h('button.g-link.gb-push-branch', { type: 'button', id: 'gb-push-target', title: t('Edit target'), onclick: (e) => { e.stopPropagation(); editTarget(); } }, target());
      targetEl.append(...[h('span.gb-push-local', branch), h('span.gb-push-arrow', '→'), h('span', remoteName()), h('span.gb-push-colon', ':'), link,
        isNew() ? h('span.gb-badge', t('New')) : null].filter(Boolean));
    }
    function editTarget() {
      const field = h('input.g-input.gb-push-edit', { type: 'text', id: 'gb-push-target-field', spellcheck: 'false', value: target() });
      const done = (keep) => { if (keep && field.value.trim()) targetName = field.value.trim(); drawTarget(); left.render(); drawForce(); };
      field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } });
      field.addEventListener('blur', () => done(true));
      Git.clear(targetEl).append(h('span.gb-push-local', branch), h('span.gb-push-arrow', '→'), h('span', remoteName()), h('span.gb-push-colon', ':'), field);
      setTimeout(() => { field.focus(); field.select(); }, 0);
    }
    const left = Git.tree({ el: leftEl, nodes: () => [{ id: 'root', kind: 'push-root', label: targetEl, children: commits.map((id) => {
      const c = Git.commit(id), d = detailsOf.get(id);
      const subject = c ? c.subject : d ? d.subject : Git.short(id);
      const who = c ? Git.author(c.author) : d ? d.author : { name: '' };
      // A commit somebody else wrote carries IntelliJ's asterisk.
      const mine = c ? Git.isMine(c) : !d || (d.author.email === R.meInfo.email);
      return { id, kind: 'push-commit', label: subject, dim: mine ? null : '*',
        tooltip: t('{0}  {1}  by {2}', Git.short(id), Git.formatDate(c ? c.time : d ? d.time : 0), who.name) + '\n\n' + subject };
    }) }], onSelect: (nodes) => { chosen = nodes[0] ? nodes[0].id : 'root'; drawRight(); } });

    // Right: the files of the selected commit (of all of them on the top row), and the commit's details under them.
    const filesEl = h('div.gb-push-files.g-grow');
    const detail = h('div.gb-push-detail.g-scroll');
    const filesOpts = { el: filesEl, emptyText: '', nodes: () => {
      const seen = new Map();
      (chosen === 'root' ? commits : [chosen]).forEach((id) => {
        const d = detailsOf.get(id);
        ((d && d.changes[0] && d.changes[0].files) || []).forEach((ch) => { if (!seen.has(ch.path)) seen.set(ch.path, ch); });
      });
      const changes = Array.from(seen.values()).sort((a, b) => a.path.localeCompare(b.path));
      if (!changes.length) return [];
      const files = (n) => t(n === 1 ? '{0} file' : '{0} files', n);
      const leaf = (ch) => ({ id: 'f:' + ch.path, label: Git.fileName(ch.path), icon: Git.fileIcon(ch.path), color: Git.statusColor(ch.status), tooltip: ch.path, data: ch });
      const dirs = new Map();
      changes.forEach((ch) => { const d = Git.dirName(ch.path); if (!dirs.has(d)) dirs.set(d, []); dirs.get(d).push(ch); });
      const kids = [];
      if (!byDir) changes.forEach((ch) => kids.push(Object.assign(leaf(ch), { dim: Git.dirName(ch.path) || null })));
      else Array.from(dirs.keys()).sort().forEach((d) => {
        if (!d) dirs.get(d).forEach((ch) => kids.push(leaf(ch)));
        else kids.push({ id: 'd:' + d, label: d, icon: 'nodes/folder', dim: files(dirs.get(d).length), children: dirs.get(d).map(leaf) });
      });
      return [{ id: 'repo', label: R.name, icon: 'nodes/folder', dim: files(changes.length), children: kids }];
    }, onActivate: (n) => {
      if (!n.data) return;
      // the newest commit of the push that touches the file (the top row), or the selected commit; the diff opens over the dialog
      const id = chosen === 'root' ? commits.find((x) => ((detailsOf.get(x) || { changes: [] }).changes[0] || { files: [] }).files.some((f) => f.path === n.data.path)) : chosen;
      if (id && Git.mergeUi && Git.mergeUi.diffOver) Git.mergeUi.diffOver(id, n.data.path);
    } };
    filesOpts.onSelect = () => syncBar();
    const files = Git.tree(filesOpts);
    // The files' toolbar (tags__push_tags.png): Show Diff · View Options · Edit Source · Show Details | Expand / Collapse All
    let byDir = true, showDetails = true;
    const fileNode = () => { const n = files.selected()[0]; return n && n.data ? n : null; };
    const showDiff = () => { const n = fileNode(); if (n) filesOpts.onActivate(n); };
    const bar = {};
    const filesBar = h('div.g-toolbar.gb-push-bar', { role: 'toolbar' },
      (bar.diff = Git.toolBtn({ icon: 'vcs/diff', title: t('Show Diff') + '  ⌘D', id: 'gb-push-diff', disabled: true, onClick: showDiff })),
      Git.toolBtn({ icon: 'general/show', title: t('View Options'), id: 'gb-push-view', arrow: true, onClick: (e) => Git.menu(e.currentTarget, [
        { label: t('Group By'), disabled: true }, { label: t('Directory'), checked: byDir, action: () => { byDir = !byDir; files.render(); } }]) }),
      (bar.edit = Git.toolBtn({ icon: 'general/edit', title: t('Edit Source') + '  F4', id: 'gb-push-edit', disabled: true, onClick: () => {
        const n = fileNode();
        if (n && Git.fileView) { dlg.close(); Git.fileView.open(n.data.path, {}); }
      } })),
      (bar.details = Git.toolBtn({ icon: 'general/editorPreview', title: t('Show Details'), id: 'gb-push-details', active: true, onClick: () => {
        showDetails = !showDetails; detail.hidden = !showDetails; bar.details.classList.toggle('on', showDetails); bar.details.setAttribute('aria-pressed', String(showDetails));
      } })),
      h('span.g-spacer'),
      Git.toolBtn({ icon: 'general/expandAll', title: t('Expand All'), id: 'gb-push-expand', onClick: () => files.expandAll() }),
      Git.toolBtn({ icon: 'general/collapseAll', title: t('Collapse All'), id: 'gb-push-collapse', onClick: () => files.collapseAll() }));
    function syncBar() { const n = fileNode(); bar.diff.disabled = !n; bar.edit.disabled = !n || !Git.fileView; }
    function drawRight() {
      const d = chosen === 'root' ? null : detailsOf.get(chosen);
      filesOpts.emptyText = !out ? t('Loading…') : !commits.length ? t('No commits selected') : t('No differences');
      files.render();
      Git.clear(detail);
      if (chosen === 'root') { if (commits.length) detail.appendChild(h('div.g-dim', t('Select to show commit details'))); return; }
      if (!d) { detail.appendChild(Git.content.loading()); return; }
      detail.appendChild(h('div.gb-push-subject', d.subject));
      if (d.body) detail.appendChild(h('div.gb-push-body', d.body));
      detail.appendChild(h('div.gb-push-meta', h('span.g-mono', Git.short(d.id)), ' ', d.author.name));
      detail.appendChild(h('div.gb-push-meta.g-dim', d.author.email ? '<' + d.author.email + '>  ' : '', Git.formatDate(d.time)));
    }

    const leftPane = h('div.gb-push-left.g-col', banner, leftEl);
    const tagsBox = Git.checkbox({ id: 'gb-push-tags', label: t('Push tags:'), checked: false, onChange: (v) => { tags = v; tagsMode.disabled = !v; } });
    // IntelliJ's two modes: All (git push --tags, the default) and Current Branch (--follow-tags)
    const tagsMode = h('select.g-input.gb-push-tags-mode', { id: 'gb-push-tags-mode', disabled: true },
      h('option', { value: 'all' }, t('All')), h('option', { value: 'current' }, t('Current Branch')));
    const dlg = Git.dialog({
      title: t('Push Commits to {0}', R.name), width: 780, height: 400, className: 'gb-push',
      content: [leftPane, Git.splitter({ target: leftPane, edge: 'right', min: 220, max: 560 }), h('div.gb-push-right.g-col.g-grow', filesBar, filesEl, detail)],
      left: [Git.mergeUi.help(Git.mergeUi.HELP.push, 'gb-push-help'), h('div.gb-push-opts', tagsBox, tagsMode)],
      buttons: [{ label: t('Cancel') }, { label: t('Push'), primary: true, id: 'push', keepOpen: true, onClick: (d) => { if (moved()) return false; d.close(); A.pushNow(mine, options()); return true; } }],
      onClose: () => { if (menu) menu.close(); off(); },
    });
    /** The branch is not where the list was read (a commit, a reset, gone): the dialog says so and reads it again. */
    function moved() {
      const now = A.refId(mine);
      if (!out || now === out.head) return false;
      if (!now) { dlg.close(); A.errorNotice({ code: 'not_found', data: { rev: branch } }, t('Push')); return true; }
      Git.notify({ kind: 'warning', title: t('The repository has changed in the meantime. Try again.'), text: t('Push Commits to {0}', R.name) + ': ' + branch });
      load();
      return true;
    }
    const off = Git.on('change', (ev) => { if (!dlg.closed && ev && ev.reason !== 'log' && out && A.refId(mine) !== out.head) load(); });
    const options = (force) => {
      const o = {};
      if (tags) { if (tagsMode.value === 'current') o.tags = true; else o.allTags = true; }
      if (targetName && targetName !== (out && out.target ? out.target.slice(remoteName().length + 1) : branch)) o.target = targetName;
      if (force) o.force = true;
      return o;
    };
    // Push is a split button: its arrow holds Force Push (git push --force-with-lease), which asks before it runs.
    const force = () => Git.confirm({ title: t('Force Push'), danger: true, yes: t('Force Push'),
      text: t("You're going to force push to {0}. It may overwrite commits at the remote. Are you sure you want to proceed?", remoteName() + '/' + target()),
      onYes: () => { if (moved()) return; dlg.close(); A.pushNow(mine, options(true)); } });
    const arrow = h('button.g-btn.primary.gb-split-arrow', { type: 'button', id: 'gb-push-more', title: t('Force Push'), 'aria-label': t('Force Push'), 'aria-haspopup': 'true',
      onclick: () => {
        if (menu) { menu.close(); return; }
        const item = h('button.g-menu-item', { type: 'button', id: 'gb-force-push', onclick: () => { menu.close(); force(); } }, h('span.g-menu-label', t('Force Push')));
        menu = Git.popup({ anchor: arrow, content: h('div.g-menu', { role: 'menu' }, item), className: 'gb-suggest-pop', onClose: () => { menu = null; } });
        menu.keepFor = arrow;
      } }, Git.icon('chevronDownSmall'));
    dlg.primary.classList.add('gb-split-main');
    dlg.footer.appendChild(arrow);
    function drawForce() { arrow.hidden = PROTECTED.indexOf(target()) >= 0; dlg.primary.classList.toggle('gb-split-main', !arrow.hidden); }

    drawTarget();
    left.render();
    left.select('root', true);
    drawRight();
    drawForce();
    let reads = 0;
    function load() {
      const n = ++reads;
      Git.content.outgoing(mine).then((res) => {
      if (dlg.closed || n !== reads) return;
      out = res;
      commits = res.ids || [];
      banner.hidden = true;
      if (res.behind) {
        // push.divergence.banner.diverged (…no.force when the target is protected) + the "Update project…" link
        const one = res.behind === 1, guarded = PROTECTED.indexOf(target()) >= 0;
        const text = guarded
          ? t(one ? DIVERGED_NO_FORCE_1 : DIVERGED_NO_FORCE, branch, res.behind)
          : t(one ? DIVERGED_1 : DIVERGED, branch, res.behind);
        banner.hidden = false;
        Git.clear(banner).append(h('span', text), ' ',
          h('button.g-link', { type: 'button', id: 'gb-push-update', onclick: () => { dlg.close(); A.updateProject(); } }, t('Update project…')));
      }
      drawTarget();
      drawForce();
      left.render();
      chosen = commits[0] || 'root';
      left.select(chosen, true);
      drawRight();
      commits.slice(0, 300).forEach((id) => Git.content.details(id).then((d) => { detailsOf.set(id, d); if (!dlg.closed) { left.render(); drawRight(); } }, () => null));
      }, (err) => { if (!dlg.closed) { A.errorNotice(err, t('Push')); dlg.close(); } });
    }
    load();
    return dlg;
  };
})();
