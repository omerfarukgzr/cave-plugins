/* The dialogs the Log's commit commands open (texts from GitBundle: git.reset.*, rebase.log.*).
   Git.dialogs.reset(id)               Git Reset: Soft / Mixed / Hard / Keep with IntelliJ's explanations; the button says
                                       "Hard Reset" for Hard → A.doReset(id, mode)
   Git.dialogs.editMessage(id)         Edit Commit Message (the full message is read with commit.details) → A.doEditMessage
   Git.dialogs.dropCommits(ids, onYes) Drop Commit(s) confirmation (detached HEAD has its own text) */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = Git.t;
  const A = Git.actions;

  Git.addTR({
    'This will reset the current branch head to the selected commit,\nand update the working tree and the index according to the selected mode:':
      'Geçerli dalın başı seçili commit\'e alınır;\nçalışma kopyası ve index seçilen moda göre güncellenir:',
    "Files won't change, differences will be staged for commit.": 'Dosyalar değişmez, farklar commit için stage\'lenir.',
    "Files won't change, differences won't be staged.": 'Dosyalar değişmez, farklar stage\'lenmez.',
    'Files will be reverted to the state of the selected commit.\nWarning: any local changes will be lost.':
      'Dosyalar seçili commit\'teki haline döner.\nUyarı: bütün yerel değişiklikler kaybolur.',
    'Files will be reverted to the state of the selected commit,\nbut local changes will be kept intact.':
      'Dosyalar seçili commit\'teki haline döner,\nama yerel değişiklikler korunur.',
    '{0} by {1}': '{0}, {1}', 'Reset': 'Reset', 'Hard Reset': 'Hard reset',
    'Edit Commit Message': 'Commit mesajını düzenle', 'Commit Message': 'Commit mesajı', 'Edit message for commit {0} by {1}': '{0} commit\'inin mesajını düzenle ({1})',
    'Drop Commit': 'Commit\'i drop et', 'Drop Commits': 'Commit\'leri drop et',
    'Do you want to drop {0} commit from the {1} branch?': '{1} dalından {0} commit drop edilsin mi?',
    'Do you want to drop {0} commits from the {1} branch?': '{1} dalından {0} commit drop edilsin mi?',
    'The repository is in the detached HEAD state. Do you want to drop {0} commit?': 'Depo ayrık HEAD durumunda. {0} commit drop edilsin mi?',
    'The repository is in the detached HEAD state. Do you want to drop {0} commits?': 'Depo ayrık HEAD durumunda. {0} commit drop edilsin mi?',
    'Editing Initial Commit': 'İlk commit düzenleniyor', 'Are you sure you want to edit the initial commit?': 'İlk commit\'i düzenlemek istediğine emin misin?',
  });

  let resetMode = 'mixed';
  Git.dialogs.reset = function (id) {
    const c = Git.commit(id);
    if (!c) return null;
    const modes = [
      ['soft', 'Soft', "Files won't change, differences will be staged for commit."],
      ['mixed', 'Mixed', "Files won't change, differences won't be staged."],
      ['hard', 'Hard', 'Files will be reverted to the state of the selected commit.\nWarning: any local changes will be lost.'],
      ['keep', 'Keep', 'Files will be reverted to the state of the selected commit,\nbut local changes will be kept intact.'],
    ];
    let mode = resetMode;
    const into = A.headMark();   // the branch the dialog names: Reset is refused when another one is current then
    // "Reset" is a git term (glossary: not translated); merge-rebase.js gives the word its own Turkish for another link
    const label = () => (mode === 'hard' ? t('Hard Reset') : 'Reset');
    const dlg = Git.dialog({ title: 'Git Reset', width: 540, className: 'gl-reset',
      content: [
        h('div.gl-reset-what', h('b', Git.currentBranch() || t('Detached HEAD')), ' → ', h('span.g-mono', Git.short(id)), ' ', t('{0} by {1}', '"' + c.subject + '"', Git.author(c.author).name)),
        h('div.gl-reset-desc', t('This will reset the current branch head to the selected commit,\nand update the working tree and the index according to the selected mode:')),
        h('div.gl-reset-modes', { role: 'radiogroup' }, modes.map(([value, name, hint]) => [
          Git.radio({ name: 'gl-reset-mode', id: 'gl-reset-' + value, value, label: name, checked: value === mode,
            onChange: (v) => { mode = v; dlg.buttons['gl-reset-ok'].textContent = label(); } }), h('div.gl-reset-hint', t(hint))])),
      ],
      buttons: [{ label: t('Cancel') }, { label: label(), primary: true, id: 'gl-reset-ok', onClick: () => { resetMode = mode; A.doReset(id, mode, { into }); } }] });
    return dlg;
  };

  /** The message comes from commit.details (the list carries subjects only); the field fills in when it arrives. */
  Git.dialogs.editMessage = function (id) {
    const c = Git.commit(id);
    if (!c) return null;
    const field = Git.field({ id: 'gl-reword-text', multiline: true, rows: 8, mono: true, label: t('Commit Message'), value: c.subject,
      onInput: (v) => { dlg.buttons['gl-reword-ok'].disabled = !v.trim(); } });
    const dlg = Git.dialog({ title: t('Edit Commit Message'), width: 560, className: 'gl-reword',
      content: [h('div.g-label', t('Edit message for commit {0} by {1}', Git.short(id), Git.author(c.author).name)), field],
      buttons: [{ label: t('Cancel') }, { label: t('OK'), primary: true, id: 'gl-reword-ok', onClick: () => { A.doEditMessage(id, field.input.value.replace(/\s+$/, '')); } }] });
    dlg.loading = Git.content.details(id).then((d) => {
      if (!dlg.closed && field.input.value === c.subject) field.input.value = d.subject + (d.body ? '\n\n' + d.body : '');
      return true;
    }, () => null);
    field.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); dlg.buttons['gl-reword-ok'].click(); } });
    return dlg;
  };

  /** IntelliJ's question before Drop Commits. */
  Git.dialogs.dropCommits = function (ids, onYes) {
    const n = ids.length, many = n > 1, branch = Git.currentBranch();
    // rebase.log.drop.action.confirmation.message: "… from the <b>{1}</b> branch?", nothing else under it
    const rich = (en, parts) => t(en).split(/\{(\d+)\}/).map((s, i) => (i % 2 ? parts[+s] : s));
    const text = branch ? rich(many ? 'Do you want to drop {0} commits from the {1} branch?' : 'Do you want to drop {0} commit from the {1} branch?', [String(n), h('b', branch)])
      : t(many ? 'The repository is in the detached HEAD state. Do you want to drop {0} commits?' : 'The repository is in the detached HEAD state. Do you want to drop {0} commit?', n);
    return Git.confirm({ title: t(many ? 'Drop Commits' : 'Drop Commit'), text, yes: t(many ? 'Drop Commits' : 'Drop Commit'), danger: true, onYes });
  };
  /** "Are you sure you want to edit the initial commit?" (rebase.log.commit.editing.action.initial.commit.dialog). */
  Git.dialogs.initialCommit = function (onYes) {
    return Git.confirm({ title: t('Editing Initial Commit'), text: t('Are you sure you want to edit the initial commit?'), onYes });
  };
})();
