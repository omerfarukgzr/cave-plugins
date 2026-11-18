// History group: merge, rebase, cherryPick, revert, reset.
import fs from 'node:fs';
import path from 'node:path';
import { commitId } from '../read/commit.js';
import {
  refuse, tryGit, headState, refuseIfBusy, refId, isAncestor, revList, opSummary, parseWouldOverwrite, wouldOverwriteResult,
  withMessage, checkedOutElsewhere, protectedContaining, pathsDifferingFrom, pathsBetween, trash, resolveRef, unambiguous,
  branchOf, asJob, settleTrash, failedAfterSaving, isCancel, lateCancel, currentOp,
} from './util.js';
import { prepareStash, stashOutcome, undoStashSideEffects, stashTop, shield, unshield, endIncomplete } from './autostash.js';
import { inTheWay, blockedBy, mergeWrites, commitWrites, rebaseWrites, rebaseStart } from './guard.js';
import { settleSequence, newCommits, runRebase, autostashFields, readPrepared, restorePrepared } from './sequence.js';

async function parentsOf(ctx, id) {
  const r = await ctx.git(['log', '-1', '-z', '--format=%P', '--end-of-options', id]);
  return r.stdout.replace(/\0$/, '').split(' ').filter(Boolean);
}

/** Full ids of `ids`, refusing merge commits (IntelliJ: "Selected commit has 2 parents"). */
async function plainCommits(ctx, ids, param) {
  const full = [];
  for (const id of ids) full.push(await commitId(ctx, id, param));
  const merges = [];
  for (const id of full) if ((await parentsOf(ctx, id)).length > 1) merges.push(id);
  if (merges.length) refuse(ctx, 'merge_commit', 'merge commits cannot be applied this way', { ids: merges });
  return Array.from(new Set(full));
}

/**
 * Oldest first in HISTORY order (a parent before its children whatever the commit dates say; unrelated commits by
 * date), as IntelliJ applies a selection. `git rev-list --date-order` never shows a parent before its children; the
 * walk is bounded by the selection's common ancestor.
 */
export async function historyOrder(ctx, ids) {
  if (ids.length < 2) return ids.slice();
  const mb = await ctx.git(['merge-base', '--octopus', '--end-of-options', ...ids], { okCodes: [0, 1] });
  const base = mb.exitCode === 0 ? mb.stdout.trim().split('\n')[0] : null;
  const order = await revList(ctx, ['--date-order', '--end-of-options', ...ids, ...(base ? ['^' + base] : [])]);
  const want = new Set(ids);
  const out = order.filter((x) => want.has(x));
  if (base && want.has(base)) out.push(base);
  for (const id of ids) if (!out.includes(id)) out.push(id); // (cannot happen: every id is in its own walk)
  return out.reverse();
}

async function pickOrRevert(ctx, kind, p) {
  await refuseIfBusy(ctx, kind);
  const h = await headState(ctx);
  if (h.unborn) refuse(ctx, 'unborn', 'HEAD has no commit yet');
  const ids = await plainCommits(ctx, p.ids, 'ids');
  const oldest = await historyOrder(ctx, ids);
  const ordered = kind === 'revert' ? oldest.reverse() : oldest;
  // the work tree guard (guard.js): what the commits bring must not run over content git does not track (git itself
  // would overwrite an ignored file)
  const blocked = blockedBy(await inTheWay(ctx, await commitWrites(ctx, ordered, kind === 'revert')));
  if (blocked) {
    return { result: 'would-overwrite', ids: ordered, created: [], skipped: [], current: null, conflicts: [], files: blocked.files, untracked: blocked.untracked, reason: null, before: h.id };
  }
  const args = [kind];
  if (kind === 'revert') args.push('--no-edit');
  else {
    // IntelliJ: add "(cherry picked from commit …)" when the commit was pushed to a protected branch.
    for (const id of ordered.slice(0, 100)) if ((await protectedContaining(ctx, id)).length) { args.push('-x'); break; }
  }
  const prepared = readPrepared(ctx);
  let r;
  try {
    r = await asJob(ctx, kind === 'revert' ? 'Reverting' : 'Cherry-picking', () => tryGit(ctx, [...args, '--end-of-options', ...ordered]));
  } catch (e) {
    // cancelled after the last commit was made (a post-commit hook was ended) and nothing is in progress: it is done;
    // cancelled half way, the sequence stays as an operation
    if (!(isCancel(e) && !(await currentOp(ctx)) && (await headState(ctx)).id !== h.id)) throw e;
    r = lateCancel();
  }
  r.ids = ordered;
  const s = await settleSequence(ctx, kind, r, { before: h.id, start: true });
  // nothing ran: a message git had prepared before (a squash merge's) is still there, none of this attempt is left
  if (s.result === 'would-overwrite') restorePrepared(ctx, prepared);
  const made = await newCommits(ctx, h.id);
  const done = kind === 'revert' ? 'reverted' : 'picked';
  const result = s.result === 'done' ? (made.length ? done : 'nothing') : s.result;
  return {
    result, ids: ordered, created: made, skipped: s.skipped, current: s.current, conflicts: s.conflicts, files: s.files, untracked: s.untracked,
    reason: s.reason || null, before: h.id,
  };
}

/** git's merge message for a ref (used when the short name is ambiguous and the full ref is given to git). */
function mergeMessage(t, target) {
  const what = t.kind === 'remote' ? 'remote-tracking branch' : t.kind === 'tag' ? 'tag' : 'branch';
  return 'Merge ' + what + " '" + t.name + "'" + (target && !['main', 'master'].includes(target) ? ' into ' + target : '');
}

/**
 * After a merge command that was cancelled or killed before it recorded anything (HEAD where it was, no MERGE_HEAD):
 * a result that is staged already is taken out again (a two-way switch back to the tree the index had), and an
 * autostash git made comes back. `pre` is prepareStash()'s state.
 */
export async function takeBackMerge(ctx, pre, smart) {
  const stashed = fs.existsSync(path.join(ctx.repo.gitDir, 'MERGE_AUTOSTASH'));
  // with an autostash the index was reset to HEAD before the merge; without one it was the user's own (pre.index)
  const want = stashed ? (await ctx.git(['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'], { okCodes: [0, 1, 128] })).stdout.trim() : smart && pre.dirty ? null : pre.index;
  const cur = await ctx.git(['write-tree'], { okCodes: [0, 128] });
  if (want && cur.exitCode === 0 && cur.stdout.trim() !== want) await tryGit(ctx, ['read-tree', '-m', '-u', cur.stdout.trim(), want]);
  if (smart) await undoStashSideEffects(ctx, pre);
}

export default [
  {
    name: 'merge', repo: true, mutating: true,
    params: {
      rev: 'rev', noFf: 'bool?', ffOnly: 'bool?', squash: 'bool?', noCommit: 'bool?', message: 'string?', noVerify: 'bool?',
      allowUnrelatedHistories: 'bool?', smart: 'bool?',
    },
    async handler(ctx, p) {
      await refuseIfBusy(ctx, 'merge');
      const h = await headState(ctx);
      const t = await resolveRef(ctx, p.rev, 'rev');
      const theirs = t.id;
      const base = { source: p.rev, sourceId: theirs, target: h.branch, before: h.id };
      if (h.id && await isAncestor(ctx, theirs, h.id)) return { result: 'up-to-date', ...base, after: h.id, conflicts: [], autostash: 'none' };
      // The work tree guard (guard.js). What the merge brings in must not run over content git does not track. A
      // stash's reset must not either: with `smart` that is a Would-overwrite too; a plain merge stashes only on its
      // failure path, so that content is shielded in the trash while git runs (a FIFO cannot be: Would-overwrite).
      const pre = await prepareStash(ctx, await mergeWrites(ctx, h.id, theirs));
      const blocked = p.smart ? pre.blocked : blockedBy(pre.hazards.incoming.concat(pre.hazards.stash.filter((x) => x.kind === 'special')));
      if (blocked) return wouldOverwriteResult(blocked, { ...base, autostash: 'none' });
      const args = ['merge'];
      if (p.noFf) args.push('--no-ff');
      if (p.ffOnly) args.push('--ff-only');
      if (p.squash) args.push('--squash');
      if (p.noCommit) args.push('--no-commit');
      if (p.noVerify) args.push('--no-verify');
      if (p.allowUnrelatedHistories) args.push('--allow-unrelated-histories');
      if (p.smart) args.push('--autostash');
      // A branch is given to git by the name git reads it as; when a tag or another ref has the same short name (or
      // the name looks like an option), by its full ref with the message git would have written.
      let name = p.rev;
      let message = p.message && p.message.trim() && !p.squash ? p.message : null;
      if (t.ref) {
        if (!t.name.startsWith('-') && await unambiguous(ctx, t.name, t.ref)) name = t.name;
        else { name = t.ref; if (!message && !p.squash) message = mergeMessage(t, h.branch); }
      }
      const run = (file) => tryGit(ctx, [...args, ...(file ? ['-F', file] : []), '--end-of-options', name]);
      const guard = p.smart ? null : shield(ctx, pre.hazards.stash);
      let r;
      try {
        r = await asJob(ctx, 'Merging', () => (message ? withMessage(ctx, message, run) : run(null)));
      } catch (e) {
        const now = await headState(ctx);
        // cancelled after the merge was made (a post-merge hook was ended): it is a merge, reported as one below
        if (isCancel(e) && now.id !== h.id) r = lateCancel();
        else {
          // cancelled or killed: a merge that got as far as MERGE_HEAD stays (op.abort); anything less is put back
          if (now.id === h.id && !fs.existsSync(path.join(ctx.repo.gitDir, 'MERGE_HEAD'))) await takeBackMerge(ctx, pre, !!p.smart);
          unshield(ctx, guard);
          throw e;
        }
      }
      const kept = () => { const left = unshield(ctx, guard); return left ? { trash: left } : {}; };
      let op = await opSummary(ctx);
      const after = (await headState(ctx)).id;
      // `git merge --squash --autostash` keeps the autostash until the next commit (the user's local changes would be
      // out of the work tree until then): it is applied now, on top of the squashed changes.
      let early = null;
      if (op && op.incomplete && r.exitCode === 0) { early = await endIncomplete(ctx, { onTop: true }); op = await opSummary(ctx); }
      // --autostash that could not be re-applied after a merge that completed: unmerged files, no MERGE_HEAD, the
      // changes kept in the stash. That is the merge's outcome plus `autostash: 'conflicts'`, not a stopped merge.
      const stashConflict = p.smart && pre.dirty && op && !op.type && (await stashTop(ctx)) !== pre.stash;
      if (op && op.type === 'merge' && !op.incomplete && op.conflicts.length) {
        return { result: 'conflicts', ...base, after, conflicts: op.conflicts, autostash: p.smart && pre.dirty ? 'pending' : 'none', ...kept() };
      }
      if (r.exitCode !== 0 && !stashConflict) {
        // (a merge git stopped without conflicts — a pre-merge-commit hook said no — is in progress: nothing is undone)
        const merging = !!(op && op.type === 'merge' && !op.incomplete);
        // nothing ran: an autostash git made (and re-applied without its staging, or left behind) is undone
        if (p.smart && !merging && after === h.id) await undoStashSideEffects(ctx, pre);
        const w = parseWouldOverwrite(r.stderr);
        if (w) { if (!p.smart && !merging) await undoStashSideEffects(ctx, pre); return wouldOverwriteResult(w, { ...base, autostash: 'none', ...kept() }); }
        unshield(ctx, guard);
        if (/refusing to merge unrelated histories/.test(r.stderr)) refuse(ctx, 'unrelated_histories', 'the histories have no common ancestor', base);
        if (/Not possible to fast-forward/.test(r.stderr)) refuse(ctx, 'not_fast_forward', 'the merge cannot be fast-forwarded', base);
        throw r.fail();
      }
      Object.assign(base, kept());
      let result;
      if (p.squash) result = 'squashed';
      else if (op && op.type === 'merge') result = 'no-commit';
      else if (after === theirs) result = 'fast-forward';
      else result = 'merged';
      let a = { autostash: 'none', conflicts: [] };
      if (p.smart && pre.dirty) a = early ? { autostash: early.autostash, conflicts: early.conflicts } : await stashOutcome(ctx, pre, !!(op && op.type === 'merge'));
      return { result, ...base, after, conflicts: a.autostash === 'conflicts' ? a.conflicts : [], autostash: a.autostash };
    },
  },
  {
    name: 'rebase', repo: true, mutating: true,
    params: {
      onto: 'rev', upstream: 'rev?', branch: 'rev?', rebaseMerges: 'bool?', keepEmpty: 'bool?', root: 'bool?', updateRefs: 'bool?',
      autosquash: 'bool?', autostash: { type: 'bool', default: true }, allowPushed: 'bool?',
      noAutosquash: 'bool?',
    },
    async handler(ctx, p) {
      await refuseIfBusy(ctx, 'rebase');
      const h = await headState(ctx);
      if (!p.branch && !h.branch) refuse(ctx, 'detached', 'rebase is not possible in the detached HEAD state');
      const branch = p.branch ? branchOf(p.branch) || p.branch : h.branch;
      const branchId = await refId(ctx, 'refs/heads/' + branch);
      if (!branchId) ctx.fail('not_found', 'no local branch ' + branch, { param: 'branch', rev: branch });
      if (branch !== h.branch) {
        const where = await checkedOutElsewhere(ctx, branch);
        if (where) refuse(ctx, 'checked_out_elsewhere', "branch '" + branch + "' is checked out in another worktree", { branch, path: where });
      }
      const ontoId = (await resolveRef(ctx, p.onto, 'onto')).id;
      const upstreamId = p.upstream ? (await resolveRef(ctx, p.upstream, 'upstream')).id : ontoId;
      const range = p.root ? [branchId] : ['--end-of-options', upstreamId + '..' + branchId];
      const rows = (await revList(ctx, ['--reverse', '--topo-order', '--parents', ...range])).map((l) => { const f = l.split(' '); return { id: f[0], parents: f.slice(1) }; });
      const commits = rows.map((x) => x.id).reverse();
      if (commits.length && !p.allowPushed) {
        const prot = await protectedContaining(ctx, commits[commits.length - 1]);
        if (prot.length) refuse(ctx, 'pushed_to_protected', 'some commits were already pushed to a protected branch', { branches: prot });
      }
      const base = { branch, onto: p.onto, ontoId, before: branchId, count: commits.length, checkedOut: branch !== h.branch, previous: { branch: h.branch, id: h.id } };
      // the work tree guard (guard.js): the checkout of the new base and every replayed commit, and the autostash
      const plan = rows.map((x) => ({ id: x.id, action: 'pick', message: null }));
      const from = p.autosquash || p.rebaseMerges ? { start: ontoId, commits: rows.filter((x) => x.parents.length < 2).map((x) => x.id) } : rebaseStart(ontoId, rows, plan);
      const pre = await prepareStash(ctx, await rebaseWrites(ctx, h.id, from.start, from.commits));
      const blocked = p.autostash ? pre.blocked : blockedBy(pre.hazards.incoming);
      if (blocked) return wouldOverwriteResult(blocked, { ...base, autostash: 'none' });
      const args = ['rebase', p.autostash ? '--autostash' : '--no-autostash'];
      if (p.rebaseMerges) args.push('--rebase-merges');
      if (p.keepEmpty) args.push('--keep-empty');
      if (p.updateRefs) args.push('--update-refs');
      if (p.autosquash) args.push('--autosquash');
      if (p.noAutosquash && !p.autosquash) args.push('--no-autosquash');
      if (p.root) args.push('--root', '--onto=' + ontoId, '--end-of-options');
      else if (p.upstream) args.push('--onto=' + ontoId, '--end-of-options', upstreamId);
      else args.push('--end-of-options', ontoId);
      if (p.branch) args.push(branch);
      const s = await runRebase(ctx, args, { pre: p.autostash ? pre : null, start: { branch: h.branch, id: h.id } });
      const after = await refId(ctx, 'refs/heads/' + branch);
      if (s.result === 'would-overwrite') return wouldOverwriteResult(s, { ...base, autostash: 'none' });
      if (s.result !== 'done') return { result: s.result, ...base, after: (await headState(ctx)).id, conflicts: s.conflicts, rebase: s.rebase, autostash: s.autostash };
      let result = 'rebased';
      if (after === branchId) result = 'up-to-date';
      else if (after === ontoId && await isAncestor(ctx, branchId, ontoId)) result = 'fast-forward';
      return { result, ...base, after, conflicts: [], ...autostashFields(s) };
    },
  },
  {
    name: 'cherryPick', repo: true, mutating: true, params: { ids: { type: 'oids', maxItems: 10000 } },
    handler: (ctx, p) => {
      if (!p.ids.length) ctx.fail('invalid_params', 'no commits given', { param: 'ids', reason: 'must not be empty' });
      return pickOrRevert(ctx, 'cherry-pick', p);
    },
  },
  {
    name: 'revert', repo: true, mutating: true, params: { ids: { type: 'oids', maxItems: 10000 } },
    handler: (ctx, p) => {
      if (!p.ids.length) ctx.fail('invalid_params', 'no commits given', { param: 'ids', reason: 'must not be empty' });
      return pickOrRevert(ctx, 'revert', p);
    },
  },
  {
    name: 'reset', repo: true, mutating: true, params: { to: 'rev', mode: { type: 'enum', values: ['soft', 'mixed', 'hard', 'keep'] } },
    async handler(ctx, p) {
      const h = await headState(ctx);
      if (h.unborn) refuse(ctx, 'unborn', 'HEAD has no commit yet');
      const target = (await resolveRef(ctx, p.to, 'to')).id;
      let saved = null;
      // hard: every file that changes, and an untracked file standing where a folder comes back (saveTrash blockers)
      if (p.mode === 'hard') saved = trash(ctx, await pathsDifferingFrom(ctx, target), 'reset --hard');
      else if (p.mode === 'keep') saved = trash(ctx, await pathsBetween(ctx, h.id, target), 'reset --keep');
      const r = await tryGit(ctx, ['reset', '--' + p.mode, '--end-of-options', target, '--']);
      if (r.exitCode !== 0) {
        const w = parseWouldOverwrite(r.stderr);
        if (w) { settleTrash(ctx, saved); return wouldOverwriteResult(w, { mode: p.mode, before: h.id }); }
        throw failedAfterSaving(ctx, saved, r.fail());   // git failed half way: what it had removed is in `data.trash`
      }
      return { result: 'reset', mode: p.mode, before: h.id, after: target, branch: h.branch, trash: saved };
    },
  },
];
