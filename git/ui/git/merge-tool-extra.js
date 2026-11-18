/* The parts of the three-pane merge tool around the panes (split from merge-tool.js):
   Git.mergeTool.compareMenu(anchor, e, s)  the toolbar's ⇄▾ Compare Contents (§18.4 #3): two of Left / Base / Middle /
                                            Right in a two-sided diff over the tool (DiffBundle action.Diff.Compare*)
   Git.mergeTool.detailsLink(sideKey)      the blue "Show Details" link of a side pane (§18.3): the commits that side
                                            brings, "Filter by conflicted file" (GitDefaultMergeDialogCustomizer)
   Git.mergeTool.openWhole(path, e, o)      a conflict the tool cannot merge line by line (binary, deleted on one
                                            side): IntelliJ's binary / one-sided merge — the three versions side by side
                                            with Accept Left / Accept Right (conflict.accept). */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const U = Git.mergeUi, C = Git.mergeCore, A = Git.actions;
  const T = Git.mergeTool;

  Git.addTR({
    'Compare Contents': 'İçerikleri karşılaştır', 'Left and Middle': 'Sol ve orta', 'Middle and Right': 'Orta ve sağ', 'Left and Right': 'Sol ve sağ',
    'Base and Left': 'Taban ve sol', 'Base and Middle': 'Taban ve orta', 'Base and Right': 'Taban ve sağ', 'Base': 'Taban', 'Middle': 'Orta',
    'Show Details': 'Ayrıntıları göster', 'Filter by conflicted file': 'Çakışan dosyaya göre süz', 'Collecting Commits Details…': 'Commit ayrıntıları toplanıyor…',
    'Hash': 'Hash', 'Subject': 'Konu', 'Author': 'Yazar', 'Author time': 'Yazılma zamanı', 'No commits': 'Commit yok',
    'Binary file viewer': 'İkili dosya görüntüleyici', 'Files contents are different': 'Dosya içerikleri farklı', "File doesn't exist": 'Dosya yok',
    'Accept Left': 'Soldakini al', 'Accept Right': 'Sağdakini al', 'Cancel': 'Vazgeç', 'Result': 'Sonuç',
  });

  // ---------------------------------------------------------------- Compare Contents
  /** `e`: the tool's session (e.read.base, e.sides), `s`: the merge state (left, right, result). */
  T.compareMenu = function (anchor, e, s, path) {
    const text = { L: C.join(s.left), M: C.text(s), R: C.join(s.right), B: e.read.base && e.read.base.text != null ? e.read.base.text : '' };
    const name = { L: t('Left'), M: t('Middle'), R: t('Right'), B: t('Base') };
    const pair = (label, a, b) => ({ label: t(label), action: () => U.textsOver(t(label) + ' — ' + path, path,
      { left: { title: name[a], text: text[a], locked: true }, right: { title: name[b], text: text[b], locked: true } }) });
    Git.menu(anchor, [pair('Left and Middle', 'L', 'M'), pair('Middle and Right', 'M', 'R'), pair('Left and Right', 'L', 'R'), '-',
      pair('Base and Left', 'B', 'L'), pair('Base and Middle', 'B', 'M'), pair('Base and Right', 'B', 'R')]);
  };

  // ---------------------------------------------------------------- Show Details
  /** The tip of each stage of the stopped operation: yours = stage 2 (HEAD), theirs = stage 3 (MERGE_HEAD, the commit applied). */
  function tips() {
    const op = Git.repo.op;
    return op && op.yours && op.theirs ? { yours: op.yours.id, theirs: op.theirs.id } : null;
  }
  /** The link for the pane that shows stage `side` ('yours' | 'theirs'); null when nothing names the two commits. */
  T.detailsLink = function (side, path) {
    const ends = tips();
    if (!ends || !ends[side]) return null;
    let pop = null;
    const link = h('button.g-link.gm-details', { type: 'button', dataset: { side }, onmousedown: (ev) => ev.preventDefault(),
      onclick: () => { if (pop) pop.close(); else open(); } }, t('Show Details'));
    function open() {
      let filter = true, all = null, touching = null;
      const list = h('div.gm-details-list', Git.content.loading(t('Collecting Commits Details…')));
      const box = Git.checkbox({ id: 'gm-details-filter-' + side, label: t('Filter by conflicted file'), checked: true, onChange: (v) => { filter = v; draw(); } });
      pop = Git.popup({ anchor: link, width: 520, className: 'gm-details-pop', content: h('div.gm-details', box, list), onClose: () => { pop = null; } });
      pop.keepFor = link;
      const other = side === 'yours' ? ends.theirs : ends.yours;
      Promise.all([Git.content.compareBranches(ends[side], other), Git.content.fileHistory(path, ends[side]).catch(() => ({ entries: [] }))]).then(([cmp, hist]) => {
        all = cmp.onlyA || [];
        touching = new Set((hist.entries || []).map((x) => x.id));
        draw();
      }, (err) => { if (pop) Git.clear(list).appendChild(Git.content.failed(err)); });
      function draw() {
        if (!all || !pop) return;
        const ids = filter ? all.filter((id) => touching.has(id)) : all;
        Git.clear(list);
        if (!ids.length) { list.appendChild(h('div.g-dim.gm-details-empty', t('No commits'))); pop.place(); return; }
        list.appendChild(h('div.gm-details-row.head', h('span', t('Hash')), h('span', t('Subject')), h('span', t('Author')), h('span', t('Author time'))));
        ids.slice(0, 500).forEach((id) => {
          const row = h('div.gm-details-row', { dataset: { id } }, h('span.g-mono', Git.short(id)), h('span', '…'), h('span'), h('span'));
          list.appendChild(row);
          const c = Git.commit(id);
          const fill = (subject, author, time) => { row.children[1].textContent = subject; row.children[2].textContent = author; row.children[3].textContent = Git.formatDate(time); };
          if (c) fill(c.subject, Git.author(c.author).name, c.time);
          else Git.content.details(id).then((d) => fill(d.subject, d.author.name, d.time), () => null);
        });
        pop.place();
      }
    }
    return link;
  };

  // ---------------------------------------------------------------- binary / one-sided conflicts
  /** "Merge Revisions for <path>" for a file the panes cannot merge: each version's state and the whole-file choices. */
  T.openWhole = function (path, e, o) {
    const info = U.operation(), read = e.read, sides = e.sides;
    const L = sides.flip ? read.theirs : read.yours, Rt = sides.flip ? read.yours : read.theirs;
    // a missing side says so; a binary one is IntelliJ's binary viewer note; a text side shows its text
    const body = (c) => (!c ? h('div.g-dim', t("File doesn't exist")) : read.binary || c.text == null ? h('div.g-dim', t('Binary file viewer'))
      : h('pre.gm-whole-text', c.text));
    const pane = (cls, title, c) => h('div.gm-whole-pane.' + cls, h('div.gm-whole-head', cls === 'mid' ? null : Git.icon('general/locked'), h('span', title)),
      h('div.gm-whole-body', cls === 'mid' ? h('div.g-dim', t('Files contents are different')) : body(c)));
    let busy = false;
    const take = (which) => {
      if (busy) return;
      busy = true;
      A.acceptSide([path], which === 'L' ? sides.left.side : sides.right.side).then((res) => {
        busy = false;
        if (!res) return;
        dlg.close();
        if (T.forget) T.forget(path);
        if (o && o.onClose) o.onClose();
      });
    };
    const dlg = Git.dialog({ title: t('Merge Revisions for {0}', Git.repo.root + '/' + path), width: 900, height: 360, className: 'gm-tool-dlg gm-whole-dlg',
      content: h('div.gm-whole', pane('left', info.left.title(), L), pane('mid', [h('b', t('Result')), ' ', h('span.g-dim', path)], read.worktree), pane('right', info.right.title(), Rt)),
      left: [Git.btn(t('Accept Left'), { id: 'gm-accept-left', onClick: () => take('L') }), Git.btn(t('Accept Right'), { id: 'gm-accept-right', onClick: () => take('R') })],
      buttons: [{ label: t('Cancel'), id: 'gm-whole-cancel', onClick: () => { if (o && o.onClose) o.onClose(); } }] });
    return dlg;
  };
})();
