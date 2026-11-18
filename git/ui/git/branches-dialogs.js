/* Git prototype: the dialogs of the branch UI, with IntelliJ's titles, fields, defaults and validation texts.
   Git.dialogs.newBranch({ from }) · renameBranch(name) · newTag(id) · checkoutRevision() · updateProject()
   · pushRejected(branch, { target, onUpdate }). The Push dialog is branches-push.js. Each one ends in a Git.actions
   command (async: the name dialogs stay open until the engine answers, a refusal shows under the field). */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const R = Git.repo, A = Git.actions;
  const D = (Git.dialogs = Git.dialogs || {});

  Git.addTR({
    'Cancel': 'Vazgeç',
    'OK': 'Tamam',
    'Create New Branch': 'Yeni dal oluştur',
    'Create Branch from {0}': '{0} üzerinden dal oluştur',
    'Branch Name:': 'Dal adı:',
    'Checkout branch': 'Dala checkout yap',
    'Overwrite existing branch': 'Var olan dalın üzerine yaz',
    'Create': 'Oluştur',
    'Specify name for the new branch': 'Yeni dal için bir ad yaz',
    'Branch name {0} is not valid': '{0} geçerli bir dal adı değil',
    'HEAD is a reserved keyword': 'HEAD ayrılmış bir sözcük',
    'Branch name {0} already exists': '{0} adında bir dal zaten var',
    'Change the name or overwrite existing branch': 'Adı değiştir ya da var olan dalın üzerine yaz',
    'Branch name {0} conflicts with remote branch with the same name': '{0} adı aynı adlı uzak dalla çakışıyor',
    'Branch name {0} conflicts with local branch directory with the same name': '{0} adı aynı adlı yerel dal klasörüyle çakışıyor',
    'Rename Branch {0}': '{0} dalını yeniden adlandır',
    'Rename': 'Yeniden adlandır',
    'Create New Tag On {0}': '{0} üzerinde yeni etiket oluştur',
    'Tag Name:': 'Etiket adı:',
    'The tag with the same name exists.': 'Aynı adda bir etiket var',
    'Tag name {0} is not valid': '{0} geçerli bir etiket adı değil',
    'Checkout': 'Checkout',
    'Enter reference (branch, tag) name or commit hash:': 'Dal ya da etiket adı ya da commit hash\'i yaz:',
    'Revision not found': 'Böyle bir dal, etiket ya da commit yok',
    'Push Commits to {0}': 'Commit\'leri push et: {0}',
    'New': 'Yeni',
    'Push': 'Push',
    'Force Push': 'Force Push',
    "You're going to force push to {0}. It may overwrite commits at the remote. Are you sure you want to proceed?":
      '{0} dalına force push yapmak üzeresin. Uzaktaki commit\'lerin üzerine yazabilir. Devam edilsin mi?',
    'No commits selected': 'Seçili commit yok',
    'No differences': 'Fark yok',
    'Select to show commit details': 'Ayrıntısını görmek için bir commit seç',
    '{0} file': '{0} dosya',
    '{0} files': '{0} dosya',
    '{0}  {1}  by {2}': '{0}  {1}  {2}',
    'Update Project': 'Projeyi güncelle',
    'Merge incoming changes into the current branch': 'Gelen değişiklikleri geçerli dala merge et',
    'Rebase the current branch on top of incoming changes': 'Geçerli dalı gelen değişikliklerin üzerine rebase et',
    "Don't show again": 'Bir daha gösterme', 'Unset upstream branch': 'İzlenen uzak dalı kaldır',
    'Remember the update method choice and silently update in the future': 'Seçilen güncelleme yöntemini hatırla ve bundan sonra sormadan güncelle',
    'Remember the update method and update silently in the future. Change this later in {0} | Version Control.':
      'Güncelleme yöntemini hatırla ve bundan sonra sormadan güncelle. Sonra {0} | Version Control altında değiştirebilirsin.',
    '"{0}" has {1} commit that is not in "{2}".': '"{0}" dalında "{2}" dalında olmayan {1} commit var.',
    '"{0}" has {1} commits that are not in "{2}".': '"{0}" dalında "{2}" dalında olmayan {1} commit var.',
    'Force push to replace them, or merge or rebase to keep them.': 'Onların yerine yazmak için force push yap, korumak için merge ya da rebase et.',
    'Force push to "{0}" is prohibited.': '"{0}" dalına force push yasak.', 'Merge or rebase to keep them, then push again.': 'Onları korumak için merge ya da rebase et, sonra yeniden push et.',
    'Settings': 'Ayarlar', 'Force Push': 'Force Push',
    'Reset to the Remote Branch': 'Uzak dala reset et', 'Checks out the corresponding remote branch': 'Karşılık gelen uzak dala checkout yapar',
    'Do you want to reset local branch {0} to {1}? Local commits will be dropped': 'Yerel {0} dalı {1} dalına reset edilsin mi? Yerel commit\'ler atılacak',
    'Reset': 'Reset', 'Tag': 'Etiket', 'Git Root:': 'Git kökü:', 'Force': 'Zorla', 'Commit:': 'Commit:', 'Validate': 'Doğrula', 'Message:': 'Mesaj:',
    'Create Tag': 'Etiket oluştur', 'The commit or object name is invalid.': 'Commit ya da nesne adı geçersiz.',
    'Enter the new tag name here.': 'Yeni etiketin adını buraya yaz.', 'Force creation of the tag even if another tag with such name already exists.':
      'Aynı adda bir etiket olsa bile etiketi oluştur.', 'Enter name of commit or object to tag or leave blank to use HEAD.':
      'Etiketlenecek commit\'in ya da nesnenin adını yaz; boş bırakırsan HEAD kullanılır.', 'Click this button to validate the commit to be tagged':
      'Etiketlenecek commit\'i doğrulamak için tıkla', 'If the message is not empty, an annotated tag is created.': 'Mesaj boş değilse açıklamalı (annotated) etiket oluşturulur.',
    'Push Rejected': 'Push reddedildi',
    'Push of the current branch "{0}" was rejected.': 'Geçerli dalın ("{0}") push\'u reddedildi',
    'Push to {0} was rejected': '{0} dalına push reddedildi',
    'Remote changes need to be merged before pushing.': 'Push\'tan önce uzaktaki değişikliklerin birleştirilmesi gerekiyor',
    'Merge': 'Merge',
    'Rebase': 'Rebase',
    'Push rejected': 'Push reddedildi',
    'Push was canceled, because there were conflicts during the update. Check that conflicts were resolved correctly, and invoke push again.':
      'Güncelleme sırasında çakışma çıktığı için push iptal edildi. Çakışmaları çözdükten sonra yeniden push et',
  });

  const isHash = (s) => /^[0-9a-f]{40}$/.test(s || '');
  const shown = (ref) => (isHash(ref) ? Git.short(ref) : ref);

  // ---------------------------------------------------------------- name fields
  /** What `git check-ref-format` refuses in a branch or tag name. */
  const badRef = (name) => /^[./-]|\.\.|[\s~^:?*[\\]|@\{|[\x00-\x1f\x7f]|\/\/|\/\.|\.lock(\/|$)|[/.]$|^@$/.test(name);
  /** IntelliJ turns the spaces typed into a branch name into dashes as you type. */
  function dashSpaces(input) {
    if (!/\s/.test(input.value)) return;
    const at = input.selectionStart;
    input.value = input.value.replace(/\s/g, '-');
    try { input.setSelectionRange(at, at); } catch (e) { /* not focused */ }
  }
  /** The problem with a new local branch name: null or { text, hint?, overwritable? }. `self` is the branch being renamed. */
  function branchProblem(name, o) {
    o = o || {};
    if (!name) return { text: t('Specify name for the new branch') };
    if (name === 'HEAD') return { text: t('HEAD is a reserved keyword') };
    if (badRef(name)) return { text: t('Branch name {0} is not valid', name) };
    if (Git.isLocal(name)) {
      const can = !!o.overwrite && name !== Git.currentBranch();
      return { text: t('Branch name {0} already exists', name), hint: can ? t('Change the name or overwrite existing branch') : null, overwritable: can };
    }
    if (Git.isRemote(name)) return { text: t('Branch name {0} conflicts with remote branch with the same name', name) };
    if (Git.localBranches().some((b) => b !== o.self && (b.indexOf(name + '/') === 0 || name.indexOf(b + '/') === 0))) {
      return { text: t('Branch name {0} conflicts with local branch directory with the same name', name) };
    }
    return null;
  }
  /** The line under a field: the problem in red, an optional second line that says what to do. */
  function showProblem(line, field, p) {
    Git.clear(line);
    field.classList.toggle('gb-invalid', !!p);
    if (!p) return;
    line.appendChild(h('div.gb-problem', p.text));
    if (p.hint) line.appendChild(h('div.g-dim', p.hint));
  }
  function setEnabled(check, on) {
    check.classList.toggle('disabled', !on);
    check.querySelector('input').disabled = !on;
  }

  /** A list of completions under a text field. `items(value)` → [{ value, label, icon?, hint? }]. ↑ ↓ choose, Enter / Tab take. */
  function suggest(field, items, onPick) {
    const input = field.input;
    let pop = null, list = [], sel = -1, box = null;
    const close = () => { if (pop) pop.close(); };
    const paint = () => Array.prototype.forEach.call(box.children, (el, i) => {
      el.classList.toggle('sel', i === sel);
      if (i === sel) el.scrollIntoView({ block: 'nearest' });
    });
    function pick(i) {
      input.value = list[i].value;
      close();
      input.focus();
      onPick(list[i].value);
    }
    function update() {
      list = items(input.value) || [];
      sel = -1;
      if (!list.length) { close(); return; }
      const rows = list.map((it, i) => h('button.g-menu-item', { type: 'button', tabIndex: -1, onclick: () => pick(i) },
        it.icon ? Git.icon(it.icon) : null, h('span.gb-suggest-label', it.label), it.hint ? h('span.gb-suggest-hint', it.hint) : null));
      if (pop) { Git.clear(box); rows.forEach((el) => box.appendChild(el)); pop.place(); return; }
      box = h('div.g-menu.gb-suggest', { role: 'listbox' }, rows);
      box.addEventListener('mousedown', (e) => e.preventDefault());
      pop = Git.popup({ anchor: field, content: box, width: Math.max(220, field.offsetWidth), className: 'gb-suggest-pop', onClose: () => { pop = null; } });
      pop.keepFor = field;
    }
    input.addEventListener('input', update);
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('keydown', (e) => {
      if (!pop) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        sel = e.key === 'ArrowDown' ? (sel + 1) % list.length : (sel <= 0 ? list.length : sel) - 1;
        paint();
      } else if ((e.key === 'Enter' && sel >= 0) || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        pick(Math.max(0, sel));
      }
    });
    return { close };
  }

  /** The grid the name dialogs share: label | field, then rows under the field. */
  const form = (label, field, ...rest) => h('div.gb-form', h('label.g-label', { for: field.input.id }, label), field, rest.map((el) => [h('span'), el]));

  // ---------------------------------------------------------------- New Branch
  D.newBranch = function (o) {
    // `from`: a ref pair, a revision pair (a commit) or null (HEAD); typed text is resolved (A.asRef)
    const from = o && o.from != null ? A.asRef(o.from) : null;
    const fromLabel = (o && o.label) || (from ? A.refLabel(from) : null);
    const state = { checkout: true, overwrite: false, typed: false };
    let busy = false, refusedName = null;
    // A remote branch offers its own name for the local one, as IntelliJ does (the remote's name is cut off).
    const remote = from && from.kind === 'remote' ? (R.remoteNames || []).filter((r) => from.name.indexOf(r + '/') === 0).sort((a, b) => b.length - a.length)[0] : null;
    const guess = from && from.kind === 'remote' ? (remote ? from.name.slice(remote.length + 1) : from.name.replace(/^[^/]+\//, '')) : '';
    const field = Git.field({ id: 'gb-branch-name', value: guess && !Git.isLocal(guess) ? guess : '', onInput: () => { dashSpaces(field.input); state.typed = true; check(); } });
    const line = h('div.gb-line', { role: 'alert' });
    const checkout = Git.checkbox({ id: 'gb-branch-checkout', label: t('Checkout branch'), checked: true, onChange: (v) => { state.checkout = v; } });
    const overwrite = Git.checkbox({ id: 'gb-branch-overwrite', label: t('Overwrite existing branch'), checked: false, disabled: true, onChange: (v) => { state.overwrite = v; check(); } });
    const dlg = Git.dialog({
      title: from ? t('Create Branch from {0}', shown(fromLabel)) : t('Create New Branch'), width: 450, className: 'gb-name-dialog',
      content: form(t('Branch Name:'), field, h('div.gb-options', checkout, overwrite), line),
      buttons: [{ label: t('Cancel') }, { label: t('Create'), primary: true, id: 'create', keepOpen: true, onClick: () => {
        state.typed = true;
        if (check() || busy) return false;
        const name = field.input.value.trim();
        busy = true;
        dlg.primary.disabled = true;
        // the dialog stays until the engine answers: a refusal (the name was taken meanwhile) shows under the field
        A.createBranch(name, from, { checkout: state.checkout, overwrite: state.overwrite,
          onProblem: () => { refusedName = name; } }).then((res) => {
          busy = false;
          if (res) { dlg.close(); return; }
          check();
        });
        return false;
      } }],
      onClose: () => hints.close(),
    });
    /** Updates the message, the Overwrite box and the Create button; true while the name can't be used. */
    function check() {
      const name = field.input.value.trim();
      const p = branchProblem(name, { overwrite: true }) ||
        (refusedName === name ? { text: t('Branch name {0} already exists', name), overwritable: name !== Git.currentBranch() } : null);
      const exists = !!(p && p.overwritable);
      setEnabled(overwrite, exists);
      if (!exists && state.overwrite) { state.overwrite = false; overwrite.querySelector('input').checked = false; }
      const blocked = !!p && !(exists && state.overwrite);
      dlg.primary.disabled = blocked;
      showProblem(line, field, blocked && state.typed ? p : null);
      return blocked;
    }
    // "IntelliJ IDEA will suggest relevant prefixes based on the names of existing local branches."
    const hints = suggest(field, (v) => {
      const q = v.trim().toLowerCase();
      if (!q || q.indexOf('/') >= 0) return [];
      const dirs = Array.from(new Set(Git.localBranches().filter((b) => b.indexOf('/') > 0).map((b) => b.split('/')[0] + '/')));
      return dirs.filter((d) => d.toLowerCase().indexOf(q) === 0).map((d) => ({ value: d, label: d, icon: 'nodes/folder' }));
    }, () => { state.typed = true; check(); });
    check();
    field.input.select();
    return dlg;
  };

  // ---------------------------------------------------------------- Rename
  /** `ref`: the local branch (its pair, or its name). */
  D.renameBranch = function (ref) {
    const mine = A.localOf(ref), name = mine.name;
    if (!Git.isLocal(name)) return null;
    const field = Git.field({ id: 'gb-branch-name', value: name, onInput: () => { dashSpaces(field.input); check(); } });
    const line = h('div.gb-line', { role: 'alert' });
    let unset = false, refused = null;
    // "Note that this action only renames the local branch": the old upstream can be dropped here (spec §10.1).
    const unsetBox = Git.upstream(name) ? Git.checkbox({ id: 'gb-branch-unset', label: t('Unset upstream branch'), checked: false, onChange: (v) => { unset = v; } }) : null;
    const dlg = Git.dialog({
      title: t('Rename Branch {0}', name), width: 450, className: 'gb-name-dialog',
      content: form(t('Branch Name:'), field, ...(unsetBox ? [h('div.gb-options', unsetBox)] : []), line),
      buttons: [{ label: t('Cancel') }, { label: t('Rename'), primary: true, id: 'rename', keepOpen: true, onClick: () => {
        if (check()) return false;
        const next = field.input.value.trim();
        dlg.primary.disabled = true;
        A.doRenameBranch(mine, next, { unsetUpstream: unset, onProblem: () => { refused = next; } }).then((res) => { if (res) dlg.close(); else check(); });
        return false;
      } }],
    });
    function check() {
      const next = field.input.value.trim();
      const p = next === name ? null : branchProblem(next, { self: name }) || (refused === next ? { text: t('Branch name {0} already exists', next) } : null);
      dlg.primary.disabled = !!p || next === name;
      showProblem(line, field, p);
      return dlg.primary.disabled;
    }
    check();
    field.input.select();
    return dlg;
  };

  // ---------------------------------------------------------------- New Tag
  D.newTag = function (id) {
    const at = id || Git.headId();
    const field = Git.field({ id: 'gb-tag-name', onInput: () => { dashSpaces(field.input); check(true); } });
    const line = h('div.gb-line', { role: 'alert' });
    const dlg = Git.dialog({
      title: t('Create New Tag On {0}', shown(at)), width: 420, className: 'gb-name-dialog',
      content: form(t('Tag Name:'), field, line),
      buttons: [{ label: t('Cancel') }, { label: t('OK'), primary: true, id: 'ok', keepOpen: true, onClick: () => {
        if (check(true)) return false;
        const name = field.input.value.trim();
        dlg.primary.disabled = true;
        A.doNewTag(name, at, { onProblem: () => { refused = name; } }).then((res) => { if (res) dlg.close(); else check(true); });
        return false;
      } }],
    });
    let refused = null;
    function check(show) {
      const name = field.input.value.trim();
      const p = !name ? {} : badRef(name) ? { text: t('Tag name {0} is not valid', name) }
        : Object.prototype.hasOwnProperty.call(R.tags, name) || refused === name ? { text: t('The tag with the same name exists.') } : null;
      dlg.primary.disabled = !!p;
      showProblem(line, field, show && p && p.text ? p : null);
      return !!p;
    }
    check(false);
    return dlg;
  };

  // ---------------------------------------------------------------- Git ▸ New Tag… ("Tag": GitTagDialog, §21.3)
  /** Git Root, Tag Name, Force, Commit + Validate, Message (not empty: an annotated tag), Create Tag. `o.commit` prefills. */
  D.tag = function (o) {
    o = o || {};
    const name = Git.field({ id: 'gb-tag-dlg-name', label: t('Tag Name:'), onInput: () => { dashSpaces(name.input); check(true); } });
    name.input.title = t('Enter the new tag name here.');
    let force = false, refused = null;
    const forceBox = Git.checkbox({ id: 'gb-tag-dlg-force', label: t('Force'), title: t('Force creation of the tag even if another tag with such name already exists.'),
      onChange: (v) => { force = v; check(true); } });
    const commit = Git.field({ id: 'gb-tag-dlg-commit', mono: true, value: o.commit || '', label: t('Commit:'), onInput: () => { valid = null; check(true); } });
    commit.input.title = t('Enter name of commit or object to tag or leave blank to use HEAD.');
    let valid = null;   // null: not checked; else the commit id or false
    const validate = Git.btn(t('Validate'), { id: 'gb-tag-dlg-validate', title: t('Click this button to validate the commit to be tagged'), onClick: () => resolve().then(() => check(true)) });
    const message = Git.field({ id: 'gb-tag-dlg-message', multiline: true, rows: 4, label: t('Message:') });
    message.input.title = t('If the message is not empty, an annotated tag is created.');
    const line = h('div.gb-line', { role: 'alert' });
    const row = (label, el, id) => [h('label.g-label', { for: id }, label), el];
    const dlg = Git.dialog({
      title: t('Tag'), width: 520, className: 'gb-name-dialog gb-tag-dialog',
      content: h('div.gb-form',
        row(t('Git Root:'), h('span.gb-tag-root', Git.repo.root), null),
        row(t('Tag Name:'), name, 'gb-tag-dlg-name'), h('span'), h('div.gb-options', forceBox),
        row(t('Commit:'), h('div.gb-tag-commit', commit, validate), 'gb-tag-dlg-commit'),
        row(t('Message:'), message, 'gb-tag-dlg-message'), h('span'), line),
      left: Git.mergeUi.help(Git.mergeUi.HELP.tag, 'gb-tag-help'),
      buttons: [{ label: t('Cancel') }, { label: t('Create Tag'), primary: true, id: 'create', keepOpen: true, onClick: () => {
        resolve().then(() => {
          if (check(true)) return;
          const tag = name.input.value.trim();
          dlg.primary.disabled = true;
          A.doNewTag(tag, valid || null, { message: message.input.value, force, onProblem: () => { refused = tag; } })
            .then((res) => { if (res) dlg.close(); else check(true); });
        });
        return false;
      } }],
    });
    /** The commit field as a commit id (the engine resolves `main~2`); an empty field is HEAD. */
    function resolve() {
      const text = commit.input.value.trim();
      if (!text) { valid = Git.headId(); return Promise.resolve(valid); }
      return Git.content.details(text).then((d) => { valid = d.id; }, () => { valid = false; });
    }
    function check(show) {
      const tag = name.input.value.trim();
      const p = !tag ? {} : badRef(tag) ? { text: t('Tag name {0} is not valid', tag) }
        : (Object.prototype.hasOwnProperty.call(R.tags, tag) || refused === tag) && !force ? { text: t('The tag with the same name exists.') }
          : valid === false ? { text: t('The commit or object name is invalid.') } : null;
      dlg.primary.disabled = !!p;
      showProblem(line, valid === false ? commit : name, show && p && p.text ? p : null);
      return !!p;
    }
    check(false);
    return dlg;
  };

  // ---------------------------------------------------------------- Checkout Tag or Revision
  /** A full ref for what was typed: a branch, a tag, a whole hash or an unambiguous start of one. */
  function resolveRef(text) {
    const v = text.trim();
    if (!v) return null;
    if (Git.refId(v)) return v;
    if (!/^[0-9a-f]{4,39}$/i.test(v)) return null;
    const ids = Array.from(R.commits.keys()).filter((id) => id.indexOf(v.toLowerCase()) === 0);
    return ids.length === 1 ? ids[0] : null;
  }
  D.checkoutRevision = function () {
    const field = Git.field({ id: 'gb-revision', mono: true, onInput: () => showProblem(line, field, null) });
    const line = h('div.gb-line', { role: 'alert' });
    const dlg = Git.dialog({
      title: t('Checkout'), width: 440, className: 'gb-name-dialog',
      content: h('div.gb-stack', h('label.gb-prompt', { for: 'gb-revision' }, t('Enter reference (branch, tag) name or commit hash:')), field, line),
      buttons: [{ label: t('Cancel') }, { label: t('OK'), primary: true, id: 'ok', keepOpen: true, onClick: () => {
        const typed = field.input.value.trim();
        const ref = resolveRef(typed);
        const missing = () => { showProblem(line, field, { text: t('Revision not found') }); field.input.focus(); };
        if (ref) { dlg.close(); A.checkout(ref); return false; }
        if (!typed || /\s/.test(typed) || typed.startsWith('-')) { missing(); return false; }
        // Not in the loaded refs or commits (`main~2`, an older hash): the engine resolves it.
        Git.content.details(typed).then((d) => { if (dlg.closed) return; dlg.close(); A.checkout(d.id); }, () => { if (!dlg.closed) missing(); });
        return false;
      } }],
      onClose: () => hints.close(),
    });
    // "IntelliJ IDEA provides a list of matching tags and revisions as you type."
    const hints = suggest(field, (v) => {
      const q = v.trim().toLowerCase();
      if (!q) return [];
      const out = [];
      const add = (names, icon) => names.forEach((n) => {
        const i = n.toLowerCase().indexOf(q);
        if (i >= 0) out.push({ value: n, label: n, icon, rank: i ? 1 : 0 });
      });
      add(Git.tagNames(), 'dvcs/branchLabel');
      add(Git.localBranches(), 'branch');
      add(Git.remoteBranches(), 'branch');
      if (/^[0-9a-f]{3,}$/.test(q)) {
        Git.logOrder(Git.logHeads()).forEach((id) => {
          if (id.indexOf(q) === 0) out.push({ value: Git.short(id), label: Git.short(id), hint: Git.commit(id).subject, icon: 'vcs/commit', rank: 2 });
        });
      }
      out.sort((a, b) => a.rank - b.rank);
      return out.length === 1 && out[0].value.toLowerCase() === q ? [] : out.slice(0, 10);
    }, () => showProblem(line, field, null));
    return dlg;
  };

  // ---------------------------------------------------------------- Update Project
  D.updateProject = function () {
    let method = 'merge', silent = false;
    const pick = (v) => { method = v; };
    const branch = Git.currentBranch(), up = branch ? Git.upstream(branch) : null;
    // "Reset to the Remote Branch": drop the local commits and align the branch with its remote (D §6.9), after asking
    const reset = (d) => Git.confirm({ title: t('Reset to the Remote Branch'), width: 460, yes: t('Reset'), danger: true,
      text: t('Do you want to reset local branch {0} to {1}? Local commits will be dropped', branch, up),
      onYes: () => { d.close(); A.resetToRemote(branch); } });
    return Git.dialog({
      title: t('Update Project'), width: 560, className: 'gb-update',
      content: h('div.gb-radios', { role: 'radiogroup', 'aria-label': t('Update Project') },
        Git.radio({ name: 'gb-update-method', id: 'gb-update-merge', value: 'merge', label: t('Merge incoming changes into the current branch'), checked: true, onChange: pick }),
        Git.radio({ name: 'gb-update-method', id: 'gb-update-rebase', value: 'rebase', label: t('Rebase the current branch on top of incoming changes'), onChange: pick })),
      left: [Git.mergeUi.help(Git.mergeUi.HELP.update, 'gb-update-help'),
        Git.checkbox({ id: 'gb-update-silent', label: t("Don't show again"), checked: false, onChange: (v) => { silent = v; } })],
      buttons: [{ label: t('Reset to the Remote Branch'), id: 'reset', disabled: !up || !A.resetToRemote, title: t('Checks out the corresponding remote branch'), keepOpen: true, onClick: reset },
        { label: t('Cancel') }, { label: t('OK'), primary: true, id: 'ok', onClick: (d) => {
        if (silent) Git.host.prefs.set('update.method', method);
        d.close();
        A.update(null, method);
      } }],
    });
  };

  // ---------------------------------------------------------------- Push Rejected
  /** `o`: { target, onUpdate(method) } — the update (and the push again) is the caller's (actions-remote.js). */
  /** `o.onForce()` (a Force Push button unless the target is protected) — current IntelliJ (push.rejected.*). */
  D.pushRejected = function (branch, o) {
    o = o || {};
    let remember = false;
    const run = (method) => { if (remember) Git.host.prefs.set('push.updateMethod', method); o.onUpdate(method); };
    const target = o.target || Git.upstream(branch) || R.remoteName + '/' + branch;
    const what = branch === Git.currentBranch() ? t('Push of the current branch "{0}" was rejected.', branch) : t('Push to {0} was rejected', target);
    const guarded = /^(main|master)$/.test(target.replace(/^[^/]+\//, ''));
    // how many commits the remote has that the branch has not (known when they were fetched)
    const s = Git.isLocal(branch) && Git.upstream(branch) === target ? Git.sync(branch) : null;
    const behind = (s && s.behind) || 0;
    const lines = behind
      ? [t(behind === 1 ? '"{0}" has {1} commit that is not in "{2}".' : '"{0}" has {1} commits that are not in "{2}".', target, behind, branch),
        guarded ? t('Force push to "{0}" is prohibited.', target) + ' ' + t('Merge or rebase to keep them, then push again.') : t('Force push to replace them, or merge or rebase to keep them.')]
      : [t('Remote changes need to be merged before pushing.')];
    const buttons = [{ label: t('Cancel'), id: 'cancel' }];
    if (!guarded && o.onForce) buttons.push({ label: t('Force Push'), id: 'force', onClick: (d) => { d.close(); o.onForce(); } });
    buttons.push({ label: t('Rebase'), id: 'rebase', onClick: (d) => { d.close(); run('rebase'); } },
      { label: t('Merge'), primary: true, id: 'merge', onClick: (d) => { d.close(); run('merge'); } });
    return Git.dialog({
      title: t('Push Rejected'), width: 500, className: 'g-confirm',
      content: h('div.g-confirm-text', what, lines.map((x) => h('div.g-confirm-detail', x)),
        branch === Git.currentBranch() ? h('div.gb-options', Git.checkbox({ id: 'gb-reject-remember',
          label: t('Remember the update method and update silently in the future. Change this later in {0} | Version Control.', t('Settings')),
          checked: false, onChange: (v) => { remember = v; } })) : null),
      buttons,
    });
  };
})();
