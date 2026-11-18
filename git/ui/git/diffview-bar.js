/* The diff tab's toolbar, its Settings (gear) menu, its context menus and keys (diffview.js owns the tab).
   IntelliJ's new diff toolbar (A §5.2.1, D §6.12): Previous / Next Difference | Jump to Source | Compare Previous File,
   the file counter, Compare Next File | Collapse Unchanged Fragments … the differences count, the Side-by-side /
   Unified switch and the Settings gear (Synchronize Scrolling and Align Changes in the side-by-side viewer, then the
   Ignore Differences and Highlighting Differences policies). Context menus (A §5.5, §5.7; D Diff.EditorPopupMenu,
   Diff.EditorGutterPopupMenu): a change's Revert / Append, Annotate with Git Blame, the difference navigation.
   `x` is the tab's view of itself (diffview.js `api`): { spec(), src(), m(), lay(), mode(), solo(), off(), cur(), files(),
   hasFile(d), fileStep(d), step(d), jump(), canJump(), revert(bi, append), unfold() }.
     Git.diffBar.toolbar(x) -> { el, tb } · .gearMenu(x, anchor) · .contextMenu(x, e) · .key(x, e) -> handled */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const L = Git.diffLoad;
  const B = (Git.diffBar = {});

  Git.addTR({
    'Revert': 'Geri al', 'Append': 'Ekle', 'Annotate with Git Blame': 'Git Blame ile annotate et', 'Include into commit': 'Commit\'e dahil et',
    'Side-by-side needs a wider panel': 'Yan yana görünüm için panel daha geniş olmalı',
  });

  const tool = (name, icon, title, o) => { const b = Git.toolBtn(Object.assign({ icon, title }, o)); b.dataset.gd = name; return b; };

  B.toolbar = function (x) {
    const S = L.settings, list = x.files(), fi = list.indexOf(x.spec().path), solo = x.solo();
    const sep = () => h('span.g-toolbar-sep');
    // a narrow page shows the unified viewer (diffview.js NARROW): the switch says so and stays as it is (the setting is kept)
    const narrow = !!(x.narrow && x.narrow()), why = t('Side-by-side needs a wider panel');
    const seg = (value, ic, label) => tool('mode-' + value, ic, narrow ? t(label) + ' · ' + why : t(label),
      { active: narrow ? value === 'unified' : S.mode === value, disabled: !!solo || narrow, onClick: () => L.setting('mode', value) });
    const tb = {
      prev: tool('prev', 'general/up', t('Previous Difference') + '  ⇧F7', { onClick: () => x.step(-1) }),
      next: tool('next', 'general/down', t('Next Difference') + '  F7', { onClick: () => x.step(1) }),
      count: h('span.gd-count', { role: 'status' }),
    };
    const gear = tool('settings', 'general/settings', t('Settings'), { onClick: (e) => B.gearMenu(x, e.currentTarget) });
    gear.setAttribute('aria-haspopup', 'menu');
    // diff.files.count.progress: "1 file" / "{1}/{0} files"
    const counter = fi >= 0 ? h('span.gd-files', list.length > 1 ? t('{0}/{1} files', fi + 1, list.length) : t('1 file')) : null;
    const el = h('div.g-toolbar.gd-toolbar', { role: 'toolbar', 'aria-label': t('Diff') }, tb.prev, tb.next, sep(),
      tool('jump', 'general/edit', t('Jump to Source') + '  ⌘↓', { disabled: !x.canJump(), onClick: () => x.jump() }), sep(),
      tool('prev-file', 'general/left', t('Compare Previous File') + '  ⇧⌘[', { disabled: !x.hasFile(-1), onClick: () => x.fileStep(-1) }),
      counter,
      tool('next-file', 'general/right', t('Compare Next File') + '  ⇧⌘]', { disabled: !x.hasFile(1), onClick: () => x.fileStep(1) }), sep(),
      tool('collapse', 'general/collapseAll', t('Collapse Unchanged Fragments'), { active: S.collapse, disabled: !!solo || x.off(),
        onClick: () => { x.unfold(); L.setting('collapse', !S.collapse); } }),
      h('span.g-spacer'), tb.count,
      h('div.gd-seg', { role: 'group', title: narrow ? why : null, class: narrow ? 'gd-seg-narrow' : '' }, seg('side', 'diff/sideBySide', 'Side-by-side viewer'), seg('unified', 'diff/unified', 'Unified viewer')),
      gear);
    return { el: h('div.gd-bar', el), tb };
  };

  /** The gear: the viewer's own toggles (side by side only), then the two policies under their group titles. */
  B.gearMenu = function (x, anchor) {
    const S = L.settings, side = x.mode() === 'side', solo = !!x.solo();
    const items = [];
    if (side) {
      items.push({ label: t('Synchronize Scrolling'), checked: S.sync, action: () => L.setting('sync', !S.sync) },
        { label: t('Align Changes In Side-by-Side Diff'), checked: S.align, action: () => L.setting('align', !S.align) }, '-');
    }
    const group = (title, list, name) => [{ header: t(title), label: t(title), disabled: true }]
      .concat(list.map((o) => ({ label: t(o[1]), checked: S[name] === o[0], disabled: solo, action: () => L.setting(name, o[0]) })));
    // outside the workbench (a single view's page, the center tab) the language rows follow (lang.js)
    // and Report a Problem (report.js; in the workbench both are in its Settings menu)
    Git.menu(anchor, items.concat(group('Ignore Differences', L.IGNORE, 'ignore'), '-', group('Highlighting Differences', L.HIGHLIGHT, 'highlight'), Git.languageMenu(), Git.report ? Git.report.menu() : []));
  };

  /** The pane row under the pointer: { pane: 'L'|'R'|'U', row, gutter } (rows are the children of .gd-code / .gd-gutter). */
  function rowAt(x, e) {
    const cell = e.target.closest && e.target.closest('.gd-ln, .gd-gl, .gd-fold');
    const pane = e.target.closest && e.target.closest('.gd-pane');
    if (!cell || !pane) return null;
    const key = pane.classList.contains('left') ? 'L' : pane.classList.contains('uni') ? 'U' : 'R';
    const i = Array.prototype.indexOf.call(cell.parentNode.children, cell);
    const rows = x.lay() ? x.lay()[key === 'R' && x.solo() ? 'R' : key] : null;
    return rows && rows[i] ? { pane: key, row: rows[i], gutter: !!e.target.closest('.gd-gutter') } : null;
  }
  /** Annotate with Git Blame for the side under the pointer: the work tree file, or the file at that side's commit. */
  function annotateItem(x, pane) {
    const src = x.src(), spec = x.spec(), A = Git.actions;
    const sd = pane === 'L' ? src.left : src.right || src.left;
    const path = sd && (sd.path || sd.file || spec.path);
    const tracked = sd && !(sd.worktree && Git.localFile(spec.path) && /^[A?]$/.test(Git.localFile(spec.path).status));
    const ok = !!(sd && path && tracked && (sd.worktree || sd.rev) && Git.annotate);
    // opens the annotated file view (an annotation already on stays on)
    const work = () => (Git.annotate.isOn(spec.path) ? Git.fileView.open(spec.path, {}) : Git.annotate.toggle(spec.path));
    return { label: t('Annotate with Git Blame'), disabled: !ok, action: () => (sd.worktree ? work() : A.annotate(path, { rev: sd.rev })) };
  }
  B.contextMenu = function (x, e) {
    const at = rowAt(x, e);
    if (!at) return false;
    e.preventDefault();
    if (at.gutter) { Git.menu(e, [annotateItem(x, at.pane)]); return true; }   // Diff.EditorGutterPopupMenu: Annotate first
    const m = x.m(), src = x.src(), bi = at.row.block;
    const k = bi != null ? m.blocks[bi] : null;
    const change = !!(k && k.type !== 'eq' && src.revert && !x.off() && !x.solo());
    const n = m.changes.length;
    Git.menu(e, [
      { label: t('Revert'), shortcut: '⌃⌘→', disabled: !change, action: () => x.revert(bi, false) },
      { label: t('Append'), disabled: !change, action: () => x.revert(bi, true) },
      '-',
      annotateItem(x, at.pane),
      '-',
      { label: t('Previous Difference'), shortcut: '⇧F7', disabled: !n && !x.hasFile(-1), action: () => x.step(-1) },
      { label: t('Next Difference'), shortcut: 'F7', disabled: !n && !x.hasFile(1), action: () => x.step(1) },
      { label: t('Jump to Source'), shortcut: '⌘↓', disabled: !x.canJump(), action: () => x.jump() },
    ]);
    return true;
  };

  /** F7 / ⇧F7, ⌘↓ (F4), ⇧⌘[ / ⇧⌘], ⌃⌘→ (Revert of the current difference). */
  B.key = function (x, e) {
    const cmd = e.metaKey || e.ctrlKey;
    if (e.key === 'F7') x.step(e.shiftKey ? -1 : 1);
    else if (e.key === 'F4' || (e.metaKey && !e.shiftKey && !e.altKey && e.key === 'ArrowDown')) x.jump();
    else if (cmd && e.shiftKey && (e.key === '[' || e.key === '{' || e.code === 'BracketLeft')) x.fileStep(-1);
    else if (cmd && e.shiftKey && (e.key === ']' || e.key === '}' || e.code === 'BracketRight')) x.fileStep(1);
    else if (e.ctrlKey && e.metaKey && e.key === 'ArrowRight' && x.cur() >= 0) x.revert(x.m().changes[x.cur()], false);
    else return false;
    e.preventDefault();
    return true;
  };

  /** The right header's checkbox of a local change: the whole file in or out of the commit (Git._commit.S.included). */
  B.includeBox = function (path) {
    const C = Git._commit;
    if (!C || !C.S || !Git.views.commit) return null;
    const box = Git.checkbox({ checked: C.S.included.has(path), onChange: (v) => { if (v) C.S.included.add(path); else C.S.included.delete(path); if (C.refresh) C.refresh(); Git.emit('included'); } });
    box.classList.add('gd-include');
    box.title = t('Include into commit');
    return box;
  };
})();
