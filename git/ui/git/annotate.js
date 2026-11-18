/* Annotate with Git Blame, in the file view (fileview.js). IntelliJ's annotation gutter (B §16): for every
   line the date and the author of the commit that last changed it, tinted by the commit's age (VCS_ANNOTATIONS_COLOR_1..5
   by order, newest first); lines of the file's current revision (the last commit that changed the file, `annotate`'s
   `current`) bold with "*"; lines not committed yet stay empty ("Not committed yet"). Hovering shows the commit (hash,
   author, date, message) and lights up its other lines; a click shows the commit in the Log (Git.actions.showInLog).
   The gutter's context menu (B §16.4–16.5, D §6.11): Annotate Revision, Annotate Previous Revision, Copy Revision
   Number, View ▸ (Revision, Date, Author, Commit number, Names ▸), Colors ▸ (Author, Order, Hide), Options ▸ (Ignore
   Whitespaces -w, Detect Movements Within File -M, Detect Movements Across Files -C, Show Commit Timestamp), Close
   Annotations. View/Colors/Options are kept in prefs `annotate.opts`. The blame is the engine's `annotate`.
     Git.annotate.toggle(path, { rev }?) · open(path, { rev, line }) (Annotate Revision) · isOn(key) · mark(key, on)
     · load(view) · cell(view, i) · width(view) · hover(view, ev) · click(view, ev) · menu(view, ev) · opts   (key: path, or path@rev) */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const on = new Set();
  let tip = null, tipTimer = 0, seq = 0;

  Git.addTR({ 'Annotate with Git Blame': 'Git Blame ile annotate et', 'Close Annotations': 'Annotation\'ları kapat',
    'Author: {0}': 'Yazar: {0}', 'Date: {0}': 'Tarih: {0}', 'commit {0}': 'commit {0}', 'Not committed yet': 'Henüz commit edilmedi',
    'Annotate': 'Annotate', 'Show in Git Log': 'Git Log\'da göster',
    'Annotate Revision': 'Revizyonu annotate et', 'Annotate Previous Revision': 'Önceki revizyonu annotate et', 'Copy Revision Number': 'Commit hash\'ini kopyala',
    'View': 'Görünüm', 'Revision': 'Revizyon', 'Date': 'Tarih', 'Author': 'Yazar', 'Commit number': 'Commit numarası', 'Names': 'Adlar',
    'Initials': 'Baş harfler', 'First Name': 'Ad', 'Last Name': 'Soyad', 'Full Name': 'Tam ad', 'Email': 'E-posta',
    'Colors': 'Renkler', 'Order': 'Sıra', 'Hide': 'Gizle', 'Options': 'Seçenekler', 'Ignore Whitespaces': 'Boşlukları yok say',
    'Detect Movements Within File': 'Dosya içindeki taşımaları bul', 'Detect Movements Across Files': 'Dosyalar arası taşımaları bul',
    'Show Commit Timestamp': 'Commit zamanını göster' });

  // ---------------------------------------------------------------- options (prefs annotate.opts)
  const DEFAULTS = { revision: false, date: true, author: true, number: false, names: 'full', colors: 'order',
    ignoreWhitespace: false, movesInFile: false, movesAcrossFiles: false, commitTime: false };
  const O = (Git.annotate && Git.annotate.opts) || Object.assign({}, DEFAULTS, (() => { try { return Git.host.prefs.get('annotate.opts', null) || {}; } catch (e) { return {}; } })());
  const save = () => { try { Git.host.prefs.set('annotate.opts', O); } catch (e) { /* not kept */ } };

  const p2 = (n) => String(n).padStart(2, '0');
  /** The annotation's short date (IntelliJ: the locale's short date). */
  const shortDate = (ms) => {
    const d = new Date(ms);
    return Git.dateOrder() === 'dmy' ? p2(d.getDate()) + '.' + p2(d.getMonth() + 1) + '.' + String(d.getFullYear()).slice(2)
      : (d.getMonth() + 1) + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(2);
  };
  /** ShortNameType: Initials, First Name, Last Name, Full Name, Email. */
  function shortName(a) {
    const name = (a.name || '').trim(), parts = name.split(/\s+/).filter(Boolean);
    if (O.names === 'initials') return parts.map((x) => x[0].toUpperCase()).join('');
    if (O.names === 'first') return parts[0] || '';
    if (O.names === 'last') return parts[parts.length - 1] || '';
    if (O.names === 'email') return a.email || '';
    return name;
  }
  const when = (c) => (O.commitTime ? c.commitTime || c.time : c.time);

  /** Turns the engine's answer into what the gutter draws: per line { id }, per commit its tint bucket, number and texts. */
  function model(res) {
    const commits = res.commits || {}, ids = Object.keys(commits);
    ids.sort((a, b) => (commits[b].commitTime || commits[b].time) - (commits[a].commitTime || commits[a].time));
    const rank = new Map(ids.map((id, i) => [id, Math.min(4, Math.floor(i * 5 / Math.max(1, ids.length)))]));
    const number = new Map(ids.map((id, i) => [id, ids.length - i]));      // Commit number: 1 = the oldest commit shown
    const authors = new Map();
    ids.forEach((id) => { const k = commits[id].author.email || commits[id].author.name; if (!authors.has(k)) authors.set(k, authors.size % 5); });
    return { lines: res.lines.map((l) => l.id), commits, rank, number, authors, current: res.current || null, path: res.path };
  }
  /** The columns shown, in IntelliJ's order, each with its width in characters. */
  function columns(b) {
    const ids = Object.keys(b.commits), cols = [];
    if (O.number) cols.push({ w: String(ids.length).length, text: (id) => String(b.number.get(id)) });
    if (O.revision) cols.push({ w: 8, text: (id) => Git.short(id).slice(0, 8) });
    if (O.date) cols.push({ w: 8, text: (id) => shortDate(when(b.commits[id])) });
    if (O.author) {
      let w = 0;
      ids.forEach((id) => { w = Math.max(w, shortName(b.commits[id].author).length); });
      cols.push({ w: Math.min(w, 24), text: (id) => shortName(b.commits[id].author).slice(0, 24) });
    }
    return cols;
  }

  function draw(v) { if (v && v.draw) v.draw(true); }
  const keyOf = (path, o) => (Git.fileView ? Git.fileView.keyOf(path, o && o.rev ? Git.refId(o.rev) || o.rev : null) : path);
  const views = () => Array.from(on).map((k) => Git.fileView && Git.fileView.tab(k)).filter(Boolean);
  function reloadAll() { views().forEach((v) => { if (v.root) Git.annotate.load(v); }); }
  function redrawAll() { views().forEach((v) => { if (v.blame) { v.blame.cols = null; draw(v); } }); }

  Git.annotate = {
    opts: O,
    /** `key`: the path (work tree file) or path@rev (a committed version). */
    isOn: (key) => on.has(key),
    mark(key, value) { if (value) on.add(key); else on.delete(key); },
    /** Annotate a file (or, with `o.rev`, its version in that commit); a second call closes the annotations. */
    toggle(path, o) {
      const key = keyOf(path, o), v = Git.fileView && Git.fileView.tab(key);
      if (on.has(key)) {
        on.delete(key);
        if (v) { v.blame = null; Git.annotate.hover(v, null); draw(v); }
        return false;
      }
      on.add(key);
      if (Git.fileView) Git.fileView.open(path, { rev: o && o.rev, line: o && o.line });   // brings the view forward (opens it when needed)
      const now = Git.fileView && Git.fileView.tab(key);
      if (now && now.root && now.lines.length) Git.annotate.load(now);
      return true;
    },
    /** Opens the file (at `o.rev`) annotated: Annotate Revision of the History tab. */
    open(path, o) {
      const key = keyOf(path, o);
      on.add(key);
      if (Git.fileView) Git.fileView.open(path, { rev: o && o.rev, line: o && o.line, annotate: true });
    },
    /** Reads the annotation (of the work tree file, or of the view's revision) with the Options; turns itself off when git cannot annotate the file. */
    load(v) {
      const my = ++seq, path = v.path, key = v.key;
      v.blameSeq = my;
      const params = { repo: Git.repo.root, path, ignoreWhitespace: !!O.ignoreWhitespace, movesInFile: !!O.movesInFile, movesAcrossFiles: !!O.movesAcrossFiles };
      if (v.rev) params.rev = v.rev;
      return Git.backend.call('annotate', params).then((res) => {
        if (v.blameSeq !== my || !on.has(key) || !v.root) return;
        v.blame = model(res);
        draw(v);
        Git.emit('annotated', { path });
      }, (err) => {
        if (v.blameSeq !== my) return;
        on.delete(key);
        v.blame = null;
        draw(v);
        if (Git.actions && Git.actions.errorNotice) Git.actions.errorNotice(err, t('Annotate'));
      });
    },
    width(v) {
      if (!v.blame) return 0;
      if (!v.blame.cols) v.blame.cols = columns(v.blame);
      return v.blame.cols.reduce((n, c) => n + c.w + 1, 0) + 2;
    },
    cell(v, i) {
      const b = v.blame, id = b.lines[i] || null;
      if (!id) return h('span.fv-blame.none', { title: t('Not committed yet') });
      if (!b.cols) b.cols = columns(b);
      const c = b.commits[id], last = !!b.current && id === b.current;
      const tint = O.colors === 'hide' ? '' : 'c' + (O.colors === 'author' ? b.authors.get(c.author.email || c.author.name) : b.rank.get(id));
      const text = b.cols.map((col) => col.text(id).padEnd(col.w)).join(' ');
      return h('span.fv-blame', { class: tint + (last ? ' last' : '') + (v.hoverId === id ? ' same' : ''), dataset: { id } }, text + (last ? ' *' : '  '));
    },
    hover(v, e) {
      const cell = e && e.target.closest && e.target.closest('.fv-blame');
      const id = cell && cell.dataset.id ? cell.dataset.id : null;
      if (!id) {
        if (!tip) { if (v.hoverId) { v.hoverId = null; draw(v); } return; }
        clearTimeout(tipTimer);
        tipTimer = setTimeout(() => hideTip(v), 250);
        return;
      }
      clearTimeout(tipTimer);
      if (v.hoverId === id && tip) return;
      v.hoverId = id;
      showTip(v, id, cell);
      draw(v);                                  // the commit's other lines light up
    },
    click(v, e) {
      const cell = e.target.closest && e.target.closest('.fv-blame');
      if (!cell || !cell.dataset.id || e.button) return;
      hideTip(v);
      if (Git.actions.showInLog) Git.actions.showInLog(cell.dataset.id);
    },
    /** The annotation gutter's context menu for the line under the pointer. */
    menu(v, e) {
      hideTip(v);
      const cell = e.target.closest && e.target.closest('.fv-blame');
      const id = cell && cell.dataset.id ? cell.dataset.id : null;
      const c = id ? v.blame.commits[id] : null, prev = c && c.previous;
      const line = +((e.target.closest('.fv-row') || {}).dataset || {}).line || null;
      const set = (name, value, reload) => () => { O[name] = value; save(); if (reload) reloadAll(); else redrawAll(); };
      const flip = (name, reload) => set(name, !O[name], reload);
      const nameItem = (value, label) => ({ label: t(label), checked: O.names === value, action: set('names', value) });
      Git.menu(e, [
        { label: t('Annotate Revision'), disabled: !c, action: () => Git.annotate.open(c.path || v.path, { rev: id, line }) },
        { label: t('Annotate Previous Revision'), disabled: !prev, action: () => Git.annotate.open(prev.path || v.path, { rev: prev.id }) },
        { label: t('Copy Revision Number'), shortcut: '⌥⇧⌘C', disabled: !id, action: () => Git.copy(id) },
        '-',
        { label: t('View'), children: [
          { label: t('Revision'), checked: O.revision, action: flip('revision') },
          { label: t('Date'), checked: O.date, action: flip('date') },
          { label: t('Author'), checked: O.author, action: flip('author') },
          { label: t('Commit number'), checked: O.number, action: flip('number') },
          '-',
          { label: t('Names'), children: [nameItem('initials', 'Initials'), nameItem('first', 'First Name'), nameItem('last', 'Last Name'),
            nameItem('full', 'Full Name'), nameItem('email', 'Email')] }] },
        { label: t('Colors'), children: [
          { label: t('Author'), checked: O.colors === 'author', action: set('colors', 'author') },
          { label: t('Order'), checked: O.colors === 'order', action: set('colors', 'order') },
          { label: t('Hide'), checked: O.colors === 'hide', action: set('colors', 'hide') }] },
        { label: t('Options'), children: [
          { label: t('Ignore Whitespaces'), checked: O.ignoreWhitespace, action: flip('ignoreWhitespace', true) },
          { label: t('Detect Movements Within File'), checked: O.movesInFile, action: flip('movesInFile', true) },
          { label: t('Detect Movements Across Files'), checked: O.movesAcrossFiles, action: flip('movesAcrossFiles', true) },
          { label: t('Show Commit Timestamp'), checked: O.commitTime, action: flip('commitTime') }] },
        '-',
      ].concat(Git.inlineBlame ? [Git.inlineBlame.item()] : [], [
        { label: t('Close Annotations'), action: () => Git.annotate.toggle(v.path, v.rev ? { rev: v.rev } : null) },
      ]));
    },
  };

  function hideTip(v) {
    clearTimeout(tipTimer);
    if (tip) { tip.remove(); tip = null; }
    if (v && v.hoverId) { v.hoverId = null; draw(v); }
  }
  function showTip(v, id, cell) {
    if (tip) tip.remove();
    const c = v.blame.commits[id];
    const msg = h('div.fv-tip-msg', c.subject);
    tip = h('div.fv-tip.g-root', { role: 'tooltip', onmouseenter: () => clearTimeout(tipTimer), onmouseleave: () => { tipTimer = setTimeout(() => hideTip(v), 200); } },
      h('div', t('commit {0}', ''), h('button.g-link.g-mono#fv-tip-commit', { type: 'button', title: t('Show in Git Log'), onclick: () => { hideTip(v); Git.actions.showInLog(id); } }, id)),
      h('div', t('Author: {0}', (c.author.name || '') + ' <' + (c.author.email || '') + '>')),
      h('div', t('Date: {0}', Git.formatDate(c.time))),
      msg);
    (document.getElementById('g-layer') || document.body).appendChild(tip);
    const r = cell.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(r.left + 12, window.innerWidth - tip.offsetWidth - 12)) + 'px';
    tip.style.top = Math.max(8, r.bottom + 4 + tip.offsetHeight > window.innerHeight - 8 ? r.top - tip.offsetHeight - 4 : r.bottom + 4) + 'px';
    // the full message comes with commit.details
    Git.content.details(id).then((d) => { if (tip && msg.isConnected) msg.textContent = d.subject + (d.body ? '\n\n' + d.body : ''); }, () => null);
  }
})();
