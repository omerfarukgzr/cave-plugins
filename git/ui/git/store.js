/* The client's copy of one repository (docs/ARCHITECTURE.md §6.1). Replaces the prototype's model.js.
   No DOM here (node:test runs it with a fake backend: test/ui/store.test.js).

   Git.on(event, fn) -> off · Git.emit(event, data)
     'change' { reason, what }   the snapshot or the commit list moved: redraw from Git.repo
     'log'    { loaded, complete } the commit list grew (background paging)
     'files'  { paths|null }     work tree files changed on disk: re-read open contents (paths null = all)
     'console' · 'job' · 'progress' (engine events of this repository) · 'connection' { state } · 'store' { status }
   Git.store.open(path) -> Promise<root>   repos.open + subscribe + snapshot + first Log page; the rest pages in the
                                           background. Git.store.status: 'idle'|'loading'|'ready'|'error', .error
   Git.store.resync() · Git.store.close() · Git.store.refresh() (repo.refresh)
   Git.repo (one object, never replaced; views keep a reference): see README §3. Query helpers below keep the
   prototype's names and meaning and are synchronous. */
(function () {
  'use strict';
  const Git = (window.Git = window.Git || {});

  // ---------------------------------------------------------------- events
  const subs = {};
  Git.on = function (ev, fn) {
    (subs[ev] = subs[ev] || []).push(fn);
    return () => { subs[ev] = (subs[ev] || []).filter((f) => f !== fn); };
  };
  Git.emit = function (ev, arg) {
    (subs[ev] || []).slice().forEach((fn) => { try { fn(arg); } catch (e) { console.error('Git.on(' + ev + ')', e); } });
  };

  const NO_CHANGES = Object.freeze([]);
  // The first page paints the Log; the rest comes in one call: every log.page walks the whole history
  // (git log --date-order), so on 51 000 commits one 100 000 page costs about what one 25 000 page does.
  const FIRST_PAGE = 2000, PAGE = 100000, CONSOLE_CAP = 5000, CHUNK = 20000;

  // ---------------------------------------------------------------- state
  const R = (Git.repo = {});
  function blank() {
    Object.assign(R, {
      root: null, name: '', gitDir: null, commonDir: null, linked: false, version: -1,
      head: { branch: null, detached: null, unborn: false }, headId: null,
      branches: {}, remotes: {}, remoteNames: [], remoteUrls: {}, remoteName: 'origin', remoteUrl: '',
      tags: {}, favorites: new Set(), recent: [], me: null, meInfo: { name: '', email: '' },
      local: [], localTruncated: false, op: null, conflicts: [], stashes: [],
      authors: {}, commits: new Map(),
      log: { heads: null, order: [], loaded: 0, complete: false, truncated: false },
      console: [],
    });
  }
  blank();

  const S = (Git.store = { status: 'idle', error: null });
  let gen = 0;                    // bumps on open/close: answers of an older generation are dropped
  let stateSeq = 0, logSeq = 0;   // newest request of each kind wins
  let refsVersion = 0;            // bumps whenever the commit list may have changed (content caches key on it)
  const offs = [];
  const backend = () => {
    if (!Git.backend) throw Object.assign(new Error('Git.backend is not set'), { code: 'internal' });
    return Git.backend;
  };
  const call = (method, params) => backend().call(method, Object.assign({ repo: R.root }, params || {}));
  S.refsVersion = () => refsVersion;
  function setStatus(status, error) {
    S.status = status;
    S.error = error || null;
    Git.emit('store', { status, error: S.error });
  }

  // ---------------------------------------------------------------- people and commits
  const keyOf = (p) => (p ? p.name + ' <' + p.email + '>' : '');
  /** Adds the commits of one response; `people` indices are valid for that response only (PROTOCOL "Shared shapes"). */
  function addCommits(list, people) {
    const keys = (people || []).map((p) => {
      const k = keyOf(p);
      if (!R.authors[k]) R.authors[k] = { name: p.name, email: p.email };
      return k;
    });
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (R.commits.has(c.id)) continue;
      R.commits.set(c.id, { id: c.id, parents: c.parents, author: keys[c.author], committer: keys[c.committer],
        time: c.time, commitTime: c.commitTime, subject: c.subject, body: '', changes: NO_CHANGES });
    }
  }

  // ---------------------------------------------------------------- snapshot
  function applyState(st) {
    if (!st || (R.version > st.version && R.root === st.root)) return false;
    const before = R.headId + '|' + JSON.stringify(R.branches) + JSON.stringify(R.remotes) + JSON.stringify(R.tags);
    R.root = st.root; R.name = st.name; R.gitDir = st.gitDir; R.commonDir = st.commonDir; R.linked = !!st.linked;
    R.version = st.version;
    const hd = st.head || {};
    R.head = { branch: hd.branch || null, detached: hd.detached || null, unborn: !!hd.unborn };
    R.headId = st.headId || null;
    R.branches = st.branches || {};
    R.remotes = st.remotes || {};
    R.remoteNames = st.remoteNames || [];
    R.remoteUrls = st.remoteUrls || {};
    R.remoteName = R.remoteNames.indexOf('origin') >= 0 ? 'origin' : R.remoteNames[0] || 'origin';
    R.remoteUrl = Object.prototype.hasOwnProperty.call(R.remoteUrls, R.remoteName) ? R.remoteUrls[R.remoteName] || '' : '';
    R.tags = st.tags || {};
    R.favorites = new Set(st.favorites || []);
    R.recent = st.recent || [];
    R.meInfo = st.me || { name: '', email: '' };
    R.me = keyOf(R.meInfo);
    R.local = st.local || [];
    R.localTruncated = !!st.localTruncated;
    R.op = st.op || null;
    R.pendingMessage = typeof st.pendingMessage === 'string' ? st.pendingMessage : null;   // squash merge, cherry-pick -n
    R.conflicts = st.conflicts || (R.op && R.op.conflicts) || [];   // every unmerged path, also without an operation
    R.stashes = Array.isArray(st.stashes) ? st.stashes : [];        // the stash list's ids, top first (the Stash tab reads stash.list)
    memo.clear();
    return before !== R.headId + '|' + JSON.stringify(R.branches) + JSON.stringify(R.remotes) + JSON.stringify(R.tags);
  }
  async function readState(method) {
    const seq = ++stateSeq, g = gen;
    const st = await call(method || 'repo.state');
    if (g !== gen || seq !== stateSeq) return null;   // a newer read or another repository: drop it
    return st;
  }

  // ---------------------------------------------------------------- the commit list
  async function loadLog() {
    const seq = ++logSeq, g = gen;
    const live = () => g === gen && seq === logSeq;
    const first = await call('log.page', { limit: FIRST_PAGE });
    if (!live()) return;
    addCommits(first.commits, first.people);
    R.log = { heads: first.heads, order: first.commits.map((c) => c.id), loaded: first.commits.length, complete: !first.more, truncated: false };
    if (typeof performance !== 'undefined') { S.firstPageAt = performance.now(); if (R.log.complete) S.loadedAt = S.firstPageAt; }
    refsVersion++;
    memo.clear();
    Git.emit('log', { loaded: R.log.loaded, complete: R.log.complete });
    Git.emit('change', { reason: 'log', what: ['log'] });
    let offset = first.commits.length, more = first.more;
    while (more && live()) {
      const page = await call('log.page', { heads: R.log.heads, offset, limit: PAGE });
      if (!live()) return;
      addCommits(page.commits, page.people);
      for (let i = 0; i < page.commits.length; i++) R.log.order.push(page.commits[i].id);
      offset += page.commits.length;
      more = page.more && page.commits.length > 0;
      if (R.log.order.length >= 100000) { more = false; R.log.truncated = !!page.more; }
      R.log.loaded = R.log.order.length;
      R.log.complete = !more;
      if (R.log.complete && typeof performance !== 'undefined') S.loadedAt = performance.now();
      refsVersion++;
      memo.clear();
      Git.emit('log', { loaded: R.log.loaded, complete: R.log.complete });
      Git.emit('change', { reason: 'log', what: ['log'] });
    }
  }
  /** After a refs change: the new order, and only the commits we do not have yet. */
  async function syncOrder() {
    const seq = ++logSeq, g = gen;
    const live = () => g === gen && seq === logSeq;
    const res = await call('log.order', {});
    if (!live()) return;
    const missing = res.ids.filter((id) => !R.commits.has(id));
    for (let i = 0; i < missing.length; i += CHUNK) {
      const part = await call('log.commits', { ids: missing.slice(i, i + CHUNK) });
      if (!live()) return;
      addCommits(part.commits, part.people);
    }
    R.log = { heads: res.heads, order: res.ids.filter((id) => R.commits.has(id)), loaded: res.ids.length, complete: true, truncated: !!res.truncated };
    refsVersion++;
    memo.clear();
    Git.emit('log', { loaded: R.log.loaded, complete: true });
    Git.emit('change', { reason: 'refs', what: ['refs'] });
  }

  // ---------------------------------------------------------------- open / close / resync
  S.open = async function (path) {
    S.close();
    const g = gen;
    setStatus('loading');
    try {
      const info = await backend().call('repos.open', { path });
      if (g !== gen) return null;
      R.root = info.root; R.name = info.name;
      // snapshot, subscription and the first Log page are asked for at once
      const sub = backend().call('repo.subscribe', { repo: R.root }).catch(() => null);
      const first = loadLogFirst().then(() => null, (e) => e);
      const st = await readState();
      if (g !== gen) return null;
      applyState(st);
      Git.emit('change', { reason: 'open', what: ['state', 'refs', 'worktree', 'op'] });
      await sub;
      const err = await first;
      if (g !== gen) return null;
      if (err) {
        // a repository without commits has nothing to list; anything else is an error of the Log
        if (R.headId || Object.keys(R.branches).length || Object.keys(R.tags).length) throw err;
        R.log.complete = true;
        Git.emit('log', { loaded: 0, complete: true });
      }
      setStatus('ready');
      return R.root;
    } catch (e) {
      if (g === gen) { setStatus('error', e); }
      throw e;
    }
  };
  /** Resolves after the first page; the rest keeps paging in the background. */
  function loadLogFirst() {
    return new Promise((resolve, reject) => {
      let done = false;
      const off = Git.on('log', () => { if (!done) { done = true; off(); resolve(); } });
      loadLog().catch((e) => {
        off();
        if (!done) { done = true; reject(e); return; }
        Git.emit('store', { status: S.status, error: e });
      });
    });
  }
  S.close = function () {
    gen++;
    const root = R.root;
    if (root && Git.backend) Git.backend.call('repo.unsubscribe', { repo: root }).catch(() => null);
    blank();
    memo.clear();
    refsVersion++;
    if (Git.content && Git.content.clear) Git.content.clear();
    setStatus('idle');
  };
  /** Full resync: snapshot, commit order, contents (after a reconnect or when the page becomes visible). */
  S.resync = async function (o) {
    if (!R.root) return;
    const g = gen;
    if (o && o.subscribe) await backend().call('repo.subscribe', { repo: R.root }).catch(() => null);
    if (g !== gen) return;
    const st = await readState(o && o.refresh ? 'repo.refresh' : 'repo.state').catch((e) => { Git.emit('store', { status: S.status, error: e }); return null; });
    if (st) applyState(st);
    if (Git.content && Git.content.dropWorktree) Git.content.dropWorktree(null);
    Git.emit('change', { reason: 'resync', what: ['state', 'refs', 'worktree', 'op'] });
    Git.emit('files', { paths: null });
    await syncOrder().catch((e) => Git.emit('store', { status: S.status, error: e }));
  };
  S.refresh = () => S.resync({ refresh: true });

  /** One `changed` event: what moved decides what is fetched again (PROTOCOL "Events"). */
  async function onChanged(ev) {
    if (!ev || ev.repo !== R.root) return;
    const what = ev.what || [];
    if (what.indexOf('files') >= 0) {
      if (Git.content && Git.content.dropWorktree) Git.content.dropWorktree(ev.paths || null);
      Git.emit('files', { paths: ev.paths || null });
    }
    const needState = what.some((w) => w === 'state' || w === 'refs' || w === 'worktree' || w === 'op');
    if (needState && !(ev.version != null && ev.version <= R.version && what.indexOf('refs') < 0)) {
      const st = await readState().catch(() => null);
      if (st) {
        const refsMoved = applyState(st);
        if (what.indexOf('worktree') >= 0 && Git.content && Git.content.dropWorktree) Git.content.dropWorktree(null);
        Git.emit('change', { reason: 'changed', what });
        if (what.indexOf('refs') >= 0 || refsMoved) await syncOrder().catch(() => null);
      }
    }
  }
  function wire() {
    if (offs.length || !Git.backend) return;
    offs.push(Git.backend.on('changed', (ev) => { onChanged(ev); }));
    offs.push(Git.backend.on('console', (ev) => {
      if (!ev || ev.repo !== R.root) return;
      (ev.lines || []).forEach((l) => R.console.push({ kind: l.kind, time: l.time,
        text: l.kind === 'cmd' ? stamp(l.time) + ': [' + R.name + '] ' + l.text : l.text }));
      if (R.console.length > CONSOLE_CAP) R.console.splice(0, R.console.length - CONSOLE_CAP);
      Git.emit('console', ev);
    }));
    offs.push(Git.backend.on('progress', (ev) => { if (ev && ev.repo === R.root) Git.emit('progress', ev); }));
    offs.push(Git.backend.on('job', (ev) => { if (ev && ev.repo === R.root) Git.emit('job', ev); }));
    offs.push(Git.backend.on('connection', (ev) => {
      Git.emit('connection', ev);
      // The stream may now come from another engine (a restarted server or worker), whose snapshot versions start
      // from 1 again: the old number must not make its state look older. Answers still on their way from before are
      // dropped anyway (readState's sequence), so forgetting the number is safe also after a short break.
      if (ev && ev.state === 'reconnected' && R.root) { R.version = -1; S.resync({ subscribe: true }); }
    }));
  }
  S.wire = wire;
  function stamp(ms) {
    const d = new Date(ms || Date.now());
    const p = (n, w) => String(n).padStart(w || 2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
  }
  Promise.resolve().then(wire);

  // ---------------------------------------------------------------- queries (synchronous, over Git.repo)
  const memo = new Map();
  function cached(name, key, make) {
    const k = name + '\u0000' + key;
    if (!memo.has(k)) memo.set(k, make());
    return memo.get(k);
  }
  Git.short = (id) => (id || '').slice(0, 8);
  Git.commit = (id) => R.commits.get(id) || null;
  Git.author = (key) => R.authors[key] || { name: key || '', email: '' };
  Git.isMine = (c) => !!c && !!R.me && c.author === R.me;
  Git.headId = () => R.headId;
  Git.currentBranch = () => R.head.branch || null;
  Git.isRemote = (name) => Object.prototype.hasOwnProperty.call(R.remotes, name);
  Git.isLocal = (name) => Object.prototype.hasOwnProperty.call(R.branches, name);
  Git.localBranches = () => Object.keys(R.branches).sort((a, b) => a.localeCompare(b));
  Git.remoteBranches = () => Object.keys(R.remotes).sort((a, b) => a.localeCompare(b));
  Git.tagNames = () => Object.keys(R.tags).sort((a, b) => a.localeCompare(b));
  Git.refId = function (name) {
    if (!name) return null;
    if (name === 'HEAD') return R.headId;
    // full ref names name exactly one kind (docs/PROTOCOL.md Ref names)
    const own = (map, k) => (Object.prototype.hasOwnProperty.call(map, k) ? k : null);
    if (name.startsWith('refs/heads/')) { const k = own(R.branches, name.slice(11)); return k === null ? null : R.branches[k].head; }
    if (name.startsWith('refs/remotes/')) { const k = own(R.remotes, name.slice(13)); return k === null ? null : R.remotes[k]; }
    if (name.startsWith('refs/tags/')) { const k = own(R.tags, name.slice(10)); return k === null ? null : R.tags[k]; }
    if (Git.isLocal(name)) return R.branches[name].head;
    if (Git.isRemote(name)) return R.remotes[name];
    if (Object.prototype.hasOwnProperty.call(R.tags, name)) return R.tags[name];
    if (R.commits.has(name)) return name;
    return null;
  };
  /** The snapshot's record of a local branch. Names are data: `constructor`, `__proto__` are legal branch names. */
  const branchRec = (branch) => (Git.isLocal(branch) ? R.branches[branch] : null);
  Git.upstream = (branch) => {
    const b = branchRec(branch);
    return b && b.upstream && !b.gone && Git.isRemote(b.upstream) ? b.upstream : null;
  };
  /** { ahead, behind, upstream } from the snapshot (the engine counts them); null without an upstream. */
  Git.sync = function (branch) {
    const up = Git.upstream(branch);
    if (!up) return null;
    const b = branchRec(branch);
    return { ahead: b.ahead | 0, behind: b.behind | 0, upstream: up };
  };
  /** Refs pointing at a commit, in the order the Log draws them. */
  Git.refsAt = function (id) {
    const index = cached('refs', '', () => {
      const m = new Map();
      const push = (cid, ref) => { if (!cid) return; if (!m.has(cid)) m.set(cid, []); m.get(cid).push(ref); };
      push(R.headId, { type: 'head', name: 'HEAD' });
      Git.localBranches().forEach((n) => push(R.branches[n].head, { type: 'local', name: n, current: n === R.head.branch }));
      Git.remoteBranches().forEach((n) => push(R.remotes[n], { type: 'remote', name: n }));
      Git.tagNames().forEach((n) => push(R.tags[n], { type: 'tag', name: n }));
      return m;
    });
    return index.get(id) || [];
  };
  /** Heads the Log starts from; `ref` narrows it to one ref. */
  Git.logHeads = function (ref) {
    if (ref) { const id = Git.refId(ref); return id ? [id] : []; }
    const ids = [];
    const add = (id) => { if (id && ids.indexOf(id) < 0) ids.push(id); };
    add(R.headId);
    Git.localBranches().forEach((n) => add(R.branches[n].head));
    Git.remoteBranches().forEach((n) => add(R.remotes[n]));
    Git.tagNames().forEach((n) => add(R.tags[n]));
    return ids;
  };
  /** Every loaded ancestor of `id`, `id` included (a Set; cached per refs version). */
  function closure(id) {
    return cached('closure', id, () => {
      const seen = new Set(), stack = [id];
      while (stack.length) {
        const x = stack.pop();
        if (!x || seen.has(x)) continue;
        const c = R.commits.get(x);
        if (!c) continue;
        seen.add(x);
        for (let i = 0; i < c.parents.length; i++) stack.push(c.parents[i]);
      }
      return seen;
    });
  }
  Git.closure = closure;
  Git.isAncestor = (a, b) => !!a && !!b && closure(b).has(a);
  /** Log order (newest first, `git log --date-order`): the engine's order, restricted to what `heads` reach. */
  Git.logOrder = function (heads) {
    const all = R.log.order;
    if (!heads) return all;
    const key = heads.join(',');
    if (key === Git.logHeads().join(',')) return all;
    return cached('order', key, () => {
      const reach = new Set();
      heads.forEach((h) => closure(h).forEach((id) => reach.add(id)));
      return all.filter((id) => reach.has(id));
    });
  };
  /** Commits reachable from `tip` and not from `base`, oldest first. */
  Git.range = function (base, tip) {
    const stop = base ? closure(base) : new Set(), set = closure(tip);
    return R.log.order.filter((id) => set.has(id) && !stop.has(id)).reverse();
  };
  Git.mergeBase = function (a, b) {
    const ca = closure(a), cb = closure(b);
    // In log order the first common commit is a best common ancestor (children come before parents).
    return R.log.order.find((id) => ca.has(id) && cb.has(id)) || null;
  };
  Git.children = function (id) {
    const index = cached('children', '', () => {
      const m = new Map();
      R.commits.forEach((c) => c.parents.forEach((p) => { if (!m.has(p)) m.set(p, []); m.get(p).push(c.id); }));
      return m;
    });
    return index.get(id) || [];
  };
  /** Names of the branches (local and remote) that contain a commit. Walks the graph: prefer Git.content.containing. */
  Git.branchesContaining = function (id) {
    const out = [];
    if (Git.isAncestor(id, R.headId)) out.push('HEAD');
    Git.localBranches().forEach((n) => { if (Git.isAncestor(id, R.branches[n].head)) out.push(n); });
    Git.remoteBranches().forEach((n) => { if (Git.isAncestor(id, R.remotes[n])) out.push(n); });
    return out;
  };
  /** In some remote-tracking branch (pushed). */
  Git.isPushed = (id) => Object.keys(R.remotes).some((r) => Git.isAncestor(id, R.remotes[r]));
  /** What a push of `branch` would send, newest first (approximation; `push.outgoing` is the engine's answer). */
  Git.outgoing = function (branch) {
    const b = branchRec(branch);
    if (!b) return [];
    const up = Git.upstream(branch);
    return Git.range(up ? R.remotes[up] : null, b.head).reverse().filter((id) => (up ? true : !Git.isPushed(id)));
  };

  // ---------------------------------------------------------------- working tree
  Git.localChanges = () => R.local.filter((f) => f.status !== '?');
  Git.unversioned = () => R.local.filter((f) => f.status === '?');
  /** Unmerged paths of the ongoing operation: [{ path, kind }]. */
  /** Every unmerged path ({ path, kind }): those of the stopped operation, and those without one (unstash, squash…). */
  Git.conflicts = () => (R.conflicts && R.conflicts.length ? R.conflicts : R.op ? R.op.conflicts || [] : []);
  Git.localFile = (path) => R.local.find((f) => f.path === path) || null;
  Git.hasCommits = () => !!R.headId || R.log.order.length > 0;
})();
