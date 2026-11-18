// Reading the outcome of commands that may stop half way (merge, rebase, cherry-pick, revert and their --continue /
// --skip). Conflicts are a state, not an error (docs/ARCHITECTURE.md §3.6): these helpers turn exit codes and the
// repository state into result objects whose `result` field the UI branches on.
import fs from 'node:fs';
import path from 'node:path';
import { readGitFile } from '../repo.js';
import { readTodo } from '../op-state.js';
import { tryGit, currentOp, unmerged, headState, parseWouldOverwrite, revList, asJob, isCancel, lateCancel } from './util.js';
import { stashOutcome, undoStashSideEffects, endIncomplete } from './autostash.js';

/** True when the index equals HEAD (a pick that became empty). */
async function indexIsHead(ctx) {
  return (await ctx.git(['diff', '--cached', '--quiet', '--ignore-submodules=all', 'HEAD', '--'], { okCodes: [0, 1, 128] })).exitCode === 0;
}

// git's words for a pick that changes nothing; with other local changes in the work tree it says "no changes added to
// commit" (git status' own summary) instead of "nothing to commit"
const isEmptyPick = (r) => /nothing to commit|nothing added to commit|no changes added to commit|is now empty/.test((r.stdout || '') + (r.stderr || ''));
const wouldOverwrite = (r) => parseWouldOverwrite(r.stderr) ||
  (/your local changes would be overwritten by/.test(r.stderr || '') ? { files: [], untracked: [] } : null);

/**
 * Goes on with a sequence that waits BEFORE its next commit (op.pending: no CHERRY_PICK_HEAD / REVERT_HEAD).
 * `git <kind> --continue` there treats the first todo line as done and drops it unapplied. So:
 *   - the first line is the waiting commit (nothing of it is applied): op.skip (`again: false`) is exactly git's
 *     --continue; to apply it (op.continue, `again: true`) its line is written twice first, so the copy is what git
 *     drops;
 *   - the first line is a commit that IS committed already (`concluded`, op-state.js: its conflict was resolved and
 *     committed with plain `git commit`; the waiting commit is the second line): op.continue is exactly git's
 *     --continue, and op.skip takes the committed line out first, so git drops the waiting one.
 * Everything else (abort-safety, options, the rest of the todo) stays git's own.
 */
export async function continuePending(ctx, kind, again, concluded = null) {
  const file = path.join(ctx.repo.gitDir, 'sequencer', 'todo');
  const lines = (readGitFile(path.join(ctx.repo.gitDir, 'sequencer'), 'todo') || '').split('\n');
  const isCommand = (l) => l.trim() && !l.trim().startsWith('#');
  const first = lines.findIndex(isCommand);
  if (first >= 0) {
    if (concluded) {
      if (!again && lines.filter(isCommand).length > 1) { lines.splice(first, 1); fs.writeFileSync(file, lines.join('\n')); }
    } else if (again) { lines.splice(first, 0, lines[first]); fs.writeFileSync(file, lines.join('\n')); }
  }
  return tryGit(ctx, [kind, '--continue']);
}

const PREPARED = ['SQUASH_MSG', 'MERGE_MSG'];

/** The messages git has prepared for the next commit (a squash merge's SQUASH_MSG, a MERGE_MSG), to put back later. */
export const readPrepared = (ctx) => PREPARED.map((name) => [name, readGitFile(ctx.repo.gitDir, name)]);

/**
 * Puts the prepared messages back as `saved` (readPrepared) had them: a cherry-pick / revert that could not start
 * leaves its own MERGE_MSG, and ending it (`git <kind> --quit`) removes a squash merge's SQUASH_MSG that was there
 * before. A Would-overwrite leaves `.git` as it was.
 */
export function restorePrepared(ctx, saved) {
  for (const [name, text] of saved || []) {
    const file = path.join(ctx.repo.gitDir, name);
    if (text === null) fs.rmSync(file, { force: true });
    else if (readGitFile(ctx.repo.gitDir, name) !== text) fs.writeFileSync(file, text);
  }
}

/** The commits of a stopped sequence that are still to do (the waiting one first), as the todo list writes them. */
export const todoIds = (ctx) => readTodo(ctx.repo.gitDir).map((t) => t.id);

/**
 * Settles a cherry-pick or revert sequence. `r` is the result of the command that just ran (r.ids: the commits it was
 * given, when known). Commits that turn out to be empty (their changes are already there) are skipped, as IntelliJ
 * does ("was skipped, because all changes have already been applied"). Returns { result: 'done'|'conflicts'|
 * 'stopped'|'would-overwrite', skipped, current, conflicts, files?, untracked?, reason? }:
 *   would-overwrite  local changes are in the way and nothing was applied (the sequence is ended: nothing changed);
 *   stopped          local changes are in the way of a LATER commit: earlier commits were made, the sequence waits
 *                    as an operation (op.pending) that op.continue / op.skip / op.abort drive (`reason`, `files`).
 */
export async function settleSequence(ctx, kind, r, opts = {}) {
  const skipped = opts.skipped || [];
  const before = opts.before || null;
  for (let guard = 0; guard < 10000; guard++) {
    const op = await currentOp(ctx);
    const u = await unmerged(ctx);
    if (u.size) return { result: 'conflicts', skipped, current: op ? op.theirs.id : null, conflicts: Array.from(u.keys()) };
    if (!op || op.type !== kind) {
      if (r.exitCode === 0) {
        // an empty commit skipped on the way leaves git's MERGE_MSG behind (it would fill the commit message)
        if (!op && skipped.length) try { fs.rmSync(path.join(ctx.repo.gitDir, 'MERGE_MSG'), { force: true }); } catch { /* gone */ }
        return { result: 'done', skipped, current: null, conflicts: [] };
      }
      const w = wouldOverwrite(r);
      if (w) return { result: 'would-overwrite', skipped, current: null, conflicts: [], files: w.files, untracked: w.untracked };
      if (!op && isEmptyPick(r) && await indexIsHead(ctx)) {
        // A single commit whose change is already there: git stops without an operation and leaves MERGE_MSG.
        const ids = r.ids || [];
        if (ids.length) skipped.push(ids[ids.length - 1]);
        try { fs.rmSync(path.join(ctx.repo.gitDir, 'MERGE_MSG'), { force: true }); } catch { /* gone */ }
        return { result: 'done', skipped, current: null, conflicts: [] };
      }
      throw r.fail();
    }
    if (op.pending) {
      const w = wouldOverwrite(r);
      if (w) {
        // Only the command that started the sequence ends it here: from op.continue / op.skip the stop stays visible.
        const made = opts.start ? await newCommits(ctx, before) : [null];
        if (!made.length) {
          await ctx.git([kind, '--quit']);
          return { result: 'would-overwrite', skipped, current: null, conflicts: [], files: w.files, untracked: w.untracked };
        }
        return { result: 'stopped', reason: 'would-overwrite', skipped, current: op.theirs.id, conflicts: [], files: w.files, untracked: w.untracked };
      }
      if (await indexIsHead(ctx)) {
        // The waiting commit is empty (a revert of something already reverted): skip it and go on with the rest.
        if (op.theirs.id) skipped.push(op.theirs.id);
        r = await continuePending(ctx, kind, false, op.concluded);
        continue;
      }
      return { result: 'stopped', reason: 'other', skipped, current: op.theirs.id, conflicts: [], stderr: r.stderr || '' };
    }
    if (await indexIsHead(ctx)) {
      skipped.push(op.theirs.id);
      r = await tryGit(ctx, [kind, '--skip']);
      continue;
    }
    const w = wouldOverwrite(r);
    if (w) return { result: 'would-overwrite', skipped, current: null, conflicts: [], files: w.files, untracked: w.untracked };
    if (r.exitCode === 0) return { result: 'done', skipped, current: null, conflicts: [] };
    throw r.fail();
  }
  throw new Error('cherry-pick sequence did not settle');
}

/** New commits on HEAD since `before`, oldest first. */
export async function newCommits(ctx, before) {
  const h = await headState(ctx);
  if (!h.id || h.id === before) return [];
  return (await revList(ctx, ['--reverse', '--end-of-options', before ? before + '..' + h.id : h.id]));
}

/** The autostash fields of a result: { autostash } plus, when it could not be applied, `conflicts` (its files). */
export function autostashFields(s) {
  const out = { autostash: s.autostash || 'none' };
  if (s.autostash === 'conflicts') out.conflicts = s.autostashConflicts || [];
  return out;
}

/**
 * Settles a rebase command. `pre` is prepareStash()'s state when the rebase autostashed (or null), `start` where it
 * began ({ branch, id }). Returns { result: 'done'|'conflicts'|'stopped'|'would-overwrite', conflicts, rebase,
 * autostash, autostashConflicts } — 'stopped' is a stop without conflicts (an `edit` step, or an `exec` that failed).
 * A rebase that did not run gets its staging back (undoStashSideEffects), so its Would-overwrite changed nothing; one
 * that died while git set it up (op.incomplete: only an autostash is left) is ended first, its autostash put back.
 */
export async function settleRebase(ctx, r, pre = null, start = null) {
  let op = await currentOp(ctx);
  let died = null;
  if (op && op.incomplete) {
    died = await endIncomplete(ctx, { start });
    op = await currentOp(ctx);
  }
  const u = await unmerged(ctx);
  if (op && op.type === 'rebase') {
    const a = await stashOutcome(ctx, pre, true);
    return { result: u.size ? 'conflicts' : 'stopped', conflicts: Array.from(u.keys()), rebase: op.rebase, stderr: r.exitCode ? r.stderr : '', autostash: a.autostash, autostashConflicts: [] };
  }
  if (died && died.autostash !== 'applied' && died.autostash !== 'none') {
    // the local changes could not be put back into the work tree: they are in the stash list, and the error says so
    const e = r.fail();
    e.data.autostash = died.autostash;
    throw e;
  }
  if (r.exitCode !== 0) {
    let w = null;
    if (/cannot rebase: (You have unstaged changes|Your index contains uncommitted changes)/.test(r.stderr || '')) w = { files: [], untracked: [] };
    else w = parseWouldOverwrite(r.stderr);
    // git applies the autostash itself after a failed start ("Applying autostash resulted in conflicts" is a failure)
    if (w) { await undoStashSideEffects(ctx, pre); return { result: 'would-overwrite', conflicts: [], files: w.files, untracked: w.untracked, autostash: 'none' }; }
    if (!(pre && pre.dirty && /Applying autostash resulted in conflicts|Your changes are safe in the stash/.test((r.stderr || '') + (r.stdout || '')))) {
      // git refused to start (a pre-rebase hook, a bad plan): it put its autostash back without the staging
      if (pre && (await headState(ctx)).id === pre.head) await undoStashSideEffects(ctx, pre);
      throw r.fail();
    }
  }
  const a = await stashOutcome(ctx, pre, false);
  return { result: 'done', conflicts: [], rebase: null, autostash: a.autostash, autostashConflicts: a.conflicts };
}

/**
 * Runs a `git rebase …` command as a cancellable job and settles it. opts: { env, pre (prepareStash), start ({ branch,
 * id }: HEAD before) }. Cancelled or killed: a rebase that got as far as its state stays (a stopped operation the
 * user aborts or continues); anything less is put back (autostash, staging) before the cancel is reported.
 */
export async function runRebase(ctx, args, opts = {}) {
  let r;
  try {
    r = await asJob(ctx, 'Rebasing', () => tryGit(ctx, args, opts.env ? { env: opts.env } : {}));
  } catch (e) {
    await endIncomplete(ctx, { start: opts.start });
    if (await currentOp(ctx)) throw e;                         // stopped half way: a rebase in progress
    // cancelled after the rebase was done (a hook after it was ended, HEAD is somewhere new): it is a rebase
    if (isCancel(e) && opts.start && (await headState(ctx)).id !== opts.start.id) r = lateCancel();
    else { await undoStashSideEffects(ctx, opts.pre); throw e; }
  }
  return settleRebase(ctx, r, opts.pre || null, opts.start || null);
}
