// createEngine({ home, methods, watch, dataDir, label }) -> { call(method, params, meta), on(event, fn), dropClient(id), close(), methods() }
//   dataDir: the engine's folder inside each git dir (default `git-panel`); label: the name it writes into git messages
//   (default `Git Panel`). Both defaults: core/product.js.
//
// THE METHOD REGISTRY — how to add an operation (the contract `core/ops/*.js` is written against):
//
//   A module exports an array of method definitions and is listed once in core/methods.js. A definition is
//     { name: 'branch.create',          // dotted, lower camel case; must also be documented in docs/PROTOCOL.md
//       repo: true,                     // true: params.repo (absolute folder) is required and resolved to ctx.repo
//       mutating: true,                 // true: runs in the repository's queue, one at a time per common dir;
//                                       //       watchers are held while it runs, the snapshot is refreshed after
//                                       //       and `changed` is published when something moved
//       console: true,                  // optional; report this method's git commands on the Console stream
//                                       //       (default: same as `mutating`; background reads are quiet)
//       params: { name: 'rev', force: 'bool?', … },   // core/validate.js spec; unknown keys are refused
//       handler: async (ctx, params) => result }      // result must be JSON-serializable
//
//   ctx (handler context)
//     ctx.repo                 { root, name, gitDir, commonDir, linked } (repo methods only)
//     ctx.git(args, opts)      runGit in ctx.repo.root; adds the Console sink, background-read options for
//                              non-mutating methods and the current job's AbortSignal (see core/git.js for opts)
//     ctx.snapshot()           current snapshot (cached while watched and clean, rebuilt otherwise)
//     ctx.invalidate()         mark the snapshot stale (mutating methods get a refresh after they end anyway)
//     ctx.refresh()            rebuild now, publish `changed` if it moved, return the snapshot
//     ctx.job({ title, cancellable }) -> job   progress(text, fraction), cancellable(bool), signal (core/jobs.js);
//                              the engine ends it with done/failed/cancelled when the handler settles
//     ctx.signal               AbortSignal of the most recent job of this call (undefined without one)
//     ctx.detach()             clears ctx.signal: git commands that follow are not cut by the job's cancel any more
//                              (core/ops/util.js `asJob` runs one command as a cancellable job and detaches after it)
//     ctx.emit(event, data)    publish an event; ctx.log(text, kind) writes a Console line without a command
//     ctx.repoState.read()/write(obj)   engine-owned per-repository JSON (<common dir>/<dataDir>/state.json)
//     ctx.home                 core/home.js store (config, recent); ctx.client — caller's client id
//     ctx.walks                the engine's commit-walk cache (core/read/walk.js), used by the Log group
//     ctx.fail(code, message, data)     throw an EngineError with a stable code (core/errors.js)
//
// call(method, params, meta): meta.client (subscriptions belong to it), meta.signal (AbortSignal: a READ method's git
// commands are killed when it aborts, e.g. the HTTP client went away; mutating methods are never cut off midway).
// Reads share a cap of simultaneous git processes (options.maxReads, default 8) with a fair queue per client;
// mutating methods and background refreshes do not wait behind a client's reads (refreshes have their own turn).
// options.log: the log on disk (core/disklog.js createDiskLog, made by the host from its settings home); every git
// command, each call's start and end and diag.report's page errors go there, redacted (core/redact.js).
// options.gitEnv: variables every git command gets explicitly (the host's GIT_DIR & co. are never inherited, see
// core/git.js). Timeouts: a read method's git is killed after options.readTimeoutMs (default runGit's 120 s); a
// mutating method's git has no timeout (a slow hook, a long rebase run to their end; a job's cancel still stops them).
//   Errors: throw EngineError for expected failures; a GitError from ctx.git becomes `git_failed`
//   (or `cancelled` / `timeout`); anything else becomes `internal`.
//
// Events (on(event, fn) returns an unsubscribe function):
//   changed  { repo, version, what: ['state','refs','worktree','op','files'], paths? }
//   console  { repo, lines: [{ time, kind: 'cmd'|'out'|'err', text }] }
//   progress { repo, job, title, text, fraction }
//   job      { repo, job, title, state: 'running'|'done'|'failed'|'cancelled', cancellable }
import fs from 'node:fs';
import path from 'node:path';
import { runGit, createLimiter, liveGit } from './git.js';
import { EngineError, toWireError } from './errors.js';
import { validate } from './validate.js';
import { resolveRepo, resolutionHolds, DATA_DIR, LABEL } from './repo.js';
import { buildSnapshot, readRepoState, stateFile } from './snapshot.js';
import { createQueue, createJobs } from './jobs.js';
import { createWatcher } from './watch.js';
import { createHome } from './home.js';
import { createWalkCache } from './read/walk.js';
import { createReportLimit } from './disklog.js';
import { gitLine, redactArgs, summarizeParams, errorSummary } from './redact.js';
import { METHODS } from './methods.js';

const GONE_CAP = 10000;
// Repositories nobody watches or works on are forgotten beyond these many (the oldest first); a later call opens
// them again. Versions come from one counter of the engine, so a forgotten and reopened repository never shows a
// version a page already saw (a page drops a snapshot whose version is not newer than its own).
const IDLE_ENTRY_CAP = 32;
const RESOLVED_CAP = 256;

const NAME_RE = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)*$/;
const SECTIONS = {
  refs: ['head', 'headId', 'branches', 'remotes', 'remoteNames', 'remoteUrls', 'tags', 'favorites', 'recent', 'me', 'stashes'],
  worktree: ['local', 'localTruncated', 'conflicts'],
  op: ['op'],
};

export function checkDefinition(m) {
  const where = 'method ' + (m && m.name);
  if (!m || typeof m.name !== 'string' || !NAME_RE.test(m.name)) throw new Error(where + ': bad name');
  if (typeof m.repo !== 'boolean' || typeof m.mutating !== 'boolean') throw new Error(where + ': repo and mutating must be booleans');
  if (m.mutating && !m.repo) throw new Error(where + ': a mutating method must be a repository method');
  if (typeof m.handler !== 'function') throw new Error(where + ': handler missing');
  if (m.params && (typeof m.params !== 'object' || 'repo' in m.params)) throw new Error(where + ': params must be an object without `repo`');
}

export function createEngine(options = {}) {
  const listeners = new Map();
  const emit = (event, data) => {
    const set = listeners.get(event);
    if (set) for (const fn of Array.from(set)) { try { fn(data); } catch { /* a listener must not break the engine */ } }
  };
  const registry = new Map();
  for (const m of METHODS.concat(options.methods || [])) {
    checkDefinition(m);
    if (registry.has(m.name)) throw new Error('method registered twice: ' + m.name);
    registry.set(m.name, Object.freeze({ ...m }));
  }
  const queue = createQueue();
  const jobs = createJobs(emit);
  const home = createHome(options.home);
  // the engine's folder inside every git dir and the name it writes into git (core/repo.js dataDir/label)
  const safeName = (v, fallback) => (typeof v === 'string' && /^[a-z0-9][a-z0-9._-]{0,40}$/i.test(v) && !v.startsWith('.') ? v : fallback);
  const dataName = safeName(options.dataDir, DATA_DIR);
  const labelName = typeof options.label === 'string' && options.label.trim() ? options.label.trim().slice(0, 40) : LABEL;
  const watchOpts = options.watch || {};
  const gitEnv = { ...(options.gitEnv || {}) };
  const readLimiter = createLimiter(options.maxReads || 8);
  const readTimeoutMs = options.readTimeoutMs || 0; // 0: runGit's default (120 s) for reads; mutating methods have none
  const walks = createWalkCache({ max: options.walkCacheSize || 3 });
  const entries = new Map(); // root -> entry
  const resolved = new Map(); // input folder -> Promise<repo>
  const gone = new Set(); // clients whose stream closed: a subscribe that arrives late must not start a watcher
  let closed = false;
  // Every snapshot version of this engine, all repositories: grows only. It starts at the clock (ms), so the versions
  // of a restarted server or worker are larger than any its predecessor gave out (one per change, far fewer than one
  // a millisecond): a page that still holds an old number — also one whose scripts predate the store's own reset on
  // reconnect (ui/git/store.js) — takes the new engine's snapshots. options.versionStart: tests.
  let versionSeq = Number.isSafeInteger(options.versionStart) ? options.versionStart : Date.now();

  /** Forgets the oldest repositories nobody uses (no subscriber, no watcher, no call running) beyond IDLE_ENTRY_CAP. */
  function evictIdle() {
    const idle = [];
    for (const [root, x] of entries) if (!x.clients.size && !x.watcher && !x.holds && !x.inUse && !x.queued) idle.push(root);
    for (let i = 0; i < idle.length - IDLE_ENTRY_CAP; i++) entries.delete(idle[i]);
  }
  /** Remembers a resolution, the oldest forgotten beyond RESOLVED_CAP (a forgotten folder is resolved again). */
  function remember(folder, p) {
    resolved.delete(folder);
    resolved.set(folder, p);
    while (resolved.size > RESOLVED_CAP) resolved.delete(resolved.keys().next().value);
  }
  // The log on disk (options.log: createDiskLog, core/disklog.js): every git command through runGit's `trace`, each
  // call's start and end, page errors through diag.report. Nothing is written without it.
  const diskLog = options.log && typeof options.log.write === 'function' ? options.log : null;
  const trace = diskLog ? (r) => diskLog.write(gitLine(r)) : undefined;
  const report = createReportLimit(diskLog);
  const withEnv = (opts) => {
    const o = opts && opts.env ? { ...opts, env: { ...gitEnv, ...opts.env } } : { ...(opts || {}), env: gitEnv };
    if (trace && !o.trace) o.trace = trace;
    return o;
  };

  async function openEntry(folder) {
    let p = resolved.get(folder);
    if (p) {
      // A cached resolution is re-checked with a few stats: the folder may have become its own repository, the .git
      // may be gone, a linked worktree's main repository may have moved, or the repository was created again.
      const prev = await p.catch(() => null);
      if (!prev || !resolutionHolds(folder, prev)) { if (resolved.get(folder) === p) resolved.delete(folder); p = null; }
    }
    if (!p) {
      p = resolveRepo(folder, { env: gitEnv, trace });
      remember(folder, p);
      p.catch(() => { if (resolved.get(folder) === p) resolved.delete(folder); });
    } else remember(folder, p);
    const repo = await p;
    repo.dataDir = dataName;
    repo.label = labelName;
    let e = entries.get(repo.root);
    if (e && (e.repo.gitDir !== repo.gitDir || e.repo.commonDir !== repo.commonDir || e.repo.gitDirId !== repo.gitDirId)) {
      stopWatching(e);
      entries.delete(repo.root);
      e = null;
    }
    if (!e) {
      e = { repo, snapshot: null, version: 0, dirty: true, chain: Promise.resolve(), queued: null, clients: new Set(), watcher: null, holds: 0, inUse: 0 };
      entries.set(repo.root, e);
      evictIdle();
    } else { entries.delete(repo.root); entries.set(repo.root, e); }   // most recently used last
    return e;
  }

  // A snapshot rebuild (every change of a watched repository: about 8 git commands) writes ONE `refresh` line to the
  // log on disk: its duration, how many commands, the slowest one; a command that did not succeed still gets its
  // own `git` line with exit code and stderr. Without this an editor saving every few seconds filled the day's cap.
  const bgTrace = (acc) => (diskLog ? (r) => {
    acc.n++;
    if (!r.ok) { acc.failed++; diskLog.write(gitLine(r)); }
    if (!acc.slow || r.ms > acc.slow.ms) acc.slow = { args: redactArgs(r.args).slice(0, 4), ms: r.ms };
  } : undefined);
  const bg = (e, acc) => (args, opts) => runGit(e.repo.root, args, withEnv({ quiet: true, optionalLocks: false, limiter: readLimiter, limitKey: 'bg:' + e.repo.root, ...(acc && diskLog ? { trace: bgTrace(acc) } : {}), ...(opts || {}) }));

  function diffSections(a, b) {
    if (!a) return ['state', 'refs', 'worktree', 'op'];
    const what = [];
    for (const [section, keys] of Object.entries(SECTIONS)) {
      if (keys.some((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))) what.push(section);
    }
    if (what.length) what.unshift('state');
    return what;
  }

  /**
   * Rebuilds the snapshot (serialized per entry). Returns { snapshot, what, emitted }. Callers that arrive while a
   * rebuild is queued but not started share it (it starts after them, so it sees what they saw); a rebuild that has
   * already started is not shared, as it may have read the repository before the caller's change.
   */
  function rebuild(e) {
    if (e.queued) return e.queued;
    const run = e.chain.then(async () => {
      if (e.queued === run) e.queued = null;
      e.dirty = false;
      let snap;
      const acc = { n: 0, failed: 0, slow: null }, t0 = Date.now();
      try { snap = await buildSnapshot(e.repo, bg(e, acc)); } catch (err) { e.dirty = true; throw err; } finally {
        if (diskLog && acc.n) diskLog.write({ kind: 'refresh', repo: e.repo.root, ms: Date.now() - t0, git: acc.n, failed: acc.failed, slowest: acc.slow });
      }
      const what = e.snapshot ? diffSections(e.snapshot, snap) : [];
      if (!e.snapshot || what.length) e.version = ++versionSeq;
      snap.version = e.version;
      e.snapshot = snap;
      return { snapshot: snap, what, emitted: false };
    });
    e.queued = run;
    e.chain = run.catch(() => {});
    return run;
  }

  async function snapshotOf(e) {
    if (e.snapshot && !e.dirty && e.watcher) return e.snapshot;
    const r = await rebuild(e);
    if (r.what.length && !r.emitted) { r.emitted = true; emit('changed', { repo: e.repo.root, version: r.snapshot.version, what: r.what }); }
    return r.snapshot;
  }

  async function refreshEntry(e, extra) {
    const r = await rebuild(e);
    const what = r.emitted ? [] : r.what.slice();
    r.emitted = true;
    const evt = { repo: e.repo.root, version: r.snapshot.version, what };
    if (extra && extra.files) { what.push('files'); evt.paths = extra.paths; }
    if (what.length) emit('changed', evt);
    return r.snapshot;
  }

  async function isIgnored(e, list) {
    // check-ignore refuses pathspec magic, so GIT_LITERAL_PATHSPECS is off here (its input is not a pathspec anyway).
    // (the watcher's storm guard, before every refresh of work tree changes: only a check that failed is logged)
    const quietTrace = diskLog ? (r) => { if (r.killed || (r.exitCode !== 0 && r.exitCode !== 1)) diskLog.write(gitLine(r)); } : undefined;
    const out = await runGit(e.repo.root, ['check-ignore', '-z', '--stdin'], withEnv({ quiet: true, optionalLocks: false, okCodes: [0, 1], input: list.join('\0') + '\0', env: { GIT_LITERAL_PATHSPECS: '0' }, limiter: readLimiter, limitKey: 'bg:' + e.repo.root, ...(quietTrace ? { trace: quietTrace } : {}) }));
    return new Set(out.stdout.split('\0').filter(Boolean));
  }

  function startWatching(e) {
    if (e.watcher || closed) return;
    e.watcher = createWatcher(e.repo, {
      debounceMs: watchOpts.debounceMs,
      minIntervalMs: watchOpts.minIntervalMs,
      maxWaitMs: watchOpts.maxWaitMs,
      isIgnored: (list) => isIgnored(e, list),
      onChange: async ({ kinds, paths }) => {
        e.dirty = true;
        const files = kinds.includes('worktree');
        await refreshEntry(e, files ? { files: true, paths } : null);
      },
      onError: () => {},
    });
    for (let i = 0; i < e.holds; i++) e.watcher.hold();
    // Whatever was read before the watcher existed may be stale already: the next read rebuilds.
    e.dirty = true;
  }

  function stopWatching(e) {
    if (e.watcher) { e.watcher.close(); e.watcher = null; }
    e.dirty = true;
  }

  function subscribe(e, client) {
    if (gone.has(client)) return; // its stream closed while this call was on its way
    e.clients.add(client);
    startWatching(e);
  }

  function unsubscribe(e, client) {
    e.clients.delete(client);
    if (!e.clients.size) { stopWatching(e); evictIdle(); }
  }

  function makeCtx(def, e, meta) {
    const ctxJobs = [];
    // A read stops when its caller goes away; a mutating method always runs to its end (or its own job's cancel).
    const callerSignal = !def.mutating && meta.signal ? meta.signal : undefined;
    const consoleSink = e ? (lines) => emit('console', { repo: e.repo.root, lines }) : null;
    const reports = def.console === undefined ? def.mutating : def.console;
    const ctx = {
      repo: e ? e.repo : null,
      client: meta.client || 'default',
      home,
      emit,
      fail: (code, message, data) => { throw new EngineError(code, message, data); },
      log(text, kind = 'out') {
        if (consoleSink) consoleSink(String(text).split('\n').map((t) => ({ time: Date.now(), kind, text: t })));
      },
      job(opts = {}) {
        const j = jobs.start({ repo: e ? e.repo.root : null, title: opts.title || def.name, cancellable: !!opts.cancellable });
        ctxJobs.push(j);
        ctx.signal = callerSignal ? AbortSignal.any([callerSignal, j.signal]) : j.signal;
        return j;
      },
      signal: callerSignal,
      // After a job's git command ended (done, failed or cancelled): the git commands that follow run to their end,
      // so a handler can tidy up after a cancel and read what really happened.
      detach() { ctx.signal = callerSignal; },
      walks,
      jobs: { cancel: (id) => jobs.cancel(id), get: (id) => jobs.get(id), list: () => jobs.list() },
      openRepo: async (folder) => (await openEntry(folder)).repo,
      // a page's error for the log on disk (diag.report); false when there is no log or the rate limit left it out
      report: (line) => report({ ...line, client: ctx.client }),
    };
    if (e) {
      ctx.git = (args, opts = {}) => runGit(e.repo.root, args, withEnv({
        console: consoleSink,
        quiet: !reports,
        // A mutating method's git runs to its end (a slow hook, a long rebase): no read timeout; a job's cancel still
        // stops it where the job allows that. Reads keep runGit's default timeout.
        ...(def.mutating ? { timeoutMs: 0 } : { optionalLocks: false, limiter: readLimiter, limitKey: 'client:' + ctx.client, ...(readTimeoutMs ? { timeoutMs: readTimeoutMs } : {}) }),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
        ...opts,
      }));
      ctx.snapshot = () => snapshotOf(e);
      ctx.invalidate = () => { e.dirty = true; };
      ctx.refresh = () => refreshEntry(e);
      ctx.subscribe = () => subscribe(e, ctx.client);
      ctx.unsubscribe = () => unsubscribe(e, ctx.client);
      ctx.version = () => e.version;
      ctx.repoState = {
        read: () => readRepoState(e.repo),
        write(data) {
          const file = stateFile(e.repo);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          const tmp = file + '.' + process.pid + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
          fs.renameSync(tmp, file);
          e.dirty = true;
        },
      };
    }
    return { ctx, ctxJobs };
  }

  async function invoke(def, e, params, meta) {
    const { ctx, ctxJobs } = makeCtx(def, e, meta);
    try {
      const result = await def.handler(ctx, params);
      ctxJobs.forEach((j) => j.end('done'));
      // ctx.staging = 'unstaged': the handler could not put the staging back as it was (index entries with flags a
      // tree loses, core/ops/autostash.js undoStashSideEffects); every result and error says so
      if (ctx.staging && result && typeof result === 'object' && !result.staging) result.staging = ctx.staging;
      return result === undefined ? null : result;
    } catch (err) {
      const cancelled = err && (err.cancelled || err.code === 'cancelled');
      ctxJobs.forEach((j) => j.end(cancelled ? 'cancelled' : 'failed'));
      if (ctx.staging && err instanceof EngineError) err.data = { ...(err.data || {}), staging: ctx.staging };
      else if (ctx.staging && err && err.name === 'GitError') { const w = toWireError(err); throw new EngineError(w.code, w.message, { ...(w.data || {}), staging: ctx.staging }); }
      throw err;
    }
  }

  async function runMutating(def, e, params, meta) {
    const siblings = () => Array.from(entries.values()).filter((x) => x.repo.commonDir === e.repo.commonDir);
    siblings().forEach((x) => { x.holds++; if (x.watcher) x.watcher.hold(); });
    try {
      return await invoke(def, e, params, meta);
    } finally {
      for (const x of siblings()) {
        x.holds = Math.max(0, x.holds - 1);
        x.dirty = true;
        if (x.watcher) x.watcher.release(true);
        if (x === e || x.watcher) { try { await refreshEntry(x); } catch { /* the repository may be gone */ } }
      }
    }
  }

  /**
   * call() with its lines in the log on disk (not for diag.report, whose line is the report). A mutating method writes
   * a start line (with its parameters) and an end line: what was under way when something went wrong stays visible.
   * A read writes one line when it ends, with its parameters, duration and outcome (phase 'done'): reads run on every
   * change and every page, and a start line of theirs says nothing the end line does not.
   */
  async function call(method, params, meta = {}) {
    if (!diskLog || method === 'diag.report') return callInner(method, params, meta);
    const t0 = Date.now();
    const repo = params && typeof params === 'object' && typeof params.repo === 'string' ? params.repo : undefined;
    let summary;
    try { const { repo: _r, ...rest } = params && typeof params === 'object' && !Array.isArray(params) ? params : {}; summary = summarizeParams(rest); } catch { summary = null; }
    const client = meta.client || 'default';
    const def = registry.get(method);
    const mutating = !!(def && def.mutating);
    if (mutating) diskLog.write({ kind: 'op', phase: 'start', method, repo, client, params: summary });
    const end = (fields) => diskLog.write(mutating
      ? { kind: 'op', phase: 'end', method, repo, client, ms: Date.now() - t0, ...fields }
      : { kind: 'op', phase: 'done', method, repo, client, params: summary, ms: Date.now() - t0, ...fields });
    try {
      const result = await callInner(method, params, meta);
      end({ ok: true });
      return result;
    } catch (err) {
      end({ ok: false, error: errorSummary(err) });
      throw err;
    }
  }

  async function callInner(method, params, meta = {}) {
    if (closed) throw new EngineError('internal', 'engine is closed');
    try {
      const def = registry.get(method);
      if (!def) throw new EngineError('unknown_method', 'unknown method ' + method, { method });
      if (params != null && (typeof params !== 'object' || Array.isArray(params))) throw new EngineError('invalid_params', 'params must be an object', { param: 'params', reason: 'must be an object' });
      const raw = { ...(params || {}) };
      let e = null;
      if (def.repo) {
        if (typeof raw.repo !== 'string' || !path.isAbsolute(raw.repo)) throw new EngineError('invalid_params', 'repo must be an absolute folder path', { param: 'repo', reason: 'must be absolute' });
        e = await openEntry(raw.repo);
        delete raw.repo;
      }
      if (e) e.inUse++;
      try {
        const p = validate(def.params || {}, raw);
        if (def.mutating) return await queue.run(e.repo.commonDir, () => runMutating(def, e, p, meta));
        return await invoke(def, e, p, meta);
      } finally {
        if (e && --e.inUse === 0 && !e.clients.size && entries.size > IDLE_ENTRY_CAP) evictIdle();
      }
    } catch (err) {
      if (err instanceof EngineError) throw err;
      const w = toWireError(err);
      throw new EngineError(w.code, w.message, w.data);
    }
  }

  return {
    call,
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => { const set = listeners.get(event); if (set) set.delete(fn); };
    },
    /** A host calls this when a client's event stream goes away: its subscriptions end. */
    dropClient(client) {
      if (client && client !== 'default') {
        gone.add(client);
        if (gone.size > GONE_CAP) gone.delete(gone.values().next().value);
      }
      for (const e of entries.values()) if (e.clients.has(client)) unsubscribe(e, client);
    },
    methods: () => Array.from(registry.values()).map((m) => ({ name: m.name, repo: m.repo, mutating: m.mutating })),
    home,
    /** Sizes of what the engine keeps (tests: the soak test asserts they level off; nothing in the UI reads it). */
    stats() {
      let watchers = 0, watchedDirs = 0, subscriptions = 0, snapshots = 0, inUse = 0;
      for (const e of entries.values()) {
        if (e.watcher) { watchers++; watchedDirs += e.watcher.dirs.length; }
        subscriptions += e.clients.size;
        if (e.snapshot) snapshots++;
        inUse += e.inUse;
      }
      let listening = 0;
      for (const set of listeners.values()) listening += set.size;
      return {
        entries: entries.size, resolved: resolved.size, gone: gone.size, watchers, watchedDirs, subscriptions, snapshots, inUse,
        walks: walks.size, walkResults: walks.resultsSize, jobs: jobs.list().length, queued: queue.size(), listeners: listening,
        reads: { running: readLimiter.running, waiting: readLimiter.waiting, keys: readLimiter.keys }, git: liveGit(),
      };
    },
    close() {
      closed = true;
      for (const e of entries.values()) stopWatching(e);
      walks.clear();
      listeners.clear();
    },
  };
}
