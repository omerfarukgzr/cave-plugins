/* The Merge and Rebase dialogs (Git ▸ Merge… / Rebase…), IntelliJ's current layouts (GitMergeDialog,
   GitRebaseDialog); every label is IntelliJ's own bundle text. The Conflicts dialog is merge-conflicts.js.
   Git.dialogs.merge({ source? }) · Git.dialogs.rebase({ target?, interactive? })
   Git.mergeUi: what the merge dialogs share (labels with bold parts, how the stopped operation names its two sides). */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  Git.dialogs = Git.dialogs || {};
  const U = (Git.mergeUi = {});

  Git.addTR({
    'Merge into {0}': '{0} içine merge et', 'Merge': 'Merge', 'Rebase': 'Rebase', 'Cancel': 'Vazgeç',
    'Modify options': 'Seçenekleri değiştir', 'Add Merge Options': 'Merge seçeneği ekle', 'Add Rebase Options': 'Rebase seçeneği ekle',
    'Specify branch': 'Dal belirt', 'No branches': 'Dal yok', 'Show list': 'Listeyi göster', 'Remove': 'Kaldır', 'Commit message:': 'Commit mesajı:',
    'The merge branch should be selected.': 'Merge edilecek dal seçilmeli.', 'There is no matching branch.': 'Eşleşen bir dal yok.',
    "Branch '{0}' is already merged": "'{0}' dalı zaten merge edilmiş",
    'Create a merge commit even if it can be fast-forwarded': 'Fast-forward yapılabilse bile merge commit\'i oluştur',
    'Merge only if it can be fast-forwarded': 'Yalnız fast-forward yapılabiliyorsa merge et',
    'Create a single commit for all merged changes': 'Merge edilen bütün değişiklikler için tek commit oluştur',
    'Specify a message for the merge commit': 'Merge commit\'i için mesaj belirt', 'Do not commit the merge result': 'Merge sonucunu commitleme',
    'Bypass the pre-merge and commit message hooks': 'pre-merge ve commit mesajı hook\'larını atla',
    'Allow merging histories that do not share a common ancestor.': 'Ortak atası olmayan geçmişlerin merge edilmesine izin ver',
    'branch or hash': 'dal ya da hash', 'new base (branch or hash)': 'yeni taban (dal ya da hash)', 'old base (branch or hash)': 'eski taban (dal ya da hash)',
    'source branch': 'kaynak dal', 'Select an upstream': 'Bir hedef seç', 'Select a new base': 'Yeni bir taban seç',
    'There is no such branch or tag': 'Böyle bir dal ya da etiket yok', 'Select a branch to switch to': 'Geçilecek dalı seç',
    "Branch '{0}' does not exist": "'{0}' dalı yok", 'Specify a new base for the rebased commits': 'Rebase edilen commit\'ler için yeni taban belirt',
    'Edit commits before rebasing': 'Rebase\'den önce commit\'leri düzenle', 'Select another branch to rebase': 'Rebase edilecek başka bir dal seç',
    'Recreate commits topology': 'Commit\'lerin dallanma yapısını yeniden kur', 'Do not remove empty commits during rebase': 'Rebase sırasında boş commit\'leri atma',
    'Rebase all commits in the branch': 'Daldaki bütün commit\'leri rebase et', 'Auto-update branches pointing to rebased commits': 'Rebase edilen commit\'leri gösteren dalları kendiliğinden güncelle',
    'Auto-squash commits marked for fixup or squash': 'Fixup ya da squash için işaretli commit\'leri kendiliğinden squash et',
    'Override the Git config setting to disable automatic squashing': 'Git ayarını ez, otomatik squash\'ı kapat',
    'Merging branch {0} into branch {1}': '{0} dalı {1} dalına merge ediliyor', 'Rebasing branch {0} onto branch {1}': '{0} dalı {1} dalı üzerine rebase ediliyor',
    'Rebasing branch {0} onto {1}': '{0} dalı {1} üzerine rebase ediliyor', 'Current commit {0} made by {1}:': 'Şu anki commit {0}, yazan {1}:',
    'Conflicts during cherry-picking commit {0} made by {1}': '{1} tarafından yazılan {0} commit\'i cherry-pick edilirken çakışma çıktı',
    'Conflicts during reverting commit {0} made by {1}': '{1} tarafından yazılan {0} commit\'i revert edilirken çakışma çıktı',
    'Conflicts during unstashing {0}': '{0} stash\'ten geri getirilirken çakışma çıktı',
    'Changes from {0}': '{0} dalından gelen değişiklikler', 'Rebasing {0} from {1}': '{1} dalından {0} rebase ediliyor',
    'Already rebased commits and commits from {0}': 'Rebase edilmiş commit\'ler ve {0} dalındaki commit\'ler', 'Already rebased commits': 'Rebase edilmiş commit\'ler',
    'Local Changes': 'Yerel değişiklikler', 'Local changes': 'Yerel değişiklikler', 'Changes from stash': 'Stash\'teki değişiklikler',
    'Uncommitted changes from the stash': 'Stash\'teki commit\'lenmemiş değişiklikler',
    'Changes from cherry-pick {0}': '{0} cherry-pick\'inden gelen değişiklikler', 'Changes from revert {0}': '{0} revert\'inden gelen değişiklikler',
    '{0} file': '{0} dosya', '{0} files': '{0} dosya',
    '1 conflict': '1 çakışma', '{0} conflicts': '{0} çakışma', '1 change': '1 değişiklik', '{0} changes': '{0} değişiklik',
  });

  // ---------------------------------------------------------------- shared pieces
  /** A translated label whose `{n}` parts are nodes (bold names…). Returns what `Git.h` takes as children. */
  U.rich = function (en, ...parts) {
    return Git.t(en).split(/(\{\d+\})/).map((s) => { const m = /^\{(\d+)\}$/.exec(s); return m ? parts[+m[1]] : s; });
  };
  U.b = (text) => h('b', text);
  U.plural = (n, zero, one, many) => (n === 0 && zero ? t(zero) : n === 1 ? t(one, n) : t(many, n));
  U.store = { get: (k) => Git.host.prefs.get('merge.' + k, null), set: (k, v) => Git.host.prefs.set('merge.' + k, v) };

  /** A branch, tag or hash typed into a field -> a ref pair (Git.actions.typed: local, then remote, then tag), a
      revision pair (a short hash completed; `HEAD~2`, a full ref name typed out), or null when nothing is named. */
  U.resolveRef = function (text) {
    const name = String(text || '').trim();
    if (!name) return null;
    const r = Git.actions.typed(name);
    if (r.kind !== 'revision') return r;
    if (/^[0-9a-f]{7,40}$/i.test(name)) {
      for (const id of Git.repo.commits.keys()) if (id.startsWith(name.toLowerCase())) return Git.actions.ref('revision', id);
    }
    return Git.refId(name) ? r : null;
  };
  /** The list of a combo: each ref once with its kind (a local `origin/x` and the remote `origin/x` are two entries). */
  U.refItems = (pairs) => pairs.map((ref) => ({ label: ref.name, ref, hint: ref.kind === 'remote' && Git.isLocal(ref.name) ? Git.t('Remote') : ref.kind === 'tag' && (Git.isLocal(ref.name) || Git.isRemote(ref.name)) ? Git.t('Tags') : null }));

  /** How the stopped operation names its two sides (IntelliJ's GitDefaultMergeDialogCustomizer). A rebase is shown
      reversed: "Yours" (left) is the commit being applied (stage 3), "Theirs" (right) what it lands on (stage 2). */
  U.operation = function () {
    const R = Git.repo, op = R.op, A = Git.actions, b = U.b, short = Git.short;
    const sides = A.opSides();
    const pack = (left, right, about) => ({ flip: sides.flip, left: Object.assign({}, sides.left, left), right: Object.assign({}, sides.right, right), about });
    if (op && (op.type === 'rebase' || op.type === 'am')) {
      const n = A.rebaseNames(), cur = Git.commit(n.current), named = Git.isLocal(n.onto) || Git.isRemote(n.onto);
      return pack({ title: () => U.rich('Rebasing {0} from {1}', b(short(n.current)), b(n.branch)) },
        { title: () => (named ? U.rich('Already rebased commits and commits from {0}', b(n.onto)) : [t('Already rebased commits')]) },
        () => [h('div', U.rich(named ? 'Rebasing branch {0} onto branch {1}' : 'Rebasing branch {0} onto {1}', b(n.branch), b(n.onto))),
          cur ? h('div.gm-conf-sub', U.rich('Current commit {0} made by {1}:', b(short(cur.id)), Git.author(cur.author).name), ' ', cur.subject) : null]);
    }
    if (op && (op.type === 'cherry-pick' || op.type === 'revert')) {
      const id = op.theirs && op.theirs.id, cur = Git.commit(id), hash = short(id), pick = op.type === 'cherry-pick';
      return pack({ title: () => [t('Local Changes')] }, { title: () => U.rich(pick ? 'Changes from cherry-pick {0}' : 'Changes from revert {0}', b(hash)) },
        () => [h('div', U.rich(pick ? 'Conflicts during cherry-picking commit {0} made by {1}' : 'Conflicts during reverting commit {0} made by {1}', b(hash), cur ? Git.author(cur.author).name : '')),
          cur ? h('div.gm-conf-sub', cur.subject) : null]);
    }
    const ctx = !op ? A.conflictContext() || {} : null;
    if (ctx && ctx.kind === 'restore') {
      // GitPreservingProcess: the local changes stashed for update / rebase / merge / checkout did not come back
      return pack({ title: () => [t('Uncommitted changes from the stash')] }, { title: () => U.rich('Changes from {0}', b(ctx.from || '')) },
        () => [h('div', U.rich('Uncommitted changes that were saved before {0} have conflicts with files from {1}', t(ctx.operation || 'rebase'), b(ctx.from || '')))]);
    }
    if (ctx && ctx.kind === 'unstash') {
      return pack({ title: () => [t('Local changes')] }, { title: () => [t('Changes from stash')] },
        () => [h('div', U.rich('Conflicts during unstashing {0}', b('stash@{0}')))]);   // the engine keeps the conflicted stash on top
    }
    const left = sides.left.name, right = sides.right.name;
    return pack({ title: () => (left ? U.rich('Changes from {0}', b(left)) : []) }, { title: () => (right ? U.rich('Changes from {0}', b(right)) : []) },
      () => (left && right ? [h('div', U.rich('Merging branch {0} into branch {1}', b(right), b(left)))] : []));
  };

  /**
   * Show Diff from inside a modal dialog (Push Commits, Rebasing Commits): IntelliJ opens the diff in a window of its
   * own over the dialog. The editor area's diff viewer (Git.diffTab, kind `texts`) is mounted in a dialog here; the tab
   * area is not touched (Git.tabs is stood in for while the viewer mounts). One file of commit `id`, against its parent.
   */
  U.diffOver = function (id, path) {
    if (!Git.diffTab || !Git.content) return null;
    return U.textsOver(path, path, Git.content.details(id).then((d) => {
      const entry = (d.changes || [])[0], ch = entry && entry.files.find((f) => f.path === path);
      if (!ch) throw new Error('no ' + path + ' in ' + id);
      const l = ch.status === 'A' || !entry.parent ? null : { path: ch.oldPath || path, rev: entry.parent };
      const r = ch.status === 'D' ? null : { path, rev: d.id };
      return Git.content.pair(l, r).then((p) => {
        const side = (c, label) => (c && c.exists && !c.binary ? { title: label, text: c.text, locked: true } : null);
        return { left: l ? side(p.left, Git.short(entry.parent)) : null, right: r ? side(p.right, Git.short(d.id)) : null };
      });
    }));
  };
  /** A two-sided diff of two texts in a dialog over the current one: `sides` (a value or a Promise) = { left, right },
      each { title, text } or null (one-sided view). */
  U.textsOver = function (title, path, sides) {
    let host = null;
    const body = h('div.gm-diff-over', Git.content.loading());
    const dlg = Git.dialog({ title, width: Math.min(1100, window.innerWidth - 40), height: Math.min(680, window.innerHeight - 40), className: 'gm-diff-dlg',
      content: body, buttons: [{ label: t('Close'), primary: true, id: 'gm-diff-close' }], onClose: () => { if (host && host.unmount) host.unmount(); } });
    Promise.resolve(sides).then((s) => {
      if (dlg.closed) return;
      const real = Git.tabs;
      Git.clear(body);
      Git.tabs = { open: (o) => { host = o; o.mount(body); } };
      try {
        Git.diffTab.open({ kind: 'texts', id: 'diff:over', title: Git.fileName(path || title), path, left: s.left, right: s.right });
      } finally { Git.tabs = real; }
      const sink = dlg.el.querySelector('.g-sink');   // the viewer took the focus: the dialog keeps the keyboard (the Esc rule, ui.js)
      if (sink) sink.focus({ preventScroll: true });
    }).catch((err) => { if (!dlg.closed) { Git.clear(body).appendChild(Git.content.failed(err)); } });
    return dlg;
  };

  /** The round (?) button at the bottom left of IntelliJ's dialogs: opens the dialog's page of IntelliJ's help. */
  const HELP = 'https://www.jetbrains.com/help/idea/';
  U.HELP = {
    merge: HELP + 'apply-changes-from-one-branch-to-another.html#merge', rebase: HELP + 'apply-changes-from-one-branch-to-another.html#rebase-branch',
    push: HELP + 'commit-and-push-changes.html#push', update: HELP + 'sync-with-a-remote-repository.html#update',
    interactive: HELP + 'edit-project-history.html#interactive-rebase', tag: HELP + 'use-tags-to-mark-specific-commits.html',
  };
  U.help = function (url, id) {
    return h('button.gm-help', { type: 'button', id, title: t('Help'), 'aria-label': t('Help'),
      onclick: () => { if (Git.host && Git.host.openExternal) Git.host.openExternal(url); } }, Git.icon('general/questionMark'));
  };

  /** Editable drop-down: typing narrows the list, the arrow shows all of it. `o`: { id, placeholder, items(), value, onChange }.
      An item is a string or { label, ref, hint }: the entry picked from the list keeps its ref (el.ref()) while the text
      is still its label; typed text is resolved by the caller (U.resolveRef). */
  U.combo = function (o) {
    const input = h('input.g-input', { type: 'text', id: o.id, placeholder: o.placeholder, 'aria-label': o.placeholder, spellcheck: 'false', autocomplete: 'off', role: 'combobox' });
    const text = (n) => (typeof n === 'string' ? n : n.label);
    let picked = o.ref || null;
    input.value = o.value || (picked ? picked.name : '');
    let pop = null, shown = [], at = -1;
    const mark = () => { if (pop) Array.prototype.forEach.call(pop.el.querySelectorAll('.gm-list-item'), (el, i) => { el.classList.toggle('on', i === at); if (i === at) el.scrollIntoView({ block: 'nearest' }); }); };
    const close = () => { if (pop) pop.close(); };
    const pick = (n) => { input.value = text(n); picked = typeof n === 'string' ? null : n.ref; close(); if (o.onChange) o.onChange(text(n)); input.focus(); };
    function open(all) {
      close();
      const q = input.value.trim().toLowerCase(), names = o.items();
      shown = all || !q ? names : names.filter((n) => text(n).toLowerCase().indexOf(q) >= 0);
      if (!shown.length && !all) return;
      const list = h('div.gm-list', { role: 'listbox' }, shown.length
        ? shown.map((n) => h('button.gm-list-item', { type: 'button', role: 'option', tabIndex: -1, onmousedown: (e) => e.preventDefault(), onclick: () => pick(n) },
          text(n), typeof n !== 'string' && n.hint ? h('span.gm-list-hint', ' ' + n.hint) : null))
        : h('div.gm-list-empty', t('No branches')));
      pop = Git.popup({ anchor: el, content: list, width: el.offsetWidth, className: 'gm-combo-pop', onClose: () => { pop = null; } });
      pop.keepFor = el;
      at = shown.findIndex((n) => text(n) === input.value.trim());
      mark();
    }
    const arrow = h('button.gm-combo-arrow', { type: 'button', tabIndex: -1, title: t('Show list'), 'aria-label': t('Show list'),
      onmousedown: (e) => e.preventDefault(), onclick: () => { if (pop) close(); else { input.focus(); open(true); } } }, Git.icon('chevronDownSmall'));
    const el = h('div.gm-combo', input, arrow);
    el.ref = () => (picked && input.value.trim() === picked.name ? picked : null);
    input.addEventListener('input', () => { picked = null; open(false); if (o.onChange) o.onChange(input.value.trim()); });
    input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) close(); }, 120));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!pop) { open(true); return; }
        at = Math.max(0, Math.min(shown.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)));
        mark();
      } else if (e.key === 'Enter' && pop && at >= 0) { e.preventDefault(); e.stopPropagation(); pick(shown[at]); }
    });
    el.input = input;
    el.value = () => input.value.trim();
    return el;
  };

  /** The "Modify options" link of both dialogs. `rows()`: [{ key, name, desc, on, disabled, toggle() }] */
  function optionsLink(title, rows) {
    let pop = null;
    const link = h('button.g-link.gm-options', { type: 'button', id: 'gm-modify-options', onclick: () => {
      if (pop) { pop.close(); return; }
      const list = rows().map((r) => h('button.gm-opt', { type: 'button', disabled: !!r.disabled, role: 'menuitemcheckbox', 'aria-checked': String(!!r.on), dataset: { opt: r.key },
        onclick: () => { pop.close(); r.toggle(); } },
        h('span.gm-opt-check', r.on ? Git.icon('actions/checked') : null), r.name ? h('span.gm-opt-name', r.name) : null,
        h('span.gm-opt-desc', { class: r.name ? '' : 'solo' }, t(r.desc))));
      pop = Git.popup({ anchor: link, content: h('div.gm-opts', { role: 'menu' }, h('div.gm-opts-title', t(title)), list), className: 'gm-opts-pop', onClose: () => { pop = null; } });
      pop.keepFor = link;
    } }, t('Modify options'), Git.icon('chevronDownSmall', 12));
    return link;
  }
  function chip(name, remove) {
    return h('span.gm-chip', { dataset: { opt: name } }, h('span', name),
      h('button', { type: 'button', title: t('Remove'), 'aria-label': t('Remove') + ' ' + name, onclick: remove }, Git.icon('closeSmall')));
  }

  // ---------------------------------------------------------------- Merge
  const MERGE_OPTIONS = [
    ['--no-ff', 'Create a merge commit even if it can be fast-forwarded', 'noFf'],
    ['--ff-only', 'Merge only if it can be fast-forwarded', 'ffOnly'],
    ['--squash', 'Create a single commit for all merged changes', 'squash'],
    ['-m', 'Specify a message for the merge commit', null],
    ['--no-commit', 'Do not commit the merge result', 'noCommit'],
    ['--no-verify', 'Bypass the pre-merge and commit message hooks', 'noVerify'],
    ['--allow-unrelated-histories', 'Allow merging histories that do not share a common ancestor.', 'allowUnrelatedHistories'],
  ];
  // GitMergeOption.isOptionSuitable: what each chosen option rules out.
  const MERGE_CLASH = { '--no-ff': ['--ff-only', '--squash'], '--ff-only': ['--no-ff', '--squash', '-m'], '--squash': ['--no-ff', '--ff-only', '-m'],
    '-m': ['--ff-only', '--squash', '--no-commit'], '--no-commit': ['-m'] };

  Git.dialogs.merge = function (o) {
    o = o || {};
    const flags = new Set();
    const A = Git.actions, into = A.headMark();   // the branch the dialog merges into: refused when another one is current at Merge
    const unmerged = () => U.refItems(Git.localBranches().map((n) => A.ref('local', n)).concat(Git.remoteBranches().map((n) => A.ref('remote', n)))
      .filter((r) => !(r.kind === 'local' && r.name === Git.currentBranch()) && !Git.isAncestor(A.refId(r), Git.headId())));
    const source = o.source && typeof o.source === 'object' ? o.source : null;
    const error = h('div.gm-error', { hidden: true, role: 'alert' });
    const chips = h('div.gm-chips', { hidden: true });
    const message = Git.field({ id: 'gm-merge-message', multiline: true, rows: 3, label: t('Commit message:') });
    const messageRow = h('div.gm-msg', { hidden: true }, h('div.g-label', t('Commit message:')), message);
    const fail = (text) => { error.hidden = !text; error.textContent = text || ''; branch.classList.toggle('bad', !!text); return false; };
    const branch = U.combo({ id: 'gm-merge-branch', placeholder: t('Specify branch'), items: unmerged, ref: source, value: source ? '' : o.source || '', onChange: () => fail(null) });
    function sync() {
      Git.clear(chips);
      MERGE_OPTIONS.forEach(([key]) => { if (flags.has(key) && key !== '-m') chips.appendChild(chip(key, () => toggle(key))); });
      chips.hidden = !chips.firstChild;
      messageRow.hidden = !flags.has('-m');
      if (flags.has('-m')) message.input.focus();
    }
    function toggle(key) { if (flags.has(key)) flags.delete(key); else flags.add(key); sync(); }
    const rows = () => MERGE_OPTIONS.map(([key, desc]) => ({ key, name: key, desc, on: flags.has(key), toggle: () => toggle(key),
      disabled: !flags.has(key) && Array.from(flags).some((f) => (MERGE_CLASH[f] || []).indexOf(key) >= 0) }));
    function run() {
      if (!branch.value()) return fail(t('The merge branch should be selected.'));
      const ref = branch.ref() || U.resolveRef(branch.value());   // the entry picked from the list, else what was typed
      if (!ref) return fail(t('There is no matching branch.'));
      if (Git.isAncestor(A.refId(ref), Git.headId())) return fail(t("Branch '{0}' is already merged", A.refLabel(ref)));
      const opts = { into };
      MERGE_OPTIONS.forEach(([key, , param]) => { if (param && flags.has(key)) opts[param] = true; });
      const text = message.input.value.trim();
      if (flags.has('-m') && text) opts.message = text;
      dlg.close();
      A.merge(ref, opts);
      return true;
    }
    const dlg = Git.dialog({ title: t('Merge into {0}', Git.currentBranch() || 'HEAD'), width: 470, className: 'gm-cmd-dlg',
      content: [h('div.gm-cmd', h('span.gm-cmd-prefix', 'git merge'), branch), error, chips, messageRow],
      left: [U.help(U.HELP.merge, 'gm-merge-help'), optionsLink('Add Merge Options', rows)],
      buttons: [{ label: t('Cancel'), id: 'gm-merge-cancel' }, { label: t('Merge'), primary: true, id: 'gm-merge-ok', keepOpen: true, onClick: run }] });
    return dlg;
  };

  // ---------------------------------------------------------------- Rebase
  /** The (?) next to --onto: the "Show Git rebase help" balloon (GitRebaseDialog's help popup). */
  function ontoHelp() {
    let pop = null;
    const link = h('button.g-link', { type: 'button', id: 'gm-onto-help-link', onclick: () => Git.host.openExternal && Git.host.openExternal('https://git-scm.com/docs/git-rebase') }, t('git rebase on git-scm.com'));
    const btn = h('button.gm-help.small', { type: 'button', id: 'gm-onto-help', title: t('Show Git rebase help'), 'aria-label': t('Show Git rebase help'), onmousedown: (e) => e.preventDefault(),
      onclick: () => {
        if (pop) { pop.close(); return; }
        pop = Git.popup({ anchor: btn, className: 'gm-help-pop', onClose: () => { pop = null; },
          content: h('div.gm-help-box', h('div', t('Rebase a branch based on one branch to another:')), h('pre.gm-help-graph', 'o---o---o---o---o  master\n     \\\n      o---o---o---o---o  next\n                       \\\n                        o---o---o  topic'), link,
            h('div.gm-help-ad', t('Press Space to open external link'))) });
        pop.keepFor = btn;
        pop.el.addEventListener('keydown', (e) => { if (e.key === ' ') { e.preventDefault(); link.click(); } });
      } }, Git.icon('general/questionMark', 12));
    return btn;
  }
  Git.addTR({ 'Help': 'Yardım', 'Show Git rebase help': 'Git rebase yardımını göster', 'Rebase a branch based on one branch to another:': 'Bir daldan çıkmış dalı başka bir dalın üzerine rebase et:',
    'git rebase on git-scm.com': 'git-scm.com\'da git rebase', 'Press Space to open external link': 'Dış bağlantıyı açmak için Space\'e bas' });
  // GitRebaseOption's order (the enum the popup lists: SWITCH_BRANCH, ONTO, REBASE_MERGES, KEEP_EMPTY, ROOT,
  // INTERACTIVE, UPDATE_REFS, AUTOSQUASH, NO_AUTOSQUASH); the third field is the engine's parameter.
  const REBASE_OPTIONS = [
    ['switch', 'Select another branch to rebase'],
    ['--onto', 'Specify a new base for the rebased commits'],
    ['--rebase-merges', 'Recreate commits topology', 'rebaseMerges'],
    ['--keep-empty', 'Do not remove empty commits during rebase', 'keepEmpty'],
    ['--root', 'Rebase all commits in the branch', 'root'],
    ['--interactive', 'Edit commits before rebasing'],
    ['--update-refs', 'Auto-update branches pointing to rebased commits', 'updateRefs'],
    ['--autosquash', 'Auto-squash commits marked for fixup or squash', 'autosquash'],
    ['--no-autosquash', 'Override the Git config setting to disable automatic squashing', 'noAutosquash'],
  ];
  const REBASE_CLASH = { '--autosquash': ['--no-autosquash'], '--no-autosquash': ['--autosquash'] };

  Git.dialogs.rebase = function (o) {
    o = o || {};
    const flags = new Set(o.interactive ? ['--interactive'] : []);
    const A = Git.actions, into = A.headMark();   // the branch the dialog rebases: refused when another one is current at Rebase
    const refs = () => U.refItems(Git.localBranches().map((n) => A.ref('local', n)).concat(Git.remoteBranches().map((n) => A.ref('remote', n)), Git.tagNames().map((n) => A.ref('tag', n))));
    const target0 = o.target && typeof o.target === 'object' ? o.target : null;
    const error = h('div.gm-error', { hidden: true, role: 'alert' });
    const chips = h('div.gm-chips', { hidden: true });
    const lines = h('div.g-col', { style: { gap: '8px' } });
    let dlg = null;
    const check = () => { if (dlg) dlg.buttons['gm-rebase-ok'].disabled = !(flags.has('--onto') ? newBase : upstream).value(); };
    const fail = (text, field) => {
      error.hidden = !text; error.textContent = text || '';
      [upstream, newBase, source].forEach((f) => f.classList.toggle('bad', !!text && f === field));
      return false;
    };
    const typed = () => { fail(null); check(); };
    const upstream = U.combo({ id: 'gm-rebase-upstream', placeholder: t('branch or hash'), items: refs, ref: target0, value: target0 ? '' : o.target || '', onChange: typed });
    const newBase = U.combo({ id: 'gm-rebase-onto', placeholder: t('new base (branch or hash)'), items: refs, onChange: typed });
    const source = U.combo({ id: 'gm-rebase-branch', placeholder: t('source branch'), items: () => Git.localBranches(), onChange: typed });
    function build() {
      const onto = flags.has('--onto'), other = flags.has('switch');
      upstream.input.placeholder = t(onto ? 'old base (branch or hash)' : 'branch or hash');
      Git.clear(lines);
      // GitRebaseDialog: without --onto everything is on the top line; with it the new base is on top, the old base (and the branch) below.
      if (onto) {
        lines.appendChild(h('div.gm-cmd', h('span.gm-cmd-prefix', 'git rebase'), h('span.gm-cmd-prefix.gm-onto', '--onto', ontoHelp()), newBase));
        lines.appendChild(h('div.gm-cmd', upstream, other ? source : null));
      } else lines.appendChild(h('div.gm-cmd', h('span.gm-cmd-prefix', 'git rebase'), upstream, other ? source : null));
      Git.clear(chips);
      REBASE_OPTIONS.forEach(([key]) => { if (flags.has(key) && key !== '--onto' && key !== 'switch') chips.appendChild(chip(key, () => toggle(key))); });
      chips.hidden = !chips.firstChild;
      fail(null);
      check();
    }
    function toggle(key) {
      if (flags.has(key)) flags.delete(key);
      else { flags.add(key); (REBASE_CLASH[key] || []).forEach((x) => flags.delete(x)); }
      build();
      (key === '--onto' && flags.has(key) ? newBase : key === 'switch' && flags.has(key) ? source : upstream).input.focus();
    }
    const rows = () => REBASE_OPTIONS.map(([key, desc]) => ({ key, name: key === 'switch' ? null : key, desc, on: flags.has(key), toggle: () => toggle(key) }));
    function run() {
      const onto = flags.has('--onto'), field = onto ? newBase : upstream;
      if (!field.value()) return fail(t(onto ? 'Select a new base' : 'Select an upstream'), field);
      // the entry picked from the list keeps its kind; typed text is resolved (local, remote, tag, else a revision)
      const target = field.ref() || U.resolveRef(field.value());
      if (!target) return fail(t('There is no such branch or tag'), field);
      const old = onto && upstream.value() ? upstream.ref() || U.resolveRef(upstream.value()) : null;
      if (onto && upstream.value() && !old) return fail(t('There is no such branch or tag'), upstream);
      let branch;
      if (flags.has('switch')) {
        const name = source.value();
        if (!name) return fail(t('Select a branch to switch to'), source);
        if (!Git.isLocal(name)) return fail(t("Branch '{0}' does not exist", name), source);
        branch = A.ref('local', name);   // the list holds local branches only
      }
      dlg.close();
      if (!branch && !A.stillCurrent(into, t('Rebase'))) return true;
      // every other option goes with the rebase, the interactive one included (the plan comes with --autosquash / --root)
      const opts = {};
      REBASE_OPTIONS.forEach(([key, , param]) => { if (param && flags.has(key)) opts[param] = true; });
      if (flags.has('--interactive') && Git.dialogs.interactiveRebase) {
        Git.dialogs.interactiveRebase(null, Object.assign({ onto: target, upstream: old || target, branch }, opts));
        return true;
      }
      Object.assign(opts, { branch, upstream: old || undefined, checkedOut: !!branch && branch.name !== Git.currentBranch(), into: branch ? null : into });
      A.rebaseOnto(target, opts);
      return true;
    }
    dlg = Git.dialog({ title: t('Rebase'), width: 520, className: 'gm-cmd-dlg', content: [lines, error, chips],
      left: [U.help(U.HELP.rebase, 'gm-rebase-help'), optionsLink('Add Rebase Options', rows)],
      buttons: [{ label: t('Cancel'), id: 'gm-rebase-cancel' }, { label: t('Rebase'), primary: true, id: 'gm-rebase-ok', keepOpen: true, onClick: run }] });
    build();
    setTimeout(() => upstream.input.focus(), 0);
    return dlg;
  };
})();
