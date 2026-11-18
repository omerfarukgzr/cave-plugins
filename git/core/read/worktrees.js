// Worktrees group: worktree.list — the repository's worktrees (`git worktree list --porcelain -z`) and, for every one
// that is on disk, how many entries the Commit view would list there (changes, unversioned files and conflicts: the
// snapshot's own reading, core/snapshot.js localLists, so a row's number is what the panel shows after picking it).
// `counts: false` leaves every count out (`changes: null`) and runs no status at all.
// Read only: background reads (no optional locks), nothing is written. A worktree whose count does not arrive within
// COUNT_MS (slow disk, a broken worktree, git failing) gets `changes: null`; it never holds the list back.
import fs from 'node:fs';
import path from 'node:path';
import { parseStatusV2 } from '../parse.js';
import { STATUS_ARGS, localLists } from '../snapshot.js';

const COUNT_CONCURRENCY = 3;
const COUNT_MS = 4000;

/** `git worktree list --porcelain -z` → [{ path, head, branch, detached, bare, locked, lockReason, prunable, prunableReason }]. */
export function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  for (const field of String(text || '').split('\0')) {
    if (!field) { if (cur) out.push(cur); cur = null; continue; }
    const sp = field.indexOf(' ');
    const key = sp < 0 ? field : field.slice(0, sp);
    const value = sp < 0 ? '' : field.slice(sp + 1);
    if (key === 'worktree') {
      if (cur) out.push(cur);
      cur = { path: value, head: null, branch: null, detached: false, bare: false, locked: false, lockReason: null, prunable: false, prunableReason: null };
      continue;
    }
    if (!cur) continue;
    if (key === 'HEAD') cur.head = value;
    else if (key === 'branch') cur.branch = value.startsWith('refs/heads/') ? value.slice(11) : value;
    else if (key === 'detached') cur.detached = true;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') { cur.locked = true; cur.lockReason = value || null; }
    else if (key === 'prunable') { cur.prunable = true; cur.prunableReason = value || null; }
  }
  if (cur) out.push(cur);
  return out;
}

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
// A worktree folder without its `.git` (file or folder) is broken: git would find the repository of a folder above
// (a worktree kept inside the main work tree) and count that one's changes.
const hasGit = (p) => { try { fs.lstatSync(path.join(p, '.git')); return true; } catch { return false; } };
const real = (p) => { try { return fs.realpathSync(p); } catch { return p; } };

/** Runs fn over items with at most `n` at a time. */
async function eachLimited(items, n, fn) {
  let next = 0;
  const lane = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
}

/** The Commit view's count in worktree `dir`, or null when it is not there within `ms`. */
async function countChanges(ctx, dir, ms) {
  if (!hasGit(dir)) return null;
  const stop = new AbortController();
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, stop.signal]) : stop.signal;
  // every command of this count runs in `dir` (git's -C), with the read's options and this count's own deadline
  const git = (args, opts) => ctx.git(['-C', dir, ...args], { ...(opts || {}), signal, timeoutMs: ms });
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => { stop.abort(); resolve(null); }, ms); });
  const count = (async () => {
    const out = await git(STATUS_ARGS);
    const { local, conflicts } = await localLists(git, parseStatusV2(out.stdout));
    return local.length + conflicts.length;
  })().catch(() => null);
  try { return await Promise.race([count, late]); } finally { clearTimeout(timer); }
}

export default [
  {
    name: 'worktree.list', repo: true, mutating: false,
    // counts: false is the list alone (one `git worktree list`, no status anywhere): what a page reads in the
    // background for the chip; the list's menu asks with counts.
    params: { counts: { type: 'bool', default: true } },
    async handler(ctx, p) {
      const out = await ctx.git(['worktree', 'list', '--porcelain', '-z']);
      const list = parseWorktreeList(out.stdout).filter((w) => !w.bare);
      const rows = list.map((w, i) => {
        const exists = isDir(w.path);
        const p = exists ? real(w.path) : w.path;
        return {
          path: p,
          name: path.basename(p),
          // git lists the main worktree first (a bare repository's entry, when there is one, is left out above)
          main: i === 0 && !list[0].bare,
          current: p === ctx.repo.root,
          head: w.head || null,
          branch: w.detached ? null : w.branch,
          detached: !!w.detached,
          locked: w.locked,
          lockReason: w.lockReason,
          prunable: w.prunable || !exists,
          prunableReason: w.prunableReason,
          exists,
          changes: null,
        };
      });
      if (p.counts) await eachLimited(rows.filter((r) => r.exists), COUNT_CONCURRENCY, async (r) => { r.changes = await countChanges(ctx, r.path, COUNT_MS); });
      rows.forEach((r) => { delete r.exists; });
      return { root: ctx.repo.root, worktrees: rows };
    },
  },
];
