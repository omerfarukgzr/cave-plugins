/* Openers. Everything that opens a tab or a page (a diff, a file at a revision, File History, a comparison…)
   is a named opener with plain JSON arguments (a descriptor: ids, paths, refs, revisions, options). `Git.open(name,
   args)` first offers it to the host (`Git.host.forward(name, args)`: truthy, or a promise of it, means the host shows it
   elsewhere: the Orca center tab, hosts/orca/README.md); otherwise, or when that fails, the opener runs here and builds
   the real spec or view in this frame (loading contents here, creating the callbacks here). A host that shows an opener
   runs the same name with the same arguments in its own frame (`Git.openers.run`).
     Git.openers.define(name, run(args)) · .run(name, args) · .names()
     Git.openers.describe(name, args) -> { id, title } | null   the tab the opener opens, before it runs (a host that
                    shows it in a tab of its own names that tab with it): the same ids and titles the openers give
                    their tabs (diffview-load.js tabId / titleOf, fileview.js, actions-history.js, actions-branches.js,
                    log-actions.js), so a second diff of the same kind lands in the same tab
     Git.open(name, args)
   Openers (defined next to the code they open):
     diff      { kind: 'commit'|'local', path, commit?, parent?, files?, tabId? }   diffview.js (actions-changes.js)
     file      { path, rev?, line? }                                                 the read-only file view
     texts     { id, title, path, what?, left: Side|null, right: Side|null, items?: [{ path, title, left, right }] }
               Side: { title, at: { path, rev } | { path, worktree: true } | null, locked?, path?, nullIfMissing? }
               the two sides are loaded here (Git.content.pair); `items`: Compare Previous / Next File
     history   { path, rev? }            File History / History Up to Here (actions-history.js)
     compare   { a, b, title }           Compare with Current (actions-branches.js)
     branchDiff { ref }                  a branch's changes against the working tree (actions-branches.js)
     repoAt    { rev }                   Show Repository at Revision (log-actions.js)
     versions  { a, b }                  Changes Between two revisions (log-actions.js) */
(function () {
  'use strict';
  const Git = window.Git;
  const t = (...a) => Git.t(...a);
  const defs = Object.create(null);
  const O = (Git.openers = {
    define(name, run) { defs[name] = run; },
    run(name, args) { const run = defs[name]; if (!run) throw new Error('unknown opener ' + name); return run(args || {}); },
    names: () => Object.keys(defs),
    describe(name, args) {
      if (!defs[name]) return null;
      try { return describe(name, args || {}); } catch (e) { return null; }
    },
  });

  /** One tab per subject, as each opener names its own tab; a title is the one shown now (the page's language). */
  function describe(name, a) {
    const file = (p) => (Git.fileName ? Git.fileName(p || '') : String(p || '').split('/').pop());
    const short = (id) => (Git.short ? Git.short(id || '') : String(id || '').slice(0, 8));
    const A = Git.actions || {};
    const wire = (r) => (A.wire ? A.wire(r) : typeof r === 'string' ? r : r && r.name);
    const label = (r) => (A.refLabel ? A.refLabel(r) : wire(r));
    const out = (id, title) => (typeof id === 'string' && id ? { id, title: typeof title === 'string' && title ? title : null } : null);
    const L = Git.diffLoad;
    switch (name) {
      case 'diff':
      case 'texts': {
        const spec = name === 'texts' ? Object.assign({ kind: 'texts' }, a) : a;
        if (L && L.tabId && L.titleOf) return out(L.tabId(spec), L.titleOf(spec));
        return out(spec.tabId || (spec.kind === 'local' ? 'diff:local' : spec.kind === 'commit' ? 'diff:commit' : spec.id || 'diff:texts'), spec.title || file(spec.path));
      }
      case 'file': {
        const rev = a.rev ? (Git.refId && Git.refId(a.rev)) || a.rev : null;
        return out('file:' + a.path + (rev ? '@' + rev : ''), file(a.path) + (rev ? ' (' + short(rev) + ')' : ''));
      }
      case 'history': return out('history:' + a.path + (a.rev ? '@' + a.rev : ''), t('History: {0}', file(a.path)));
      case 'compare': return out('compare:' + wire(a.a), a.title);
      case 'branchDiff': return out('branchdiff:' + wire(a.ref), t('Changes') + ': ' + label(a.ref));
      case 'repoAt': return out('repo-at:' + a.rev, t('{0} at {1}', (Git.repo && Git.repo.name) || '', short(a.rev)));
      case 'versions': return out('versions:' + a.a + '..' + a.b, t('Changes Between {0} and {1}', short(a.a), short(a.b)));
      default: return out(name, null);
    }
  }

  const SAME_MS = 800;
  let last = null;
  Git.open = function (name, args) {
    if (!defs[name]) throw new Error('unknown opener ' + name);
    args = args || {};
    const forward = Git.host && typeof Git.host.forward === 'function' ? Git.host.forward : null;
    if (!forward) return O.run(name, args);
    // The same opener handed over again at once (a click switched the centre's diff, the double click of that same
    // gesture opens it again; ui/git/centre.js): the host shows it already.
    const plain = Object.assign({}, args);
    delete plain.preview;
    const sig = name + '\u0000' + JSON.stringify(plain), now = Date.now();
    if (last && last.sig === sig && now - last.at < SAME_MS) return null;
    last = { sig, at: now };
    let answer;
    try { answer = forward(name, JSON.parse(JSON.stringify(args))); } catch (e) { answer = false; }
    const here = () => O.run(name, args);
    if (answer && typeof answer.then === 'function') { answer.then((ok) => { if (!ok) here(); }, here); return null; }
    return answer ? null : here();
  };

  // ---------------------------------------------------------------- the built-in openers
  O.define('diff', (a) => (Git.diffTab ? Git.diffTab.open(a) : null));
  O.define('file', (a) => (Git.fileView ? Git.fileView.open(a.path, { rev: a.rev || null, line: a.line != null ? a.line : null }) : null));
  /** A diff of two texts loaded from their descriptors (a revision's file or the work tree file). */
  function texts(a) {
    if (!Git.diffTab) return;
    const at = (s) => (s && s.at ? s.at : null);
    Git.content.pair(at(a.left), at(a.right)).then((p) => {
      const side = (s, c) => {
        if (!s) return null;
        const ok = c && c.exists && !(s.nullIfMissing && (c.binary || c.tooLarge));
        if (s.nullIfMissing && !ok) return null;
        return { title: s.title || '', text: ok ? c.text : null, locked: !!s.locked, path: s.path || (s.at && s.at.path) || null };
      };
      const items = Array.isArray(a.items) && a.items.length ? a.items : null;
      Git.diffTab.open({ kind: 'texts', id: a.id || 'diff:texts', title: a.title, path: a.path, left: side(a.left, p.left), right: side(a.right, p.right), preview: !!a.preview,
        files: items ? items.map((x) => x.path) : undefined,
        openFile: items ? (path) => { const it = items.find((x) => x.path === path); if (it) texts(Object.assign({}, a, { path: it.path, title: it.title, left: it.left, right: it.right })); } : undefined });
    }, (err) => { if (Git.actions && Git.actions.errorNotice) Git.actions.errorNotice(err, t(a.what || 'Show Diff')); });
  }
  O.define('texts', texts);
})();
