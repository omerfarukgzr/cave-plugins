/* The stash dialogs (docs/spec-stash.md §2–3): Stash (GitStashDialog), Unstash Changes in <root> (GitUnstashAsDialog,
   the Stash tab's Unstash…), Unstash Changes (GitUnstashDialog, Git ▸ Unstash Changes…), Paths Affected by (its View),
   and the Drop / Clear questions (GitStashOperations). Labels are IntelliJ's (GitBundle keys in the spec).
     Git.dialogs.stash() · .unstashAs(stash) · .unstash() · .stashDrop(stash) · .stashClear() · .stashPaths(stash) */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const R = Git.repo, A = Git.actions;
  const D = (Git.dialogs = Git.dialogs || {});

  Git.addTR({
    'Git Root:': 'Git kökü:', 'Current Branch:': 'Geçerli dal:', 'Current branch:': 'Geçerli dal:', 'Message:': 'Mesaj:',
    'Keep index': 'Keep index', 'Include untracked': 'Takip edilmeyenleri de al', 'Create Stash': 'Stash oluştur',
    'If this checkbox is selected, all changes already added to the index are left intact': 'İşaretliyse index\'e eklenmiş değişikliklere dokunulmaz',
    'If this checkbox is selected, all untracked files are also stashed': 'İşaretliyse takip edilmeyen dosyalar da stash\'lenir',
    'Enter stash message here': 'Stash mesajını buraya yaz',
    'Unstash Changes in {0}': '{0} içinde stash\'ten geri al', 'Unstash Changes': 'Stash\'ten geri al', 'As new branch:': 'Yeni dal olarak:',
    'Pop stash': 'Pop stash', 'Reinstate index': 'Reinstate index', 'Apply Stash': 'Stash\'i uygula', 'Pop Stash': 'Pop stash', 'Branch': 'Dal',
    'If selected the stash is dropped after it is applied': 'İşaretliyse stash uygulandıktan sonra silinir',
    'Attempt to reinstate index as well as working tree changes': 'Çalışma kopyasındaki değişikliklerle birlikte index\'i de geri koymayı dene',
    'If non-empty name is entered, the stash is checked out as a new branch': 'Bir ad yazılırsa stash yeni bir dal olarak checkout yapılır',
    'Stashes:': 'Stash\'ler:', 'Drop': 'Drop', 'View selected stash': 'Seçili stash\'i göster',
    'Delete selected stash': 'Seçili stash\'i sil', 'Delete all stashes in the repository': 'Depodaki bütün stash\'leri sil',
    'Paths Affected by {0}': '{0} tarafından değişen yollar', 'Remove Stash {0}?': '{0} silinsin mi?', 'Do you want to remove {0}?': '{0} silinsin mi?',
    'Remove All Stashes?': 'Bütün stash\'ler silinsin mi?', 'Remove all stashes?': 'Bütün stash\'ler silinsin mi?', 'Yes': 'Evet', 'No': 'Hayır',
    'Branch name {0} already exists': '{0} adında bir dal zaten var', 'Index on {0}': '{0} üzerindeki index', 'Untracked files on {0}': '{0} üzerindeki takip edilmeyen dosyalar',
  });

  const form = (rows) => h('div.gb-form.gs-form', rows.map(([label, field]) => [label ? h('label.g-label', label) : h('span'), field]));
  const plain = (text, cls) => h('span.gs-value' + (cls || ''), text);
  /** Below 1: a stash row of the Unstash Changes list (StashInfo.text: the ref bold monospace, the branch italic). */
  function stashLine(s) {
    return h('span.gs-line', h('b.gs-ref', A.stashRef(s)), ': ', s.branch ? [h('i', s.branch), ': '] : null, s.message || s.subject);
  }
  /** A name typed for "As new branch": null when it can be used, else IntelliJ's text. */
  function branchProblem(name) {
    if (!name) return null;
    if (Git.isLocal && Git.isLocal(name)) return t('Branch name {0} already exists', name);
    if (/^-|\.\.|[\s~^:?*[\\]|@\{|\/$|\.lock$|^\.|\/\./.test(name)) return t('This is not a valid branch or tag name');
    return null;
  }

  // ---------------------------------------------------------------- Stash (GitStashDialog)
  D.stash = function () {
    const st = { keepIndex: false, includeUntracked: false };
    const msg = Git.field({ id: 'gs-message', multiline: true, mono: true, rows: 3, label: t('Message:') });
    msg.classList.add('gs-message');
    msg.title = t('Enter stash message here');
    const keep = Git.checkbox({ id: 'gs-keep-index', label: t('Keep index'), title: t('If this checkbox is selected, all changes already added to the index are left intact'), onChange: (v) => { st.keepIndex = v; } });
    const untracked = Git.checkbox({ id: 'gs-include-untracked', label: t('Include untracked'), title: t('If this checkbox is selected, all untracked files are also stashed'), onChange: (v) => { st.includeUntracked = v; } });
    let busy = false;
    const dlg = Git.dialog({
      title: t('Stash'), width: 480, className: 'gs-dialog gs-stash-dialog',
      content: h('div.gb-stack', form([[t('Git Root:'), plain(R.root || '')], [t('Current Branch:'), plain(A.current())]]),
        h('label.g-label.gs-msg-label', { for: 'gs-message' }, t('Message:')), msg, h('div.gb-options', keep, untracked)),
      buttons: [{ label: t('Cancel') }, { label: t('Create Stash'), primary: true, id: 'create', keepOpen: true, onClick: () => {
        if (busy) return false;
        busy = true;
        dlg.primary.disabled = true;
        A.stashMessage(msg.input.value, st).then(() => dlg.close(), () => dlg.close());
        return false;
      } }],
    });
    // Enter in the message is a new line; ⌘⏎ creates the stash
    msg.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); dlg.primary.click(); } });
    return dlg;
  };

  // ---------------------------------------------------------------- Unstash Changes in <root> (GitUnstashAsDialog)
  D.unstashAs = function (s) {
    const st = { pop: false, index: false };
    const line = h('div.gb-line');
    const name = Git.field({ id: 'gs-branch', label: t('As new branch:'), onInput: () => update() });
    name.title = t('If non-empty name is entered, the stash is checked out as a new branch');
    const pop = Git.checkbox({ id: 'gs-as-pop', label: t('Pop stash'), title: t('If selected the stash is dropped after it is applied'), onChange: (v) => { st.pop = v; update(); } });
    const index = Git.checkbox({ id: 'gs-as-index', label: t('Reinstate index'), title: t('Attempt to reinstate index as well as working tree changes'), onChange: (v) => { st.index = v; } });
    const dlg = Git.dialog({
      title: t('Unstash Changes in {0}', R.name), width: 440, className: 'gs-dialog gs-unstash-as',
      content: h('div.gb-stack', form([[t('Current branch:'), plain(A.current())], [t('As new branch:'), name]]), h('div.gb-stack.gs-checks', pop, index), line),
      buttons: [{ label: t('Cancel') }, { label: t('Apply Stash'), primary: true, id: 'ok', onClick: () => {
        const branch = name.input.value.trim();
        if (branchProblem(branch)) return false;
        if (branch) A.stashPop(s, { branch });
        else if (st.pop) A.stashPop(s, { index: st.index });
        else A.stashApply(s, { index: st.index });
        return true;
      } }],
    });
    // GitUnstashAsDialog.updateEnabled / updateOkButtonText: a branch name disables both boxes; the button names the action
    function update() {
      const branch = name.input.value.trim();
      [pop, index].forEach((c) => { c.classList.toggle('disabled', !!branch); c.querySelector('input').disabled = !!branch; });
      dlg.primary.textContent = branch ? t('Branch') : st.pop ? t('Pop Stash') : t('Apply Stash');
      const p = branchProblem(branch);
      Git.clear(line).appendChild(h('span.gb-problem', p || ''));
      name.classList.toggle('gb-invalid', !!p);
      dlg.primary.disabled = !!p;
    }
    update();
    return dlg;
  };

  // ---------------------------------------------------------------- Unstash Changes (GitUnstashDialog)
  D.unstash = function () {
    const st = { pop: false, index: false, sel: 0, list: A.stashes() };
    const listEl = h('div.gs-list', { role: 'listbox', tabIndex: 0, 'aria-label': t('Stashes:') });
    const view = Git.btn(t('View'), { title: t('View selected stash'), onClick: () => { const s = cur(); if (s) D.stashPaths(s); } });
    const drop = Git.btn(t('Drop'), { title: t('Delete selected stash'), onClick: () => { const s = cur(); if (s) D.stashDrop(s, reload); } });
    const clear = Git.btn(t('Clear'), { title: t('Delete all stashes in the repository'), onClick: () => D.stashClear(reload) });
    const line = h('div.gb-line');
    const name = Git.field({ id: 'gs-unstash-branch', label: t('As new branch:'), onInput: () => update() });
    name.title = t('If non-empty name is entered, the stash is checked out as a new branch');
    const pop = Git.checkbox({ id: 'gs-unstash-pop', label: t('Pop stash'), title: t('If selected the stash is dropped after it is applied'), onChange: (v) => { st.pop = v; update(); } });
    const index = Git.checkbox({ id: 'gs-unstash-index', label: t('Reinstate index'), title: t('Attempt to reinstate index as well as working tree changes'), onChange: (v) => { st.index = v; } });
    const cur = () => st.list[st.sel] || null;
    const dlg = Git.dialog({
      title: t('Unstash Changes'), width: 560, className: 'gs-dialog gs-unstash',
      content: h('div.gb-stack', form([[t('Git Root:'), plain(R.root || '')], [t('Current Branch:'), plain(A.current())]]),
        h('div.gs-stashes', h('label.g-label', t('Stashes:')), listEl, h('div.gs-side', view, drop, clear)),
        form([[t('As new branch:'), name]]), h('div.gb-options', pop, index), line),
      buttons: [{ label: t('Cancel') }, { label: t('Apply Stash'), primary: true, id: 'ok', onClick: () => {
        const s = cur(), branch = name.input.value.trim();
        if (!s || branchProblem(branch)) return false;
        if (branch) A.stashPop(s, { branch });
        else if (st.pop) A.stashPop(s, { index: st.index });
        else A.stashApply(s, { index: st.index });
        return true;
      } }],
    });
    listEl.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); st.sel = Math.max(0, Math.min(st.list.length - 1, st.sel + (e.key === 'ArrowDown' ? 1 : -1))); draw(); }
    });
    function draw() {
      Git.clear(listEl);
      st.list.forEach((s, i) => listEl.appendChild(h('div.gs-list-row', { role: 'option', class: i === st.sel ? 'sel' : '', 'aria-selected': String(i === st.sel),
        onclick: () => { st.sel = i; draw(); }, ondblclick: () => { st.sel = i; D.stashPaths(s); } }, stashLine(s))));
      update();
    }
    // GitUnstashDialog.updateDialogState
    function update() {
      const branch = name.input.value.trim();
      const p = branchProblem(branch);
      if (branch) {
        [pop, index].forEach((c) => { c.classList.add('disabled'); const i = c.querySelector('input'); i.disabled = true; i.checked = true; });
        dlg.primary.textContent = t('Branch');
      } else {
        [pop, index].forEach((c) => { c.classList.remove('disabled'); const i = c.querySelector('input'); i.disabled = false; });
        pop.querySelector('input').checked = st.pop;
        index.querySelector('input').checked = st.index;
        dlg.primary.textContent = st.pop ? t('Pop Stash') : t('Apply Stash');
      }
      const none = !st.list.length, unpicked = !cur();
      view.disabled = drop.disabled = none || unpicked;
      clear.disabled = none;
      Git.clear(line).appendChild(h('span.gb-problem', p || ''));
      name.classList.toggle('gb-invalid', !!p);
      dlg.primary.disabled = none || unpicked || !!p;
    }
    function reload() { A.stashList().then((list) => { if (dlg.closed) return; st.list = list; st.sel = Math.min(st.sel, Math.max(0, list.length - 1)); draw(); }); }
    draw();
    reload();
    return dlg;
  };

  // ---------------------------------------------------------------- Paths Affected by stash@{n} (GitStashOperations.viewStash)
  D.stashPaths = function (s) {
    const files = s.files || { changes: [], index: [], untracked: [] };
    const rows = [];
    const add = (list) => list.forEach((c) => rows.push(h('div.gs-path', { style: { color: Git.statusColor(c.status) } }, Git.fileIcon(c.path), h('span', c.path))));
    add(files.changes || []);
    if ((files.untracked || []).length) { rows.push(h('div.gs-path-group', t('Untracked files on {0}', s.branch || ''))); add(files.untracked); }
    return Git.dialog({ title: t('Paths Affected by {0}', A.stashRef(s)), width: 520, className: 'gs-dialog gs-paths',
      content: h('div.gs-paths-list', rows), buttons: [{ label: t('Close'), primary: true }] });
  };

  // ---------------------------------------------------------------- Drop / Clear (GitStashOperations, Yes / No)
  D.stashDrop = function (s, after) {
    return Git.confirm({ title: t('Remove Stash {0}?', A.stashRef(s)), text: t('Do you want to remove {0}?', A.stashRef(s)), detail: '"' + (s.message || s.subject) + '"',
      yes: t('Yes'), no: t('No'), onYes: () => A.stashDrop(s).then(() => after && after()) });
  };
  // IntelliJ adds "This cannot be undone." — here a cleared stash is kept for 14 days and Restore brings it back
  D.stashClear = function (after) {
    return Git.confirm({ title: t('Remove All Stashes?'), text: t('Remove all stashes?'), yes: t('Yes'), no: t('No'),
      onYes: () => A.stashClear().then(() => after && after()) });
  };
})();
