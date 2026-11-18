// What every operation on a stash shares (docs/spec-stash.md "Engine design"): finding a stash by its commit id in the
// list as it is NOW, finding the stash a push just made, the verified drop, applying by id with the work tree guard.
// Used by core/ops/stash.js (stash.*) and by Smart Checkout (core/ops/branches.js).
//
// Serialization: every caller is a mutating method, and the engine runs mutating methods one at a time per COMMON dir
// (core/engine.js `queue.run(e.repo.commonDir, …)`): two panels of two worktrees of one repository never interleave
// what changes refs/stash. Other programs (another engine, plain git) are caught by the checks after each command.
import path from 'node:path';
import { readStashList } from '../read/stash.js';
import { saveStashTrash, dropStashTrash, stashTrashSummary } from '../stash-trash.js';
import { lstat } from '../fsname.js';
import { tryGit, unmerged, parseWouldOverwrite, asJob, isCancel, refuse } from './util.js';
import { inTheWay, treeWrites } from './guard.js';
import { EngineError } from '../errors.js';

const NUL = '\0';
export const OID = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Options for git's stash commands. git stash runs its own commands with pathspecs such as `:/` (keep-index restores
 * the index with `git checkout -- :/`, include-untracked cleans with one): under the engine's GIT_LITERAL_PATHSPECS=1
 * those are literal names, `--keep-index` fails ("pathspec ':/' did not match") and `--include-untracked` stores the
 * untracked files without removing them. The engine passes no path to a stash command, so literal pathspecs protect
 * nothing here and are turned off for them.
 */
export const STASH_OPTS = Object.freeze({ env: { GIT_LITERAL_PATHSPECS: '0' } });

/** Counts of ids (a stash commit can be stored twice). */
const counts = (list) => { const m = new Map(); for (const s of list) m.set(s.id, (m.get(s.id) || 0) + 1); return m; };

/** The stash `id` in the list now, or a not_found error. `id` must be a full id: never an index from the UI. */
export async function stashById(ctx, id, param = 'id') {
  if (typeof id !== 'string' || !OID.test(id)) throw new EngineError('invalid_params', 'not a full stash id: ' + id, { param, reason: 'not a full object id' });
  const list = await readStashList(ctx);
  const s = list.find((x) => x.id === id);
  if (!s) ctx.fail('not_found', 'no stash ' + id + ' in the stash list', { reason: 'no_stash', id });
  return { stash: s, list };
}

/**
 * The stash a `git stash push` just made: the top-most entry that was not in `before` (ids), whose first parent is
 * `head` (HEAD before the push) and whose subject ends with `message` (git's "On <branch>: <message>"; for git's own
 * message "WIP on <branch>: <hash> <subject>" pass null: then it must start with "WIP on "). Another session may push
 * in between; when the candidates are not exactly one, the answer is { stash: null, candidates }.
 */
export async function findPushed(ctx, before, head, message) {
  const list = await readStashList(ctx);
  const had = counts(before.map((id) => ({ id })));
  const fresh = [];
  for (const s of list) {
    const n = had.get(s.id) || 0;
    if (n > 0) { had.set(s.id, n - 1); continue; }
    fresh.push(s);
  }
  const ours = fresh.filter((s) => s.base === head && (message ? s.subject.endsWith(': ' + message) : s.subject.startsWith('WIP on ')));
  return { stash: ours.length === 1 ? ours[0] : null, candidates: ours.map((s) => s.id), fresh: fresh.map((s) => s.id), list };
}

/** git's "Dropped stash@{n} (<hash>)" (LC_ALL=C): the id it names, or null. A second signal beside the list. */
const droppedId = (stdout) => { const m = /\(([0-9a-f]{40,64})\)\s*$/.exec(String(stdout || '').trim()); return m ? m[1] : null; };

/**
 * Drops stash `id` so that it stays recoverable: a trash entry with a ref that keeps the commit is made first (any
 * failure there drops nothing), then `git stash drop stash@{n}` with the n found in the list right before. Then the
 * list is read again: `id` must be gone once and every other stash still there. A stash dropped by mistake (another
 * program moved the list between the read and the drop) is stored back at once (its subject read from the commit);
 * should that fail, a trash ref keeps it and the error says so. Returns the entry (summary) or throws.
 */
export async function dropVerified(ctx, id, op) {
  const { stash, list } = await stashById(ctx, id);
  const entry = await saveStashTrash(ctx, [{ id: stash.id, subject: stash.subject }], op);
  const r = await tryGit(ctx, ['stash', 'drop', stash.ref], STASH_OPTS);
  const after = await readStashList(ctx);
  const was = counts(list);
  const now = counts(after);
  const missing = [];
  for (const [x, n] of was) for (let i = 0; i < n - (now.get(x) || 0); i++) missing.push(x);
  const ourGone = missing.includes(id);
  const others = missing.filter((x) => x !== id);
  if (ourGone && !others.length && (now.get(id) || 0) === (was.get(id) || 0) - 1) {
    return stashTrashSummary(entry);
  }
  // put back whatever went that was not ours (from the state; git's own message as a fallback)
  const wrong = others.length ? others : (r.exitCode === 0 && droppedId(r.stdout) && droppedId(r.stdout) !== id ? [droppedId(r.stdout)] : []);
  const unkept = [];
  for (const w of wrong) {
    const subj = (await ctx.git(['log', '-1', '--format=%s', '--end-of-options', w], { okCodes: [0, 128] })).stdout.trim() || 'restored stash';
    const back = await tryGit(ctx, ['stash', 'store', '-q', '-m', subj, w], STASH_OPTS);
    if (back.exitCode !== 0) {
      try { unkept.push(stashTrashSummary(await saveStashTrash(ctx, [{ id: w, subject: subj }], 'stash.drop (kept)'))); } catch { unkept.push({ stashes: [w], ref: null }); }
    }
  }
  if (ourGone) {
    // ours went, and something else went too (and was put back): the drop did what was asked
    return stashTrashSummary(entry);
  }
  await dropStashTrash(ctx, entry);
  if (wrong.length) refuse(ctx, 'stash_moved', 'the stash list changed while dropping; nothing of yours was dropped', { id, restored: wrong, kept: unkept });
  if (r.exitCode !== 0) throw r.fail();
  refuse(ctx, 'stash_moved', 'the stash was not dropped: the list changed', { id });
  return null;
}

/** Paths of the untracked part of a stash (its third parent's tree). */
async function untrackedPaths(ctx, s) {
  if (!s.untrackedId) return [];
  const out = await ctx.git(['ls-tree', '-r', '-z', '--name-only', '--full-tree', '--end-of-options', s.untrackedId]);
  return out.stdout.split(NUL).filter(Boolean);
}

/**
 * What stands in the way of applying stash `s` (git would refuse half way or overwrite content it does not track):
 * { files, untracked } or null. The tracked paths it changes must have no untracked or ignored content standing at,
 * above or below them (the guard); every path of its untracked part must be free on disk, parents included (git
 * applies the tracked part first and then stops on "already exists, no checkout").
 */
export async function stashBlocked(ctx, s, extraWrites = []) {
  const writes = (await treeWrites(ctx, s.base, s.id)).concat(extraWrites);
  const hazards = await inTheWay(ctx, writes);
  const untracked = new Set(hazards.map((h) => h.path));
  const files = new Set();
  const paths = await untrackedPaths(ctx, s);
  if (paths.length) {
    const tracked = new Set((await ctx.git(['ls-files', '-z', '--full-name'])).stdout.split(NUL).filter(Boolean));
    for (const p of paths) {
      const parts = p.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const rel = parts.slice(0, i).join('/');
        const st = lstat(path.join(ctx.repo.root, rel));
        if (!st) break;
        if (i < parts.length && st.isDirectory()) continue;
        (tracked.has(rel) ? files : untracked).add(rel);
        break;
      }
    }
  }
  if (!files.size && !untracked.size) return null;
  return { files: Array.from(files).sort(), untracked: Array.from(untracked).sort() };
}

/**
 * Entries whose per-entry flags `git read-tree` would drop (assume-unchanged, skip-worktree, intent-to-add): after a
 * failed `apply --index` the index is put back from its tree only when there are none.
 */
export async function indexHasFlags(ctx) {
  const v = await ctx.git(['ls-files', '-v', '-z']);
  for (const rec of v.stdout.split(NUL)) {
    if (!rec) continue;
    const tag = rec[0];
    if (tag === 'S' || (tag >= 'a' && tag <= 'z')) return true;   // skip-worktree, assume-unchanged
  }
  const st = await ctx.git(['status', '--porcelain=v2', '-z', '--untracked-files=no']);
  return st.stdout.split(NUL).some((rec) => rec.startsWith('1 .A '));   // intent-to-add
}

const writeTree = async (ctx) => { const r = await tryGit(ctx, ['write-tree']); return r.exitCode === 0 ? r.stdout.trim() : null; };

/**
 * Applies stash `s` by its id: `git stash apply [--index] <id>` (or, with `branch`, `git stash branch <name> <id>`,
 * which git does with the index), as a cancellable job. Returns { result: 'applied'|'conflicts'|'index-conflict'|
 * 'would-overwrite', conflicts, files, untracked, index: 'kept'|'restored'|'unstaged' }. The stash is never dropped
 * here. After a failure that is no conflict the index is put back from its tree (R6: only without per-entry flags;
 * otherwise `index: 'unstaged'`, as git left it; the content is in the work tree either way).
 */
export async function applyById(ctx, s, opts = {}) {
  const withIndex = !!(opts.index || opts.branch);
  const flagged = withIndex ? await indexHasFlags(ctx) : false;
  const tree = await writeTree(ctx);
  const args = opts.branch ? ['stash', 'branch', opts.branch, s.id] : ['stash', 'apply', ...(opts.index ? ['--index'] : []), s.id];
  let r;
  try {
    r = await asJob(ctx, opts.title || 'Unstashing…', () => tryGit(ctx, args, STASH_OPTS));
  } catch (e) {
    // the stash stays in the list (it is never dropped after a cancel); the snapshot shows what git had written
    if (isCancel(e)) throw new EngineError('cancelled', 'cancelled', { command: e.command || null, stash: s.id });
    throw e;
  }
  const u = await unmerged(ctx);
  if (u.size) return { result: 'conflicts', conflicts: Array.from(u.keys()), index: 'kept' };
  if (r.exitCode === 0) return { result: 'applied', conflicts: [], index: 'kept' };
  const putBack = async () => {
    if (!withIndex || !tree) return 'kept';
    const now = await writeTree(ctx);
    if (now === tree) return 'kept';
    if (flagged) return 'unstaged';
    await ctx.git(['read-tree', tree]);
    await ctx.git(['update-index', '-q', '--refresh'], { okCodes: [0, 1] });
    return 'restored';
  };
  if (/conflicts in index/i.test(r.stderr)) return { result: 'index-conflict', conflicts: [], index: await putBack(), stderr: r.stderr };
  const w = parseWouldOverwrite(r.stderr);
  const exists = /already exists, no checkout/.test(r.stderr);
  if (w || exists) {
    const untracked = (w ? w.untracked : []).concat(exists ? Array.from(r.stderr.matchAll(/^(.+) already exists, no checkout$/gm), (m) => m[1]) : []);
    return { result: 'would-overwrite', files: w ? w.files : [], untracked, conflicts: [], index: await putBack() };
  }
  const err = r.fail();
  err.data = { ...(err.data || {}), stash: s.id, index: await putBack() };
  throw err;
}
