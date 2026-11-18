/* The right side of the Log tab.
   Changed Files: the files of the selected commit(s) as a tree (grouped by directory, or flat); several commits are
   zipped into one change per path (L.zipChanges); a merge shows "No merged conflicts." and, on request, its changes to
   each parent. Toolbar Show Diff, Revert Selected Changes, History Up to Here, View Options (Group By, Show Details, Show
   Diff Preview and its location), Expand/Collapse All; menu Show Diff, Compare with Local, Compare Before with Local,
   Edit Source, Open Repository Version, Revert Selected Changes, Cherry-Pick Selected Changes, Get, History Up to Here,
   Show Changes to Parents (merge).
   Commit Details: message, hash, author, committer when different, dates, the refs on the commit and the branches that
   contain it ("In N branches", read lazily from commit.containing). No parents line: IntelliJ has none. The body's
   hard-wrapped paragraphs are joined again (L.reflowBody); the narrow arrangement shows the who line and the refs
   before the body by CSS order (git-log.css), the DOM order stays IntelliJ's.
   Both read the engine on demand (Git.content.details / .containing, cached) and show "Loading…" meanwhile; an answer
   for a selection that is no longer current is dropped (Git.content.slot).
   Git.logUI.createDetails({ reveal(id), onFile(entry|null)?, layoutChanged()?, preview? }) → { files, details, update(ids), layout(),
   tree }; log.js and the compare tab mount it (`layoutChanged`: the Log offers Show Details / Show Diff Preview;
   `preview`: a picked file switches the diff that shows in the centre, ui/git/centre.js). */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = Git.t;
  const R = Git.repo, A = Git.actions, L = Git.logUI;
  const MAX = 100;                                  // selected commits whose files and details are read
  const CONTAINING = 10;                            // blocks that ask commit.containing (each walks the history)
  const LATE = 400;                                 // ms a wait lasts before "In branches: loading…" shows

  Git.addTR({
    'Show Diff': 'Diff\'i göster', 'History Up to Here': 'Buraya kadarki geçmiş', 'View Options': 'Görünüm seçenekleri', 'Group By': 'Grupla', 'Directory': 'Klasör',
    'Expand All': 'Tümünü aç', 'Collapse All': 'Tümünü kapat', 'Compare with Local': 'Yerel sürümle karşılaştır', 'Edit Source': 'Kaynağı düzenle',
    'Compare Before with Local': 'Önceki sürümü yerel sürümle karşılaştır', 'Revert Selected Changes': 'Seçili değişiklikleri geri al', 'Get': 'Al',
    'Show Changes to Parents': 'Ebeveynlere göre değişiklikleri göster', 'Layout': 'Yerleşim', 'Show Details': 'Ayrıntıları göster',
    'Show Diff Preview': 'Diff önizlemesini göster', 'Diff Preview Location': 'Diff önizlemesinin yeri', 'Bottom': 'Alt',
    'Open Repository Version': 'Depodaki sürümü aç', 'Cherry-Pick Selected Changes': 'Seçili değişiklikleri cherry-pick et', '{0} file': '{0} dosya', '{0} files': '{0} dosya',
    'Select commit to view changes': 'Değişiklikleri görmek için bir commit seç', 'No merged conflicts.': 'Merge sırasında çakışma olmadı.',
    'No merged conflicts': 'Merge sırasında çakışma olmadı', 'Show changes to parents': 'Ebeveynlere göre değişiklikleri göster',
    'Changes to {0}': 'Şuna göre değişiklikler: {0}', 'Commit details': 'Commit ayrıntıları', 'on {0} at {1}': '{0} {1}',
    'committed on {0} at {1}': 'commit zamanı: {0} {1}', 'committed by {0} on {1} at {2}': 'commit eden: {0}, {1} {2}',
    'In {0} branch:': '{0} dalda:', 'In {0} branches:': '{0} dalda:', 'Show all': 'Tümünü göster', 'Hide': 'Gizle', 'Not in any branch': 'Hiçbir dalda değil',
    '(showing {0} of {1} selected commits)': '(seçili {1} commit\'in {0} tanesi gösteriliyor)', 'In branches: loading…': 'Dallar: yükleniyor…',
    'Error loading commit details': 'Commit ayrıntıları yüklenemedi', 'Local': 'Yerel',
    'Combined changes of {0} commits': '{0} commit\'in birleşik değişiklikleri',
  });

  const countText = (n) => t(n === 1 ? '{0} file' : '{0} files', n);
  /** [date, "14:05"]: the details pane writes dates out in full ("on 19.08.25 at 20:57"). */
  function dateTime(ms) {
    const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
    return [Git.dateOrder() === 'dmy' ? p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() : d.getMonth() + 1 + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(2),
      p(d.getHours()) + ':' + p(d.getMinutes())];
  }
  L.dateTime = dateTime;

  /** Directory grouping: a chain of directories with nothing else in them is one row ("Sources/App/Git"). Shared with
      the compare tabs. `leaf(item, flat)` makes a file node. */
  L.fileTree = function (items, byDir, scope, leaf) {
    const byName = (a, b) => Git.fileName(a.path).localeCompare(Git.fileName(b.path));
    if (!byDir) return items.slice().sort(byName).map((it) => leaf(it, true));
    const top = { dirs: new Map(), files: [] };
    items.forEach((it) => {
      let at = top;
      it.path.split('/').slice(0, -1).forEach((part) => { if (!at.dirs.has(part)) at.dirs.set(part, { dirs: new Map(), files: [] }); at = at.dirs.get(part); });
      at.files.push(it);
    });
    const count = (n) => n.files.length + Array.from(n.dirs.values()).reduce((a, d) => a + count(d), 0);
    const walk = (n, prefix) => Array.from(n.dirs.keys()).sort().map((name) => {
      let dir = n.dirs.get(name), label = name;
      while (dir.dirs.size === 1 && !dir.files.length) { const only = dir.dirs.keys().next().value; label += '/' + only; dir = dir.dirs.get(only); }
      return { id: 'd:' + scope + prefix + label, label, icon: 'nodes/folder', dim: countText(count(dir)), kind: 'dir', children: walk(dir, prefix + label + '/') };
    }).concat(n.files.slice().sort(byName).map((it) => leaf(it, false)));
    return [{ id: 'root:' + scope, label: R.name, icon: 'nodes/module', dim: countText(items.length) + '  ' + R.root, kind: 'dir', children: walk(top, '') }];
  };
  L.filesUnder = (n) => (n.kind === 'file' ? [n.data] : (n.children || []).reduce((a, k) => a.concat(L.filesUnder(k)), []));

  /** A change of one commit as the pane's entry (the shape L.zipChanges gives). */
  const single = (ch, commitId, parent) => Object.assign({}, ch, { commitId, parent, single: true, commits: [commitId],
    before: ch.status === 'A' || !parent ? null : { path: ch.oldPath || ch.path, rev: parent }, after: ch.status === 'D' ? null : { path: ch.path, rev: commitId } });

  // ---------------------------------------------------------------- what the entries do (also used by the compare tab)
  /** The diff of an entry: one commit's change in the commit diff tab; a zipped change from before its oldest commit to
      after its newest one. `all`: the entries of the same list, for Compare Previous / Next File. */
  L.showEntryDiff = function (e, all, o) {
    if (!e) return;
    const preview = !!(o && o.preview);         // the selection moved while a diff shows in the centre (ui/git/centre.js)
    if (e.single) {
      const files = (all || []).filter((x) => x.single && x.commitId === e.commitId && x.parent === e.parent).map((x) => x.path);
      A.showCommitDiff(e.commitId, e.path, { parent: e.parent, files, preview });
      return;
    }
    // a zipped change: its two sides as descriptors (ui/git/openers.js `texts`), the other zipped files for Next File
    const sides = (x) => ({ path: x.path, title: Git.fileName(x.path),
      left: { title: x.before ? Git.short(x.before.rev) + ' ' + x.before.path : '', at: x.before ? { path: x.before.path, rev: x.before.rev } : null, locked: true, path: x.before && x.before.path },
      right: { title: x.after ? Git.short(x.after.rev) + ' ' + x.after.path : '', at: x.after ? { path: x.after.path, rev: x.after.rev } : null, locked: true, path: x.after && x.after.path } });
    const others = (all || []).filter((x) => !x.single);
    Git.open('texts', Object.assign({ id: 'diff:combined', what: 'Show Diff', items: others.map(sides) }, sides(e), preview ? { preview: true } : null));
  };
  /** The file as of the commit against what is in the working tree now (IntelliJ's Compare with Local); `before`: the
      version before the commit (Compare Before with Local). */
  L.compareWithLocal = function (e, before) {
    if (!e) return;
    const name = Git.fileName(e.path), at = before ? e.before || null : e.after || null;
    const rev = before ? (e.before ? e.before.rev : e.parent) : e.commitId;
    Git.open('texts', { id: 'diff:with-local', title: name, path: e.path, what: before ? 'Compare Before with Local' : 'Compare with Local',
      left: { title: (rev ? Git.short(rev) + ' ' : '') + Git.fileName(at ? at.path : e.path), at: at ? { path: at.path, rev: at.rev } : null, locked: true, path: at ? at.path : e.path },
      right: { title: t('Local'), at: { path: e.path, worktree: true }, path: e.path } });
  };
  /** Revert Selected Changes: each commit's own files, newest commit first (the opposite of Cherry-Pick Selected Changes). */
  L.revertEntries = async function (list) {
    const byCommit = new Map();
    list.forEach((e) => (e.commits || [e.commitId]).forEach((id) => {
      if (!byCommit.has(id)) byCommit.set(id, { paths: [], parent: e.single ? e.parent : null });
      [e.oldPath, e.path].forEach((p) => { if (p && byCommit.get(id).paths.indexOf(p) < 0) byCommit.get(id).paths.push(p); });
    }));
    const order = Array.from(byCommit.keys()).sort((a, b) => R.log.order.indexOf(a) - R.log.order.indexOf(b));
    for (const id of order) { const x = byCommit.get(id); const res = await A.revertSelectedChanges(id, x.paths, x.parent); if (!res || res.result === 'conflicts') break; }
  };
  /** Get: the files as they are in the (newest) commit of each entry. */
  L.getEntries = async function (list) {
    const byRev = new Map();
    list.forEach((e) => { const rev = e.after ? e.after.rev : e.commitId; if (!byRev.has(rev)) byRev.set(rev, []); [e.oldPath, e.path].forEach((p) => { if (p && byRev.get(rev).indexOf(p) < 0) byRev.get(rev).push(p); }); });
    // one command at a time: A.run turns away another command under the same id while one runs
    for (const [rev, paths] of byRev) { const res = await A.getFromRevision(rev, paths); if (!res) break; }
  };
  /** Cherry-Pick Selected Changes: each commit's own files, oldest commit first. */
  L.applyEntries = async function (list) {
    const byCommit = new Map();
    list.forEach((e) => (e.commits || [e.commitId]).forEach((id) => {
      if (!byCommit.has(id)) byCommit.set(id, []);
      const path = e.single ? e.path : e.path;
      if (byCommit.get(id).indexOf(path) < 0) byCommit.get(id).push(path);
    }));
    const order = Array.from(byCommit.keys()).sort((a, b) => (R.log.order.indexOf(b) - R.log.order.indexOf(a)));
    for (const id of order) { const res = await A.applySelectedChanges(id, byCommit.get(id)); if (!res || res.result === 'conflicts') break; }
  };
  /** Vcs.RepositoryChangesBrowserMenu + Vcs.Log.ChangesBrowser.Popup in IntelliJ's order. `o`: { all, merge, parents:
      { on, toggle() } (a merge commit: Show Changes to Parents) }. Create Patch, Extract Selected Changes to Separate
      Commit and Drop Selected Changes are not built (out of scope). */
  L.entryMenu = function (list, o) {
    const one = list[0];
    const merge = o && o.merge;
    const items = [
      { label: t('Show Diff'), shortcut: '⌘D', action: () => L.showEntryDiff(one, o && o.all) },
      { label: t('Compare with Local'), disabled: !Git.diffTab || !one.after, action: () => L.compareWithLocal(one) },
      { label: t('Compare Before with Local'), disabled: !Git.diffTab || !one.before, action: () => L.compareWithLocal(one, true) },
      { label: t('Edit Source'), shortcut: '⌘↓', disabled: list.every((e) => e.status === 'D'), action: () => list.filter((e) => e.status !== 'D').forEach((e) => A.jumpToSource(e.path)) },
      { label: t('Open Repository Version'), disabled: !one.after, action: () => A.showFileAt(one.after.path, one.after.rev) }, '-',
      { label: t('Revert Selected Changes'), disabled: !!R.op || !A.revertSelectedChanges, action: () => L.revertEntries(list) },
      { label: t('Cherry-Pick Selected Changes'), disabled: !!R.op || !!merge, action: () => L.applyEntries(list) },
      { label: t('Get'), disabled: !!R.op || list.every((e) => !e.after && !e.before), action: () => L.getEntries(list) },
      { label: t('History Up to Here'), disabled: !Git.views.history, action: () => A.showHistory(one.path, { rev: one.commitId }) },
    ];
    if (o && o.parents) items.push({ label: t('Show Changes to Parents'), checked: !!o.parents.on, action: () => o.parents.toggle() });
    return items;
  };

  L.createDetails = function (ctx) {
    const opts = L.opts;
    let ids = [], parentsOf = null, nodes = [], loaded = [], entries = [];   // `loaded`: details of the selected commits (newest first)
    const expanded = new Set();                                // commits whose "In N branches" list is open
    const filesSlot = Git.content.slot();

    // ---------------------------------------------------------------- Changed Files
    const bar = h('div.g-toolbar', { role: 'toolbar' });
    const treeEl = h('div.gl-ftree');
    const note = h('div.gl-fnote', { hidden: true });
    const files = h('div.gl-files.g-col', bar, treeEl, note);

    const leaf = (scope) => (e, flat) => ({ id: 'f:' + scope + e.path, label: Git.fileName(e.path), icon: Git.fileIcon(e.path), color: Git.statusColor(e.status),
      dim: flat ? Git.dirName(e.path) : null, tooltip: e.oldPath ? e.oldPath + ' → ' + e.path : e.path, kind: 'file', data: e });
    const picked = () => tree.selected().reduce((a, n) => a.concat(L.filesUnder(n)), []).filter((e, i, all) => all.indexOf(e) === i);
    const isMerge = () => loaded.length === 1 && loaded[0].merge;
    const showDiff = (list) => { if (list.length) L.showEntryDiff(list[0], entries); };
    const editSource = (list) => list.filter((e) => e.status !== 'D').forEach((e) => A.jumpToSource(e.path));
    const history = (list) => { if (list.length) A.showHistory(list[0].path, { rev: list[0].commitId }); };

    const tree = Git.tree({ el: treeEl, nodes: () => nodes, multi: true, emptyText: t('Select commit to view changes'),
      onSelect: () => { drawBar(); if (ctx.onFile) ctx.onFile(picked()[0] || entries[0] || null); },
      onActivate(node) { if (node.kind === 'file') showDiff([node.data]); },
      // `ctx.preview` (the Log's own list): a picked file switches the diff that shows in the centre (ui/git/centre.js)
      onPick: ctx.preview ? (node) => { if (node.kind === 'file' && Git.centre) Git.centre.preview(() => L.showEntryDiff(node.data, entries, { preview: true })); } : null,
      onContext(node, ev) {
        if (tree.selected().indexOf(node) < 0) tree.select(node.id);
        const list = picked();
        if (!list.length) return;
        const merge = isMerge() ? loaded[0] : null;
        Git.menu(ev, L.entryMenu(list, { all: entries, merge: !!merge,
          parents: merge ? { on: parentsOf === merge.id, toggle: () => { parentsOf = parentsOf === merge.id ? null : merge.id; build(true); } } : null }));
      },
      onKey(e) {
        if (!(e.metaKey || e.ctrlKey)) return;
        if (e.key.toLowerCase() === 'd') { e.preventDefault(); showDiff(picked()); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); editSource(picked()); }
      } });

    function drawBar() {
      const list = picked();
      const regroup = () => { opts.filesByDir = !opts.filesByDir; L.saveOpts(); build(true); };
      Git.clear(bar);
      const layoutFlag = (key, label) => ({ label, checked: !!opts[key], action: () => { opts[key] = !opts[key]; L.saveOpts(); if (ctx.layoutChanged) ctx.layoutChanged(); } });
      const at = (value, label) => ({ label, checked: (opts.previewAt || 'bottom') === value, action: () => { opts.previewAt = value; L.saveOpts(); if (ctx.layoutChanged) ctx.layoutChanged(); } });
      bar.appendChild(Git.toolBtn({ icon: 'vcs/diff', title: t('Show Diff') + '  ⌘D', id: 'gl-files-diff', disabled: !list.length, onClick: () => showDiff(list) }));
      bar.appendChild(Git.toolBtn({ icon: 'vcs/revert', title: t('Revert Selected Changes'), id: 'gl-files-revert', disabled: !list.length || !!R.op, onClick: () => L.revertEntries(list) }));
      bar.appendChild(Git.toolBtn({ icon: 'general/history', title: t('History Up to Here'), id: 'gl-files-history', disabled: !list.length || !Git.views.history, onClick: () => history(list) }));
      // Vcs.Log.ChangesBrowser.PresentationSettings: Group By, then Configure Layout (Show Details, Show Diff Preview, its location)
      bar.appendChild(Git.toolBtn({ icon: 'general/show', title: t('View Options'), id: 'gl-files-view', onClick: (e) => Git.menu(e.currentTarget, [
        { label: t('Group By'), header: t('Group By'), disabled: true }, { label: t('Directory'), checked: !!opts.filesByDir, action: regroup }].concat(ctx.layoutChanged ? ['-',
        { label: t('Layout'), header: t('Layout'), disabled: true }, layoutFlag('details', t('Show Details')), layoutFlag('preview', t('Show Diff Preview')),
        { label: t('Diff Preview Location'), children: [at('bottom', t('Bottom')), at('right', t('Right'))] }] : [])) }));
      bar.appendChild(h('span.g-spacer'));
      if (opts.filesByDir) {
        bar.appendChild(Git.toolBtn({ icon: 'general/expandAll', title: t('Expand All'), id: 'gl-files-expand', onClick: () => tree.expandAll() }));
        bar.appendChild(Git.toolBtn({ icon: 'general/collapseAll', title: t('Collapse All'), id: 'gl-files-collapse', onClick: () => tree.collapseAll() }));
      }
    }
    /** What the pane lists: one commit's files, the zipped changes for several commits, and for a merge either the
        "No merged conflicts." note or, on request, what it brought in relative to each parent (commit.details gives
        the changes against every parent). */
    function build(open) {
      const merge = isMerge() ? loaded[0] : null;
      const plain = merge && parentsOf !== merge.id;
      treeEl.hidden = !!plain;
      note.hidden = !plain;
      entries = [];
      if (plain) {
        nodes = [];
        Git.clear(note);
        note.appendChild(h('div', t('No merged conflicts.')));
        note.appendChild(h('button.g-link#gl-parents', { type: 'button', onclick: () => { parentsOf = merge.id; build(true); } }, t('Show changes to parents')));
      } else if (merge) {
        nodes = [{ id: 'none', label: t('No merged conflicts'), kind: 'note', selectable: false }].concat(merge.changes.map((entry) => {
          const list = entry.files.map((ch) => single(ch, merge.id, entry.parent));
          entries = entries.concat(list);
          const pc = Git.commit(entry.parent);
          return { id: 'p:' + entry.parent, label: t('Changes to {0}', Git.short(entry.parent) + (pc ? ' ' + pc.subject : '')), dim: countText(list.length), kind: 'parent',
            children: L.fileTree(list, opts.filesByDir, entry.parent + ':', leaf(entry.parent + ':')) };
        }));
      } else {
        entries = loaded.length === 1 ? (loaded[0].changes[0] ? loaded[0].changes[0].files.map((ch) => single(ch, loaded[0].id, loaded[0].changes[0].parent)) : [])
          : L.zipChanges(loaded, (id) => { const i = R.log.order.indexOf(id); return i < 0 ? ids.indexOf(id) : i; });
        nodes = loaded.length ? L.fileTree(entries, opts.filesByDir, '', leaf('')) : [];
      }
      if (open) tree.expandAll(); else tree.render();
      drawBar();
      // the diff preview follows the selected file, else the first one of the commit (IntelliJ's preview)
      if (ctx.onFile) ctx.onFile(picked()[0] || entries[0] || null);
    }
    function loadingFiles() {
      nodes = [];
      entries = [];
      treeEl.hidden = true;
      note.hidden = false;
      Git.clear(note).appendChild(Git.content.loading());
    }

    // ---------------------------------------------------------------- Commit Details
    const details = h('div.gl-details.g-scroll', { tabIndex: 0 });
    /** Hashes of known commits inside a message are links into the log. */
    function linked(text) {
      return text.split(/\b([0-9a-f]{7,40})\b/).map((part, i) => {
        if (i % 2 === 0) return part;
        let hit = null, many = false;
        for (const id of R.commits.keys()) { if (id.startsWith(part)) { if (hit) { many = true; break; } hit = id; } }
        return hit && !many ? h('a.g-link', { href: '#', title: Git.commit(hit).subject, onclick: (e) => { e.preventDefault(); ctx.reveal(hit); } }, part) : part;
      });
    }
    const containingSlots = new Map(), containingSince = new Map();
    function containing(c) {
      // the line is there from the start (the details do not jump when the answer comes); its "loading" text only shows
      // when the wait lasts LATE ms
      // (counted from the first time this selection asked: a redraw of the details does not start the wait again)
      if (!containingSince.has(c.id)) containingSince.set(c.id, performance.now());
      const left = LATE - (performance.now() - containingSince.get(c.id));
      const wait = h('div.gl-din.gl-din-wait', { class: left <= 0 ? 'late' : '' }, t('In branches: loading…'));
      const box = h('div.gl-dcontaining', wait);
      const timer = left > 0 ? setTimeout(() => wait.classList.add('late'), left) : 0;
      box.refill = () => fillContaining(c, box, 0);          // refs moved elsewhere: asked again, redrawn only if it differs
      fillContaining(c, box, timer);
      return box;
    }
    function fillContaining(c, box, timer) {
      const slot = containingSlots.get(c.id) || Git.content.slot();
      containingSlots.set(c.id, slot);
      slot.run(() => Git.content.containing(c.id), {
        done: (res) => {
          clearTimeout(timer);
          const names = (res.head && !Git.currentBranch() ? ['HEAD'] : []).concat(res.branches || [], res.remotes || []);
          const key = names.join('\n') + '|' + expanded.has(c.id) + '|' + Git.lang;
          if (box.dataset.key === key) return;
          box.dataset.key = key;
          Git.clear(box);
          if (!names.length) { box.appendChild(h('div.gl-din', t('Not in any branch'))); return; }
          const label = t(names.length === 1 ? 'In {0} branch:' : 'In {0} branches:', names.length);
          const flip = (on) => h('button.g-link', { type: 'button', onclick: () => { if (on) expanded.add(c.id); else expanded.delete(c.id); drawDetails(true); } }, t(on ? 'Show all' : 'Hide'));
          if (expanded.has(c.id)) { box.appendChild(h('div', h('div.gl-din', h('span', label), flip(false)), h('div.gl-din-list', names.map((n) => h('div', n))))); return; }
          const link = flip(true);
          link.hidden = names.length <= 6;
          box.appendChild(h('div.gl-din', { dataset: { more: String(names.length > 6), count: String(names.length) } }, h('span.gl-din-text', label + ' ' + names.slice(0, 6).join(', ') + (names.length > 6 ? ', …' : '')), link));
          layout();
        },
        error: () => { clearTimeout(timer); if (!box.dataset.key) Git.clear(box); },
      });
    }
    function block(c, d, withContaining) {
      const author = d ? d.author : Git.author(c.author), when = dateTime(c.time), commit = dateTime(c.commitTime);
      const committerInfo = d ? d.committer : Git.author(c.committer);
      const committer = committerInfo && (committerInfo.name !== author.name || committerInfo.email !== author.email) ? committerInfo.name : null;
      const refs = Git.refsAt(c.id);
      return h('div.gl-dblock', { dataset: { id: c.id } },
        h('div.gl-dsubject', linked(c.subject)),
        // a body hard-wrapped at about 72 columns is joined again so a narrow pane wraps it itself (L.reflowBody)
        d && d.body ? h('div.gl-dbody', linked(L.reflowBody ? L.reflowBody(d.body) : d.body)) : null,
        h('div.gl-dwho', h('span.gl-dhash', { title: c.id }, Git.short(c.id)), ' ', author.name, ' ',
          author.email ? h('a.g-link', { href: 'mailto:' + author.email }, '<' + author.email + '>') : null, ' ', t('on {0} at {1}', when[0], when[1]),
          committer ? h('div.gl-dcommitted', t('committed by {0} on {1} at {2}', committer, commit[0], commit[1]))
            : Math.abs(c.commitTime - c.time) >= 60000 ? h('div.gl-dcommitted', t('committed on {0} at {1}', commit[0], commit[1])) : null),
        refs.length ? h('div.gl-drefs', refs.map((r) => h('div.gl-dref', L.tagIcon([L.refColor(r.type)]), h('span', r.name)))) : null,
        withContaining ? containing(c) : null);
    }
    /** Draws the blocks again only when what they show changed: the commits, their loaded details, each commit's own
        refs and subject, the expanded branch lists, the language. Otherwise (a 'change' of the repository, a page of the
        log, the table's width) the DOM stays, so a scroll under the wheel is not torn down; when refs moved anywhere the
        "In branches" lines are asked again and change only if their answer did. A redraw keeps the scroll offset. */
    let drawnSig = null, drawnRefs = null;
    function drawDetails(force) {
      const commits = ids.map(Git.commit).filter(Boolean), LIMIT = 50, top = details.scrollTop;
      const byId = new Map(loaded.map((d) => [d.id, d]));
      const sig = [Git.lang, commits.length, Array.from(expanded).join(',')].concat(commits.slice(0, LIMIT).map((c) => {
        const d = byId.get(c.id);
        return [c.id, c.subject, c.time, c.commitTime, d ? 'd' + (d.body || '').length + (d.body || '').slice(0, 64) : '-',
          Git.refsAt(c.id).map((r) => r.type + ':' + r.name).join(',')].join('\u0001');
      })).join('\u0002');
      // where every branch, remote branch and HEAD point: "In branches" can only change when this does (a page of the log
      // bumps the store's refsVersion, not this)
      const refs = Object.keys(R.branches || {}).map((n) => n + '=' + R.branches[n].head).concat(Object.keys(R.remotes || {}).map((n) => n + '=' + R.remotes[n]))
        .sort().join(',') + '|' + (R.headId || '');
      if (!force && sig === drawnSig) {
        if (refs !== drawnRefs) { drawnRefs = refs; Array.prototype.forEach.call(details.querySelectorAll('.gl-dcontaining'), (box) => { if (box.refill) box.refill(); }); }
        return;
      }
      drawnSig = sig;
      drawnRefs = refs;
      Git.clear(details);
      if (!commits.length) { details.appendChild(h('div.gl-dempty', t('Commit details'))); return; }
      commits.slice(0, LIMIT).forEach((c, i) => details.appendChild(block(c, byId.get(c.id), i < CONTAINING)));
      if (commits.length > LIMIT) details.appendChild(h('div.gl-dmore', t('(showing {0} of {1} selected commits)', LIMIT, commits.length)));
      details.scrollTop = top;
      layout();
    }
    /** "Show all" appears when the one-line list of branches is cut off. */
    function layout() {
      Array.prototype.forEach.call(details.querySelectorAll('.gl-din[data-more="false"]'), (line) => {
        const text = line.firstChild, link = line.lastChild;
        link.hidden = true;
        link.hidden = text.scrollWidth <= text.clientWidth;
      });
    }

    let shown = '';
    build(false);
    drawDetails();
    return { files, details, layout, tree, entries: () => entries.slice(),
      /** Called with the selected commits whenever the selection or the repository changes. */
      update(list) {
        const key = list.join(',');
        const fresh = key !== shown;
        ids = list;
        shown = key;
        if (fresh) { details.scrollTop = 0; parentsOf = null; containingSlots.clear(); containingSince.clear(); }
        if (!list.length) { loaded = []; filesSlot.cancel(); build(false); drawDetails(); return; }
        if (!fresh) { drawDetails(); return; }                 // refs moved: labels and branches again, files stay
        const wanted = list.slice(0, MAX);
        filesSlot.run(() => {
          const ps = wanted.map((id) => Git.content.details(id));
          const all = Promise.all(ps);
          if (ps.every((p) => p.entry && p.entry.done)) all.entry = { done: true, value: ps.map((p) => p.entry.value) };
          return all;
        }, {
          loading: () => { loaded = []; loadingFiles(); drawDetails(); },
          done: (res) => { loaded = res; build(true); drawDetails(); },
          error: (err) => { loaded = []; nodes = []; entries = []; treeEl.hidden = true; note.hidden = false; Git.clear(note).appendChild(Git.content.failed(err, t('Error loading commit details'))); drawDetails(); },
        });
      } };
  };
})();
