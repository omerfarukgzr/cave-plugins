/* Worktrees (IntelliJ's Git ▸ Worktrees list, help "Use Git worktrees"): a chip beside the repository and branch chips
   of every header that has them, shown when the repository has more than one worktree; its list (the shell menu) has
   one row per worktree with its branch and how many changes the Commit view would list there (worktree.list,
   docs/PROTOCOL.md; counted only when the list opens, every background read asks with `counts: false`). Picking a row shows that worktree's folder in this same page (Git.workbench.open(path,
   { pick: true })): nothing is checked out, nothing moves. While the page shows another worktree than its home (the
   folder the host opened it for) a strip under the header names it and offers Back.
   The pick is kept per view in localStorage with its home, so a re-created frame (Orca builds a panel's frame again
   when its sidebar tab shows) shows it again; opening another home forgets it.
     Git.worktrees.chip() → element · .strip() → element | null · .show(path) · .back() · .away() · .home() · .list()
     · .load(force, { counts }) → Promise<list>   (counts: the list's menu only)
     Git.worktrees.beforeOpen(path, o) → the folder to open · .afterOpen(root) → the home root · .forget()   (workbench.js) */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const WT = (Git.worktrees = {});

  Git.addTR({
    'Worktrees': 'Worktrees', 'WT': 'WT', '1 change': '1 değişiklik', '{0} changes': '{0} değişiklik', 'main': 'main', 'linked': 'linked',
    'locked': 'locked', 'prunable': 'prunable', 'home': 'başlangıç', 'Back to {0}': '{0} klasörüne dön',
    'Showing worktree': 'Gösterilen worktree',
    'Changes could not be read': 'Değişiklikler okunamadı', 'The folder is gone': 'Klasör yok',
  });
  // IntelliJ's GitIcons.Worktree (git4idea, ui/git/icons/worktree_dark.svg; icons/index.md); icons.js is generated
  // from the platform icons only, so this one is added here.
  if (Git.ICONS && !Git.ICONS['vcs/worktree']) {
    Git.ICONS['vcs/worktree'] = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">'
      + '<path d="M2.5 7.5H8.5L13.5 2.5" stroke="#CED0D6" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<path d="M10.5 2.5H13.5V5.5" stroke="#CED0D6" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<path d="M8.5 7.5L13.5 12.5" stroke="#CED0D6" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<path d="M10.5 12.5H13.5V9.5" stroke="#CED0D6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  // ---------------------------------------------------------------- the pick, kept per view (localStorage)
  const memory = new Map();
  const viewName = () => (Git.workbench && Git.workbench.view) || 'workbench';
  const pickKey = () => Git.storagePrefix() + 'worktree.shown:' + viewName();
  const storage = () => { try { return window.localStorage || null; } catch (e) { return null; } };
  function readPick() {
    let text = null;
    try { const s = storage(); text = s ? s.getItem(pickKey()) : null; } catch (e) { text = null; }
    if (text == null) text = memory.get(pickKey()) || null;
    try {
      const v = text ? JSON.parse(text) : null;
      return v && typeof v.home === 'string' && typeof v.shown === 'string' && typeof v.homePath === 'string' ? v : null;
    } catch (e) { return null; }
  }
  function writePick(v) {
    const k = pickKey();
    if (!v) { memory.delete(k); try { const s = storage(); if (s) s.removeItem(k); } catch (e) { /* refused */ } return; }
    const text = JSON.stringify(v);
    memory.set(k, text);
    try { const s = storage(); if (s) s.setItem(k, text); } catch (e) { /* full or refused: memory keeps it */ }
  }

  // ---------------------------------------------------------------- home and what is shown
  let home = null;          // { root, path }: the folder the host opened this page for
  let pending = null;       // the open in flight: { path, pick, restore }
  WT.home = () => (home ? home.root : null);
  /** True while the page shows another folder than its home. */
  WT.away = () => !!(home && Git.repo.root && Git.repo.root !== home.root);
  /** Which folder W.open(path, o) opens: a pick opens `path`; a home open shows the kept pick of that home, if any
      (and forgets a pick that belongs to another home). */
  WT.beforeOpen = function (path, o) {
    const pick = !!(o && o.pick) && !!home;
    if (pick) { pending = { path, pick: true }; return path; }
    const kept = readPick();
    if (kept && (kept.homePath === path || kept.home === path)) { pending = { path, restore: kept }; return kept.shown; }
    if (kept) writePick(null);
    pending = { path };
    return path;
  };
  /** After the store opened `root`: records it and answers the home root (the one the page's URL keeps). */
  WT.afterOpen = function (root) {
    const p = pending || { path: root };
    pending = null;
    if (p.pick) {
      if (root === home.root) writePick(null);
      else writePick({ homePath: home.path, home: home.root, shown: root });
    } else if (p.restore) {
      home = { root: p.restore.home, path: p.path };
      if (root === home.root) writePick(null);
    } else home = { root, path: p.path };
    data.at = 0;
    return home.root;
  };
  /** A kept pick that cannot be opened any more (the worktree went away). */
  WT.forget = () => { writePick(null); pending = null; };
  WT.show = (path) => (Git.workbench && path ? Git.workbench.open(path, { pick: true }) : null);
  WT.back = () => (home ? WT.show(home.root) : null);

  // ---------------------------------------------------------------- the list
  // Only opening the list counts (worktree.list with counts: a status in every worktree, 24 of them cost seconds);
  // every other read (the chip, a page that shows again, the shown repository's changes, a host's folder lookup) asks
  // with `counts: false`. `counted`: the list holds the counts of a counting read; after a read without counts the
  // rows keep the counts the last opening found (`counted` false).
  const data = { common: null, list: null, at: 0, counted: false, loaded: false };
  const inflight = { plain: null, counts: null };
  let seq = 0, applied = 0;
  const cacheKey = (common) => Git.storagePrefix() + 'worktrees:' + common;
  /** The last list of this repository without its counts (the chip shows at once on a new frame). */
  function cached(common) {
    try {
      const s = storage(), v = s ? JSON.parse(s.getItem(cacheKey(common)) || 'null') : null;
      return Array.isArray(v) ? v.filter((w) => w && typeof w.path === 'string').map((w) => Object.assign({}, w, { changes: null })) : null;
    } catch (e) { return null; }
  }
  function remember(common, list) {
    try { const s = storage(); if (s) s.setItem(cacheKey(common), JSON.stringify(list.map((w) => Object.assign({}, w, { changes: null })))); } catch (e) { /* refused */ }
  }
  WT.list = function () {
    const common = Git.repo.commonDir;
    if (!common) return null;
    if (data.common !== common) { data.common = common; data.list = cached(common); data.counted = false; data.loaded = false; data.at = 0; }
    return data.list;
  };
  /** Reads worktree.list (at most once in 2 s unless `force`); redraws the chips, the strips and an open list.
      `o.counts`: with each worktree's count (the list's menu); without it nothing is counted. */
  WT.load = function (force, o) {
    const root = Git.repo.root, common = Git.repo.commonDir;
    const counts = !!(o && o.counts);
    if (!root || !Git.backend) return Promise.resolve(null);
    WT.list();
    const kind = counts ? 'counts' : 'plain';
    const mineNow = (k) => (inflight[k] && inflight[k].root === root ? inflight[k] : null);
    // a counting read in flight answers a read without counts too (also a forced one: it is newer than that read's
    // start, and a newer read without counts would make the menu drop that read's counts)
    if (!counts && mineNow('counts')) return mineNow('counts').p;
    if (!force && mineNow(kind)) return mineNow(kind).p;
    if (!force && data.loaded && (data.counted || !counts) && Date.now() - data.at < 2000) return Promise.resolve(data.list);
    const mine = { root, n: ++seq };
    const done = () => { if (inflight[kind] === mine) inflight[kind] = null; };
    mine.p = Git.backend.call('worktree.list', { repo: root, counts }).then((res) => {
      done();
      if (Git.repo.root !== root || data.common !== common) return null;
      if (mine.n < applied) return data.list;     // an older read answered after a newer one
      applied = mine.n;
      const list = res.worktrees || [];
      if (!counts) {
        const last = new Map((data.list || []).map((w) => [w.path, w.changes]));
        list.forEach((w) => { w.changes = last.has(w.path) ? last.get(w.path) : null; });
      }
      data.list = list;
      data.counted = counts;
      data.loaded = true;
      data.at = Date.now();
      remember(common, data.list);
      redraw();
      return data.list;
    }, () => { done(); return null; });
    inflight[kind] = mine;
    return mine.p;
  };
  const shownRoot = () => Git.repo.root;

  // ---------------------------------------------------------------- the chip
  const chips = new Set();
  function paintChip(el) {
    const list = WT.list();
    const n = list ? list.length : 0;
    el.hidden = n < 2;
    // No "other worktrees have changes" dot (the owner, 18 Nov 2026: with several worktrees in use it is always on and
    // says nothing); the list shows each worktree's count.
    el.querySelector('.wb-wt-n').textContent = String(n);
    el.title = t('Worktrees');
    el.setAttribute('aria-label', t('Worktrees') + ': ' + n);
  }
  WT.chip = function () {
    // A word, not an icon (the owner, 17 Nov 2026: nobody could tell what the branching glyph beside a number meant;
    // first "PR", then 18 Nov 2026: "WT", short for worktree, since PR reads as a pull request). The tooltip and the
    // list still say Worktrees.
    const el = h('button.wb-repo.wb-wt', { type: 'button', id: 'wb-worktrees', hidden: true, 'aria-haspopup': 'true', onclick: (e) => open(e.currentTarget) },
      h('span.wb-wt-ic', h('span.wb-wt-word', t('WT'))), h('span.wb-wt-n', ''));
    chips.add(el);
    paintChip(el);
    WT.load();
    return el;
  };

  // ---------------------------------------------------------------- the list (the shell menu)
  let menu = null;
  const countText = (w) => (w.changes == null ? '' : w.changes === 0 ? '' : w.changes === 1 ? t('1 change') : t('{0} changes', w.changes));
  function tip(w) {
    const words = [w.main ? t('main') : t('linked')];
    if (w.locked) words.push(t('locked') + (w.lockReason ? ': ' + w.lockReason : ''));
    if (w.prunable) words.push(t('prunable') + (w.prunableReason ? ': ' + w.prunableReason : ''));
    const lines = [w.path, words.join(', ')];
    if (data.counted && w.changes == null && !w.prunable) lines.push(t('Changes could not be read'));
    return lines.join('\n');
  }
  function items(list) {
    const lockHTML = (Git.ICONS || {})['general/locked'] || '';
    return [{ header: t('Worktrees'), label: t('Worktrees'), disabled: true }].concat(list.map((w) => ({
      key: w.path, label: w.name, bold: !!w.main, hint: w.branch || (w.head ? Git.short(w.head) : ''),
      tag: home && w.path === home.root ? t('home') : null, badgeHTML: w.locked ? lockHTML : null,
      checked: w.path === shownRoot(), disabled: !!w.prunable, title: tip(w),
      // the count's place is kept while it is read: the same width, a quiet dot
      shortcut: data.counted ? countText(w) : '·',
      action: () => { if (w.path !== shownRoot()) WT.show(w.path); },
    })));
  }
  /** Wide enough for the longest row with a count of "999 changes", never wider than the page. */
  function widthFor(list) {
    const probe = items(list).map((it) => (it.header ? it : Object.assign({}, it, { shortcut: t('{0} changes', 999) })));
    const w = Git.popupMenu ? Git.popupMenu.width(probe) : 260;
    return Math.max(220, Math.min(w, window.innerWidth - 16));
  }
  function open(anchor) {
    const list = WT.list();
    if (!list || !list.length) return;
    menu = Git.menu(anchor, items(list), { width: widthFor(list) });
    const shownAt = menu;
    WT.load(true, { counts: true }).then(() => { if (menu === shownAt) updateMenu(anchor); });
  }
  /** The open list after a new answer: counts in place; another set of worktrees opens the list again. */
  function updateMenu(anchor) {
    const el = menu && menu.el;
    if (!el || !el.isConnected) { menu = null; return; }
    const list = WT.list() || [];
    const rows = Array.prototype.slice.call(el.querySelectorAll('.cm-row[data-key]'));
    const same = rows.length === list.length && rows.every((r, i) => r.dataset.key === list[i].path);
    if (!same) { if (Git.popupMenu) Git.popupMenu.close(); if (anchor.isConnected) open(anchor); return; }
    const its = items(list);
    rows.forEach((r, i) => {
      const s = r.querySelector('.cm-short');
      if (s) s.textContent = its[i + 1].shortcut;
      r.title = its[i + 1].title;
    });
  }
  Git.on('menu-close', () => { menu = null; });

  // ---------------------------------------------------------------- the strip
  const strips = new Set();
  function paintStrip(el) {
    const list = WT.list() || [];
    const w = list.find((x) => x.path === shownRoot());
    const branch = Git.repo.head && Git.repo.head.branch ? Git.repo.head.branch : Git.repo.headId ? Git.short(Git.repo.headId) : '';
    el.querySelector('.wb-wt-strip-name').textContent = (w && w.name) || Git.repo.name || '';
    el.querySelector('.wb-wt-strip-branch').textContent = branch;
    el.title = (w ? tip(w) : Git.repo.root || '');
  }
  WT.strip = function () {
    if (!WT.away()) return null;
    const homeName = String(home.root).replace(/\/+$/, '').split('/').pop();
    const el = h('div.wb-wt-strip', { role: 'status' },
      Git.icon('vcs/worktree'),
      h('span.wb-wt-strip-text', h('span.wb-wt-strip-what', t('Showing worktree')), h('span.wb-wt-strip-name'), h('span.wb-wt-strip-branch')),
      h('button.wb-wt-back', { type: 'button', id: 'wb-wt-back', title: home.root, onclick: () => WT.back() }, Git.icon('general/chevronLeft', 14), h('span', t('Back to {0}', homeName))));
    strips.add(el);
    paintStrip(el);
    return el;
  };

  function redraw() {
    chips.forEach((el) => { if (el.isConnected) paintChip(el); else chips.delete(el); });
    strips.forEach((el) => { if (el.isConnected) paintStrip(el); else strips.delete(el); });
  }
  // The other worktrees are not watched: the list (without counts: which worktrees, their branches) is read again at
  // most every 15 s while the shown repository changes, and when the page shows again. Counts come only from opening
  // the list.
  let lastMove = 0;
  Git.on('change', (ev) => {
    redraw();
    const what = (ev && ev.what) || [];
    if (!data.loaded || !(what.indexOf('worktree') >= 0 || what.indexOf('refs') >= 0 || what.indexOf('state') >= 0)) return;
    if (Date.now() - lastMove < 15000) return;
    lastMove = Date.now();
    if (chips.size) WT.load(true);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && chips.size && Git.repo.root) WT.load(true); });
})();
