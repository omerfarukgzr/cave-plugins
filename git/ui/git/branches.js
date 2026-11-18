/* Git prototype: IntelliJ's VCS widget (the branch button), the Branches popup and the per-branch action menus.
   Git.branchWidget.mount(el) · Git.branches.open(anchor) · Git.branches.close() · Git.branches.menuFor(name)
   The dialogs these open (New Branch, Rename, Push, Update Project, …) live in branches-dialogs.js. */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = (...a) => Git.t(...a);
  const R = Git.repo, A = Git.actions;
  const B = (Git.branches = {});

  Git.addTR({
    'Git Branch: {0}': 'Git dalı: {0}',
    "Git: Detached HEAD doesn't point to any branch": 'Git: ayrık HEAD hiçbir dalı göstermiyor',
    'Branches': 'Dallar',
    'Search for branches and actions': 'Dal ve eylem ara',
    'Fetch': 'Fetch',
    'Settings': 'Ayarlar',
    'Update Project…': 'Projeyi güncelle…',
    'Commit…': 'Commit…',
    'Push…': 'Push…',
    'New Branch…': 'Yeni dal…',
    'Checkout Tag or Revision…': 'Etiket ya da commit\'e checkout yap…',
    'Recent': 'Son kullanılanlar',
    'Local': 'Yerel',
    'Remote': 'Uzak',
    'Tags': 'Etiketler',
    'Group by Directory': 'Klasöre göre grupla', 'Show Actions in Search Results': 'Arama sonuçlarında eylemleri göster',
    'Restore Popup Size': 'Popup boyutunu geri al',
    'Show Recent Branches': 'Son kullanılan dalları göster',
    'Show Tags': 'Etiketleri göster',
    '{0} incoming commit': '{0} gelen commit',
    '{0} incoming commits': '{0} gelen commit',
    '{0} outgoing commit': '{0} giden commit',
    '{0} outgoing commits': '{0} giden commit',
    '{0} incoming and {1} outgoing commits': '{0} gelen, {1} giden commit',
    'current branch': 'geçerli dal',
    'current favorite branch': 'geçerli favori dal',
    'Mark/Unmark As Favorite': 'Favori yap / favoriden çıkar',
    'Checkout': 'Checkout',
    "New Branch from '{0}'…": "'{0}' üzerinden yeni dal…",
    "Checkout and Rebase onto '{0}'": "Checkout yap ve '{0}' üzerine rebase et",
    "Compare with '{0}'": "'{0}' ile karşılaştır",
    'Show Diff with Working Tree': 'Çalışma kopyasıyla diff\'i göster',
    "Rebase '{0}' onto '{1}'": "'{0}' dalını '{1}' üzerine rebase et",
    "Merge '{0}' into '{1}'": "'{0}' dalını '{1}' içine merge et",
    "Pull into '{0}' Using Rebase": "Rebase ile '{0}' içine pull yap",
    "Pull into '{0}' Using Merge": "Merge ile '{0}' içine pull yap",
    'Update': 'Güncelle',
    "Tracked Branch '{0}'": "İzlenen dal '{0}'",
    'Rename…': 'Yeniden adlandır…',
    'Delete': 'Sil',
  });

  // ---------------------------------------------------------------- popup settings (the gear menu)
  const prefs = { actions: true, group: true, recent: true, tags: true };
  const prefKey = (k) => 'branches.' + k;
  const loadPrefs = () => Object.keys(prefs).forEach((k) => { const v = Git.host.prefs.get(prefKey(k), null); if (v != null) prefs[k] = !!v; });
  function setPref(k, v) {
    prefs[k] = v;
    Git.host.prefs.set(prefKey(k), !!v);
  }
  const openState = new Map();   // section / folder id -> expanded, kept while the page lives

  // ---------------------------------------------------------------- incoming / outgoing marks
  const count = (n, one, many) => t(n === 1 ? one : many, n);
  function syncTip(s) {
    if (!s) return '';
    if (s.behind && s.ahead) return t('{0} incoming and {1} outgoing commits', s.behind, s.ahead);
    if (s.behind) return count(s.behind, '{0} incoming commit', '{0} incoming commits');
    if (s.ahead) return count(s.ahead, '{0} outgoing commit', '{0} outgoing commits');
    return '';
  }
  /** The blue ↙ and green ↗ marks after a branch name; the popup adds the counts, the widget shows the arrows alone. */
  function syncMarks(name, numbers) {
    const s = Git.isLocal(name) ? Git.sync(name) : null;
    if (!s || (!s.ahead && !s.behind)) return null;
    return h('span.gb-sync', { title: syncTip(s) },
      s.behind ? h('span.gb-in', Git.icon('dvcs/changesUpdate@12x12', 12), numbers ? String(s.behind) : null) : null,
      s.ahead ? h('span.gb-out', Git.icon('dvcs/changesPush@12x12', 12), numbers ? String(s.ahead) : null) : null);
  }

  // ---------------------------------------------------------------- the widget
  let widgetHost = null;
  let current = null;            // the open Branches popup
  function drawWidget() {
    const el = widgetHost;
    if (!el || !el.isConnected) return;
    Git.clear(el);
    el.classList.add('gb-w');
    const op = A.opLabels();
    const cur = Git.currentBranch();
    const name = op ? op.text : cur || Git.short(Git.headId());
    const tip = op ? op.text + (op.tip ? '\n' + op.tip : '') : cur ? t('Git Branch: {0}', cur) : t("Git: Detached HEAD doesn't point to any branch");
    const marks = cur ? syncTip(Git.sync(cur)) : '';
    const btn = h('button.gb-widget', { type: 'button', id: 'g-branch-widget', title: tip + (marks ? '\n' + marks : ''), 'aria-label': tip, 'aria-haspopup': 'true',
      'aria-expanded': String(!!current), class: (op ? 'op ' : '') + (current ? 'open' : ''), onclick: () => B.open(btn) },
      Git.icon(op ? 'balloonWarning' : 'branch'), h('span.gb-widget-name', name), cur ? syncMarks(cur, false) : null, Git.icon('chevronDownSmall'));
    el.appendChild(btn);
    if (current) current.pop.keepFor = btn;
    if (!op) return;
    // IntelliJ's "VCS Merge/Rebase Widget": the green » and the red ✕ next to the branch button.
    // an operation git left half-made has nothing to go on with: only the ✕ (op.incomplete)
    if (op.go) el.appendChild(h('button.gb-op.go', { type: 'button', id: 'g-op-continue', title: op.go, 'aria-label': op.go, onclick: () => A.continueOp() }, Git.icon('dvcs/resolveContinue')));
    el.appendChild(h('button.gb-op.stop', { type: 'button', id: 'g-op-abort', title: op.stop, 'aria-label': op.stop, onclick: () => A.abortOp() }, Git.icon('vcs/abort')));
  }
  Git.branchWidget = { mount(el) { widgetHost = el; drawWidget(); } };
  Git.on('change', drawWidget);

  // The action menu of one ref (B.menuFor) is branches-menu.js.

  // ---------------------------------------------------------------- the popup
  const HOVER_MS = 220;          // how long the pointer rests on a row's arrow, or on a menu item, before its submenu opens

  B.close = function () { if (current) current.pop.close(); };
  /** Opens the Branches popup under `anchor` (the widget); a second call closes it. */
  B.open = function (anchor) {
    if (current) { B.close(); return null; }
    const at = (anchor && anchor.querySelector && anchor.querySelector('.gb-widget')) || anchor || document.getElementById('g-branch-widget');
    if (!at) return null;
    current = popup(at);
    drawWidget();
    return current.pop;
  };

  function popup(anchor) {
    loadPrefs();
    // during an operation its first action (Abort …) is the selected row (apply__cherry_pick_status.png)
    const st = { query: '', sel: A.opLabels() ? 'a:abort' : null, rows: [], levels: [], timer: null, mouse: null };
    const search = Git.field({ placeholder: t('Search for branches and actions'), icon: 'general/search', id: 'gb-search', onInput: (v) => { st.query = v; render(true); } });
    search.classList.add('gb-search');
    search.input.setAttribute('role', 'combobox');
    search.input.setAttribute('aria-controls', 'gb-list');
    const list = h('div.gb-list.g-scroll#gb-list', { role: 'tree', 'aria-label': t('Branches') });
    const fetchBtn = Git.toolBtn({ icon: 'vcs/fetch', title: t('Fetch'), id: 'gb-fetch', onClick: () => { A.fetch(); search.input.focus(); } });
    const gearBtn = Git.toolBtn({ icon: 'general/settings', title: t('Settings'), id: 'gb-settings', onClick: () => gearMenu() });
    const root = h('div.gb-pop', h('div.gb-head', search, fetchBtn, gearBtn), list);
    const off = Git.on('change', () => render(false));
    const pop = Git.popup({ anchor, content: root, width: 375, className: 'gb-popup', onClose: () => {
      off();
      clearTimeout(st.timer);
      current = null;
      drawWidget();
    } });
    pop.keepFor = anchor;

    // ------------------------------------------------------------ rows
    function buildRows() {
      const q = st.query.trim().toLowerCase();
      // Show Actions in Search Results off: a search lists branches only
      const hit = (s) => !q || (prefs.actions && s.toLowerCase().indexOf(q) >= 0);
      const cur = Git.currentBranch();
      const rows = [];
      const act = (id, label, o) => Object.assign({ type: 'action', id: 'a:' + id, label, depth: 0 }, o);
      const op = A.opLabels();
      const ongoing = [];
      if (op) {
        // IntelliJ's Git.Ongoing.Rebase.Actions group: no icons, right above New Branch…; a merge and a revert only offer
        // their abort here (the group has Abort Revert but no Continue Revert).
        ongoing.push(act('abort', op.stop, { run: () => A.abortOp() }));
        if (op.go && R.op.type !== 'merge' && (R.op.type !== 'revert' || R.op.pending)) ongoing.push(act('continue', op.go, { run: () => A.continueOp() }));   // a waiting revert sequence goes on too
        if (op.skip) ongoing.push(act('skip', op.skip, { run: () => A.skipCommit() }));
      }
      [[
        act('update', t('Update Project…'), { icon: 'vcs/update', key: '⌘T', run: () => A.updateProject() }),
        act('commit', t('Commit…'), { icon: 'vcs/commit', key: '⌘K', run: () => { if (A.checkinProject) A.checkinProject(); else if (Git.frame && Git.frame.showRight) Git.frame.showRight('commit'); } }),
        act('push', t('Push…'), { icon: 'vcs/push', key: '⇧⌘K', run: () => A.push() }),
      ], ongoing.concat([
        // "The new branch will start from the current branch HEAD": the dialog is "Create Branch from <current>"
        act('new', t('New Branch…'), { icon: 'general/add', key: '⌥⌘N', run: () => A.newBranch(A.currentRef(), Git.currentBranch()) }),
        act('rev', t('Checkout Tag or Revision…'), { run: () => A.checkoutTagOrRevision() }),
      ])].forEach((group) => {
        const shown = group.filter((a) => hit(a.label));
        if (shown.length) rows.push(...shown, { type: 'sep' });
      });

      rows.push(...Git.branchTree.rows({ query: st.query, group: prefs.group, showRecent: prefs.recent, showTags: prefs.tags,
        isOpen: (id, fallback) => (openState.has(id) ? openState.get(id) : fallback), current: cur, isFavorite: (kind, name) => A.isFavorite(A.ref(kind, name)), recent: R.recent,
        local: Git.localBranches(), remote: Git.remoteBranches(), tags: Git.tagNames(), isLocal: Git.isLocal,
        labels: { recent: t('Recent'), local: t('Local'), remote: t('Remote'), tags: t('Tags') } }));
      while (rows.length && rows[rows.length - 1].type === 'sep') rows.pop();
      return rows;
    }

    const branchIcon = (r) => (r.current ? (r.fav ? 'dvcs/currentBranchFavoriteLabel' : 'dvcs/currentBranchLabel')
      : r.fav ? 'nodes/star' : r.type === 'tag' ? 'dvcs/branchLabel' : 'branch');
    /** The label with the searched text marked, the way IntelliJ's speed search does. */
    function marked(text) {
      const q = st.query.trim().toLowerCase();
      const i = q ? text.toLowerCase().indexOf(q) : -1;
      return i < 0 ? text : [text.slice(0, i), h('span.gb-hit', text.slice(i, i + q.length)), text.slice(i + q.length)];
    }
    function rowEl(r, i) {
      if (r.type === 'sep') return h('div.gb-sep', { role: 'separator' });
      const el = h('div.gb-row', { class: 'gb-' + r.type, id: 'gb-row-' + i, role: 'treeitem', 'aria-selected': 'false', dataset: { id: r.id }, style: { '--gb-depth': String(r.depth) } });
      if (r.type === 'action') {
        el.appendChild(r.icon ? Git.icon(r.icon) : h('span.g-ic'));
        el.appendChild(h('span.gb-label', marked(r.label)));
        if (r.key) el.appendChild(h('span.gb-key', r.key));
      } else if (r.type === 'section' || r.type === 'folder') {
        el.setAttribute('aria-expanded', String(r.open));
        el.appendChild(h('span.gb-chev', { class: r.open ? 'open' : '' }, Git.icon('chevronRight')));
        if (r.type === 'folder') el.appendChild(Git.icon('nodes/folder'));
        el.appendChild(h('span.gb-label', r.label));
      } else {
        const tip = r.current ? t(r.fav ? 'current favorite branch' : 'current branch') : t('Mark/Unmark As Favorite');
        el.appendChild(h('span.gb-chev'));
        // The icon doubles as the favorite toggle; on the selected row a plain branch shows the star outline instead.
        el.appendChild(h('button.gb-fav', { type: 'button', tabIndex: -1, title: tip, 'aria-label': t('Mark/Unmark As Favorite'), 'aria-pressed': String(r.fav),
          class: r.fav || r.current ? '' : 'plain', onclick: (e) => { e.stopPropagation(); A.toggleFavorite(A.ref(r.kind, r.name)); } },
          h('span.gb-fav-own', Git.icon(branchIcon(r))), h('span.gb-fav-hover', Git.icon('nodes/starEmpty'))));
        el.appendChild(h('span.gb-label', { title: r.name }, marked(r.label)));
        const marks = r.local ? syncMarks(r.name, true) : null;
        if (marks) el.appendChild(marks);
        el.appendChild(h('span.gb-tracked', r.local ? Git.upstream(r.name) || '' : ''));
        el.appendChild(h('span.gb-more', Git.icon('chevronRight')));
      }
      return el;
    }
    const selectable = () => st.rows.filter((r) => r.type !== 'sep');
    const rowNode = (id) => Array.prototype.find.call(list.children, (el) => el.dataset && el.dataset.id === id) || null;
    function mark(scroll) {
      let active = null;
      Array.prototype.forEach.call(list.children, (el) => {
        if (!el.dataset || !el.dataset.id) return;
        const on = el.dataset.id === st.sel;
        el.classList.toggle('sel', on);
        el.setAttribute('aria-selected', String(on));
        if (on) active = el;
      });
      if (active) search.input.setAttribute('aria-activedescendant', active.id); else search.input.removeAttribute('aria-activedescendant');
      if (active && scroll) active.scrollIntoView({ block: 'nearest' });
    }
    function select(id, scroll) { st.sel = id; mark(scroll); }
    function render(fromSearch) {
      closeLevels(0);
      st.rows = buildRows();
      const rows = selectable();
      const keep = list.scrollTop;
      Git.clear(list);
      st.rows.forEach((r, i) => list.appendChild(rowEl(r, i)));
      if (!rows.length) list.appendChild(h('div.gb-empty', t('Nothing found')));
      // Typing jumps to the best match: the first branch, or the first action when no branch matches.
      if (fromSearch && st.query.trim()) st.sel = (rows.find((r) => r.type === 'branch' || r.type === 'tag') || rows[0] || {}).id || null;
      else if (!rows.some((r) => r.id === st.sel)) st.sel = rows[0] ? rows[0].id : null;
      list.scrollTop = fromSearch ? 0 : keep;
      mark(fromSearch);
    }

    // ------------------------------------------------------------ submenus (a branch's actions, the gear menu, Tracked Branch ▸)
    const enabled = (lv, i) => lv.items[i] && lv.items[i] !== '-' && !lv.items[i].disabled;
    function setLevelSel(lv, i) {
      lv.sel = i;
      lv.els.forEach((el, k) => { if (el) el.classList.toggle('sel', k === i); });
      if (lv.els[i]) lv.els[i].scrollIntoView({ block: 'nearest' });
    }
    function closeLevels(depth) {
      const lv = st.levels[depth];
      if (lv) lv.pop.close();   // deeper levels are its children and close with it
    }
    /** Opens menu level `depth` with `items`; `pos(width, height)` gives its top-left corner. */
    function showLevel(depth, items, pos, owner, viaKeyboard) {
      closeLevels(depth);
      const parent = depth ? st.levels[depth - 1].pop : pop;
      const lv = { depth, owner, items: items.filter((it, i) => !(it === '-' && (i === 0 || i === items.length - 1 || items[i - 1] === '-'))),
        els: [], sel: -1, entered: !!viaKeyboard, timer: null, pop: null };
      const checks = lv.items.some((it) => it !== '-' && it.checked !== undefined);
      const box = h('div.gb-menu', { role: 'menu' });
      lv.items.forEach((it, i) => {
        if (it === '-') { box.appendChild(h('div.gb-msep', { role: 'separator' })); lv.els.push(null); return; }
        const el = h('button.gb-mi', { type: 'button', role: checks ? 'menuitemcheckbox' : 'menuitem', tabIndex: -1, disabled: !!it.disabled, class: it.danger ? 'danger' : '', title: it.title,
          'aria-checked': checks ? String(!!it.checked) : null, 'aria-haspopup': it.children ? 'true' : null, onclick: () => runItem(lv, i, false) },
          checks ? h('span.gb-mcheck', it.checked ? Git.icon('actions/checked') : null) : null,
          h('span.gb-mlabel', it.label), it.shortcut ? h('span.gb-mkey', it.shortcut) : null, it.children ? h('span.gb-marrow', Git.icon('chevronRight')) : null);
        el.addEventListener('mousemove', (e) => {
          if (!moved(e)) return;
          clearTimeout(st.timer);
          st.levels.forEach((x) => { x.entered = x.depth <= lv.depth; });
          if (typeof lv.owner === 'string' && lv.owner !== 'gear' && st.sel !== lv.owner) select(lv.owner, false);
          if (lv.sel === i) return;
          setLevelSel(lv, it.disabled ? -1 : i);
          clearTimeout(lv.timer);
          lv.timer = setTimeout(() => {
            if (lv.sel !== i || lv.pop.closed) return;
            if (it.children && !it.disabled) runItem(lv, i, false); else closeLevels(lv.depth + 1);
          }, HOVER_MS);
        });
        box.appendChild(el);
        lv.els.push(el);
      });
      box.addEventListener('mousedown', (e) => e.preventDefault());   // the search field keeps the keyboard
      const o = { x: 0, y: 0, content: box, parent, className: 'gb-sub', onClose: () => {
        clearTimeout(lv.timer);
        const k = st.levels.indexOf(lv);
        if (k >= 0) st.levels.splice(k);
      } };
      lv.pop = Git.popup(o);
      const at = pos(lv.pop.el.offsetWidth, lv.pop.el.offsetHeight);
      o.x = at.x; o.y = at.y;
      lv.pop.place();
      st.levels[depth] = lv;
      if (viaKeyboard) setLevelSel(lv, lv.items.findIndex((it, i) => enabled(lv, i)));
      return lv;
    }
    /** Where a submenu goes: against the right edge of `ofEl` (2 px over it, as IntelliJ does), or on its left when there is no room. */
    const beside = (ofEl, top) => (w) => {
      const r = ofEl.getBoundingClientRect();
      const x = r.right - 2 + w > window.innerWidth - 8 ? r.left - w + 2 : r.right - 2;
      return { x, y: top };
    };
    function runItem(lv, i, viaKeyboard) {
      const it = lv.items[i];
      if (!enabled(lv, i)) return;
      if (it.children) {
        const open = st.levels[lv.depth + 1];
        if (open && open.owner === i) { if (viaKeyboard) { open.entered = true; setLevelSel(open, open.items.findIndex((x, k) => enabled(open, k))); } return; }
        const child = showLevel(lv.depth + 1, it.children, beside(lv.pop.el, lv.els[i].getBoundingClientRect().top - 8), i, viaKeyboard);
        child.pop.keepFor = lv.els[i];   // pressing the item again leaves its menu open
        return;
      }
      if (it.keepPopup) closeLevels(lv.depth); else B.close();
      if (it.action) it.action();
    }
    function openSub(r, viaKeyboard) {
      const el = rowNode(r.id);
      if (!el) return;
      const open = st.levels[0];
      if (open && open.owner === r.id) {
        if (viaKeyboard) { open.entered = true; setLevelSel(open, open.items.findIndex((x, k) => enabled(open, k))); }
        return;
      }
      const items = B.menuFor(r.name, r.kind);
      if (!items.length) return;
      const top = el.getBoundingClientRect().top;
      const lv = showLevel(0, items, beside(pop.el, top), r.id, viaKeyboard);
      lv.rowEl = el;
      lv.rowTop = top;
      lv.pop.keepFor = el;   // pressing the row again leaves its menu open
    }
    function gearMenu() {
      const open = st.levels[0];
      if (open && open.owner === 'gear') { closeLevels(0); return; }
      const toggle = (label, key) => ({ label, checked: prefs[key], keepPopup: true, action: () => { setPref(key, !prefs[key]); render(!!st.query.trim()); search.input.focus(); } });
      // branches__group_by_directory_option.png: the menu opens to the right of the gear
      const lv = showLevel(0, [toggle(t('Show Actions in Search Results'), 'actions'), '-', toggle(t('Group by Directory'), 'group'),
        toggle(t('Show Recent Branches'), 'recent'), toggle(t('Show Tags'), 'tags'),
        { label: t('Restore Popup Size'), checked: false, disabled: !resized(), keepPopup: true, action: () => restoreSize() }],
      beside(gearBtn, gearBtn.getBoundingClientRect().top - 6), 'gear', true);
      lv.pop.keepFor = gearBtn;
    }

    // ------------------------------------------------------------ size (the popup is resizable; Restore Popup Size)
    const sizeKey = 'branches.size';
    const resized = () => !!Git.host.prefs.get(sizeKey, null);
    function applySize() {
      const s = Git.host.prefs.get(sizeKey, null);
      pop.el.style.width = (s && s.w ? s.w : 375) + 'px';
      pop.el.style.height = s && s.h ? s.h + 'px' : '';
    }
    function restoreSize() { Git.host.prefs.set(sizeKey, null); applySize(); search.input.focus(); }
    // the corner grip drags the bottom-right corner, as the IDE's popup border does
    const grip = h('div.gb-grip', { 'aria-hidden': 'true' });
    grip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const box = pop.el.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY;
      const move = (ev) => {
        pop.el.style.width = Math.max(375, Math.min(window.innerWidth - box.left - 8, box.width + ev.clientX - x0)) + 'px';
        pop.el.style.height = Math.max(300, Math.min(window.innerHeight - box.top - 8, box.height + ev.clientY - y0)) + 'px';
        pop.el.style.maxHeight = 'none';
      };
      const up = () => {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
        const b = pop.el.getBoundingClientRect();
        Git.host.prefs.set(sizeKey, { w: Math.round(b.width), h: Math.round(b.height) });
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
    });
    root.appendChild(grip);

    // ------------------------------------------------------------ mouse
    /** False for the "moves" a browser reports when the list changes under a resting pointer. */
    function moved(e) {
      const m = st.mouse;
      st.mouse = { x: e.clientX, y: e.clientY };
      return !m || m.x !== e.clientX || m.y !== e.clientY;
    }
    const rowOf = (target) => {
      const el = target.closest && target.closest('.gb-row');
      return el ? st.rows.find((r) => r.id === el.dataset.id) : null;
    };
    function activate(r, viaKeyboard) {
      clearTimeout(st.timer);
      if (r.type === 'action') { B.close(); r.run(); }
      else if (r.type === 'section' || r.type === 'folder') { openState.set(r.id, !r.open); render(false); }
      else openSub(r, viaKeyboard);
    }
    root.addEventListener('mousedown', (e) => { if (e.target !== search.input) e.preventDefault(); });   // clicks in the popup leave the keyboard with the search field
    list.addEventListener('scroll', () => {
      // A branch's menu belongs beside its row: once the row scrolls away, the menu goes.
      const lv = st.levels[0];
      if (lv && lv.rowEl && Math.abs(lv.rowEl.getBoundingClientRect().top - lv.rowTop) > 1) closeLevels(0);
    });
    list.addEventListener('click', (e) => { const r = rowOf(e.target); if (r) { select(r.id, false); activate(r, false); } });
    list.addEventListener('mousemove', (e) => {
      if (!moved(e)) return;
      const r = rowOf(e.target);
      if (!r) return;
      st.levels.forEach((lv) => { lv.entered = false; setLevelSel(lv, -1); });
      if (st.sel !== r.id) select(r.id, false);
      clearTimeout(st.timer);
      const open = st.levels[0];
      if (open && open.owner === r.id) return;
      // A row's menu opens on a click, or when the pointer rests on the row's arrow (›), as in IntelliJ (research
      // notes C §5). Not because the pointer rests on the row (the owner, 17 Nov 2026: in a long list every row the
      // pointer stopped on threw its menu open). Resting on another row closes a menu that is open.
      const onArrow = !!(e.target.closest && e.target.closest('.gb-more'));
      st.timer = setTimeout(() => {
        if (st.sel !== r.id || pop.closed) return;
        if (onArrow && (r.type === 'branch' || r.type === 'tag')) openSub(r, false);
        else if (st.levels[0] && st.levels[0].owner !== 'gear') closeLevels(0);
      }, HOVER_MS);
    });

    // ------------------------------------------------------------ keyboard (the search field has the focus throughout)
    /** The keys of a selected branch row (§4.5 / §4.7): Space favorite (while nothing is typed: a search may hold a
        space), ⌘C copies the name (unless text of the field is selected), F2 Rename. True when the key was taken. */
    function rowKey(e, r) {
      const input = search.input;
      if (e.key === ' ' && !input.value && !e.metaKey && !e.ctrlKey && !e.altKey && r.type === 'branch') {
        e.preventDefault(); A.toggleFavorite(A.ref(r.kind, r.name)); return true;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'c' || e.key === 'C') && input.selectionStart === input.selectionEnd) {
        e.preventDefault(); Git.copy(r.name); return true;
      }
      if (e.key === 'F2' && r.kind === 'local') { e.preventDefault(); B.close(); A.renameBranch(A.ref('local', r.name)); return true; }
      return false;
    }
    function menuKey(e, lv) {
      const step = (dir) => {
        const n = lv.items.length;
        for (let k = 1; k <= n; k++) { const i = (((lv.sel < 0 && dir < 0 ? 0 : lv.sel) + dir * k) % n + n) % n; if (enabled(lv, i)) { setLevelSel(lv, i); return; } }
      };
      if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); runItem(lv, lv.sel, true); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); if (lv.items[lv.sel] && lv.items[lv.sel].children) runItem(lv, lv.sel, true); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); closeLevels(lv.depth); }
    }
    root.addEventListener('keydown', (e) => {
      const top = st.levels[st.levels.length - 1];
      const input = search.input;
      // ⌘F: back to the search field (out of a submenu the keyboard walks)
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); closeLevels(0); input.focus(); input.select(); return; }
      if (top && top.entered) { menuKey(e, top); return; }
      const rows = selectable();
      const i = rows.findIndex((r) => r.id === st.sel);
      const r = rows[i];
      if (r && (r.type === 'branch' || r.type === 'tag') && rowKey(e, r)) return;
      const atEnd = !input.value || (e.target === input && input.selectionStart === input.value.length);
      const atStart = !input.value || (e.target === input && input.selectionEnd === 0);
      const go = (k) => { const next = rows[Math.max(0, Math.min(rows.length - 1, k))]; closeLevels(0); if (next) select(next.id, true); };
      if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); go(i < 0 ? 0 : i - 1); }
      else if (e.key === 'Enter' && r && e.target.tagName !== 'BUTTON') { e.preventDefault(); e.stopPropagation(); activate(r, true); }
      else if (e.key === 'ArrowRight' && r && atEnd) {
        if (r.type === 'branch' || r.type === 'tag') { e.preventDefault(); openSub(r, true); }
        else if ((r.type === 'section' || r.type === 'folder') && !r.open) { e.preventDefault(); activate(r, true); }
      } else if (e.key === 'ArrowLeft' && r && atStart) {
        if ((r.type === 'section' || r.type === 'folder') && r.open) { e.preventDefault(); activate(r, true); }
        else if (r.depth) {
          e.preventDefault();
          for (let k = i - 1; k >= 0; k--) { if (rows[k].depth < r.depth) { go(k); break; } }
        }
      }
    });

    render(false);
    applySize();
    // The popup grows as nodes open; it may reach the window's bottom edge but not pass it.
    pop.el.style.maxHeight = Math.max(240, window.innerHeight - pop.el.getBoundingClientRect().top - 8) + 'px';
    setTimeout(() => { if (!pop.closed) search.input.focus(); }, 0);
    return { pop, state: st, render };
  }
})();
