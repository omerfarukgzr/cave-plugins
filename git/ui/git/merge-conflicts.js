/* The Conflicts dialog an operation stopped by conflicts opens (IntelliJ's iterative MultipleFileMergeDialog),
   split from merge.js. The files are the snapshot's unmerged paths (also without an operation: unstash, squash merge…);
   Accept writes one side as git has it (conflict.accept), Resolve Manually opens the merge tool (merge-tool.js),
   Revert Conflict Resolution brings a resolved file back (conflict.unresolve).
   Git.dialogs.conflicts({ onClose(finished) }) — `finished` is true after Accept and Finish. */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const U = Git.mergeUi, A = Git.actions;
  Git.dialogs = Git.dialogs || {};

  Git.addTR({
    'Conflicts': 'Çakışmalar', 'Yours': 'Seninki', 'Theirs': 'Onlarınki', 'Yours ({0})': 'Seninki ({0})', 'Theirs ({0})': 'Onlarınki ({0})',
    'Modified': 'Değişti', 'Deleted': 'Silindi', 'Unresolved': 'Çözülmemiş', 'Resolved': 'Çözülmüş', 'Accept': 'Al', 'Accept ‘{0}’': '‘{0}’ sürümünü al',
    'Accept and Finish': 'Kabul et ve bitir', 'Resolve Manually': 'Elle çöz', 'Resolve All Simple Conflicts': 'Bütün basit çakışmaları çöz',
    'Apply all non-conflicting changes and resolve simple conflicts (ones that can be resolved through static analysis) across all files':
      'Bütün dosyalarda çakışmayan değişiklikleri uygular ve basit çakışmaları (kendiliğinden çözülebilenleri) çözer',
    'There are no simple conflicts to resolve': 'Çözülecek basit çakışma yok',
    'No conflicts were resolved automatically': 'Hiçbir çakışma kendiliğinden çözülemedi', 'All conflicts were resolved automatically': 'Bütün çakışmalar kendiliğinden çözüldü',
    '{0} resolved. {1} in {2} still require attention': '{0} çözüldü. {2} içindeki {1} hâlâ sana bakıyor',
    '{0} resolved. {1} in {2} still requires attention': '{0} çözüldü. {2} içindeki {1} hâlâ sana bakıyor',
    '1 change has been merged': '1 değişiklik birleştirildi', '{0} changes have been merged': '{0} değişiklik birleştirildi',
    'View Options': 'Görünüm seçenekleri', 'Group By': 'Grupla', 'Directory': 'Klasör', 'Overwrite Changes': 'Değişikliklerin üstüne yaz',
    'This file already contains merged changes. Accepting changes from ‘{0}’ will discard and overwrite them.':
      'Bu dosyada birleştirilmiş değişiklikler var. ‘{0}’ sürümünü almak onları atıp üstüne yazar.',
    'Discard and Accept': 'At ve al', 'Discard Changes?': 'Değişiklikler atılsın mı?',
    'Closing the dialog will discard your changes in partially resolved files': 'Pencereyi kapatmak, kısmen çözülmüş dosyalardaki değişikliklerini atar',
    'Discard Changes': 'Değişiklikleri at', 'Continue Merge': 'Merge\'e devam et', 'Close': 'Kapat',
    'Revert Conflict Resolution': 'Çakışma çözümünü geri al', 'Confirm Revert': 'Geri almayı onayla', 'Revert': 'Geri al',
    'All changes will be reverted. The file will return to its original conflicted state.': 'Bütün değişiklikler geri alınacak. Dosya ilk çakışmalı haline dönecek.',
  });

  const markIcon = (kind) => h('span.gm-mark', { class: kind, html: kind === 'x'
    ? '<svg viewBox="0 0 16 16" fill="none" stroke-width="1.3" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>'
    : '<svg viewBox="0 0 16 16" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 5"/></svg>' });
  /** Whether stage 2 ("yours") / stage 3 ("theirs") of a conflict kind has the file. */
  const HAS = { 'both-modified': [1, 1], 'both-added': [1, 1], 'added-by-us': [1, 0], 'deleted-by-them': [1, 0], 'added-by-them': [0, 1], 'deleted-by-us': [0, 1], 'both-deleted': [0, 0] };
  const has = (kind, side) => (HAS[kind] || [1, 1])[side === 'yours' ? 0 : 1] === 1;
  let live = null;
  /** The kind each conflicted file had: a resolved row keeps its "Modified" / "Deleted" columns (…_progress.png). */
  const kinds = new Map();

  Git.dialogs.conflicts = function (o) {
    o = o || {};
    if (!Git.conflicts().length) return null;
    if (live) { live.onClose = o.onClose || live.onClose; live.refresh(); return live.dlg; }
    const me = (live = { onClose: o.onClose });
    const tool = () => Git.mergeTool;
    let byDir = U.store.get('conflicts-by-dir') === true, note = '', finished = false;
    const about = h('div.gm-conf-about');
    const noteEl = h('span.gm-conf-note', { role: 'status' });
    const wand = h('button.g-btn.gm-conf-wand', { type: 'button', id: 'gm-conf-auto', onclick: () => autoResolve() }, Git.icon('diff/magicResolveToolbar'), h('span', t('Resolve All Simple Conflicts')));
    const eye = Git.toolBtn({ icon: 'general/show', title: t('View Options'), id: 'gm-conf-view', arrow: true, onClick: (e) => Git.menu(e.currentTarget, [
      { label: t('Group By'), disabled: true },
      { label: t('Directory'), checked: byDir, action: () => { byDir = !byDir; U.store.set('conflicts-by-dir', byDir); refresh(); } }]) });
    const head = h('div.gm-conf-head');
    const treeEl = h('div.gm-conf-tree');
    const selectedNode = () => tree.selected()[0] || null;
    const selected = () => { const n = selectedNode(); return n && n.data && !n.data.resolved ? n.data : null; };
    const progressOf = (path) => (tool() ? tool().progress(path) : null);

    function accept(c, side) {
      const go = () => { if (tool()) tool().forget(c.path); A.acceptSide([c.path], side.side).then(() => refresh()); };
      const p = progressOf(c.path);
      if (p && p.done > 0) {
        Git.confirm({ title: t('Overwrite Changes'), text: t('This file already contains merged changes. Accepting changes from ‘{0}’ will discard and overwrite them.', side.name || t(side.side === 'yours' ? 'Yours' : 'Theirs')),
          yes: t('Discard and Accept'), onYes: go });
      } else go();
    }
    function nodes() {
      const open = Git.conflicts();
      open.forEach((c) => kinds.set(c.path, c.kind));
      const closed = Array.from(A.resolvedPaths()).sort().map((path) => ({ path, resolved: true, kind: kinds.get(path) }));
      const sd = U.operation();
      const badges = !!tool() && (closed.length > 0 || open.some((c) => { const p = progressOf(c.path); return p && p.done > 0; }));
      const count = (n) => t(n === 1 ? '{0} file' : '{0} files', n);
      const file = (c) => {
        const p = badges && !c.resolved ? progressOf(c.path) : null;
        const cell = (col, id) => h('span.gm-conf-cell', h('span', t(has(c.kind, col.side) ? 'Modified' : 'Deleted')),
          c.resolved ? null : h('button.g-btn.small.gm-accept', { type: 'button', dataset: { accept: id }, title: t('Accept ‘{0}’', col.name || t(id === 'yours' ? 'Yours' : 'Theirs')),
            onclick: (e) => { e.stopPropagation(); accept(c, col); } }, t('Accept')));
        const done = c.resolved ? { done: 1, total: 1 } : p;
        const badge = badges && done ? h('span.gm-badge', { class: done.done ? 'on' : '', title: done.done ? U.plural(done.done, null, '1 change has been merged', '{0} changes have been merged') : U.plural(done.total, null, '1 change', '{0} changes') }, done.done + '/' + done.total) : null;
        return { id: (c.resolved ? 'r:' : '') + c.path, label: Git.fileName(c.path), icon: Git.fileIcon(c.path), dim: [badge, byDir ? null : Git.dirName(c.path)],
          right: h('span.gm-conf-cols', cell(sd.left, 'yours'), cell(sd.right, 'theirs')), data: c, kind: c.resolved ? 'resolved' : 'conflict', tooltip: c.path };
      };
      const files = (list, key) => {
        if (!byDir) return list.map(file);
        const dirs = {};
        list.forEach((c) => { const d = Git.dirName(c.path); (dirs[d] = dirs[d] || []).push(c); });
        return Object.keys(dirs).sort().map((d) => ({ id: key + ':' + d, label: d || '/', icon: 'nodes/folder', dim: count(dirs[d].length), children: dirs[d].map(file), selectable: false }));
      };
      const out = [];
      if (open.length) out.push({ id: '#unresolved', label: t('Unresolved'), bold: true, icon: markIcon('x'), dim: count(open.length), children: files(open, 'u'), selectable: false, kind: 'group' });
      if (closed.length) out.push({ id: '#resolved', label: t('Resolved'), bold: true, icon: markIcon('ok'), dim: count(closed.length), children: files(closed, 'r'), selectable: false, kind: 'group' });
      return out;
    }
    const openTool = (c) => { if (c && tool() && tool().canOpen(c)) tool().open(c.path, { onClose: () => { if (!dlg.closed) refresh(); } }); };
    function revert(c) {
      Git.confirm({ title: t('Confirm Revert'), text: t('All changes will be reverted. The file will return to its original conflicted state.'), yes: t('Revert'),
        onYes: () => A.unresolve(c.path).then(() => refresh()) });
    }
    const tree = Git.tree({ el: treeEl, nodes, onSelect: () => state(), onActivate: (n) => { if (n.data && !n.data.resolved) openTool(n.data); },
      onContext: (n, e) => { if (n && n.data && n.data.resolved) Git.menu(e, [{ label: t('Revert Conflict Resolution'), action: () => revert(n.data) }]); } });

    async function autoResolve() {
      if (!tool()) return;
      let solved = 0, left = 0, files = 0;
      wand.disabled = true;
      for (const c of Git.conflicts().filter((x) => tool().canOpen(x))) {
        const r = await tool().autoResolve(c.path);
        solved += r.resolved || 0;
        if (r.remaining) { left += r.remaining; files++; }
      }
      note = !solved ? t('No conflicts were resolved automatically') : !left ? t('All conflicts were resolved automatically')
        : t(left === 1 ? '{0} resolved. {1} in {2} still requires attention' : '{0} resolved. {1} in {2} still require attention', U.plural(solved, null, '1 conflict', '{0} conflicts'), U.plural(left, null, '1 conflict', '{0} conflicts'), U.plural(files, null, '{0} file', '{0} files'));
      if (!dlg.closed) refresh();
    }
    function state() {
      const left = Git.conflicts(), c = selected(), done = !left.length;
      const B = dlg.buttons;
      B['gm-conf-finish'].disabled = !done;
      B['gm-conf-resolve'].disabled = !c || !tool() || !tool().canOpen(c);
      B['gm-conf-finish'].classList.toggle('primary', done);
      B['gm-conf-resolve'].classList.toggle('primary', !done);
      dlg.primary = done ? B['gm-conf-finish'] : B['gm-conf-resolve'];
      const can = !!tool() && left.some((x) => tool().canAutoResolve(x.path));
      wand.disabled = !can;
      wand.title = t(can ? 'Apply all non-conflicting changes and resolve simple conflicts (ones that can be resolved through static analysis) across all files' : 'There are no simple conflicts to resolve');
      noteEl.textContent = note;
    }
    /** Reads every text conflict once, so the wand and the badges know what is simple (IntelliJ loads them up front). */
    function preload() {
      if (!tool()) return;
      Git.conflicts().filter((c) => tool().textual(c) && !tool().entry(c.path)).slice(0, 100)
        .forEach((c) => tool().load(c.path).then(() => { if (!dlg.closed) state(); }));
    }
    function refresh() {
      if (!Git.conflicts().length && !A.resolvedPaths().size && !Git.repo.op) { dlg.close(true); return; }
      const info = U.operation();
      Git.clear(about).appendChild(h('div', info.about()));
      Git.clear(head);
      head.appendChild(h('span'));
      head.appendChild(h('span.gm-conf-cell', { title: info.left.name }, info.left.name ? t('Yours ({0})', info.left.name) : t('Yours')));
      head.appendChild(h('span.gm-conf-cell', { title: info.right.name }, info.right.name ? t('Theirs ({0})', info.right.name) : t('Theirs')));
      const keep = selectedNode();
      tree.render();
      const first = Git.conflicts()[0];
      const next = keep && tree.rows().some((n) => n.id === keep.id) ? keep.id : first ? first.path : null;
      tree.select(next, true);
      state();
      preload();
    }
    me.refresh = refresh;

    const dlg = (me.dlg = Git.dialog({ title: t('Conflicts'), width: 720, className: 'gm-conf',
      content: [about, h('div.gm-conf-bar', wand, noteEl, h('span.g-spacer'), eye), h('div.gm-conf-table', head, treeEl)],
      onClose: () => { if (me.onClose) me.onClose(finished); },
      buttons: [
        { label: t('Close'), id: 'gm-conf-close' },
        { label: t('Accept and Finish'), id: 'gm-conf-finish', disabled: true, onClick: () => { finished = true; } },
        { label: t('Resolve Manually'), id: 'gm-conf-resolve', primary: true, keepOpen: true, onClick: () => openTool(selected()) },
      ] }));
    const off = Git.on('change', () => { if (!dlg.closed) refresh(); });
    const shut = dlg.close;
    dlg.close = function (sure) {
      const partial = tool() ? Git.conflicts().filter((c) => { const p = progressOf(c.path); return p && p.done > 0; }) : [];
      if (sure !== true && !finished && partial.length) {
        Git.confirm({ title: t('Discard Changes?'), text: t('Closing the dialog will discard your changes in partially resolved files'), yes: t('Discard Changes'), no: t('Continue Merge'),
          onYes: () => { partial.forEach((c) => tool().forget(c.path)); dlg.close(true); } });
        return;
      }
      if (sure === true && !Git.conflicts().length) finished = true;
      off();
      live = null;
      shut();
    };
    refresh();
    setTimeout(() => { if (!dlg.closed) treeEl.focus(); }, 0);
    return dlg;
  };
})();
