/* History: <file> (IntelliJ's File History tab), on log.fileHistory (follows renames: each revision knows the
   file's path in it). The revisions with Branch filter, Refresh, Show Diff, Show All Affected Files and View Options
   (Show Commit Timestamp, Columns, Layout); the selected revision's message under the list and its diff beside it
   (Show Diff Preview, log-preview.js). Menu in IntelliJ's order: Copy Revision Number, Cherry-Pick, Get, Show File at
   Revision, Compare with Local, Show Diff, Show Diff in a New Tab or Window, Show All Affected Files, Annotate, Show in
   Git Log, Revert Commit, Fixup…, Squash Into…, New Tag….
   Git.views.history.mount(el, { path, rev? }) → stop()   (`rev`: History Up to Here) */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = Git.t;
  const R = Git.repo, A = Git.actions;
  const L = (Git.logUI = Git.logUI || {});
  const T = Git.logTabs;

  Git.addTR({
    'Show Diff': 'Diff\'i göster', 'Compare with Local': 'Yerel sürümle karşılaştır', 'Copy Revision Number': 'Commit hash\'ini kopyala',
    'Show in Git Log': 'Git Log\'da göster', 'Refresh': 'Yenile', 'View Options': 'Görünüm seçenekleri', 'Branch': 'Dal',
    'Show': 'Göster', 'Columns': 'Sütunlar', 'Author': 'Yazar', 'Date': 'Tarih', 'Hash': 'Hash', 'Layout': 'Yerleşim',
    'Show Details': 'Ayrıntıları göster', 'Show Diff Preview': 'Diff önizlemesini göster', 'Clear': 'Temizle',
    'No changes committed.': 'Commit\'lenmiş değişiklik yok', 'Commit message': 'Commit mesajı', '{0} {1} on {2} at {3}': '{0} {1}, {2} {3}',
    'committed by {0}': 'commit eden: {0}', 'Select commit to view changes': 'Değişiklikleri görmek için bir commit seç', 'Local': 'Yerel',
    'Open Repository Version': 'Depodaki sürümü aç', 'Annotate': 'Annotate', 'Get': 'Al', 'Revert Commit': 'Commit\'i revert et',
    'Previous Difference': 'Önceki fark', 'Next Difference': 'Sonraki fark', 'Jump to Source': 'Kaynağa git', 'Diff': 'Diff',
    'No differences': 'Fark yok', '1 difference': '1 fark', '{0} differences': '{0} fark', 'Differences highlighting is off': 'Fark vurgulama kapalı',
    'Files are too large to compare': 'Dosyalar karşılaştırılamayacak kadar büyük', 'Files contents are different': 'Dosya içerikleri farklı',
    'History: {0}': 'Geçmiş: {0}', 'path at this revision: {0}': 'bu sürümdeki yolu: {0}', 'Loading…': 'Yükleniyor…',
    'Show File at Revision': 'Dosyayı bu sürümde göster', 'Show Diff in a New Tab or Window': 'Diff\'i yeni sekmede göster',
    'Show All Affected Files': 'Değişen bütün dosyaları göster', 'Show Commit Timestamp': 'Commit zamanını göster', 'Cherry-Pick': 'Cherry-Pick',
    'Fixup…': 'Fixup…', 'Squash Into…': 'Bunun içine squash et…', 'New Tag…': 'Yeni etiket…',
  });

  const diffPreview = () => L.diffPreview();      // log-preview.js

  // ---------------------------------------------------------------- History: <file>
  Git.views.history = {
    mount(el, o) {
      const path = o.path, name = Git.fileName(path), opts = T.opts;
      let branch = o.rev || 'HEAD';                // the Branch filter: HEAD, a branch, or the commit of History Up to Here
      let entries = [], byId = new Map(), loading = true, failed = null;
      const extra = new Map();                     // commits the Log has not loaded (past its cap): from commit.details
      const slot = Git.content.slot(), detailSlot = Git.content.slot();
      const commitOf = (id) => Git.commit(id) || extra.get(id) || null;
      const current = () => table.selected()[0] || null;
      const entryOf = (id) => byId.get(id) || null;
      const shownBranch = () => (Git.refId(branch) === branch && !Git.isLocal(branch) && !Git.isRemote(branch) ? Git.short(branch) : branch);
      const parentOf = (id) => { const c = commitOf(id); return c && c.parents.length ? c.parents[0] : null; };
      const specOf = (id) => { const e = id && entryOf(id); return e ? { id, path: e.path, oldPath: e.oldPath || null, status: e.status, parent: parentOf(id) } : null; };

      const showDiff = (id) => { const e = entryOf(id); if (e) A.showCommitDiff(id, e.path, { files: null }); };
      /** The file as of the revision against what is in the working tree now. */
      function compareWithLocal(id) {
        const e = entryOf(id);
        if (!e) return;
        Git.open('texts', { id: 'diff:with-local', title: name, path, what: 'Compare with Local',
          left: { title: Git.short(id) + ' ' + Git.fileName(e.path), at: e.status === 'D' ? null : { path: e.path, rev: id }, locked: true, path: e.path },
          right: { title: t('Local'), at: { path, worktree: true }, path } });
      }
      /** Show Diff in a New Tab or Window: the same diff in a tab of its own (the plain Show Diff reuses one tab). */
      function diffInNewTab(id) {
        const e = entryOf(id), parent = parentOf(id);
        if (!e) return;
        Git.open('texts', { id: 'diff:history:' + id + ':' + e.path, title: Git.fileName(e.path) + ' (' + Git.short(id) + ')', path: e.path, what: 'Show Diff',
          left: { title: parent ? Git.short(parent) + ' ' + (e.oldPath || e.path) : '', at: e.status === 'A' || !parent ? null : { path: e.oldPath || e.path, rev: parent }, locked: true, path: e.oldPath || e.path },
          right: { title: Git.short(id) + ' ' + e.path, at: e.status === 'D' ? null : { path: e.path, rev: id }, locked: true, path: e.path } });
      }
      /** Vcs.FileHistory.ContextMenu with Dvcs.FileHistory.ContextMenu (Cherry-Pick) and Git.FileHistory.ContextMenu (Revert
          Commit, Fixup…, Squash Into…, New Tag…) in IntelliJ's order; Create Patch is not built. */
      const menu = (id) => {
        const e = entryOf(id), gone = !e || e.status === 'D';
        const s = L.menuState && L.menuFacts ? L.menuState([id], L.menuFacts()) : null;
        const item = (key, label, action, extra) => Object.assign({ label, disabled: !(s && s[key].on), why: s && !s[key].on && s[key].why ? t(...s[key].why) : undefined, action }, extra || {});
        return [
          { label: t('Copy Revision Number'), shortcut: '⌥⇧⌘C', action: () => A.copyHash([id]) },
          item('cherryPick', t('Cherry-Pick'), () => A.cherryPick([id])), '-',
          { label: t('Get'), disabled: gone || e.path !== path, action: () => A.getFromRevision(id, [e.path]) },
          { label: t('Show File at Revision'), disabled: gone, action: () => A.showFileAt(e.path, id) },
          { label: t('Compare with Local'), action: () => compareWithLocal(id) },
          { label: t('Show Diff'), shortcut: '⌘D', action: () => showDiff(id) },
          { label: t('Show Diff in a New Tab or Window'), disabled: !Git.diffTab, action: () => diffInNewTab(id) },
          { label: t('Show All Affected Files'), shortcut: '⌃⌘A', action: () => A.showAllAffected(id) },
          { label: t('Annotate'), disabled: gone || !Git.annotate, action: () => A.annotate(e.path, { rev: id }) },
          { label: t('Show in Git Log'), action: () => A.showInLog(id) },
          item('revert', t('Revert Commit'), () => A.revert([id])),
          item('fixup', t('Fixup…'), () => A.fixupInto(id, 'fixup')),
          item('squashInto', t('Squash Into…'), () => A.fixupInto(id, 'squash')), '-',
          item('newTag', t('New Tag…'), () => A.newTag(id))];
      };

      const table = T.commitTable({ label: t('History: {0}', name), ids: () => entries.map((e) => e.id), commit: commitOf,
        time: (c) => (opts.commitDate && c.commitTime ? c.commitTime : c.time),
        columns: () => ['date', 'subject', 'author', 'hash'].filter((k) => k === 'subject' || opts[k]),
        extra: (id) => { const e = entryOf(id); return e && e.path !== path ? h('span.glt-path', { title: t('path at this revision: {0}', e.path) }, e.path) : null; },
        empty: () => (loading ? Git.content.loading() : failed ? Git.content.failed(failed) : t('No changes committed.')),
        onSelect: () => { drawBar(); drawDetails(); preview.show(specOf(current())); },
        onActivate: showDiff,
        onContext: (ev, ids, id) => Git.menu(ev, menu(id)) });

      // ---- toolbar: Branch filter · Refresh · Show Diff · View Options
      const bar = h('div.g-toolbar.glt-bar', { role: 'toolbar' });
      function setBranch(value) { branch = value || 'HEAD'; load(); }
      function branchMenu(anchor) {
        const pick = (n) => ({ label: n, checked: n === branch, action: () => setBranch(n) });
        Git.menu(anchor, [pick('HEAD'), '-'].concat(Git.localBranches().map(pick), ['-'], Git.remoteBranches().map(pick)));
      }
      function viewOptions(anchor) {
        const toggle = (key, label, after) => ({ label, checked: !!opts[key], action: () => { opts[key] = !opts[key]; T.saveOpts(); after(); } });
        Git.menu(anchor, [T.header(t('Show')), toggle('commitDate', t('Show Commit Timestamp'), table.render),
          { label: t('Columns'), children: [toggle('author', t('Author'), table.render), toggle('date', t('Date'), table.render), toggle('hash', t('Hash'), table.render)] }, '-',
          T.header(t('Layout')), toggle('details', t('Show Details'), layout), toggle('preview', t('Show Diff Preview'), layout)]);
      }
      function drawBar() {
        const id = current();
        const chip = h('div.gl-filter.set', { dataset: { key: 'branch' } });
        chip.appendChild(h('button.gl-filter-btn', { type: 'button', title: t('Branch') + ': ' + shownBranch(), onclick: () => branchMenu(chip) },
          h('span', t('Branch') + ':'), h('span.gl-filter-value', shownBranch())));
        // IntelliJ shows the × also for HEAD ("Branch: HEAD ×"): it clears to the default, which is HEAD here
        chip.appendChild(h('button.gl-filter-x', { type: 'button', title: t('Clear'), 'aria-label': t('Clear'), onclick: () => setBranch(null) }, Git.icon('closeSmall')));
        Git.clear(bar);
        [chip, h('span.g-toolbar-sep'),
          Git.toolBtn({ icon: 'general/refresh', title: t('Refresh') + '  ⌘R', id: 'glt-refresh', onClick: () => load(true) }),
          Git.toolBtn({ icon: 'vcs/diff', title: t('Show Diff') + '  ⌘D', id: 'glt-diff', disabled: !id, onClick: () => showDiff(id) }),
          Git.toolBtn({ icon: 'vcs/changes', title: t('Show All Affected Files') + '  ⌃⌘A', id: 'glt-affected', disabled: !id, onClick: () => A.showAllAffected(id) }),
          h('span.g-toolbar-sep'),
          Git.toolBtn({ icon: 'general/show', title: t('View Options'), id: 'glt-view', onClick: (e) => viewOptions(e.currentTarget) })].forEach((x) => bar.appendChild(x));
      }

      // ---- the selected revision's message (Show Details)
      const details = h('div.gl-details.glt-hdetails.g-scroll', { tabIndex: 0 });
      function drawDetails() {
        const id = current(), c = commitOf(id);
        Git.clear(details);
        if (!c) { details.appendChild(h('div.gl-dempty', t('Commit message'))); detailSlot.cancel(); return; }
        const when = L.dateTime ? L.dateTime(c.time) : [Git.formatDate(c.time), ''];
        const body = h('div.gl-dbody');
        details.appendChild(h('div.gl-dblock', { dataset: { id } }, h('div.gl-dsubject', c.subject), body,
          h('div.gl-dwho', { title: c.id }, t('{0} {1} on {2} at {3}', Git.short(c.id), Git.author(c.author).name, when[0], when[1]),
            c.committer && c.committer !== c.author ? h('div.gl-dcommitted', t('committed by {0}', Git.author(c.committer).name)) : null)));
        body.hidden = true;
        detailSlot.run(() => Git.content.details(id), { done: (d) => { body.textContent = d.body || ''; body.hidden = !d.body; } });
      }

      // ---- layout: [toolbar / revisions / details] | diff preview
      const preview = diffPreview();
      const left = h('div.glt-hleft.g-col', bar, table.el);
      const root = h('div.gl-root.glt-root.g-grow', { dataset: { path } });
      const dsplit = Git.splitter({ target: details, edge: 'top', min: 56, max: () => Math.max(60, left.clientHeight - 110), key: 'history-details' });
      const psplit = Git.splitter({ target: left, edge: 'right', min: 240, max: () => Math.max(260, root.clientWidth - 220), key: 'history-left' });
      left.appendChild(dsplit);
      left.appendChild(details);
      [left, psplit, preview.el].forEach((x) => root.appendChild(x));
      function layout() {
        details.hidden = dsplit.hidden = !opts.details;
        preview.el.hidden = psplit.hidden = !opts.preview;
        root.classList.toggle('no-preview', !opts.preview);
      }
      /** Commits past the Log's cap are read one by one (the list keeps their place meanwhile). */
      function fillMissing() {
        const missing = entries.map((e) => e.id).filter((id) => !commitOf(id)).slice(0, 200);
        if (!missing.length) return;
        Promise.all(missing.map((id) => Git.content.details(id).then((d) => {
          const key = (p) => p.name + ' <' + p.email + '>';
          [d.author, d.committer].forEach((p) => { if (!R.authors[key(p)]) R.authors[key(p)] = { name: p.name, email: p.email }; });
          extra.set(id, { id, parents: d.parents, author: key(d.author), committer: key(d.committer), time: d.time, commitTime: d.commitTime, subject: d.subject });
        }, () => null))).then(() => { if (root.isConnected) table.render(); });
      }
      /** The revisions from the engine; the list keeps its selection while that revision is still there. */
      function load(again) {
        if (branch !== 'HEAD' && !Git.refId(branch) && !/^[0-9a-f]{40}$/.test(branch)) branch = 'HEAD';
        const rev = branch === 'HEAD' ? undefined : (Git.refId(branch) || branch);
        if (again && Git.store && Git.store.refresh) Git.store.refresh();
        slot.run(() => Git.content.fileHistory(path, rev), {
          loading: () => { loading = true; failed = null; if (!entries.length) table.render(); drawBar(); },
          done: (res) => {
            loading = false; failed = null;
            entries = res.entries || [];
            byId = new Map(entries.map((e) => [e.id, e]));
            table.render();
            if (!current() && entries.length) table.select([entries[0].id], true);
            drawBar(); drawDetails(); preview.show(specOf(current()));
            fillMissing();
          },
          error: (err) => { loading = false; failed = err; entries = []; byId = new Map(); table.render(); drawBar(); drawDetails(); preview.show(null); },
        });
      }
      left.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'r') { e.preventDefault(); load(true); }
        else if (e.metaKey && e.ctrlKey && e.key.toLowerCase() === 'a' && current()) { e.preventDefault(); A.showAllAffected(current()); }
      });

      el.appendChild(root);
      T.solids(table.el);
      layout();
      drawBar();
      drawDetails();
      load();
      if (Git.frame && Git.frame.setTabTitle) Git.frame.setTabTitle('history:' + path + (o.rev ? '@' + o.rev : ''), t('History: {0}', name));
      T.focusSoon(table.el);
      const sub = T.follow(root, (ev) => { if (!ev || ev.reason !== 'changed' || (ev.what || []).indexOf('refs') >= 0) load(); });
      sub.also(Git.on('diff-settings', () => { if (root.isConnected) preview.show(specOf(current())); }));
      sub.also(() => { preview.stop(); table.destroy(); });
      return sub.stop;
    },
  };
})();
