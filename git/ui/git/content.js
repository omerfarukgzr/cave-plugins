/* What the snapshot cannot hold, read on demand (docs/ARCHITECTURE.md §6.1). No DOM except Git.content.loading().
   Every getter returns a Promise and caches the answer (LRU; failed reads are not kept):
     details(id)                          commit.details (body, changes per parent)          key: commit id
     containing(id)                       commit.containing (branches, tags, pushed)          key: id + refs version
     file(source)                         file.read; source { path, rev | stage | worktree }  key: blob/commit id, or the path
                                          for the work tree (dropped on `files`), or stage + snapshot version
     pair(left, right)                    both sides of a diff (file.pair; a null side = the file does not exist there)
     fileHistory(path, rev?) · blame(path, rev?) · search({ text, regex, caseSensitive }) · paths([paths])
     compareFiles(a, b?) · compareBranches(a, b) · outgoing(branch?) · rebasePlan(from)
   A rev that is not a full id (HEAD, a branch) is resolved to the commit id it names now, so the key never goes stale.
   Stale answers: const slot = Git.content.slot();  slot.run(() => Git.content.details(id), { loading, done, error })
     a newer run() (or slot.cancel()) makes the older answer go nowhere; a cached answer calls `done` synchronously. */
(function () {
  'use strict';
  const Git = (window.Git = window.Git || {});
  const R = Git.repo;
  const C = (Git.content = {});

  const MAX_ENTRIES = 3000, MAX_BYTES = 64 * 1024 * 1024;
  const cache = new Map();   // key -> { promise, done, value, error, size }
  let bytes = 0;

  const call = (method, params) => Git.backend.call(method, Object.assign({ repo: R.root }, params || {}));
  const refs = () => (Git.store && Git.store.refsVersion ? Git.store.refsVersion() : 0);
  const sizeOf = (v) => {
    if (!v) return 64;
    if (typeof v.text === 'string') return v.text.length + 256;
    if (v.left || v.right) return sizeOf(v.left) + sizeOf(v.right);
    return 1024;
  };
  function touch(key, e) { cache.delete(key); cache.set(key, e); }
  function evict() {
    for (const [key, e] of cache) {
      if (cache.size <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
      if (!e.done) continue;
      cache.delete(key);
      bytes -= e.size || 0;
    }
  }
  /** The cached promise for `key`, or a new one from `load()`. The promise carries `.entry`. */
  function get(key, load) {
    const old = cache.get(key);
    if (old) { touch(key, old); return old.promise; }
    const e = { done: false, value: undefined, error: null, size: 0 };
    e.promise = Promise.resolve().then(load).then((value) => {
      e.done = true;
      e.value = value;
      e.size = sizeOf(value);
      if (cache.get(key) === e) { bytes += e.size; evict(); }
      return value;
    }, (err) => {
      if (cache.get(key) === e) cache.delete(key);
      throw err;
    });
    e.promise.entry = e;
    cache.set(key, e);
    return e.promise;
  }
  C.has = (key) => !!(cache.get(key) && cache.get(key).done);
  /** A promise that is already answered (slot.run draws it synchronously). */
  function ready(value) { const p = Promise.resolve(value); p.entry = { done: true, value }; return p; }
  C.clear = function () { cache.clear(); bytes = 0; };
  /** Forgets work tree contents: of `paths`, or all of them when `paths` is null. */
  C.dropWorktree = function (paths) {
    const set = paths ? new Set(paths) : null;
    for (const [key, e] of Array.from(cache)) {
      if (!key.startsWith('f:w:')) continue;
      if (set && !set.has(key.slice(4))) continue;
      cache.delete(key);
      bytes -= e.size || 0;
    }
  };

  // ---------------------------------------------------------------- revisions and sources
  const FULL = /^[0-9a-f]{40}$/;
  /** A commit-ish turned into the id it names now (unknown names are passed through to the engine). */
  function resolveRev(rev) {
    if (!rev || FULL.test(rev)) return rev;
    const id = Git.refId(rev);
    return id || rev;
  }
  function normalize(src) {
    if (!src) return null;
    const out = { path: src.path };
    if (src.worktree) out.worktree = true;
    else if (src.stage != null) out.stage = src.stage;
    else out.rev = resolveRev(src.rev || 'HEAD');
    return out;
  }
  function sourceKey(s) {
    if (s.worktree) return 'f:w:' + s.path;
    if (s.stage != null) return 'f:s:' + s.stage + ':' + R.version + ':' + s.path;
    return (FULL.test(s.rev) ? 'f:r:' : 'f:x:' + refs() + ':') + s.rev + ':' + s.path;
  }
  /** Content of a file that is not there (an added file's left side, a deleted file's right side). */
  const missing = (s) => ({ path: s ? s.path : null, source: s, exists: false, kind: null, id: null, mode: null, size: 0, binary: false,
    tooLarge: false, text: null, encoding: null, bom: false, eol: null, finalNewline: false });
  C.missing = missing;

  // ---------------------------------------------------------------- getters
  C.details = (id) => get('d:' + id, () => call('commit.details', { id }));
  C.containing = (id) => get('c:' + refs() + ':' + id, () => call('commit.containing', { id }));
  C.file = function (source) {
    const s = normalize(source);
    return get(sourceKey(s), () => call('file.read', s));
  };
  C.pair = function (left, right) {
    const l = normalize(left), r = normalize(right);
    if (!l && !r) return ready({ left: missing(null), right: missing(null), same: true });
    if (!l || !r) {
      const one = l || r, k = sourceKey(one);
      const wrap = (c) => ({ left: l ? c : missing(null), right: r ? c : missing(null), same: false });
      if (C.has(k)) { const e = cache.get(k); touch(k, e); return ready(wrap(e.value)); }
      return C.file(one).then(wrap);
    }
    const lk = sourceKey(l), rk = sourceKey(r);
    if (C.has(lk) && C.has(rk)) {
      const a = cache.get(lk), b = cache.get(rk);
      touch(lk, a); touch(rk, b);
      return ready({ left: a.value, right: b.value, same: !!a.value.id && a.value.id === b.value.id });
    }
    return get('p:' + lk + '\u0000' + rk, () => call('file.pair', { left: l, right: r }).then((res) => {
      // each side is cached on its own too, so a local diff and a commit diff share HEAD's content
      const put = (key, value) => { if (!cache.has(key)) { const p = Promise.resolve(value); const e = { done: true, value, size: sizeOf(value), promise: p }; p.entry = e; cache.set(key, e); bytes += e.size; } };
      put(lk, res.left);
      put(rk, res.right);
      return res;
    })).then((res) => {
      cache.delete('p:' + lk + '\u0000' + rk);   // the sides hold the content; the pair entry is only in-flight dedup
      return res;
    });
  };
  C.fileHistory = (path, rev) => get('h:' + refs() + ':' + (rev || '') + ':' + path, () => call('log.fileHistory', rev ? { path, rev } : { path }));
  C.blame = (path, rev) => get(rev ? 'b:' + resolveRev(rev) + ':' + path : 'b:w:' + R.version + ':' + path,
    () => call('blame', rev ? { path, rev: resolveRev(rev) } : { path }));
  C.search = (q) => get('s:' + refs() + ':' + (q.regex ? 'r' : '') + (q.caseSensitive ? 'c' : '') + ':' + q.text,
    () => call('log.search', { text: q.text, regex: !!q.regex, caseSensitive: !!q.caseSensitive }));
  C.paths = (paths) => get('l:' + refs() + ':' + paths.join('\u0000'), () => call('log.paths', { paths }));
  C.compareFiles = (a, b) => get('cf:' + (b ? '' : R.version + ':') + resolveRev(a) + ':' + (b ? resolveRev(b) : ''),
    () => call('compare.files', b ? { a: resolveRev(a), b: resolveRev(b) } : { a: resolveRev(a) }));
  C.compareBranches = (a, b) => get('cb:' + refs() + ':' + a + ':' + b, () => call('compare.branches', { a, b }));
  /** `branch`: a local branch (its pair or its name, never a full ref; Git.actions.wire makes the full ref). */
  C.outgoing = (branch) => {
    const full = branch ? Git.actions.wire(Git.actions.localOf(branch)) : '';
    return get('o:' + refs() + ':' + full, () => call('push.outgoing', full ? { branch: full } : {}));
  };
  C.rebasePlan = (from) => get('rp:' + refs() + ':' + from, () => call('rebase.plan', { from }));

  // ---------------------------------------------------------------- stale-answer protection
  /** One slot per place that shows an answer (a details pane, a diff tab). Only the newest run() reaches its callbacks. */
  C.slot = function () {
    let seq = 0;
    return {
      run(load, cb) {
        const my = ++seq;
        let p;
        try { p = load(); } catch (e) { p = Promise.reject(e); }
        const e = p && p.entry;
        if (e && e.done) { cb.done && cb.done(e.value); return p; }
        if (cb.loading) cb.loading();
        Promise.resolve(p).then((v) => { if (my === seq && cb.done) cb.done(v); },
          (err) => { if (my === seq) { if (cb.error) cb.error(err); else console.error(err); } });
        return p;
      },
      cancel() { seq++; },
      current: () => seq,
    };
  };
  /** IntelliJ's loading state for a pane: "Loading…". */
  C.loading = (text) => Git.h('div.g-loading', { role: 'status' }, text || Git.t('Loading…'));
  /** An error state for a pane (the code decides the text; the message is only a tooltip). */
  C.failed = (err, text) => Git.h('div.g-loading.g-failed', { role: 'alert', title: err && err.message ? err.message : '' }, text || Git.t('Error loading changes'));
})();
