// Change detection (docs/ARCHITECTURE.md §3.4). fs.watch(recursive) — FSEvents on macOS — on the work tree, the
// worktree's git dir and the common dir. Raw events are classified, debounced, and handed to `onChange({ kinds, paths })`
// at most once per `minIntervalMs` (the storm guard). Debouncing never starves: a delivery is due at the latest
// `maxWaitMs` after the first event of a batch, however long the events keep coming (a dev server writing its log,
// a build). Work tree events whose paths are all ignored by git are dropped before they cost a status run
// (`isIgnored`, which also decides for the folders of a batch too large to list path by path). While `hold()` is in
// effect (a mutating method runs) nothing is delivered; the engine refreshes itself when the method ends.
//
// kinds: 'refs' (HEAD, refs/, packed-refs, reftable/, config, favorites, logs/refs/stash),'index' (index, info/exclude,
//        info/sparse-checkout, shallow), 'op' (merge/rebase/pick/revert state, prepared messages),
//        'worktree' (files in the work tree; their paths are collected)
// Paths are NFC on macOS: FSEvents reports names as they are on disk (Cocoa apps write them decomposed), git reports
// them precomposed (core.precomposeunicode), and the UI compares the two as strings.
import fs from 'node:fs';
import path from 'node:path';
import { isInside, DATA_DIR, dataDir } from './repo.js';

const OP_FILES = new Set(['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'SQUASH_MSG', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'AUTO_MERGE']);
const OP_DIRS = ['rebase-merge', 'rebase-apply', 'sequencer'];
const REF_TOP = new Set(['HEAD', 'refs', 'packed-refs', 'config', 'config.worktree', 'reftable', 'commondir']);
const PATH_CAP = 1000; // paths an event lists; more -> paths: null
const COLLECT_CAP = 50000; // paths kept for the ignore check; beyond it only their folders
const DIR_CAP = 5000;
export const toNFC = process.platform === 'darwin' ? (s) => s.normalize('NFC') : (s) => s;

/** Classifies a path inside a git dir ('' = the dir itself). Returns a kind or null (ignored). */
export function classifyGitPath(rel, own = DATA_DIR) {
  const parts = rel.split(path.sep).filter(Boolean);
  if (!parts.length) return null;
  const top = parts[0];
  const last = parts[parts.length - 1];
  if (last.endsWith('.lock')) return null;
  if (OP_DIRS.includes(top)) return 'op';
  if (OP_FILES.has(top)) return 'op';
  if (REF_TOP.has(top)) return 'refs';
  if (top === 'index' || top === 'shallow' || top === 'sharedindex') return 'index';
  if (top === 'info') return parts[1] === 'exclude' || parts[1] === 'sparse-checkout' || parts[1] === 'grafts' ? 'index' : null;
  if (top === own) return parts[1] === 'state.json' ? 'refs' : null;
  // the stash list is the reflog of refs/stash: dropping stash@{1} rewrites only logs/refs/stash
  if (top === 'logs' && parts[1] === 'refs' && parts[2] === 'stash' && parts.length === 3) return 'refs';
  return null; // objects/, other logs/, hooks/, FETCH_HEAD, ORIG_HEAD, COMMIT_EDITMSG, worktrees/<other>, …
}

export function createWatcher(repo, opts) {
  const debounceMs = opts.debounceMs ?? 150;
  const minIntervalMs = opts.minIntervalMs ?? 1000;
  const maxWaitMs = Math.max(opts.maxWaitMs ?? 1500, debounceMs);
  const roots = [];
  const add = (dir, type) => { if (!roots.some((r) => isInside(dir, r.dir))) roots.push({ dir, type }); };
  // One watcher per folder that is not inside another watched one (a linked worktree's git dir is inside the common
  // dir; a normal repository's .git is inside the work tree). classify() decides by path, git dirs first.
  add(repo.root, 'work');
  add(repo.commonDir, 'git');
  add(repo.gitDir, 'git');

  const watchers = [];
  let kinds = new Set();
  let paths = new Set();
  let dirs = new Set();
  let overflow = false; // more paths than COLLECT_CAP: `dirs` stands for the rest
  let tooMany = false; // more folders than DIR_CAP: nothing can be decided path by path
  let timer = null;
  let pendingSince = 0;
  let lastRun = 0;
  let held = 0;
  let closed = false;
  let running = false;

  function classify(abs) {
    if (isInside(abs, repo.gitDir)) return { kind: classifyGitPath(path.relative(repo.gitDir, abs), dataDir(repo)) };
    if (isInside(abs, repo.commonDir)) {
      const rel = path.relative(repo.commonDir, abs);
      if (rel.split(path.sep)[0] === 'worktrees') return { kind: null }; // other worktrees' private state
      return { kind: classifyGitPath(rel, dataDir(repo)) };
    }
    if (isInside(abs, repo.root)) {
      const rel = path.relative(repo.root, abs);
      if (!rel) return { kind: null };
      if (rel.split(path.sep)[0] === '.git') return { kind: null }; // a gitfile or a foreign nested .git
      return { kind: 'worktree', rel: toNFC(rel.split(path.sep).join('/')) };
    }
    return { kind: null };
  }

  function onEvent(base, filename) {
    if (closed) return;
    const abs = filename ? path.join(base, filename.toString()) : base;
    const c = classify(abs);
    if (!c.kind) return;
    kinds.add(c.kind);
    if (c.rel) {
      if (paths.size < COLLECT_CAP) paths.add(c.rel);
      else {
        overflow = true;
        const d = c.rel.includes('/') ? c.rel.slice(0, c.rel.lastIndexOf('/')) : '';
        if (dirs.size < DIR_CAP) dirs.add(d); else tooMany = true;
      }
    }
    schedule();
  }

  function schedule() {
    if (closed || held) return;
    const now = Date.now();
    if (!pendingSince) pendingSince = now;
    const earliest = lastRun + minIntervalMs; // the storm guard
    const due = Math.max(now + debounceMs, earliest);
    const latest = Math.max(pendingSince + maxWaitMs, earliest); // debouncing must not starve the batch
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, Math.max(0, Math.min(due, latest) - now));
  }

  async function flush() {
    timer = null;
    if (closed || held) return;
    if (running) { schedule(); return; }
    if (!kinds.size) { pendingSince = 0; return; }
    const k = kinds;
    const p = paths;
    const d = dirs;
    const over = overflow;
    const many = tooMany;
    kinds = new Set();
    paths = new Set();
    dirs = new Set();
    overflow = false;
    tooMany = false;
    pendingSince = 0;
    running = true;
    lastRun = Date.now();
    try {
      let list = Array.from(p);
      let unknown = many; // some changed files could not be checked
      if (k.has('worktree') && !many && opts.isIgnored) {
        const folders = over ? Array.from(d).filter((x) => x) : [];
        let ignored = new Set();
        try { ignored = await opts.isIgnored(list.concat(folders)); } catch (e) { unknown = true; if (opts.onError) opts.onError(e); }
        list = list.filter((x) => !ignored.has(x));
        // Overflow paths are represented by their folders: an ignored folder ignores all of them.
        if (over && (d.has('') || folders.some((f) => !ignored.has(f)))) unknown = true;
        if (!list.length && !unknown) k.delete('worktree');
      }
      const report = unknown || list.length > PATH_CAP ? null : list;
      if (k.size) await opts.onChange({ kinds: Array.from(k), paths: report });
    } catch (e) {
      if (opts.onError) opts.onError(e);
    } finally {
      running = false;
      if (kinds.size) schedule();
    }
  }

  for (const r of roots) {
    try {
      const w = fs.watch(r.dir, { recursive: true, persistent: false }, (_type, filename) => onEvent(r.dir, filename));
      w.on('error', (e) => { if (opts.onError) opts.onError(e); });
      watchers.push(w);
    } catch (e) {
      if (opts.onError) opts.onError(e);
    }
  }

  return {
    dirs: roots.map((r) => r.dir),
    hold() { held++; if (timer) { clearTimeout(timer); timer = null; } },
    /** Ends a hold. Events collected meanwhile are dropped: the caller refreshes itself. */
    release(dropPending = true) {
      held = Math.max(0, held - 1);
      if (held) return;
      if (dropPending) {
        kinds = new Set(); paths = new Set(); dirs = new Set(); overflow = false; tooMany = false; pendingSince = 0;
        lastRun = Date.now();
      } else schedule();
    },
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      watchers.forEach((w) => { try { w.close(); } catch { /* closed */ } });
    },
  };
}
