/* The Log's commits toolbar (split out of log.js): the Text or hash field (applied on Enter or when it loses
   focus; the ▾ by the magnifier lists previous patterns) with Regex and Match Case, the Branch / User / Date / Paths
   filters and their popups (Branch and Paths "Select…" take several values), Graph Options (Sort, First Parent, No
   Merges, Collapse / Expand Linear Branches), Refresh, Cherry-Pick, View Options (the eye) and Go To Hash/Branch/Tag.
   L.filters = { build(v), fit(v), value(key), set(key, value), reset(), title(), goTo(), validBranch(name) }
   It works on the mounted view through L.core (log.js): { state, inst(), render(), reveal(id), cherryPick(), canCherryPick(ids) }. */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = Git.t;
  const R = Git.repo;
  const L = (Git.logUI = Git.logUI || {});
  const C = () => L.core;

  Git.addTR({
    'Text or hash': 'Metin ya da hash', 'Regex': 'Regex', 'Match Case': 'Büyük/küçük harf duyarlı', 'Clear': 'Temizle',
    'Branch': 'Dal', 'User': 'Kullanıcı', 'Date': 'Tarih', 'Paths': 'Yollar', 'Select…': 'Seç…', 'Favorites': 'Favoriler', 'Recent': 'Son kullanılanlar',
    'Local': 'Yerel', 'Remote': 'Uzak', 'Tags': 'Etiketler', 'me': 'ben', 'Last 24 hours': 'Son 24 saat', 'Last 7 days': 'Son 7 gün',
    'Select Period': 'Dönem seç', 'After:': 'Başlangıç:', 'Before:': 'Bitiş:', 'since {0}': '{0} sonrası', 'until {0}': '{0} öncesi',
    'between {0} and {1}': '{0} – {1}', 'Select Paths to Filter by': 'Süzülecek yolları seç', 'Refresh': 'Yenile', 'Cherry-Pick': 'Cherry-Pick',
    'Presentation Settings': 'Görünüm ayarları', 'Go To Hash/Branch/Tag': 'Hash\'e, dala ya da etikete git',
    'Enter hash or branch/tag name:': 'Hash ya da dal/etiket adı gir:', "Commit or reference '{0}' not found": "'{0}' adında commit ya da referans bulunamadı",
    'Show': 'Göster', 'Compact References View': 'Referansları tek etikette topla', 'Tag Names': 'Etiket adları', 'Long Edges': 'Uzun kenarlar',
    'Columns': 'Sütunlar', 'Author': 'Yazar', 'Hash': 'Hash', 'Highlight': 'Vurgula', 'My Commits': 'Benim commit\'lerim',
    'Merge Commits': 'Merge commit\'leri', 'Current Branch': 'Geçerli dal', 'Log': 'Log',
    'Branch name, or a range like main..feature': 'Dal adı ya da main..feature gibi bir aralık',
    'View Options': 'Görünüm seçenekleri', 'Commit Timestamp': 'Commit zamanı', 'References on the Left': 'Referanslar solda',
    'Graph Options': 'Grafik seçenekleri', 'Sort': 'Sıralama', 'By Commit Date': 'Commit tarihine göre', 'Topologically': 'Topolojik',
    'Options': 'Seçenekler', 'First Parent': 'Yalnız ilk ebeveyn', 'No Merges': 'Merge\'ler olmadan',
    'Collapse Linear Branches': 'Doğrusal dalları kapat', 'Expand Linear Branches': 'Doğrusal dalları aç',
    'Select in Tree…': 'Ağaçtan seç…', 'Recent Searches': 'Son aramalar', 'new lines': 'yeni satır', 'or {0}': 'ya da {0}',
    'Select one or more values separated with {0}, use {1} to finish': 'Bir ya da birkaç değeri {0} ile ayır, bitirmek için {1}',
  });

  // ---------------------------------------------------------------- values and changes
  const pad = (n) => String(n).padStart(2, '0');
  const dayText = (ms) => { const d = new Date(ms); return Git.dateOrder() === 'dmy' ? pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.' + d.getFullYear() : d.getMonth() + 1 + '/' + d.getDate() + '/' + String(d.getFullYear()).slice(2); };
  /** A Branch filter value that still names something: a ref, or a range whose two ends exist. */
  function validBranch(name) {
    const range = typeof name === 'string' ? L.parseRange(name) : null;
    return range ? !!(L.filterRefId(range.base) && L.filterRefId(range.tip)) : !!L.filterRefId(name);
  }
  function value(key) {
    const f = C().state.filter;
    if (key === 'branch') return f.branch ? f.branch.map(L.filterLabel).join(', ') : null;
    if (key === 'user') return f.user ? (f.user.me ? t('me') : f.user.label) : null;
    if (key === 'paths') return f.paths ? f.paths.map(Git.fileName).join(', ') : null;
    if (!f.date) return null;
    return f.date.after && f.date.before ? t('between {0} and {1}', dayText(f.date.after), dayText(f.date.before))
      : f.date.after ? t('since {0}', dayText(f.date.after)) : t('until {0}', dayText(f.date.before));
  }
  /** The tab says what the Branch filter shows: "Log: main", "Log: main..feature". */
  function title() {
    const b = C().state.filter.branch;
    if (Git.frame && Git.frame.setTabTitle) Git.frame.setTabTitle('log', b ? t('Log') + ': ' + b.map(L.filterLabel).join(', ') : t('Log'));
  }
  function set(key, v) {
    C().state.filter[key] = v;
    if (key === 'branch') title();
    const inst = C().inst();
    if (inst) { inst.filterAt = performance.now(); build(inst); C().render(); }
  }
  function reset() {
    Object.assign(C().state.filter, { text: '', branch: null, user: null, date: null, paths: null });
    title();
    const inst = C().inst();
    if (inst) { if (inst.search) inst.search.input.value = ''; build(inst); C().render(); }
  }

  // ---------------------------------------------------------------- popups
  /** A text field over a list of suggestions: Go to Hash/Branch/Tag and the "Select…" choice of the Branch and User filters. */
  function ask(o) {
    let shown = [], active = -1;
    const list = h('div.gl-suggest', { role: 'listbox' });
    const field = Git.field({ placeholder: o.placeholder, onInput: () => { active = -1; draw(); } });
    const pop = Git.popup({ anchor: o.anchor, placement: 'below', width: o.width || 300, className: 'gl-ask',
      content: h('div.gl-ask-body', o.label ? h('div.gl-ask-label', o.label) : null, field, list) });
    const pick = (text) => { if (!text) return; pop.close(); o.onPick(text); };
    function draw() {
      const q = field.input.value.trim().toLowerCase();
      shown = !q && o.typed ? [] : o.items().filter((s) => !q || s.toLowerCase().indexOf(q) >= 0).slice(0, 10);
      Git.clear(list);
      shown.forEach((s, i) => {
        const k = q ? s.toLowerCase().indexOf(q) : -1;
        list.appendChild(h('button.gl-suggest-item', { type: 'button', role: 'option', class: i === active ? 'on' : '', onclick: () => pick(s) },
          k < 0 ? s : [s.slice(0, k), h('b', s.slice(k, k + q.length)), s.slice(k + q.length)]));
      });
      list.hidden = !shown.length;
      pop.place();
    }
    field.input.addEventListener('keydown', (e) => {
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && shown.length) {
        e.preventDefault();
        active = e.key === 'ArrowDown' ? (active + 1) % shown.length : (active <= 0 ? shown.length : active) - 1;
        draw();
      } else if (e.key === 'Enter') { e.preventDefault(); pick(active >= 0 && !(e.metaKey || e.ctrlKey) ? shown[active] : field.input.value.trim()); }
    });
    draw();
    setTimeout(() => field.input.focus(), 0);
    return pop;
  }
  /** IntelliJ's multi-value "Select…" popup of a filter: values on separate lines or separated with |, the current line
      completes from `items()`, ⌘↵ finishes (vcs.log.filter.popup.advertisement.with.key.text). */
  function askMany(o) {
    let shown = [], active = -1;
    const list = h('div.gl-suggest', { role: 'listbox' });
    const field = Git.field({ id: o.id, multiline: true, rows: 3, placeholder: o.placeholder, value: o.value || '', onInput: () => { active = -1; draw(); } });
    const ad = h('div.gl-ask-ad', t('Select one or more values separated with {0}, use {1} to finish', '| ' + t('or {0}', t('new lines')), '⌘⏎'));
    const pop = Git.popup({ anchor: o.anchor, placement: 'below', width: o.width || 320, className: 'gl-ask gl-ask-many', content: h('div.gl-ask-body', field, list, ad) });
    const ta = field.input;
    const lineAt = () => { const before = ta.value.slice(0, ta.selectionStart); const start = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('|')) + 1; return { start, text: before.slice(start).trim() }; };
    const put = (s) => {
      const at = lineAt(), rest = ta.value.slice(ta.selectionStart).replace(/^[^\n|]*/, '');
      ta.value = ta.value.slice(0, at.start) + (at.start && ta.value[at.start - 1] === '|' ? ' ' : '') + s + rest;
      ta.selectionStart = ta.selectionEnd = ta.value.length - rest.length;
      active = -1; draw(); ta.focus();
    };
    function draw() {
      const q = lineAt().text.toLowerCase();
      shown = !q ? [] : o.items().filter((s) => s.toLowerCase().indexOf(q) >= 0).slice(0, 8);
      Git.clear(list);
      shown.forEach((s, i) => list.appendChild(h('button.gl-suggest-item', { type: 'button', role: 'option', class: i === active ? 'on' : '', onclick: () => put(s) }, s)));
      list.hidden = !shown.length;
      pop.place();
    }
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const values = ta.value.split(/[\n|]/).map((s) => s.trim()).filter(Boolean);
        pop.close();
        if (values.length) o.onPick(Array.from(new Set(values)));
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && shown.length) {
        e.preventDefault();
        active = e.key === 'ArrowDown' ? (active + 1) % shown.length : (active <= 0 ? shown.length : active) - 1;
        draw();
      } else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); put(shown[active]); }
    });
    draw();
    setTimeout(() => ta.focus(), 0);
    return pop;
  }
  const allRefs = () => ['HEAD'].concat(Git.localBranches(), Git.remoteBranches(), Git.tagNames());
  const notFound = (text) => Git.notify({ kind: 'warning', title: t("Commit or reference '{0}' not found", text) });
  function open(key, anchor) {
    if (key === 'branch') {
      const star = Git.icon('nodes/star').innerHTML, shell = !!Git.popupMenu;
      // an entry of a group is the pair of that group (a local and a remote branch of one name are two entries); a
      // value typed into Select… is text (names and ranges, as IntelliJ's), resolved by L.filterRefId
      const A = Git.actions;
      const pick = (ref, fav) => { const name = L.filterLabel(ref); return { label: fav && !shell ? '★ ' + name : name, iconHTML: fav ? star : undefined, action: () => set('branch', [ref]) }; };
      const favs = A.favorites().sort((a, b) => L.natural(a.name, b.name));
      const recent = (R.recent || []).filter((n) => Git.isLocal(n)).map((n) => A.ref('local', n));
      const remotes = {};
      Git.remoteBranches().forEach((n) => { const r = n.split('/')[0]; (remotes[r] = remotes[r] || []).push(n); });
      Git.menu(anchor, [
        { label: t('Select…'), action: () => askMany({ anchor, id: 'gl-branch-select', placeholder: t('Branch name, or a range like main..feature'), items: allRefs,
          value: (C().state.filter.branch || []).map(L.filterLabel).join('\n'),
          onPick: (values) => { const ok = values.filter(validBranch); values.filter((s) => !validBranch(s)).forEach(notFound); if (ok.length) set('branch', ok); } }) },
        recent.length ? { label: t('Recent'), children: recent.map((n) => pick(n)) } : null,
        { label: t('Favorites'), disabled: !favs.length, action: () => set('branch', favs) },
        pick(A.ref('revision', 'HEAD'), true)].filter(Boolean).concat(favs.map((r) => pick(r, true)), ['-', { label: t('Local'), children: Git.localBranches().map((n) => pick(A.ref('local', n))) }],
        Object.keys(remotes).sort().map((r) => ({ label: r + '/…', children: remotes[r].map((n) => pick(A.ref('remote', n))) }))));
    } else if (key === 'user') {
      const setUser = (user) => set('user', user);
      const byName = (s) => { const k = Object.keys(R.authors).find((a) => R.authors[a].name.toLowerCase() === s.toLowerCase()); return k ? { key: k, label: R.authors[k].name } : { text: s, label: s }; };
      Git.menu(anchor, [
        { label: t('Select…'), action: () => ask({ anchor, placeholder: t('User'), items: () => Object.keys(R.authors).map((k) => R.authors[k].name), onPick: (s) => setUser(byName(s)) }) },
        { label: t('me'), action: () => setUser({ me: true }) }, '-',
      ].concat(Object.keys(R.authors).sort((a, b) => L.natural(R.authors[a].name, R.authors[b].name)).map((k) => ({ label: R.authors[k].name, action: () => setUser({ key: k, label: R.authors[k].name }) }))));
    } else if (key === 'date') {
      Git.menu(anchor, [
        { label: t('Select…'), action: periodDialog },
        { label: t('Last 24 hours'), action: () => set('date', { after: Date.now() - 864e5, before: null }) },
        { label: t('Last 7 days'), action: () => set('date', { after: Date.now() - 7 * 864e5, before: null }) },
      ]);
    } else {
      // Paths: Select in Tree…, Select… (paths typed in), then the paths used last (vcs.log.filter.select.folders / edit.folders)
      const recent = recentPaths().filter((list) => !samePaths(list, C().state.filter.paths));
      Git.menu(anchor, [{ label: t('Select in Tree…'), action: pathsDialog },
        { label: t('Select…'), action: () => askMany({ anchor, id: 'gl-paths-select', placeholder: t('Paths'), value: (C().state.filter.paths || []).join('\n'),
          items: () => Array.from(new Set(recentPaths().flat().concat((R.local || []).map((c) => c.path)))),
          onPick: (values) => setPaths(values.map((p) => p.replace(/^\/+|\/+$/g, '')).filter(Boolean)) }) }]
        .concat(recent.length ? ['-'] : [], recent.map((list) => ({ label: list.join(', '), action: () => setPaths(list) }))));
    }
  }
  const PATHS_KEY = 'log.recentPaths';
  const recentPaths = () => { const v = Git.host.prefs.get(PATHS_KEY, []); return Array.isArray(v) ? v.filter(Array.isArray) : []; };
  const samePaths = (a, b) => !!a && !!b && a.join('\0') === b.join('\0');
  /** Sets the Paths filter and remembers it among the last five. */
  function setPaths(list) {
    const v = list && list.length ? Array.from(new Set(list)).sort() : null;
    if (v) Git.host.prefs.set(PATHS_KEY, [v].concat(recentPaths().filter((x) => !samePaths(x, v))).slice(0, 5));
    set('paths', v);
  }
  function periodDialog() {
    const cur = C().state.filter.date || {};
    const iso = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
    const input = (ms, id) => h('input.g-input', { type: 'date', id, value: ms ? iso(ms) : '', class: ms ? '' : 'empty', oninput: (e) => e.target.classList.toggle('empty', !e.target.value) });
    const after = input(cur.after, 'gl-period-after'), before = input(cur.before, 'gl-period-before');
    Git.dialog({ title: t('Select Period'), width: 340,
      content: h('div.gl-period', h('span.g-label', t('After:')), h('div.g-field', after), h('span.g-label', t('Before:')), h('div.g-field', before)),
      buttons: [{ label: t('Cancel') }, { label: t('OK'), primary: true, id: 'gl-period-ok', onClick: () => {
        const a = after.value ? new Date(after.value + 'T00:00:00').getTime() : null, b = before.value ? new Date(before.value + 'T23:59:59').getTime() : null;
        set('date', a || b ? { after: a, before: b } : null);
      } }] });
  }
  function pathsDialog() {
    const picked = new Set(C().state.filter.paths || []);
    // The work tree's folders, read a level at a time (fs.complete lists the folders of a folder).
    const kids = new Map();                       // relative folder ('' = root) -> [names] | null while loading
    const load = (dir) => {
      if (kids.has(dir)) return;
      kids.set(dir, null);
      Git.backend.call('fs.complete', { prefix: R.root + '/' + (dir ? dir + '/' : ''), limit: 500 }).then((res) => {
        kids.set(dir, (res.entries || []).map((e) => e.name).filter((n) => n !== '.git').sort(L.natural));
        if (!dlg.closed) tree.render();
      }, () => { kids.set(dir, []); if (!dlg.closed) tree.render(); });
    };
    const nodes = (dir, depth) => {
      const names = kids.get(dir);
      if (!names) return [{ id: dir + '/…', label: t('Loading…'), kind: 'note', selectable: false, dim: '' }];
      return names.map((name) => {
        const id = dir ? dir + '/' + name : name;
        if (depth < 1) load(id);
        return { id, label: name, icon: 'nodes/folder', checked: picked.has(id), open: depth < 1,
          children: kids.has(id) ? nodes(id, depth + 1) : [{ id: id + '/…', label: '', kind: 'note', selectable: false }] };
      });
    };
    const el = h('div.gl-paths-tree');
    let dlg = { closed: false };
    const tree = Git.tree({ el, nodes: () => nodes('', 0), onToggle: (node, on) => { if (on && node.kind !== 'note') load(node.id); },
      onCheck: (node, on) => { if (on) picked.add(node.id); else picked.delete(node.id); tree.render(); } });
    load('');
    tree.render();
    dlg = Git.dialog({ title: t('Select Paths to Filter by'), width: 420, height: 460, content: el,
      buttons: [{ label: t('Cancel') }, { label: t('OK'), primary: true, id: 'gl-paths-ok', onClick: () => setPaths(Array.from(picked)) }] });
  }
  function goTo() {
    const inst = C().inst();
    if (!inst) return;
    ask({ anchor: inst.search, width: 330, typed: true, label: t('Enter hash or branch/tag name:'), items: allRefs, onPick: (text) => {
      let id = Git.refId(text);
      if (!id && /^[0-9a-f]{4,40}$/i.test(text)) { const hits = Array.from(R.commits.keys()).filter((k) => k.indexOf(text.toLowerCase()) === 0); if (hits.length === 1) id = hits[0]; }
      if (id && C().reveal(id)) return;
      notFound(text);
    } });
  }
  function viewOptions(anchor) {
    const opts = L.opts;
    const toggle = (key, label) => ({ label, checked: !!opts[key], action: () => { opts[key] = !opts[key]; L.saveOpts(); C().render(); } });
    const head = (label) => ({ label, header: label, disabled: true });
    // Vcs.Log.PresentationSettings (Root Names: one root only; Not Cherry-Picked Commits: not built)
    Git.menu(anchor, [head(t('Show')), toggle('compact', t('Compact References View')), toggle('tagNames', t('Tag Names')), toggle('longEdges', t('Long Edges')),
      toggle('commitDate', t('Commit Timestamp')), toggle('labelsLeft', t('References on the Left')),
      { label: t('Columns'), checked: false, children: [toggle('author', t('Author')), toggle('date', t('Date')), toggle('hash', t('Hash'))] }, '-',
      head(t('Highlight')), toggle('hlMine', t('My Commits')), toggle('hlMerge', t('Merge Commits')), toggle('hlCurrent', t('Current Branch'))]
      .concat(Git.options ? Git.options.rows() : Git.languageMenu()));   // the language and Report a Problem live in the header's Options button (options.js); here only on a page without one
  }
  /** Graph Options (Vcs.Log.GraphOptionsGroup): Sort, Options (First Parent, No Merges), Collapse / Expand Linear Branches. */
  function graphOptions(anchor) {
    const opts = L.opts;
    const head = (label) => ({ label, header: label, disabled: true });
    const apply = () => { L.saveOpts(); const inst = C().inst(); if (inst) inst.filterAt = performance.now(); C().render(); };
    const sort = (value, label) => ({ label, checked: (opts.sort || 'date') === value, action: () => { opts.sort = value; apply(); } });
    const flag = (key, label) => ({ label, checked: !!opts[key], action: () => { opts[key] = !opts[key]; apply(); } });
    Git.menu(anchor, [head(t('Sort')), sort('date', t('By Commit Date')), sort('topo', t('Topologically')), '-',
      head(t('Options')), flag('firstParent', t('First Parent')), flag('noMerges', t('No Merges')), '-',
      { label: t('Collapse Linear Branches'), action: () => { L.setCollapsed(true); C().render(); } },
      { label: t('Expand Linear Branches'), action: () => { L.setCollapsed(false); C().render(); } }]);
  }
  // ---------------------------------------------------------------- the text filter's previous patterns (the ▾ by the magnifier)
  const HISTORY_KEY = 'log.textHistory';
  const textHistory = () => { const v = Git.host.prefs.get(HISTORY_KEY, []); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; };
  const remember = (text) => { if (text) Git.host.prefs.set(HISTORY_KEY, [text].concat(textHistory().filter((x) => x !== text)).slice(0, 20)); };

  // ---------------------------------------------------------------- the toolbar
  const FILTERS = [['branch', 'Branch'], ['user', 'User'], ['date', 'Date'], ['paths', 'Paths']];
  function build(v) {
    const f = C().state.filter;
    // The text goes to the engine (log.search) as IntelliJ applies it: on Enter or when the field loses focus.
    const apply = (text) => {
      clearTimeout(v.typing);
      if (C().inst() !== v || text === f.text) return;
      v.filterAt = performance.now();
      f.text = text;
      remember(text);
      C().render();
    };
    const setText = (text) => { clear.hidden = !text; };
    const flag = (key, icon, label) => h('button.gl-field-btn', { type: 'button', title: label, 'aria-label': label, 'aria-pressed': String(f[key]), class: f[key] ? 'on' : '',
      dataset: { flag: key }, onclick: (e) => { f[key] = !f[key]; e.currentTarget.classList.toggle('on', f[key]); e.currentTarget.setAttribute('aria-pressed', String(f[key])); C().render(); } }, Git.icon(icon));
    const clear = h('button.gl-field-btn.gl-clear', { type: 'button', title: t('Clear'), 'aria-label': t('Clear'), hidden: !f.text,
      onclick: () => { v.search.input.value = ''; setText(''); apply(''); v.search.input.focus(); } }, Git.icon('closeSmall'));
    v.search = Git.field({ placeholder: t('Text or hash'), value: f.text, onInput: setText,
      trailing: h('span.gl-field-tools', clear, flag('regex', 'inline/regex', t('Regex')), flag('matchCase', 'inline/matchCase', t('Match Case'))) });
    v.search.classList.add('gl-search');
    // the magnifier with its ▾: the previous patterns
    v.search.insertBefore(h('button.gl-field-btn.gl-history-btn', { type: 'button', id: 'gl-text-history', title: t('Recent Searches'), 'aria-label': t('Recent Searches'),
      onclick: (e) => {
        const list = textHistory();
        Git.menu(e.currentTarget, list.length ? list.map((s) => ({ label: s, action: () => { v.search.input.value = s; setText(s); apply(s); } }))
          : [{ label: t('Recent Searches'), disabled: true }]);
      } }, Git.icon('inline/searchHistory')), v.search.input);
    v.search.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); apply(v.search.input.value); v.table.focus(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); v.table.focus(); }
    });
    v.search.input.addEventListener('blur', () => apply(v.search.input.value));
    v.chips = FILTERS.map(([key, name]) => {
      const val = value(key);
      const el = h('div.gl-filter', { class: val ? 'set' : '', dataset: { key } });
      el.appendChild(h('button.gl-filter-btn', { type: 'button', title: val ? t(name) + ': ' + val : null, onclick: () => open(key, el) },
        h('span', val ? t(name) + ':' : t(name)), val ? h('span.gl-filter-value', val) : Git.icon('general/chevronDown')));
      if (val) el.appendChild(h('button.gl-filter-x', { type: 'button', title: t('Clear'), 'aria-label': t('Clear'), onclick: () => set(key, null) }, Git.icon('closeSmall')));
      return el;
    });
    v.more = Git.toolBtn({ icon: 'general/chevronRight', title: '', onClick: (e) => {
      const at = e.currentTarget;
      Git.menu(at, v.chips.filter((c) => c.hidden).map((c) => { const key = c.dataset.key, val = value(key), name = t(FILTERS.find((x) => x[0] === key)[1]);
        return { label: val ? name + ': ' + val : name, action: () => open(key, at) }; }));
    } });
    v.cherry = Git.toolBtn({ icon: 'dvcs/cherryPick', title: t('Cherry-Pick'), id: 'gl-cherry', disabled: !C().canCherryPick(C().state.sel), onClick: () => C().cherryPick() });
    v.graphBtn = Git.toolBtn({ icon: 'vcslog/intelliSort', title: t('Graph Options'), id: 'gl-graph', arrow: false, onClick: (e) => graphOptions(e.currentTarget) });
    v.graphBtn.classList.add('gl-graph-btn');
    // narrow and medium: the Branches drawer's button comes first (log-layout.js)
    v.left = h('div.gl-cbar-left', v.layout && v.layout.stacked() ? v.layout.button : null, v.search, v.chips, v.more, v.graphBtn);
    Git.clear(v.bar);
    v.bar.appendChild(v.left);
    v.bar.appendChild(h('div.gl-cbar-right',
      Git.toolBtn({ icon: 'general/refresh', title: t('Refresh') + '  ⌘R', id: 'gl-refresh', onClick: () => { Git.store.refresh(); C().render(); } }), v.cherry,
      Git.toolBtn({ icon: 'general/show', title: t('View Options'), id: 'gl-view', onClick: (e) => viewOptions(e.currentTarget) }),
      Git.toolBtn({ icon: 'general/search', title: t('Go To Hash/Branch/Tag') + '  ⌘F', id: 'gl-goto', onClick: goTo })));
    fit(v);
  }
  /** Filters that do not fit go behind a › button, from the right; the ones in use are the last to go. Then the
      Branches button (narrow and medium) drops its label, and only then the search field gives way. */
  function fit(v) {
    if (!v || !v.left) return;
    const bopen = v.layout && v.layout.button.parentNode === v.left ? v.layout.button : null;
    if (v.layout) v.layout.button.classList.remove('icon-only');
    v.chips.forEach((c) => { c.hidden = false; });
    v.more.hidden = true;
    v.more.classList.remove('on');
    v.left.classList.remove('tight');
    const over = () => v.left.scrollWidth > v.left.clientWidth;
    if (!over()) return;
    v.more.hidden = false;
    const inUse = (c) => c.classList.contains('set');
    for (let i = v.chips.length - 1; i >= 0 && over(); i--) if (!inUse(v.chips[i])) v.chips[i].hidden = true;
    for (let i = v.chips.length - 1; i >= 0 && over(); i--) v.chips[i].hidden = true;
    for (let i = 0; i < v.chips.length && !over(); i++) if (v.chips[i].hidden && !inUse(v.chips[i])) { v.chips[i].hidden = false; if (over()) { v.chips[i].hidden = true; break; } }
    const hidden = v.chips.filter((c) => c.hidden);
    const names = hidden.map((c) => t(FILTERS.find((x) => x[0] === c.dataset.key)[1])).join(', ');
    v.more.title = names;
    v.more.setAttribute('aria-label', names);
    v.more.classList.toggle('on', hidden.some(inUse));
    if (over() && bopen) bopen.classList.add('icon-only');         // the Branches button keeps its icon and tooltip
    if (over()) v.left.classList.add('tight');                     // not even the search field fits: it gives way too
  }

  L.filters = { build, fit, value, set, reset, title, goTo, validBranch };
})();
