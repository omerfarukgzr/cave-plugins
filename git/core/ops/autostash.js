// Everything around git's autostash (docs/ARCHITECTURE.md §3.5): the state taken before an operation that stashes
// (prepareStash, with the work tree guard's answer), how the stash ended (stashOutcome), putting things back when the
// operation did not run after all (undoStashSideEffects), the shield of a plain merge, and what a git command that
// died half way leaves behind (endIncomplete): an autostash nobody will apply any more.
//
// An autostash is a stash commit git keeps OUTSIDE the stash list while its operation runs (`rebase-merge/autostash`,
// `MERGE_AUTOSTASH`): until git applies it, it is the only copy of the user's tracked local changes. The engine never
// drops one: it is applied back, or — when the work tree cannot take it — stored in the stash list and reported.
import fs from 'node:fs';
import path from 'node:path';
import { saveTrash, restoreTrash, dropTrash, trashRoot } from '../trash.js';
import { lstat } from '../fsname.js';
import { readStatus, unmerged, refId, tryGit, headState, pathsDifferingFrom, trash } from './util.js';
import { inTheWay, stashWrites, blockedBy } from './guard.js';
import { indexHasFlags } from './stash-core.js';

const OID = /^[0-9a-f]{40,64}$/;
const readOid = (file) => { try { const t = fs.readFileSync(file, 'utf8').trim(); return OID.test(t) ? t : null; } catch { return null; } };

export async function stashTop(ctx) { return refId(ctx, 'refs/stash'); }

/**
 * State taken before an operation that autostashes: { dirty (tracked local changes: git will stash), stash (top of
 * the stash list), index (tree of the index, to put staging back when the operation turns out not to run), deleted
 * (tracked files missing from the work tree), head, hazards: { stash, incoming } (the work tree guard, guard.js:
 * content the stash's reset / the paths the operation brings in would destroy), blocked (a Would-overwrite answer for
 * all of it, or null) }. `writes`: the tracked paths the operation brings in ([{ path, gitlink }], guard.js).
 */
export async function prepareStash(ctx, writes) {
  const status = await readStatus(ctx);
  // git stashes whenever the index or the work tree differs from HEAD for a tracked path (also an "AD" entry)
  const dirty = status.entries.some((e) => e.type === '1' || e.type === '2');
  const hazards = {
    stash: dirty ? await inTheWay(ctx, stashWrites(status)) : [],
    incoming: writes && writes.length ? await inTheWay(ctx, writes) : [],
  };
  const tree = status.conflicts.size ? null : await ctx.git(['write-tree'], { okCodes: [0, 128] });
  return {
    dirty,
    stash: await stashTop(ctx),
    head: (await headState(ctx)).id,
    index: tree && tree.exitCode === 0 ? tree.stdout.trim() : null,
    // every index entry missing from the work tree (also "AD": added, then deleted, which is no local change)
    deleted: status.entries.filter((e) => (e.type === '1' || e.type === '2') && e.xy[1] === 'D').map((e) => e.path),
    hazards,
    blocked: blockedBy(hazards.stash.concat(hazards.incoming)),
  };
}

/**
 * How the autostash ended, for results: { autostash: 'none'|'applied'|'conflicts'|'pending', conflicts }. 'pending':
 * the operation stopped (conflicts, an edit stop) and git applies the stash when it ends; 'conflicts': git could not
 * apply it, the changes are kept in the stash (`stash@{0}`) and the conflicted files are listed.
 */
export async function stashOutcome(ctx, pre, stopped) {
  if (!pre || !pre.dirty) return { autostash: 'none', conflicts: [] };
  if (stopped) return { autostash: 'pending', conflicts: [] };
  if ((await stashTop(ctx)) !== pre.stash) return { autostash: 'conflicts', conflicts: Array.from((await unmerged(ctx)).keys()) };
  return { autostash: 'applied', conflicts: [] };
}

/**
 * For a command that does not stash by itself but may reset the work tree on its failure path (a plain `git merge`
 * whose strategy fails puts the tree back with a hard reset): the content the guard found is copied to the trash
 * first; unshield() writes back what is gone or changed and drops the entry. Returns the shield (or null).
 */
export function shield(ctx, hazards) {
  if (!hazards || !hazards.length) return null;
  const entry = saveTrash(ctx.repo, hazards.map((h) => h.disk), 'guard', { blockers: false, prune: false });
  if (!entry) return null;
  const sig = (rel) => { const st = lstat(path.join(ctx.repo.root, rel)); return st ? st.ino + ':' + st.size + ':' + st.mtimeMs : null; };
  return { entry, sigs: new Map(hazards.map((h) => [h.disk, sig(h.disk)])), sig };
}

/**
 * After the command: what is no longer the entry it was comes back from the shield. Returns the trash entry when
 * something could not be put back (the result carries it as `trash`: the content is there), else null.
 */
export function unshield(ctx, s) {
  if (!s) return null;
  const touched = Array.from(s.sigs.keys()).filter((rel) => s.sig(rel) !== s.sigs.get(rel));
  if (touched.length) {
    const manifest = JSON.parse(fs.readFileSync(path.join(trashRoot(ctx.repo), s.entry.id, 'manifest.json'), 'utf8'));
    const only = manifest.files.map((f) => f.path).filter((p) => touched.some((t) => p === t || p.startsWith(t + '/')));
    const back = restoreTrash(ctx.repo, s.entry.id, { only });
    // what the restore overwrote is what git's own failure path had just written there (from its objects): not kept
    if (back.trash) dropTrash(ctx.repo, back.trash.id);
    if (!back.complete) return s.entry;
  }
  dropTrash(ctx.repo, s.entry.id);
  return null;
}

/**
 * After an autostashing command that did not run (Would-overwrite): a command that died while stashing leaves its
 * autostash behind (endIncomplete puts it back); git re-applies a stash with `stash apply`, which loses what was
 * staged, and `git merge` may have brought back tracked files the user had deleted. Puts the index and those
 * deletions back, so "nothing was changed" holds.
 */
export async function undoStashSideEffects(ctx, pre) {
  await endIncomplete(ctx);
  if (!pre) return { index: 'kept' };
  let index = 'kept';
  if (pre.index) {
    const now = await ctx.git(['write-tree'], { okCodes: [0, 128] });
    if (now.exitCode === 0 && now.stdout.trim() !== pre.index) {
      // `read-tree` rebuilds the entries and drops per-entry flags (assume-unchanged, skip-worktree, intent-to-add):
      // with such entries the index stays as it is and the caller says the staging was not restored
      if (await indexHasFlags(ctx)) { index = 'unstaged'; ctx.staging = 'unstaged'; }
      else { await ctx.git(['read-tree', pre.index]); index = 'restored'; }
    }
  }
  for (const rel of pre.deleted) {
    let st = null;
    try { st = fs.lstatSync(path.join(ctx.repo.root, rel)); } catch { /* still deleted */ }
    if (!st || st.isDirectory()) continue;
    fs.rmSync(path.join(ctx.repo.root, rel), { force: true });
    // folders git made for it go again when empty (an empty folder holds nothing)
    for (let d = path.dirname(rel); d && d !== '.'; d = path.dirname(d)) {
      try { fs.rmdirSync(path.join(ctx.repo.root, d)); } catch { break; }
    }
  }
  await ctx.git(['update-index', '-q', '--refresh'], { okCodes: [0, 1] });
  return { index };
}

const treeOf = async (ctx, rev) => (await ctx.git(['rev-parse', '--verify', '--quiet', '--end-of-options', rev + '^{tree}'], { okCodes: [0, 1, 128] })).stdout.trim();

/**
 * Puts an autostash (a stash commit that is in no stash list) back. Returns { autostash, conflicts }:
 *   'applied'    its changes are in the work tree: they already were (the command died before its reset), or they
 *                applied cleanly;
 *   'conflicts'  applying left conflicts: it is now stash@{0}, the conflicted files are listed;
 *   'stashed'    the work tree has other local changes (or the stash does not apply): nothing was touched, it is
 *                now stash@{0};
 *   'none'       there was nothing to put back.
 * `onTop`: apply also over a work tree that has changes (a squash merge's result).
 */
export async function recoverAutostash(ctx, oid, onTop = false) {
  if (!oid || !(await treeOf(ctx, oid))) return { autostash: 'none', conflicts: [] };
  const store = () => ctx.git(['stash', 'store', '-m', 'autostash', '-q', oid]);
  const made = await tryGit(ctx, ['stash', 'create']);
  if (made.exitCode !== 0) { await store(); return { autostash: 'stashed', conflicts: Array.from((await unmerged(ctx)).keys()) }; }   // unmerged files: no place to apply it
  const cur = made.stdout.trim();
  if (cur) {
    // everything it holds is in the work tree and the index already: nothing to put back, nothing to keep
    const same = (await treeOf(ctx, cur)) === (await treeOf(ctx, oid)) && (await treeOf(ctx, cur + '^2')) === (await treeOf(ctx, oid + '^2'));
    if (same) return { autostash: 'applied', conflicts: [] };
    if (!onTop) { await store(); return { autostash: 'stashed', conflicts: [] }; }
  }
  // --index keeps what was staged staged; it applies only to a clean index (and fails without touching anything)
  let r = cur ? null : await tryGit(ctx, ['stash', 'apply', '--index', '--quiet', oid]);
  if (!r || r.exitCode !== 0) r = await tryGit(ctx, ['stash', 'apply', '--quiet', oid]);
  const u = await unmerged(ctx);
  if (r.exitCode === 0 && !u.size) return { autostash: 'applied', conflicts: [] };
  await store();
  return { autostash: u.size ? 'conflicts' : 'stashed', conflicts: Array.from(u.keys()) };
}

/** The half-made state in the git dir (op-state.js `incomplete`): { rebase: [dirs], merge: bool }. */
export function incompleteState(gitDir) {
  const has = (...p) => fs.existsSync(path.join(gitDir, ...p));
  const rebase = ['rebase-merge', 'rebase-apply'].filter((d) => has(d) && !has(d, 'head-name') && !has(d, 'applying'));
  return { rebase, merge: has('MERGE_AUTOSTASH') && !has('MERGE_HEAD') };
}

/**
 * Ends what a git command that died half way left behind, restoring the user's content:
 *   - `rebase-merge/` / `rebase-apply/` without `head-name` (git died while it set the rebase up: no commit was
 *     replayed): its autostash is put back, the folder goes. `start` ({ branch, id }: where the engine's own command
 *     began) also takes HEAD back to the branch when git had already detached it;
 *   - `MERGE_AUTOSTASH` without `MERGE_HEAD`: put back. With `undo` (op.abort, a cancelled merge) a merge result that
 *     is staged but was never recorded is taken out again first: when the work tree has no changes of its own beside
 *     the index, what differs from HEAD is saved to the trash and index and work tree go back to HEAD. With `onTop`
 *     (a squash merge that completed) it is applied over the staged result instead.
 * Returns { found, autostash, conflicts, trash }. Nothing is dropped: see recoverAutostash.
 */
export async function endIncomplete(ctx, opts = {}) {
  const gitDir = ctx.repo.gitDir;
  const state = incompleteState(gitDir);
  let out = { found: false, autostash: 'none', conflicts: [], trash: null };
  for (const name of state.rebase) {
    const dir = path.join(gitDir, name);
    const oid = readOid(path.join(dir, 'autostash'));
    const s = opts.start;
    if (s && s.branch) {
      const h = await headState(ctx);
      if (h.detached && (await refId(ctx, 'refs/heads/' + s.branch)) === s.id) await tryGit(ctx, ['checkout', '--quiet', '--no-overwrite-ignore', '--end-of-options', s.branch, '--']);
    }
    const res = await recoverAutostash(ctx, oid);
    // the stash is safe now (applied or in the stash list): its file goes first, so git does not store it again
    fs.rmSync(path.join(dir, 'autostash'), { force: true });
    await tryGit(ctx, ['rebase', '--quit']);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    out = { ...out, ...res, found: true };
  }
  if (state.merge) {
    const file = path.join(gitDir, 'MERGE_AUTOSTASH');
    const oid = readOid(file);
    let saved = null;
    if (opts.undo) {
      const unstaged = (await ctx.git(['diff', '--quiet', '--ignore-submodules=all'], { okCodes: [0, 1] })).exitCode === 1;
      const cur = await ctx.git(['write-tree'], { okCodes: [0, 128] });
      const head = await treeOf(ctx, 'HEAD');
      if (!unstaged && cur.exitCode === 0 && head && cur.stdout.trim() !== head) {
        saved = trash(ctx, await pathsDifferingFrom(ctx, 'HEAD'), 'merge --abort');
        // a two-way switch from the staged tree back to HEAD's: exactly the merge's files, nothing else
        const back = await tryGit(ctx, ['read-tree', '-m', '-u', cur.stdout.trim(), head]);
        if (back.exitCode !== 0 && saved) { dropTrash(ctx.repo, saved.id); saved = null; }
        // the message of a squash that is no longer staged would only mislead the next commit
        if (back.exitCode === 0) fs.rmSync(path.join(gitDir, 'SQUASH_MSG'), { force: true });
      }
    }
    const res = await recoverAutostash(ctx, oid, !!opts.onTop);
    fs.rmSync(file, { force: true });
    out = { ...out, ...res, found: true, trash: saved };
  }
  return out;
}
