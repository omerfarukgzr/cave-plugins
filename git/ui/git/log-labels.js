/* The Log's remembered view options and its ref labels (split out of log.js).
   L.opts (Presentation Settings, Branches pane and Changed Files choices; Git.host.prefs `log.opts`) · L.saveOpts()
   L.measure(text, font) · L.refColor(type) · L.tagIcon(colors) · L.refGroups(refs, compact, showTagNames)
   L.groupColors(group) · L.labelBlock(groups, room, font, names) · L.branchMenu(name) */
(function () {
  'use strict';
  const Git = window.Git;
  const h = Git.h, t = Git.t;
  const R = Git.repo, A = Git.actions;
  const L = (Git.logUI = Git.logUI || {});
  const NS = 'http://www.w3.org/2000/svg';

  // ---------------------------------------------------------------- remembered options
  const store = { get: (k, d) => Git.host.prefs.get('log.' + k, d), set: (k, v) => Git.host.prefs.set('log.' + k, v) };
  L.opts = Object.assign({ compact: true, tagNames: false, longEdges: false, author: true, date: true, hash: false,
    hlMine: true, hlMerge: true, hlCurrent: true, branches: true, onClick: 'filter', groupByDir: true, showTags: true, myBranches: false,
    filesByDir: true, sort: 'date', firstParent: false, noMerges: false, commitDate: false, labelsLeft: false,
    details: true, preview: false, previewAt: 'bottom' }, store.get('opts', {}));
  L.saveOpts = () => store.set('opts', L.opts);

  // ---------------------------------------------------------------- small helpers
  L.svgEl = (name, attrs, style) => {
    const n = document.createElementNS(NS, name);
    Object.keys(attrs).forEach((k) => n.setAttribute(k, attrs[k]));
    if (style) Object.assign(n.style, style);
    return n;
  };
  let pen = null;
  const widths = new Map();
  L.measure = function (text, font) {
    const key = font + '|' + text;
    if (!widths.has(key)) {
      pen = pen || document.createElement('canvas').getContext('2d');
      pen.font = font;
      if (widths.size > 20000) widths.clear();
      widths.set(key, pen.measureText(text).width);
    }
    return widths.get(key);
  };
  L.natural = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

  // ---------------------------------------------------------------- ref labels (LabelIcon, TagPainter, GitRefManager.groupForTable)
  const TAG = 'M13.4495 7.5001L7.01028 13.9394C6.81502 14.1347 6.49843 14.1347 6.30317 13.9394L2.06053 9.69679C1.86527 9.50152 1.86527 9.18494 2.06053 8.98968'
    + 'L8.49978 2.55035C8.61106 2.43907 8.76824 2.38667 8.92404 2.40893L12.6363 2.93926C12.8563 2.97069 13.0292 3.14354 13.0606 3.36352'
    + 'L13.5909 7.07584C13.6132 7.23163 13.5608 7.38882 13.4495 7.5001Z';
  const BG = 'var(--g-row-bg, var(--g-panel))';
  const ICON = 16;
  const iconWidth = (n) => Math.round(((6.25 + 2 * (n - 1)) * ICON) / 6.25);
  L.refColor = (type) => 'var(--g-ref-' + type + ')';
  /** The tag-shaped icon of a ref label: one outline per color, stacked to the right; the top one carries the dot. */
  L.tagIcon = function (colors) {
    const n = colors.length, s = ICON / 16, step = (2 * ICON) / 6.25, width = iconWidth(n);
    const svg = L.svgEl('svg', { class: 'gl-tag', width, height: ICON, viewBox: '0 0 ' + width + ' ' + ICON, 'aria-hidden': 'true', focusable: 'false' });
    const tag = (x, color) => svg.appendChild(L.svgEl('path', { d: TAG, transform: 'translate(' + x + ' 0) scale(' + s + ')', 'stroke-width': 1, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
      { fill: BG, stroke: color }));
    for (let i = 0; i < n; i++) {
      const color = colors[n - 1 - i];
      tag(step * i, color);
      if (i === n - 1) svg.appendChild(L.svgEl('circle', { cx: step * i + 10.5 * s, cy: 5.5 * s, r: s }, { fill: color }));
      else tag(step * i + step - Math.SQRT2, BG);
    }
    return svg;
  };
  /** Label order (GitLabelComparator): HEAD, current branch, main, origin/main, local branches, remote branches, tags. */
  function labelKind(r) {
    if (r.type === 'head') return 0;
    if (r.type === 'local') return r.current ? 1 : r.name === 'main' || r.name === 'master' ? 2 : 4;
    if (r.type === 'remote') return r.name === 'origin/main' || r.name === 'origin/master' ? 3 : 5;
    return 6;
  }
  /** Which labels a commit gets and what they are called: a local branch and its remote at the same commit become
      "origin & main", HEAD joins the first label, the compact view folds everything into one label. */
  L.refGroups = function (refs, compact, showTagNames) {
    if (!refs.length) return [];
    const by = { head: [], local: [], remote: [], tag: [] };
    refs.slice().sort((a, b) => labelKind(a) - labelKind(b) || L.natural(a.name, b.name)).forEach((r) => by[r.type].push(r));
    const tracked = [];
    by.local.forEach((local) => {
      const up = Git.upstream(local.name);
      const remote = (up && by.remote.find((r) => r.name === up)) || by.remote.find((r) => r.name === R.remoteName + '/' + local.name);
      if (remote) tracked.push({ name: remote.name.split('/')[0] + ' & ' + local.name, refs: [local, remote] });
    });
    tracked.forEach((g) => { by.local = by.local.filter((r) => r !== g.refs[0]); by.remote = by.remote.filter((r) => r !== g.refs[1]); });
    const first = [];
    const cur = by.local.find((r) => r.current);
    if (cur) { by.local = by.local.filter((r) => r !== cur); first.push({ name: cur.name, refs: [cur] }); }
    const groups = first.concat(tracked);
    const rest = ['local', 'remote', 'tag'].filter((k) => by[k].length);
    let out = groups;
    if (rest.length) {
      const all = rest.reduce((a, k) => a.concat(by[k]), []);
      if (compact) out = [groups.length ? { name: groups[0].name, refs: groups.reduce((a, g) => a.concat(g.refs), []).concat(all) }
        : { name: all[0].type !== 'tag' || showTagNames ? all[0].name : '', refs: all }];
      else {
        out = groups.slice();
        rest.forEach((k) => {
          if (k === 'tag') out.push({ name: showTagNames ? by.tag[0].name : '', refs: by.tag.slice() });
          else by[k].forEach((r) => out.push({ name: r.name, refs: [r] }));
        });
      }
    }
    if (!by.head.length) return out;
    if (!Git.currentBranch()) return [{ name: t('Detached HEAD'), refs: by.head.slice(), detached: true }].concat(out);
    if (out.length) out[0].refs = by.head.concat(out[0].refs); else out = [{ name: '', refs: by.head.slice() }];
    return out;
  };
  /** Colors of a group's icon: one per ref type, twice when the group holds several refs of that type. */
  L.groupColors = function (group) {
    const types = [];
    group.refs.forEach((r) => { if (types.indexOf(r.type) < 0) types.push(r.type); });
    return types.reduce((a, ty) => a.concat(group.refs.filter((r) => r.type === ty).length > 1 ? [L.refColor(ty), L.refColor(ty)] : [L.refColor(ty)]), []);
  };
  function mergedColors(groups) {
    const count = new Map();
    groups.forEach((g) => L.groupColors(g).forEach((c) => count.set(c, (count.get(c) || 0) + 1)));
    const out = [];
    count.forEach((n, c) => { out.push(c); if (n > 1) out.push(c); });
    return out;
  }
  /** LabelPainter.shortenRefName: a long name that does not fit loses its first path segment, then its tail. */
  function shorten(name, room, font) {
    const MAX = 22;
    if (!name || name.length <= MAX || L.measure(name, font) <= room) return name;
    const slash = name.indexOf('/');
    if (slash > 2) name = '..' + name.slice(slash);
    if (name.length <= MAX || L.measure(name, font) <= room) return name;
    for (let n = name.length - 1; room > 0 && n >= MAX; n--) { const s = name.slice(0, n) + '…'; if (L.measure(s, font) <= room) return s; }
    return name.slice(0, MAX - 1) + '…';
  }
  /** The labels at the right end of a commit's subject cell, laid out as LabelPainter does within `room` pixels. */
  L.labelBlock = function (groups, room, font, names) {
    const compact = L.opts.compact;
    const mid = compact ? 6 : 12;
    const tw = (s) => (s ? 1 + Math.ceil(L.measure(s, font)) : 0);
    const items = [];
    const detached = groups.find((g) => g.detached);
    if (detached) items.push({ text: detached.name, warn: true, width: 16 + 3 + tw(detached.name) });
    const rest = groups.filter((g) => !g.detached);
    room -= (detached ? items[0].width + mid : 0) + 8;
    let used = 0, any = false;
    for (let i = 0; i < rest.length; i++) {
      const last = i === rest.length - 1;
      const spare = !compact && !last ? iconWidth(mergedColors(rest.slice(i + 1)).length) : 0;
      const colors = L.groupColors(rest[i]);
      let w = used + iconWidth(colors.length) + (last ? 0 : mid);
      const text = shorten(rest[i].name, room - w - spare, font);
      w += tw(text);
      if (!compact && room - w - spare < 0) {
        const all = mergedColors(rest.slice(i)), shown = any ? '' : text;
        items.push({ text: shown, colors: all, width: iconWidth(all.length) + tw(shown) });
        break;
      }
      items.push({ text, colors, width: iconWidth(colors.length) + tw(text) });
      any = true;
      used = w;
    }
    const width = items.reduce((a, it) => a + it.width, 0) + mid * (items.length - 1) + 8;
    return h('span.gl-refs', { style: { width: width + 'px', gap: mid + 'px' }, title: names },
      items.map((it) => h('span.gl-ref', { class: it.warn ? 'warn' : '', style: { width: it.width + 'px' } },
        it.warn ? Git.icon('balloonWarning') : L.tagIcon(it.colors), it.text ? h('span.gl-ref-text', it.text) : null)));
  };
  /** A branch's own actions: the Branches builder's menu when it is loaded, a short list otherwise. */
  L.branchMenu = function (name, kind) {
    // `kind` ('local' | 'remote') is what the caller knows about the ref; without it the menu builder decides by name
    if (Git.branches && Git.branches.menuFor) return Git.branches.menuFor(name, kind);
    const ref = A.ref(kind || 'local', name), current = ref.kind === 'local' && name === Git.currentBranch();
    return [{ label: t('Checkout'), disabled: current, action: () => A.checkout(ref) },
      { label: t('Rename…'), disabled: ref.kind !== 'local', action: () => A.renameBranch(ref) },
      { label: t('Delete'), disabled: current, danger: true, action: () => A.deleteBranch(ref) }];
  };
})();
