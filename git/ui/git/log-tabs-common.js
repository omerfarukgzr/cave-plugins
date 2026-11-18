/* Pieces the Git tool window's extra tabs share (History, Compare, Changes with the working tree): remembered
   options, a commit table drawn like the Log's rows (virtual list, IntelliJ's graph), ref labels and a subscription
   that ends with the tab. Split out of the prototype's log-tabs.js.
   T = Git.logTabs: { opts, saveOpts(), header(label), rich(en, parts), focusSoon(el), follow(root, draw), solids(el),
                      commitTable(o), countText(n) } */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = Git.t;
  const R = Git.repo, A = Git.actions;
  const L = (Git.logUI = Git.logUI || {});
  const ROW = 26;                                   // --g-log-row
  const T = (Git.logTabs = {});

  Git.addTR({ '{0} file': '{0} dosya', '{0} files': '{0} dosya' });

  T.opts = Object.assign({ author: true, date: true, hash: false, details: true, preview: true, byDir: true, commitDate: false, viewer: 'unified' }, Git.host.prefs.get('tabs.opts', {}));
  T.saveOpts = () => Git.host.prefs.set('tabs.opts', T.opts);
  T.header = (label) => ({ label, header: label, disabled: true });
  T.countText = (n) => t(n === 1 ? '{0} file' : '{0} files', n);
  /** A translated label with elements in place of its `{0}`, `{1}`. */
  T.rich = (en, parts) => t(en).split(/\{(\d+)\}/).map((s, i) => (i % 2 ? parts[+s] : s));
  /** A tab that has just opened takes the keyboard, as the IDE's does (arrows and Enter work right away). It does not take it
      from another part of the host: the frame also mounts again when the skin or the language changes. */
  T.focusSoon = (el) => setTimeout(() => {
    const at = document.activeElement;
    if (el.isConnected && (!at || at === document.body || at.closest('.g-root, #g-layer'))) el.focus({ preventScroll: true });
  }, 0);
  /** Redraws a mounted view when the repository changes (`events`: which store events, default 'change'). The
      subscriptions end with `stop()`, or by themselves once the view's root is no longer in the document. */
  T.follow = function (root, draw, events) {
    const offs = [];
    let queued = false;
    const stop = () => { offs.splice(0).forEach((off) => off()); };
    (events || ['change']).forEach((ev) => offs.push(Git.on(ev, (arg) => {
      if (!root.isConnected) { stop(); return; }
      if (ev === 'change' && arg && arg.reason === 'log' && !R.log.complete) return;   // background paging
      if (queued) return;
      queued = true;
      Promise.resolve().then(() => { queued = false; if (root.isConnected) draw(arg); });
    })));
    return { stop, also(off) { offs.push(off); } };
  };
  T.solids = (el) => (L.solids ? L.solids(el) : null);

  // ---------------------------------------------------------------- ref labels of a row
  /** LabelPainter.shortenRefName, without measuring: a name over 22 characters loses its first path segment, then its tail. */
  function shortRef(name) {
    const MAX = 22;
    if (!name || name.length <= MAX) return name;
    const slash = name.indexOf('/');
    if (slash > 2) name = '..' + name.slice(slash);
    return name.length <= MAX ? name : name.slice(0, MAX - 1) + '…';
  }
  function refLabels(id) {
    const refs = Git.refsAt(id);
    if (!refs.length || !L.refGroups || !L.tagIcon) return null;
    const lo = L.opts || { compact: true, tagNames: false };
    return h('span.gl-refs.glt-refs', { class: lo.compact ? 'compact' : '', title: refs.map((r) => r.name).join('\n') },
      L.refGroups(refs, lo.compact, lo.tagNames).map((g) => h('span.gl-ref', { class: g.detached ? 'warn' : '' },
        g.detached ? Git.icon('balloonWarning') : L.tagIcon(L.groupColors(g)), g.name ? h('span.gl-ref-text', shortRef(g.name)) : null)));
  }

  // ---------------------------------------------------------------- commit table
  /** A list of commits drawn like the Log's rows. `o`: { label, ids() newest first, columns() of 'subject'|'author'|'date'|'hash',
      commit(id) (default Git.commit; a commit the Log has not loaded may come from elsewhere), time(c) (the Date column's
      time, default c.time), extra(id) → element after
      the subject, graph, multi, empty() → what an empty list shows, onSelect(ids), onActivate(id), onContext(event, ids, id) }
      → { el, render(), select(ids, quiet), selected(), ids() } */
  T.commitTable = function (o) {
    const el = h('div.gl-table.glt-table', { tabIndex: 0, role: 'grid', 'aria-label': o.label, 'aria-multiselectable': String(!!o.multi) });
    const empty = h('div.gl-empty', { hidden: true });
    el.appendChild(empty);
    const commitOf = o.commit || Git.commit;
    let order = [], index = new Map(), sel = [], anchor = null, lead = null, graph = null, cols = [], mineOn = false;
    const list = Git.vlist({ el, rowHeight: ROW, count: () => order.length, render: (i) => buildRow(i), overscan: 10 });
    const authorText = (c) => Git.author(c.author).name + (c.committer && c.committer !== c.author ? '*' : '');

    function buildRow(i) {
      const id = order[i], c = commitOf(id) || { id, subject: Git.short(id), parents: [], author: '', time: 0 };
      const mine = mineOn && Git.isMine(c), boldText = mine && cols.indexOf('author') < 0;
      const labels = refLabels(id);
      const cell = {
        subject: () => h('div.gl-subject', graph ? Git.graphPaint.row(graph, i, ROW) : null,
          h('span.gl-text', { class: (boldText ? 'bold ' : '') + (labels ? 'clip' : ''), title: c.subject }, c.subject), o.extra ? o.extra(id) : null, labels),
        author: () => h('div.gl-col.glt-author', { class: mine ? 'bold' : '' }, authorText(c)),
        date: () => h('div.gl-col.glt-date', c.time ? Git.formatDate(o.time ? o.time(c) : c.time) : ''),
        hash: () => h('div.gl-col.glt-hash', Git.short(id)),
      };
      const on = sel.indexOf(id) >= 0;
      return h('div.gl-row', { role: 'row', dataset: { id }, 'aria-selected': String(on),
        class: ((L.opts || {}).hlMerge !== false && c.parents.length > 1 ? 'merge ' : '') + (on ? 'sel' : '') }, cols.map((k) => cell[k]()));
    }
    function mark() { list.each((row, i) => { const on = sel.indexOf(order[i]) >= 0; row.classList.toggle('sel', on); row.setAttribute('aria-selected', String(on)); }); }
    function set(ids, a, l, quiet) {
      sel = ids.filter((id) => index.has(id)).sort((x, y) => index.get(x) - index.get(y));
      if (a !== undefined) anchor = a;
      lead = l || a || sel[0] || null;
      mark();
      if (lead && index.has(lead)) list.scrollTo(index.get(lead));
      if (!quiet && o.onSelect) o.onSelect(sel.slice());
    }
    const between = (a, b) => order.slice(Math.min(index.get(a), index.get(b)), Math.max(index.get(a), index.get(b)) + 1);
    const idAt = (e) => { const row = e.target.closest && e.target.closest('.gl-row'); return row ? row.dataset.id : null; };
    /** Column widths from a sample of the rows, as the Log measures them. */
    function widths() {
      const cs = getComputedStyle(el), size = parseFloat(cs.fontSize) || 13;
      const font = size + 'px ' + cs.fontFamily, bold = '600 ' + size + 'px ' + cs.fontFamily, sample = order.slice(0, 400);
      let aw = 0, dw = 0;
      sample.forEach((id) => { const c = commitOf(id); if (!c) return; aw = Math.max(aw, L.measure(authorText(c), bold)); dw = Math.max(dw, L.measure(c.time ? Git.formatDate(c.time) : '', font)); });
      el.style.setProperty('--glt-w-author', Math.min(260, Math.ceil(aw)) + 12 + 'px');
      el.style.setProperty('--glt-w-date', Math.ceil(dw) + 14 + 'px');
      el.style.setProperty('--glt-w-hash', Math.ceil(L.measure('e'.repeat(8), bold)) + 14 + 'px');
    }

    el.addEventListener('mousedown', (e) => {
      const id = idAt(e);
      if (!id) return;
      if (e.button === 2 || (e.ctrlKey && !e.metaKey)) { if (sel.indexOf(id) < 0) set([id], id); return; }
      if (e.button !== 0) return;
      if (o.multi && e.metaKey) set(sel.indexOf(id) >= 0 ? sel.filter((x) => x !== id) : sel.concat(id), id);
      else if (o.multi && e.shiftKey && index.has(anchor)) set(between(anchor, id), anchor, id);
      else set([id], id);
    });
    el.addEventListener('dblclick', (e) => { const id = idAt(e); if (id && o.onActivate) o.onActivate(id); });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const id = idAt(e);
      if (!id || !o.onContext) return;
      if (sel.indexOf(id) < 0) set([id], id);
      o.onContext(e, sel.slice(), id);
    });
    el.addEventListener('focus', () => el.classList.add('focused'));
    el.addEventListener('blur', () => el.classList.remove('focused'));
    el.addEventListener('keydown', (e) => {
      const n = order.length, mod = e.metaKey || e.ctrlKey, key = e.key.toLowerCase();
      const at = index.has(lead) ? index.get(lead) : -1;
      const go = (k) => {
        if (!n) return;
        const id = order[Math.max(0, Math.min(n - 1, k))];
        if (o.multi && e.shiftKey && index.has(anchor)) set(between(anchor, id), anchor, id); else set([id], id);
      };
      const page = Math.max(1, Math.floor(el.clientHeight / ROW) - 1);
      if (e.key === 'ArrowDown') go(at + 1);
      else if (e.key === 'ArrowUp') go(at < 0 ? 0 : at - 1);
      else if (e.key === 'PageDown') go(at + page);
      else if (e.key === 'PageUp') go(at - page);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(n - 1);
      else if ((e.key === 'Enter' || (mod && key === 'd')) && index.has(lead) && o.onActivate) o.onActivate(lead);
      else if (mod && key === 'a' && o.multi && n) set(order.slice(), anchor || order[0], lead);
      else if (mod && key === 'c' && sel.length) A.copyHash(sel.slice());
      else return;
      e.preventDefault();
    });

    return {
      el,
      render() {
        order = o.ids();
        index = new Map(order.map((id, i) => [id, i]));
        sel = sel.filter((id) => index.has(id));
        if (!index.has(anchor)) anchor = sel[0] || null;
        if (!index.has(lead)) lead = sel[sel.length - 1] || null;
        cols = o.columns();
        mineOn = (L.opts || {}).hlMine !== false && Object.keys(R.authors).length > 1;
        graph = o.graph && order.length ? Git.graph.create(order, { parents: (id) => ((commitOf(id) || {}).parents || []).filter((p) => index.has(p)),
          refs: (id) => Git.refsAt(id), longEdges: false }) : null;
        Git.clear(empty);
        empty.hidden = order.length > 0;
        if (!order.length) { const e = o.empty(); (Array.isArray(e) ? e : [e]).forEach((x) => empty.append(x)); }
        widths();
        list.refresh();
      },
      select(ids, quiet) { set(ids, ids[0] || null, ids[ids.length - 1] || null, quiet); },
      selected: () => sel.slice(),
      ids: () => order.slice(),
      destroy: () => list.destroy(),
    };
  };
})();
