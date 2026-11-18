/* Interactive Rebase, IntelliJ's "Rebasing Commits" dialog (GitInteractiveRebaseDialog).
   Left: the commits in the order they will be applied (oldest on top) with the one-lane graph that shows what was
   done to each; right: the selected commit's files and details. The plan logic is merge-plan.js.
   Git.dialogs.interactiveRebase(fromId)                                 "Interactively Rebase from Here…": rebase.plan
   Git.dialogs.interactiveRebase(null, { onto, upstream?, branch? })    Rebase dialog with --interactive: rebase.planOnto
   Start Rebasing → Git.actions.rebaseInteractive (rebase.apply / rebase.applyOnto). */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const M = Git.rebasePlanModel, A = Git.actions;
  Git.dialogs = Git.dialogs || {};

  Git.addTR({
    'Rebasing Commits': 'Commit\'ler rebase ediliyor', 'Start Rebasing': 'Rebase\'i başlat', 'Move Up': 'Yukarı taşı', 'Move Down': 'Aşağı taşı',
    'Pick': 'Pick', 'Stop to Edit': 'Düzenlemek için dur', 'Reword': 'Reword', 'Squash': 'Squash', 'Fixup': 'Fixup', 'Drop': 'Drop', 'Reset': 'Reset',
    'Show Diff': 'Diff\'i göster', 'Yes': 'Evet', 'No': 'Hayır',
    'Do you want to continue (this will reset the current branch to the base branch)?': 'Devam edilsin mi? (Geçerli dal hedef dala reset edilir.)',
    'Press {0} to apply changes': 'Uygulamak için {0} tuşlarına bas', 'No differences': 'Fark yok', 'Commit details': 'Commit ayrıntıları',
    'on {0} at {1}': '{0} {1}', 'Expand All': 'Tümünü aç', 'Collapse All': 'Tümünü kapat',
    'Cancel Reword': 'Reword\'den vazgeç', 'Entered commit message will be lost': 'Yazdığın commit mesajı kaybolacak', 'Keep Editing': 'Düzenlemeye devam et',
    'Cancel Rebase': 'Rebase\'den vazgeç', 'Discard changes and cancel rebase?': 'Değişiklikler atılıp rebase\'den vazgeçilsin mi?',
    'Discard': 'At', 'Continue Rebasing': 'Rebase\'e devam et', 'Git Rebase': 'Git Rebase',
    'There are no commits to rebase because the current branch is directly below the base branch, or they point to the same commit (the \'noop\' situation).':
      'Rebase edilecek commit yok: geçerli dal hedef dalın hemen altında ya da ikisi aynı commit\'i gösteriyor.',
    'Selected commit has {0} parents': 'Seçili commit\'in {0} ebeveyni var', 'The commit is not in the current branch': 'Commit geçerli dalda değil',
    'Interactive rebase failed': 'Interactive rebase başarısız oldu', 'View Options': 'Görünüm seçenekleri', 'Group By': 'Grupla', 'Directory': 'Klasör',
    '{0} file': '{0} dosya', '{0} files': '{0} dosya',
  });

  const ELBOW = '<svg viewBox="0 0 18 16" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2v9h12M1 5l3-3 3 3"/></svg>';

  /** Loads the plan, then opens the dialog. */
  Git.dialogs.interactiveRebase = function (fromId, o) {
    o = o || {};
    // A range with a merge commit cannot be planned here (IntelliJ then falls back to git's text todo editor, which
    // this UI does not have): its refusal under "Cannot Start Rebase", "Commit {0} has {1} parents"
    // (rebase.log.multiple.commit.editing.action.specific.commit.root.or.merge).
    const refused = (reason, err) => {
      const d = (err && err.data) || {};
      if (reason !== 'merge_commit' && reason !== 'not_in_current_branch') return false;
      Git.notify({ kind: 'error', title: t('Cannot Start Rebase'), text: A.reasonText ? A.reasonText(reason, d) : reason });
      return true;
    };
    // --root and --autosquash / --no-autosquash shape the plan itself (the whole branch; fixup! commits pre-marked)
    // `onto` / `upstream`: ref pairs or typed text (the Rebase dialog), `branch`: a local branch; A.wire names them
    const planParams = { upstream: A.wire(o.upstream || o.onto) };
    if (o.branch) planParams.branch = A.wire(A.localOf(o.branch));
    ['root', 'autosquash', 'noAutosquash'].forEach((k) => { if (o[k]) planParams[k] = true; });
    const load = o.onto
      ? A.run({ id: 'rebase.planOnto', title: t('Rebasing Commits'), method: 'rebase.planOnto', params: planParams, refused })
      : Git.content.rebasePlan(fromId).catch((err) => { if (!(err && err.code === 'refused' && refused(err.data && err.data.reason, err))) A.errorNotice(err, t('Rebase'), t('Interactive rebase failed')); return null; });
    return load.then((plan) => {
      if (!plan) return null;
      if (!plan.entries.length) {
        // GitInteractiveRebaseEditorHandler: the 'noop' question; Yes runs the rebase (the branch goes to the base)
        Git.confirm({ title: t('Git Rebase'), width: 480, yes: t('Yes'), no: t('No'), text: t(NOOP), detail: t(NOOP_ASK),
          onYes: () => { if (o.onto) A.rebaseOnto(o.onto, plainOptions(o)); } });
        return null;
      }
      return open(plan, o);
    });
  };
  const NOOP = 'There are no commits to rebase because the current branch is directly below the base branch, or they point to the same commit (the \'noop\' situation).';
  const NOOP_ASK = 'Do you want to continue (this will reset the current branch to the base branch)?';
  /** What the plain rebase (no edited plan) gets from the Rebase dialog. */
  function plainOptions(o) {
    const opts = { upstream: o.upstream && !A.sameRef(o.upstream, o.onto) ? o.upstream : undefined, branch: o.branch,
      checkedOut: !!o.branch && A.localOf(o.branch).name !== Git.currentBranch() };
    (A.REBASE_FLAGS || []).forEach((k) => { if (o[k]) opts[k] = true; });
    return opts;
  }

  function open(plan, o) {
    const ids = plan.entries.map((e) => e.id);
    const subjects = new Map(plan.entries.map((e) => [e.id, e.subject]));
    const details = new Map();   // id -> commit.details
    // The plan as it came (with --autosquash: fixup! / squash! already melted in); Reset goes back to it.
    const initial = () => plan.entries.map((e) => ({ id: e.id, action: e.action || 'pick', message: e.message == null ? null : e.message }));
    const first = JSON.stringify(initial());
    let entries = initial(), sel = null, editing = null, byDir = true, drag = null;
    const full = (id) => { const d = details.get(id); return d ? d.subject + (d.body ? '\n\n' + d.body : '') : subjects.get(id) || ''; };
    const subjectOf = (e) => subjects.get(e.id) || '';
    const index = () => entries.findIndex((e) => e.id === sel);
    const rootBefore = (i) => M.rootBefore(entries, i);
    const messageOf = (e) => (e.message != null ? e.message : full(e.id));
    const modified = () => JSON.stringify(entries) !== first;   // anything done since the dialog opened (Reset, Cancel's question)

    // ---- left: toolbar + list
    const B = {};
    const list = h('div.gm-ir-list', { tabIndex: 0, role: 'listbox', id: 'gm-ir-list', 'aria-label': t('Rebasing Commits') });
    const reset = h('button.g-link.gm-ir-reset', { type: 'button', id: 'gm-ir-reset', hidden: true, onmousedown: (e) => e.preventDefault(),
      onclick: () => { editing = null; entries = initial(); render(); keys(); } }, t('Reset'));
    const bar = h('div.g-toolbar', { role: 'toolbar' },
      (B.up = Git.toolBtn({ icon: 'general/moveUp', title: t('Move Up') + '  ⌥↑', id: 'gm-ir-up', onClick: () => move(-1) })),
      (B.down = Git.toolBtn({ icon: 'general/moveDown', title: t('Move Down') + '  ⌥↓', id: 'gm-ir-down', onClick: () => move(1) })),
      (B.pick = Git.toolBtn({ icon: 'vcs/revert', title: t('Pick') + '  ⌥P', id: 'gm-ir-pick', onClick: () => setAction('pick') })),
      (B.edit = Git.toolBtn({ icon: 'run/pause', title: t('Stop to Edit') + '  ⌥E', id: 'gm-ir-edit', onClick: () => setAction('edit') })),
      h('span.g-toolbar-sep'),
      (B.reword = Git.btn(t('Reword'), { small: true, id: 'gm-ir-reword', title: t('Reword') + '  ⌥R, F2', onClick: () => reword() })),
      h('span.gm-ir-split',
        (B.squash = Git.btn(t('Squash'), { small: true, id: 'gm-ir-squash', title: t('Squash') + '  ⌥S', onClick: () => setAction('squash') })),
        (B.more = h('button.g-btn.small', { type: 'button', id: 'gm-ir-squash-more', 'aria-label': t('Fixup'), title: t('Fixup') + '  ⌥F',
          onclick: (e) => Git.menu(e.currentTarget, [{ label: t('Fixup'), shortcut: '⌥F', action: () => setAction('fixup') }]) }, Git.icon('chevronDownSmall', 12)))),
      (B.drop = Git.btn(t('Drop'), { small: true, id: 'gm-ir-drop', title: t('Drop') + '  ⌥⌫', onClick: () => setAction('drop') })),
      h('span.g-spacer'), reset);

    // ---- right: files of the selected commit + its details
    const filesEl = h('div'), empty = h('div.gm-ir-empty', t('No differences')), detailsEl = h('div.gm-ir-details');
    const tree = Git.tree({ el: filesEl, nodes: () => {
      const e = entries[index()], d = e && details.get(e.id);
      if (!d) return [];
      const changes = (d.changes[0] && d.changes[0].files) || [];
      const count = (n) => t(n === 1 ? '{0} file' : '{0} files', n);
      const file = (ch) => ({ id: ch.path, label: Git.fileName(ch.path), icon: Git.fileIcon(ch.path), color: Git.statusColor(ch.status), dim: byDir ? null : Git.dirName(ch.path), tooltip: ch.path });
      let kids;
      if (byDir) {
        const dirs = {};
        changes.forEach((ch) => { const dd = Git.dirName(ch.path); (dirs[dd] = dirs[dd] || []).push(ch); });
        kids = Object.keys(dirs).sort().map((dd) => (dd ? { id: 'dir:' + dd, label: dd, icon: 'nodes/folder', dim: count(dirs[dd].length), children: dirs[dd].map(file) } : dirs[dd].map(file)))
          .reduce((all, x) => all.concat(x), []);
      } else kids = changes.map(file);
      return [{ id: '#root', label: Git.repo.name, icon: 'nodes/module', dim: count(changes.length), children: kids }];
    }, onActivate: (n) => showDiff(n), onSelect: () => { diffBtn.disabled = !fileOf(tree.selected()[0]); } });
    // Show Diff (⌘D) over the dialog: the selected file of the selected commit against its parent
    const fileOf = (n) => (n && n.id && n.id !== '#root' && n.id.indexOf('dir:') !== 0 ? n.id : null);
    function showDiff(n) {
      const e = entries[index()], path = fileOf(n || tree.selected()[0]);
      if (e && path) Git.mergeUi.diffOver(e.id, path);
    }
    const diffBtn = Git.toolBtn({ icon: 'vcs/diff', title: t('Show Diff') + '  ⌘D', id: 'gm-ir-diff', disabled: true, onClick: () => showDiff() });
    const viewBar = h('div.g-toolbar', diffBtn, h('span.g-toolbar-sep'),
      Git.toolBtn({ icon: 'general/show', title: t('View Options'), id: 'gm-ir-view', arrow: true, onClick: (e) => Git.menu(e.currentTarget, [
        { label: t('Group By'), disabled: true }, { label: t('Directory'), checked: byDir, action: () => { byDir = !byDir; tree.render(); } }]) }),
      h('span.g-spacer'),
      Git.toolBtn({ icon: 'general/expandAll', title: t('Expand All'), id: 'gm-ir-expand', onClick: () => tree.expandAll() }),
      Git.toolBtn({ icon: 'general/collapseAll', title: t('Collapse All'), id: 'gm-ir-collapse', onClick: () => tree.collapseAll() }));
    const right = h('div.gm-ir-right', viewBar, h('div.gm-ir-files', filesEl, empty), detailsEl);
    const left = h('div.gm-ir-left', bar, list);

    function showCommit() {
      const e = entries[index()], d = e && details.get(e.id);
      if (e && !d) want(e.id);
      tree.render();
      diffBtn.disabled = !fileOf(tree.selected()[0]);
      filesEl.hidden = !d;
      empty.hidden = !!d;
      Git.clear(detailsEl).classList.toggle('g-none', !e);
      if (!e) { detailsEl.appendChild(document.createTextNode(t('Commit details'))); return; }
      if (!d) { detailsEl.appendChild(Git.content.loading()); return; }
      const dt = new Date(d.time), p = (n) => String(n).padStart(2, '0');
      detailsEl.appendChild(h('div.gm-ir-subject', d.subject));
      if (d.body) detailsEl.appendChild(h('div.gm-ir-body', d.body));
      detailsEl.appendChild(h('div.gm-ir-meta', h('div', Git.short(d.id) + '  ' + d.author.name),
        h('div', h('a', { href: 'mailto:' + d.author.email }, '<' + d.author.email + '>'), ' ',
          t('on {0} at {1}', p(dt.getDate()) + '.' + p(dt.getMonth() + 1) + '.' + String(dt.getFullYear()).slice(2), p(dt.getHours()) + ':' + p(dt.getMinutes())))));
    }
    // The bodies and files come from commit.details, loaded when they are needed (the selected commit, the messages
    // a reword or a squash edits); the list draws from the plan's subjects. A plan of thousands of commits opens at once.
    const ensure = (list) => Promise.all(list.filter((id) => !details.has(id)).map((id) => Git.content.details(id).then((d) => { details.set(id, d); }, () => null)));
    function want(id) { if (id && !details.has(id)) ensure([id]).then(() => { if (!dlg.closed && sel === id) showCommit(); }); }

    // ---- what the buttons do
    function move(d) {
      const i = index();
      if (editing || i < 0) return;
      M.move(entries, i, i + d);
      render();
    }
    function setAction(action) {
      const i = index();
      if (editing || i < 0) return;
      const e = entries[i], root = rootBefore(i);
      const go = () => { if (editing || entries[i] !== e) return; const edit = M.setAction(entries, i, action, messageOf); render(); if (edit) startEdit(edit); };
      if (action === 'squash' || action === 'fixup') ensure([e.id].concat(root ? [root.id] : [])).then(go); else go();
    }
    function reword() {
      const e = entries[index()];
      if (editing || !e || !M.isRoot(e)) return;
      ensure([e.id]).then(() => { if (!editing && !dlg.closed) startEdit(e.id); });
    }
    function startEdit(id) { editing = id; sel = id; editor = null; render(); const i = index(); if (i >= 0) vl.scrollTo(i, { align: 'nearest' }); }
    function endEdit(text) {
      const e = entries.find((x) => x.id === editing);
      editing = null;
      if (e && text != null) {
        const clean = text.replace(/\s+$/, '');
        e.message = clean && clean !== full(e.id) ? clean : null;
      }
      render();
      keys();
    }
    function cancelEdit(text) {
      const e = entries.find((x) => x.id === editing);
      if (!e || text === messageOf(e)) { endEdit(null); return; }
      Git.confirm({ title: t('Cancel Reword'), text: t('Entered commit message will be lost'), yes: t('Cancel Reword'), no: t('Keep Editing'), onYes: () => endEdit(null) });
    }

    // ---- the list
    // The rows are virtual (Git.vlist): only those in view exist, so thousands of commits open at once. The reword
    // editor is kept across redraws (scrolling must not lose what was typed); its row grows to hold it and pushes the
    // rows below down (IntelliJ's inline editor), the list's one taller row (`tall`, measured once it is drawn).
    let lastNode = -1, editor = null, editorRow = 0;
    function rowEl(i) {
      const e = entries[i];
      const root = M.isRoot(e), child = M.isChild(e);
      const united = root && entries[i + 1] && M.isChild(entries[i + 1]);
      const graph = h('span.gm-ir-graph', { class: (i <= lastNode ? 'up ' : '') + (i < lastNode ? 'down ' : '') + (e.action === 'edit' ? 'pause' : '') },
        !root ? null : e.action === 'edit' ? Git.icon('run/pause') : [united ? h('i.behind') : null, h('i', { class: united ? 'united' : '' })]);
      const row = h('div.gm-ir-row', { role: 'option', dataset: { id: e.id, action: e.action }, 'aria-selected': String(e.id === sel),
        class: (e.id === sel ? 'sel ' : '') + (e.action === 'drop' ? 'dropped ' : '') + (root && messageOf(e).split('\n')[0] !== subjectOf(e) ? 'reworded ' : '') +
          (editing === e.id ? 'editing ' : '') + (drag && drag.on && drag.id === e.id ? 'dragging' : '') }, graph);
      if (editing === e.id && editor) row.appendChild(editor);
      else {
        if (child) row.appendChild(h('span.gm-ir-elbow', { html: ELBOW }));
        const text = child || e.action === 'drop' ? subjectOf(e) : messageOf(e).split('\n')[0];
        row.appendChild(h('span.gm-ir-text', { title: child || e.action === 'drop' ? subjectOf(e) : messageOf(e) }, text));
      }
      return row;
    }
    function makeEditor(e) {
      const area = h('textarea', { spellcheck: 'false', 'aria-label': t('Reword'), id: 'gm-ir-message' });
      area.value = messageOf(e);
      area.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); ev.stopPropagation(); endEdit(area.value); }
        else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); cancelEdit(area.value); }
        else ev.stopPropagation();
      });
      setTimeout(() => { area.focus(); area.setSelectionRange(area.value.length, area.value.length); }, 0);
      return h('div.gm-ir-editor', area, h('div.gm-ir-hint', t('Press {0} to apply changes', '⌘↵')));
    }
    const rowHeight = () => parseFloat(getComputedStyle(list).getPropertyValue('--gm-list-row')) || 24;
    const editIndex = () => (editing ? entries.findIndex((x) => x.id === editing) : -1);
    const tall = () => (editIndex() < 0 ? null : [editIndex(), editorRow || rowHeight() + 170]);
    const vl = Git.vlist({ el: list, rowHeight, count: () => entries.length, render: rowEl, overscan: 20, tall });
    function render() {
      lastNode = entries.reduce((last, e, i) => (M.isRoot(e) ? i : last), -1);
      const ed = editing && entries.find((x) => x.id === editing);
      if (!ed) editor = null; else if (!editor) editor = makeEditor(ed);
      list.dataset.count = String(entries.length);
      const typing = editor && editor.contains(document.activeElement) ? document.activeElement : null;
      vl.refresh();
      // the editing row's real height (fonts, skin) is known once drawn: the list is laid out again with it
      const at = editIndex(), node = at >= 0 ? vl.rowElement(at) : null;
      if (node && node.offsetHeight && Math.abs(node.offsetHeight - (editorRow || 0)) > 0.5) { editorRow = node.offsetHeight; vl.refresh(); }
      if (typing && typing.isConnected && document.activeElement !== typing) typing.focus({ preventScroll: true });
      const i = index(), e = entries[i], off = !!editing || !e;
      B.up.disabled = off || i === 0;
      B.down.disabled = off || i === entries.length - 1;
      B.pick.disabled = off || (e.action === 'pick' && e.message == null);
      B.edit.disabled = off || e.action === 'edit';
      B.reword.disabled = off || !M.isRoot(e);
      B.squash.disabled = off || e.action === 'squash' || !rootBefore(i);
      B.more.disabled = off || e.action === 'fixup' || !rootBefore(i);
      B.drop.disabled = off || e.action === 'drop';
      reset.hidden = !modified();   // it stays while a message is edited (apply__VCS_interactive_rebase_graph.png)
      if (dlg) dlg.buttons['gm-ir-start'].disabled = !!editing;
      showCommit();
    }
    function select(id) {
      if (editing || !id) return;
      sel = id;
      render();
      const i = index();
      if (i >= 0) vl.scrollTo(i, { align: 'nearest' });
    }
    // Drag a row to reorder: it moves once the pointer leaves 4 px around where it went down.
    const rowAt = (y) => Array.prototype.find.call(list.querySelectorAll('.gm-ir-row'), (r) => { const b = r.getBoundingClientRect(); return y >= b.top && y < b.bottom; });
    list.addEventListener('mousedown', (e) => {
      const row = e.target.closest('.gm-ir-row');
      if (!row || editing || e.button !== 0) return;
      select(row.dataset.id);
      drag = { id: row.dataset.id, y: e.clientY, on: false };
    });
    document.addEventListener('mousemove', onDrag);
    document.addEventListener('mouseup', endDrag);
    function onDrag(e) {
      if (!drag) return;
      if (!drag.on && Math.abs(e.clientY - drag.y) < 4) return;
      drag.on = true;
      const over = rowAt(e.clientY), from = entries.findIndex((x) => x.id === drag.id);
      if (!over || over.dataset.id === drag.id || from < 0) return;
      M.move(entries, from, entries.findIndex((x) => x.id === over.dataset.id));
      render();
    }
    function endDrag() { if (drag && drag.on) { drag = null; render(); } else drag = null; }
    list.addEventListener('dblclick', (e) => { if (e.target.closest('.gm-ir-row') && !editing) reword(); });
    /** The keyboard of the dialog: the focus sink holds it (the Esc rule: an embedding host may close the page on Esc
        unless an editable element has focus), the list's keys come from there. */
    function keys() { const sink = dlg.el.querySelector('.g-sink'); if (sink) sink.focus({ preventScroll: true }); }
    list.addEventListener('keydown', listKeys);
    function listKeys(e) {
      if (editing) return;
      const i = index(), step = (d) => { const x = entries[Math.max(0, Math.min(entries.length - 1, i + d))]; if (x) select(x.id); };
      const run = (fn) => { e.preventDefault(); e.stopPropagation(); fn(); };
      if (e.altKey && e.key === 'ArrowUp') run(() => move(-1));
      else if (e.altKey && e.key === 'ArrowDown') run(() => move(1));
      else if (e.key === 'ArrowUp') run(() => step(i < 0 ? 0 : -1));
      else if (e.key === 'ArrowDown') run(() => step(1));
      else if (e.key === 'F2' || e.key === 'Enter' || (e.altKey && e.code === 'KeyR')) run(reword);
      else if (e.altKey && e.code === 'KeyP') run(() => setAction('pick'));
      else if (e.altKey && e.code === 'KeyE') run(() => setAction('edit'));
      else if (e.altKey && e.code === 'KeyS') run(() => setAction('squash'));
      else if (e.altKey && e.code === 'KeyF') run(() => setAction('fixup'));
      else if (e.altKey && (e.key === 'Backspace' || e.key === 'Delete')) run(() => setAction('drop'));
    }

    // ---- start / cancel
    function start() {
      if (editing) return;
      // `changed`: the plan is more than every commit picked as it is (an autosquashed plan always is)
      const steps = M.toEngine(entries), changed = M.modified(entries, ids);
      shut();
      if (o.onto) {
        // the plain rebase sends no plan: it may only run while the branch is where the plan was read
        const now = o.branch ? A.refId(A.localOf(o.branch)) : Git.headId();
        if (!changed && plan.head && now !== plan.head) { A.errorNotice({ code: 'refused', data: { reason: 'head_moved' } }, t('Rebase'), t('Rebase failed')); return; }
        if (!changed) A.rebaseOnto(o.onto, plainOptions(o));
        else {
          const p = { onto: o.onto, upstream: o.upstream || o.onto, branch: o.branch, entries: steps, head: plan.head };
          (A.REBASE_FLAGS || []).forEach((k) => { if (o[k]) p[k] = true; });
          A.rebaseInteractive(p);
        }
        return;
      }
      if (!changed) return;   // nothing to do: every commit stays as it is
      A.rebaseInteractive({ base: plan.base, entries: steps, head: plan.head });
    }

    const dlg = Git.dialog({ title: t('Rebasing Commits'), width: 880, height: 500, className: 'gm-ir', content: [left, Git.splitter({ target: right, edge: 'left', min: 240, max: 620 }), right],
      onClose: () => { document.removeEventListener('mousemove', onDrag); document.removeEventListener('mouseup', endDrag); },
      buttons: [{ label: t('Cancel'), id: 'gm-ir-cancel' }, { label: t('Start Rebasing'), primary: true, id: 'gm-ir-start', keepOpen: true, onClick: () => start() }] });
    dlg.el.addEventListener('keydown', (e) => { if (e.target.classList && e.target.classList.contains('g-sink')) listKeys(e); });
    const shut = dlg.close;
    dlg.close = function () {
      if (!modified() && !editing) { shut(); return; }
      Git.confirm({ title: t('Cancel Rebase'), text: t('Discard changes and cancel rebase?'), yes: t('Discard'), no: t('Continue Rebasing'), onYes: shut });
    };
    render();   // nothing selected at first: every button is dimmed (IntelliJ's first screenshot)
    setTimeout(() => { if (!dlg.closed) keys(); }, 0);
    return dlg;
  }
})();
