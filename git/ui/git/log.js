/* The Log tab of the Git tool window (IntelliJ's Git ▸ Log).
   Three panes: Branches (log-branches.js) | Commits (this file: the commit table with the graph and the ref labels, the
   selection and the keyboard) | Changed Files over Commit Details (log-details.js). The toolbar and its filters are
   log-filters.js, the commit context menu log-menu.js, the labels log-labels.js, which commits are shown log-view.js.
   Narrow and medium Log roots stack the panes and turn the Branches pane into a drawer (log-layout.js).
   Git.views.log.mount(el) · Git.log.reveal(idOrRef) · Git.log.setBranchFilter(name | [names] | null) · Git.log.selected()
   · Git.log.select(ids) · Git.log.refresh() · Git.log.stats(); a new selection is announced with
   Git.emit('select-commit', { ids }).
   L.core (for the sibling files): { state, inst(), render(), schedule(), select(ids, anchor, lead), reveal(id),
   parentOf(id), childOf(id), cherryPick(), canCherryPick(ids) } */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = Git.t;
  const R = Git.repo, A = Git.actions;
  const L = (Git.logUI = Git.logUI || {});
  const ROW = 26;                                  // --g-log-row
  const SUBJECT = 150;                             // the subject keeps this much; a narrower table squeezes the other columns (git-log.css)
  const NS = 'http://www.w3.org/2000/svg';
  const CAP = 100000;                              // the store's commit list cap (ARCHITECTURE §5.2)

  Git.addTR({
    'No commits matching filters': 'Filtrelere uyan commit yok', 'Reset filters': 'Filtreleri sıfırla', 'No commits yet': 'Henüz commit yok',
    'Loading commits…': 'Commit\'ler yükleniyor…', 'Jump to "{0}" by {1} on {2} at {3}': '"{0}" commit\'ine git ({1}, {2} {3})',
    "{0} doesn't match the filters": '{0} filtrelere uymuyor', "Commit '{0}'": "'{0}' commit'i", 'View and reset filters': 'Göster ve filtreleri sıfırla',
    'Showing the first {0} commits': 'İlk {0} commit gösteriliyor',
    'Commit {0} is not loaded: the Log shows the first {1} commits': '{0} commit\'i yüklü değil: Log ilk {1} commit\'i gösteriyor',
  });

  const opts = L.opts;
  const state = { filter: { text: '', regex: false, matchCase: false, branch: null, user: null, date: null, paths: null }, sel: [], selSet: new Set(), anchor: null, lead: null, reveal: null };
  let inst = null;                                 // the mounted view
  const authorText = (c) => Git.author(c.author).name + (c.committer && c.committer !== c.author ? '*' : '');
  /** The Date column: the author's time, or the commit time with View Options ▸ Commit Timestamp (PREFER_COMMIT_DATE). */
  const when = (c) => (opts.commitDate && c.commitTime ? c.commitTime : c.time);
  const capText = () => CAP.toLocaleString(Git.locale());

  // ---------------------------------------------------------------- which commits are shown (log-view.js)
  function compute() {
    const f = state.filter;
    if (f.branch) { f.branch = f.branch.filter((n) => L.filters.validBranch(n)); if (!f.branch.length) { f.branch = null; L.filters.title(); } }
    const view = L.computeView(f, { longEdges: opts.longEdges });
    state.badRegex = view.badRegex;
    return view;
  }

  // ---------------------------------------------------------------- the table (a virtual list: only the rows in view exist)
  /** Opaque versions of the row backgrounds: the HEAD node's ring and the label icons are filled with what is under them. */
  function solids(el) {
    const probe = h('span');
    el.appendChild(probe);
    const read = (v) => {
      probe.style.color = v;
      const m = (getComputedStyle(probe).color.match(/[\d.]+/g) || []).map(Number);
      return m.length >= 3 ? [m[0], m[1], m[2], m.length > 3 ? m[3] : 1] : null;
    };
    const panel = read('var(--g-panel)');
    const over = (base, top) => (top ? [0, 1, 2].map((k) => top[k] * top[3] + base[k] * (1 - top[3])) : base);
    const set = (name, c) => el.style.setProperty(name, 'rgb(' + c.slice(0, 3).map(Math.round).join(',') + ')');
    if (panel) {
      const hover = read('var(--g-hover)'), cur = over(panel, read('var(--g-current-branch-row)'));
      set('--gl-solid', panel);
      set('--gl-solid-hover', over(panel, hover));
      set('--gl-solid-cur', cur);
      set('--gl-solid-cur-hover', over(cur, hover));
      set('--gl-solid-sel', over(panel, read('var(--g-select)')));
      set('--gl-solid-idle', over(panel, read('var(--g-select-idle)')));
    }
    probe.remove();
  }
  L.solids = solids;
  /** Column widths and highlight sets for one render. Widths come from the authors table and a sample of dates,
      not from every row (50 000 rows would take a measuring pass of their own). */
  function metrics(view) {
    const table = inst.table, cs = getComputedStyle(table), f = state.filter;
    const size = parseFloat(cs.fontSize) || 13;
    const m = { font: size + 'px ' + cs.fontFamily, bold: '600 ' + size + 'px ' + cs.fontFamily, refFont: size - 1 + 'px ' + cs.fontFamily };
    // the narrow arrangement gives the subject the row: no Author column, a compact date instead of the Date column
    const narrow = inst.root.classList.contains('narrow');
    m.cols = { author: opts.author && !narrow, date: opts.date && !narrow, when: opts.date && narrow, hash: opts.hash };
    m.now = Date.now();
    m.yesterday = t('Yesterday');
    let aw = 0, dw = 0;
    if (m.cols.author) Object.keys(R.authors).forEach((k) => { aw = Math.max(aw, L.measure(R.authors[k].name + '*', m.bold)); });
    if (m.cols.date || m.cols.when) {
      const text = m.cols.when ? (ms) => L.compactDate(ms, m.now, Git.dateOrder(), m.yesterday) : (ms) => Git.formatDate(ms);
      const font = m.cols.when ? '12px ' + cs.fontFamily : m.font;
      const sample = view.order.slice(0, 400);
      sample.forEach((id) => { const c = Git.commit(id); if (c) dw = Math.max(dw, L.measure(text(when(c)), font)); });
      dw = Math.max(dw, L.measure(text(new Date(2020, 11, 28, 23, 58).getTime()), font));
      if (m.cols.when) dw = Math.max(dw, L.measure(m.yesterday + ' 23:58', font), L.measure('28.12 23:58', font)) + 2;   // digits are tabular there
    }
    const author = m.cols.author ? Math.min(300, Math.ceil(aw)) + 10 : 0, date = m.cols.date || m.cols.when ? Math.ceil(dw) + 14 : 0;
    const hash = opts.hash ? Math.ceil(L.measure('e'.repeat(8), m.bold)) + 14 : 0;
    table.style.setProperty('--gl-w-author', author + 'px');
    table.style.setProperty('--gl-w-date', date + 'px');
    table.style.setProperty('--gl-w-hash', hash + 'px');
    m.subject = Math.max(SUBJECT, table.clientWidth - 17 - author - date - hash);
    m.mine = opts.hlMine && Object.keys(R.authors).length > 1 && !(f.user && f.user.me);
    // The current branch is not marked when the log shows nothing but that branch.
    const own = f.branch && f.branch.length === 1 && (f.branch[0] === 'HEAD' || f.branch[0] === Git.currentBranch());
    m.current = opts.hlCurrent && !own && Git.headId() ? Git.closure(Git.headId()) : new Set();
    return m;
  }
  function buildRow(i) {
    const view = inst.view, m = inst.m;
    const id = view.order[i], c = Git.commit(id), lr = view.graph.row(i);
    // The view can be one step behind the store while the repository is being switched or reloaded (the host moved to
    // another workspace): a row whose commit is gone is drawn empty; the 'log' event that follows rebuilds the view.
    if (!c) return h('div.gl-row', { role: 'row', dataset: { id: id || '' } });
    const mine = m.mine && Git.isMine(c), boldText = mine && !m.cols.author;
    inst.painted++;
    const svg = Git.graphPaint.row(view.graph, i, ROW);
    Array.prototype.forEach.call(svg.querySelectorAll('.g-graph-stub[data-target]'), (stub) => {
      const target = Git.commit(stub.getAttribute('data-target'));
      const title = document.createElementNS(NS, 'title');
      const at = target && L.dateTime ? L.dateTime(target.time) : null;
      title.textContent = target ? t('Jump to "{0}" by {1} on {2} at {3}', target.subject, Git.author(target.author).name, at ? at[0] : '', at ? at[1] : '')
        : t('Commit {0} is not loaded: the Log shows the first {1} commits', Git.short(stub.getAttribute('data-target')), capText());
      stub.appendChild(title);
    });
    const refs = Git.refsAt(id);
    let labels = null;
    if (refs.length) {
      const graph = Git.graphPaint.indent(lr, ROW), both = m.subject - graph;
      const free = both - graph - L.measure(c.subject, boldText ? m.bold : m.font);
      const room = opts.compact ? Math.min(free, both / 3) : Math.max(free, both / 2, both - 80);
      labels = L.labelBlock(L.refGroups(refs, opts.compact, opts.tagNames), Math.max(0, Math.floor(room)), m.refFont, refs.map((r) => r.name).join('\n'));
    }
    const sel = state.selSet.has(id);
    const row = h('div.gl-row', { role: 'row', 'aria-selected': String(sel), dataset: { id },
      class: (m.current.has(id) ? 'cur ' : '') + (opts.hlMerge && c.parents.length > 1 ? 'merge ' : '') + (sel ? 'sel' : '') },
      h('div.gl-subject', { class: labels && opts.labelsLeft ? 'labels-left' : '' }, svg, labels && opts.labelsLeft ? labels : null,
        h('span.gl-text', { class: (boldText ? 'bold ' : '') + (labels ? 'clip' : ''), title: c.subject }, c.subject), labels && !opts.labelsLeft ? labels : null));
    if (m.cols.author) row.appendChild(h('div.gl-col.gl-author', { class: mine ? 'bold' : '' }, authorText(c)));
    if (m.cols.date) row.appendChild(h('div.gl-col.gl-date', Git.formatDate(when(c))));
    if (m.cols.when) row.appendChild(h('div.gl-col.gl-date.gl-when', L.compactDate(when(c), m.now, Git.dateOrder(), m.yesterday)));
    if (opts.hash) row.appendChild(h('div.gl-col.gl-hash', Git.short(id)));
    return row;
  }
  function renderTable() {
    const v = inst;
    if (!v) return;
    v.dirty = false;
    const t0 = performance.now();
    const branch = L.filters.value('branch');
    L.requestFilter(state.filter, () => { if (inst === v) schedule(); });
    const view = compute();
    if (view.waiting && v.view) { if (v.search) v.search.classList.toggle('bad', !!state.badRegex); return; }   // keep showing the last answer
    v.view = view;
    if (L.filters.value('branch') !== branch) L.filters.build(v);          // the filtered branch is gone
    v.width = v.table.clientWidth;
    if (!v.placeDone) restorePlace(v, view);
    // the selection stays on the commits that are still shown (a rebase may have replaced them)
    const kept = L.keepSelection(state.sel, state.anchor, state.lead, view.index);
    state.sel = kept.sel; state.anchor = kept.anchor; state.lead = kept.lead;
    state.selSet = new Set(state.sel);
    if (v.search) v.search.classList.toggle('bad', !!state.badRegex);
    const loading = !R.log.complete || view.waiting;
    const filtered = !!(state.filter.text || state.filter.branch || state.filter.user || state.filter.date || state.filter.paths);
    Git.clear(v.empty);
    v.empty.hidden = view.order.length > 0 || loading;
    if (!view.order.length && !loading) {
      if (filtered) v.empty.append(t('No commits matching filters'), h('button.g-link', { type: 'button', onclick: () => L.filters.reset() }, t('Reset filters')));
      else v.empty.append(t('No commits yet'));
    }
    statusLine(v, loading);
    v.m = metrics(view);
    // the rows are drawn again only when they would differ (the same view object: same commits, refs and HEAD; same
    // columns, options and language): a busy repository renders often, rows replaced under the wheel stall scrolling
    const sig = [Git.lang, JSON.stringify(opts), v.table.style.cssText, v.m.subject, v.m.mine, v.m.current.size, R.authors ? Object.keys(R.authors).length : 0].join('|');
    if (view !== v.drawnView || sig !== v.drawnSig) { v.drawnView = view; v.drawnSig = sig; v.list.refresh(); }
    revealPending();
    selectionChanged();
    v.stats = { rows: view.order.length, computeMs: view.ms, renderMs: Math.round(performance.now() - t0), loaded: R.log.order.length, complete: R.log.complete };
    if (view.order.length && !api.firstPaintAt) api.firstPaintAt = performance.now();
    if (v.filterAt) { v.stats.filterMs = Math.round(performance.now() - v.filterAt); if (!view.waiting) v.filterAt = 0; }
    Git.emit('log-rendered', v.stats);
  }
  /** A thin line under the table: "Loading commits…" once a wait has lasted LATE ms (a short wait shows nothing), or
      the cap (the store keeps the first 100 000 commits). */
  const LATE = 400;
  function statusLine(v, loading) {
    const now = performance.now();
    if (!loading) { v.loadingSince = 0; clearTimeout(v.loadingTimer); v.loadingTimer = 0; } else if (!v.loadingSince) v.loadingSince = now;
    const late = loading && now - v.loadingSince >= LATE, cap = !loading && !!R.log.truncated;
    if (loading && !late && !v.loadingTimer) {
      v.loadingTimer = setTimeout(() => { v.loadingTimer = 0; if (inst === v && v.view) statusLine(v, !R.log.complete || !!v.view.waiting); }, LATE - (now - v.loadingSince) + 5);
    }
    v.status.hidden = !late && !cap;
    v.status.classList.toggle('cap', cap);
    v.status.textContent = late ? t('Loading commits…') : cap ? t('Showing the first {0} commits', capText()) : '';
  }
  /** The place remembered for this repository (log-place.js), once per mount: the selection when its commits are still
      in the log (a selection or a reveal already there wins), the scroll offset once the table has a height. Nothing is
      written before this ran, so a fresh mount does not overwrite what it is about to restore. */
  function restorePlace(v, view) {
    if (!R.root || !L.place || state.sel.length || state.reveal) { v.placeDone = true; return; }
    if (!view.order.length) return;
    const got = L.place.pick(L.place.read(R.root), view.index, R.log.complete && !view.waiting);
    if (got === 'wait') return;                                 // the rest of the log may hold them
    v.placeDone = true;
    if (got) { state.sel = got.sel; state.anchor = got.anchor; state.lead = got.lead; v.scrollTo = got.top; }
  }
  /** A commit revealed while the tab was hidden is scrolled to once the table has a size; so is a remembered offset. */
  function revealPending() {
    const v = inst;
    if (v.scrollTo != null && v.table.clientHeight && v.view) { v.table.scrollTop = v.scrollTo; v.scrollTo = null; }
    if (!state.reveal || !v.table.clientHeight || !v.view) return;
    if (v.view.index.has(state.reveal)) show(state.reveal, true);
    state.reveal = null;
  }
  function schedule() {
    if (!inst || inst.dirty) return;
    inst.dirty = true;
    const v = inst;
    Promise.resolve().then(() => { if (inst === v && v.dirty && v.root.isConnected) renderTable(); });
  }
  /** Scrolls row `id` into view; `center` puts a row that was out of view in the middle (IntelliJ's jump). */
  function show(id, center) {
    const v = inst, i = v.view.index.get(id);
    if (i == null) return;
    const vis = v.list.visibleRange();
    const inView = i >= vis.from && i < vis.to;
    v.list.scrollTo(i, { align: center && !inView ? 'center' : 'nearest' });
  }

  // ---------------------------------------------------------------- selection
  function selectionChanged() {
    const v = inst;
    v.list.each((row, i) => { const on = state.selSet.has(v.view.order[i]); row.classList.toggle('sel', on); row.setAttribute('aria-selected', String(on)); });
    if (v.cherry) v.cherry.disabled = !L.canCherryPick(state.sel);
    if (v.details) v.details.update(state.sel.slice());
    const key = state.sel.join(',');
    if (key !== v.emitted) { v.emitted = key; Git.emit('select-commit', { ids: state.sel.slice() }); }
    if (v.placeDone && L.place && key !== v.placeKey) { v.placeKey = key; L.place.write(R.root, { sel: state.sel.slice(), anchor: state.anchor, lead: state.lead }); }
  }
  function select(ids, anchor, lead) {
    const index = inst.view.index;
    inst.scrollTo = null;                          // a selection made now wins over a remembered offset
    state.sel = ids.filter((id) => index.has(id)).sort((a, b) => index.get(a) - index.get(b));
    state.selSet = new Set(state.sel);
    state.anchor = anchor === undefined ? state.anchor : anchor;
    state.lead = lead || anchor || state.sel[0] || null;
    selectionChanged();
    if (state.lead) show(state.lead);
  }
  const range = (a, b) => { const ix = inst.view.index, lo = Math.min(ix.get(a), ix.get(b)), hi = Math.max(ix.get(a), ix.get(b)); return inst.view.order.slice(lo, hi + 1); };
  // Parent and child as the table draws them: in a filtered log that is the nearest shown ancestor or descendant.
  const parentOf = (id) => inst.view.parents(id).find((p) => inst.view.index.has(p)) || null;
  const childOf = (id) => {
    const order = inst.view.order;
    for (let i = inst.view.index.get(id) - 1; i >= 0; i--) if (inst.view.parents(order[i]).indexOf(id) >= 0) return order[i];
    return null;
  };
  const cherryPick = () => { if (L.canCherryPick(state.sel)) A.cherryPick(state.sel.slice()); };

  /** A click on an edge of the graph (IntelliJ): a dotted edge of collapsed linear branches opens them, an edge of a
      linear branch folds that branch. Returns true when it did something (the click then selects nothing). */
  function onEdge(e, rowEl) {
    const svg = e.target.closest && e.target.closest('svg.g-graph');
    if (!svg || e.button !== 0 || e.metaKey || e.shiftKey) return false;
    const view = inst.view, i = view.index.get(rowEl.dataset.id), box = svg.getBoundingClientRect();
    const edge = i == null ? null : Git.graphPaint.edgeAt(view.graph, i, e.clientX - box.left, e.clientY - box.top, ROW);
    if (!edge) return false;
    const up = view.order[edge.up], down = view.order[edge.down];
    const folded = view.folded && view.folded.edges.get(up + '>' + down);
    if (folded) { folded.forEach((run) => L.toggleChain(run.key)); renderTable(); return true; }
    const chains = view.folded || Git.graph.collapse(view.order, { parents: view.parents, refs: (id) => Git.refsAt(id), collapsed: () => false });
    const run = chains.runOf.get(down) || chains.runOf.get(up);
    if (!run || run.collapsed) return false;
    L.toggleChain(run.key);
    renderTable();
    return true;
  }
  function onMouseDown(e) {
    const rowEl = e.target.closest('.gl-row');
    if (!rowEl || e.target.closest('.g-graph-stub')) return;
    if (onEdge(e, rowEl)) { e.preventDefault(); return; }
    const id = rowEl.dataset.id;
    if (e.button === 2 || (e.ctrlKey && !e.metaKey)) { if (state.sel.indexOf(id) < 0) select([id], id); return; }
    if (e.button !== 0) return;
    if (e.metaKey) select(state.sel.indexOf(id) >= 0 ? state.sel.filter((x) => x !== id) : state.sel.concat(id), id);
    else if (e.shiftKey && state.anchor) select(range(state.anchor, id), state.anchor, id);
    else select([id], id);
  }
  function onKeyDown(e) {
    const view = inst.view, n = view.order.length, mod = e.metaKey || e.ctrlKey;
    const at = view.index.has(state.lead) ? view.index.get(state.lead) : -1;
    const go = (k) => {
      if (!n) return;
      const id = view.order[Math.max(0, Math.min(n - 1, k))];
      if (e.shiftKey && state.anchor) select(range(state.anchor, id), state.anchor, id); else select([id], id);
    };
    const jump = (id) => { if (id) select([id], id); };
    const page = Math.max(1, Math.floor(inst.table.clientHeight / ROW) - 1);
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at < 0 ? 0 : at - 1);
    else if (e.key === 'PageDown') go(at + page);
    else if (e.key === 'PageUp') go(at - page);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(n - 1);
    else if (e.key === 'ArrowLeft' && state.lead) jump(childOf(state.lead));
    else if (e.key === 'ArrowRight' && state.lead) jump(parentOf(state.lead));
    else if (mod && e.key.toLowerCase() === 'a') select(view.order.slice(), state.anchor || view.order[0], state.lead);
    else if (mod && e.key.toLowerCase() === 'c' && state.sel.length) A.copyHash(state.sel.slice());
    else if (e.key === 'F2' && state.sel.length === 1 && L.menuState(state.sel, L.menuFacts()).reword.on) A.editMessage(state.sel[0]);
    else return;
    e.preventDefault();
  }
  /** An arrow at the end of a long edge: jump to the commit at its other end. */
  function onStub(stub) {
    const target = stub.getAttribute('data-target');
    if (!target) return;
    if (stub.hasAttribute('data-not-loaded') || !Git.commit(target)) {
      Git.notify({ kind: 'info', title: t('Commit {0} is not loaded: the Log shows the first {1} commits', Git.short(target), capText()) });
      return;
    }
    api.reveal(target);
  }

  // ---------------------------------------------------------------- mount
  function mount(el) {
    if (inst) inst.dispose();
    const v = (inst = { dirty: false, view: null, m: null, painted: 0 });
    v.bar = h('div.g-toolbar.gl-cbar', { role: 'toolbar' });
    v.table = h('div.gl-table', { tabIndex: 0, role: 'grid', 'aria-multiselectable': 'true', 'aria-label': t('Log') });
    v.empty = h('div.gl-empty', { hidden: true });
    v.status = h('div.gl-status', { role: 'status', hidden: true });
    v.table.appendChild(v.empty);
    v.list = Git.vlist({ el: v.table, rowHeight: ROW, count: () => (v.view ? v.view.order.length : 0), render: buildRow, overscan: 12 });
    const commits = h('div.gl-commits.g-col', v.bar, v.table, v.status);
    const pane = h('div.gl-bpane'), strip = h('div.gl-bstrip'), right = h('div.gl-right.g-col');
    v.root = h('div.gl-root.g-grow', pane, strip, commits, right);
    let wide = null;
    const layout = () => {
      // The arrangement follows the root's size (log-layout.js): narrow and medium stack the panes and turn the
      // branches pane into a drawer; in the wide one the side panes get their widths from what they want and the room
      // the root has now (L.wideSizes), so they grow back after a narrow moment.
      const changed = v.layout ? v.layout.update() : false;
      if (changed) placeBranches();
      if (wide && (!v.layout || !v.layout.stacked())) wide.fit();
      L.filters.fit(v);
      if (changed || (v.table.clientWidth && v.table.clientWidth !== v.width)) renderTable();
      revealPending();
      if (v.details) v.details.layout();
      if (v.branches) v.branches.layout();
    };
    wide = L.wideSizes({ root: v.root, pane, right, strip, shown: () => !!opts.branches, onResize: () => { if (wide) layout(); } });
    const split = wide.split;
    const stacked = () => !!(v.layout && v.layout.stacked());
    /** Wide: the pane or its strip, as "show branches" says. Narrow and medium: the pane is the drawer (log-layout.js). */
    const placeBranches = () => {
      pane.hidden = !stacked() && !opts.branches;
      split.hidden = stacked() || !opts.branches;
      strip.hidden = stacked() || opts.branches;
    };
    const showBranches = (on) => {
      // the drawer's hide button closes the drawer and leaves the wide arrangement's choice alone
      if (stacked()) { if (!on) v.layout.close(true); return; }
      opts.branches = on;
      L.saveOpts();
      placeBranches();
      layout();
    };
    // a branch action of the pane that changes the Log closes the drawer
    const fromPane = (fn) => (arg) => { const res = fn(arg); if (v.layout) v.layout.close(true); return res; };
    if (L.createBranches) v.branches = L.createBranches({ pane, strip, show: showBranches,
      setBranchFilter: fromPane((names) => api.setBranchFilter(names)), reveal: fromPane((id) => api.reveal(id)) });
    // Show Diff Preview (Changed Files ▸ View Options): the selected file's diff under the Log or at its right
    const outer = h('div.gl-outer.g-grow', v.root);
    let preview = null, previewBox = null, previewSplit = null, previewFile = null;
    const specOf = (e) => (e ? { id: e.after ? e.after.rev : e.commitId, path: e.path, oldPath: e.before ? e.before.path : null, status: e.status,
      parent: e.before ? e.before.rev : null } : null);
    const placePreview = () => {
      if (previewBox) { previewBox.remove(); previewSplit.remove(); }
      if (!opts.preview || !L.diffPreview) { if (preview) { preview.stop(); preview = null; } previewBox = null; return; }
      if (!preview) preview = L.diffPreview();
      const bottom = (opts.previewAt || 'bottom') === 'bottom';
      previewBox = h('div.gl-preview', { class: bottom ? 'bottom' : 'right' }, preview.el);
      previewSplit = Git.splitter({ target: previewBox, edge: bottom ? 'top' : 'left', min: 120, max: () => 4000, key: bottom ? 'log-preview-bottom' : 'log-preview-right', onResize: layout });
      if (bottom) { outer.appendChild(previewSplit); outer.appendChild(previewBox); } else { v.root.appendChild(previewSplit); v.root.appendChild(previewBox); }
      preview.show(specOf(previewFile));
    };
    const placeDetails = () => {
      if (!v.details) return;
      v.details.details.hidden = !opts.details;
      if (v.detailsSplit) v.detailsSplit.hidden = !opts.details;
      right.classList.toggle('no-details', !opts.details);
    };
    if (L.createDetails) {
      v.details = L.createDetails({ reveal: (id) => api.reveal(id), preview: true,
        onFile: (e) => { previewFile = e; if (preview) preview.show(specOf(e)); },
        layoutChanged: () => { placeDetails(); placePreview(); layout(); } });
      right.appendChild(v.details.files);
      v.detailsSplit = Git.splitter({ target: v.details.files, edge: 'bottom', min: 80, max: () => (right.clientHeight ? Math.max(100, right.clientHeight - 90) : 4000), key: 'log-files' });
      right.appendChild(v.detailsSplit);
      right.appendChild(v.details.details);
      placeDetails();
    }
    if (L.createLayout) v.layout = L.createLayout({ root: v.root, pane, right, files: v.details && v.details.files, details: v.details && v.details.details, left: () => v.left });
    el.appendChild(outer);
    placePreview();
    placeBranches();
    solids(v.table);

    v.table.addEventListener('mousedown', onMouseDown);
    v.table.addEventListener('focus', () => v.table.classList.add('focused'));
    v.table.addEventListener('blur', () => v.table.classList.remove('focused'));
    v.table.addEventListener('keydown', onKeyDown);
    v.table.addEventListener('click', (e) => { const stub = e.target.closest('.g-graph-stub'); if (stub) onStub(stub); });
    v.table.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const rowEl = e.target.closest('.gl-row');
      if (!rowEl) return;
      const id = rowEl.dataset.id;
      if (state.sel.indexOf(id) < 0) select([id], id);
      Git.menu(e, L.commitMenu(state.sel.slice(), id));
    });
    commits.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'f') L.filters.goTo(); else if (k === 'l') v.search.input.focus(); else if (k === 'r') { Git.store.refresh(); renderTable(); } else return;
      e.preventDefault();
    });

    // The branches pane follows refs; a work tree change alone does not touch the Log.
    const offs = [Git.on('change', (ev) => {
      const what = (ev && ev.what) || [];
      if (ev && ev.reason === 'changed' && what.indexOf('refs') < 0 && what.indexOf('op') < 0) return;
      schedule();
      if (v.branches && (!ev || ev.reason !== 'log' || R.log.complete)) v.branches.render();
    })];
    window.addEventListener('resize', layout);
    // layout() changes sizes itself (pane widths, the table): run it on the next frame, not inside the observer. One
    // exception: when the root's own size asks for another arrangement (or for the first one), it is applied in the same
    // callback, before that frame is painted. The root's box does not depend on the arrangement, so this cannot loop.
    let queued = false;
    const later = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; if (v.root.isConnected) layout(); }); };
    const watch = window.ResizeObserver ? new ResizeObserver(() => { if (v.layout && v.layout.pending() && v.root.isConnected) layout(); else later(); }) : null;
    if (watch) { watch.observe(v.root); watch.observe(v.table); watch.observe(v.bar); }
    if (L.place) L.place.watchScroll(v.table, () => inst === v && v.placeDone && v.scrollTo == null, () => R.root);   // log-place.js
    v.dispose = () => { if (preview) preview.stop(); offs.forEach((off) => off()); clearTimeout(v.typing); clearTimeout(v.loadingTimer); window.removeEventListener('resize', layout); if (watch) watch.disconnect(); v.list.destroy(); if (inst === v) inst = null; };
    L.filters.build(v);
    renderTable();
    L.filters.title();
    if (v.root.isConnected) layout();                // the narrow arrangement from the first frame on
    return v.dispose;
  }

  // ---------------------------------------------------------------- hooks
  const api = (Git.log = {
    /** Selects a commit (id, branch or tag name) and scrolls to it; filters that hide it are dropped. */
    reveal(ref) {
      // a ref pair from a row (the branches pane) names its ref exactly; text is a name or an id
      const id = ref && typeof ref === 'object' ? Git.actions.refId(ref) : Git.refId(ref) || ref;
      if (!Git.commit(id)) return false;
      if (!inst) { state.sel = [id]; state.anchor = state.lead = state.reveal = id; return true; }
      if (inst.dirty || !inst.view) renderTable();
      const f = state.filter;
      // inside a collapsed linear branch: that branch opens (IntelliJ expands what it navigates to)
      const run = inst.view.folded && !inst.view.index.has(id) ? inst.view.folded.runOf.get(id) : null;
      if (run && run.collapsed) { L.toggleChain(run.key); renderTable(); }
      // hidden by the filters: IntelliJ's balloon "Commit 'x' doesn't match the filters" with "View and reset filters"
      if (!inst.view.index.has(id) && (f.text || f.user || f.date || f.paths || f.branch)) {
        const n = Git.notify({ kind: 'info', title: t("{0} doesn't match the filters", t("Commit '{0}'", Git.short(id))),
          actions: [{ label: t('View and reset filters'), run: () => { if (n.close) n.close(); L.filters.reset(); api.reveal(id); } }] });
        return false;
      }
      if (!inst.view.index.has(id)) return false;
      if (inst.table.clientHeight) show(id, true); else state.reveal = id;
      select([id], id);
      return true;
    },
    /** Measures for tests and the report: { rows, computeMs, renderMs, loaded, complete, painted (rows built so far) }. */
    stats: () => (inst ? Object.assign({ painted: inst.painted, rendered: inst.list.rendered() }, inst.stats) : null),
    setBranchFilter(names) {
      const list = names == null ? [] : (Array.isArray(names) ? names : [names]).filter((n) => L.filters.validBranch(n));
      L.filters.set('branch', list.length ? list : null);
    },
    selected: () => state.sel.slice(),
    select: (ids) => { if (inst && inst.view) select(ids, ids[0] || null, ids[ids.length - 1] || null); },
    refresh: () => { if (inst) { L.dropView(); renderTable(); } },
  });
  L.core = { state, inst: () => inst, render: renderTable, schedule, select: (ids, anchor, lead) => select(ids, anchor, lead),
    reveal: (id) => api.reveal(id), parentOf, childOf, cherryPick, canCherryPick: (ids) => L.canCherryPick(ids) };
  Git.views.log = { mount };
})();
