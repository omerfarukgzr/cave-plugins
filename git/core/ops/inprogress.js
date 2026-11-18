// In progress group: op.continue, op.abort, op.skip, conflict.resolve, conflict.accept, conflict.unresolve.
//
// Sides: `yours` is index stage 2 and `theirs` stage 3, exactly as the snapshot's op.yours / op.theirs label them. In
// a merge yours is the current branch; in a rebase git swaps them: yours is the branch being rebased ONTO and theirs
// the commit being applied (the user's own commit). The UI writes IntelliJ's column titles from the labels.
import fs from 'node:fs';
import path from 'node:path';
import { workPath, readGitFile } from '../repo.js';
import { readTodo } from '../op-state.js';
import {
  refuse, tryGit, headState, currentOp, unmerged, withMessage, pathsDifferingFrom, trash, pathInput, PATHS_FROM_STDIN,
  readStatus, asJob, settleTrash, failedAfterSaving, refId,
} from './util.js';
import { stashTop, stashOutcome, endIncomplete } from './autostash.js';
import { inTheWay, blockedBy, commitWrites } from './guard.js';
import { settleSequence, settleRebase, newCommits, continuePending, autostashFields } from './sequence.js';
import { cleanRebaseFiles } from './rewrite.js';
import { readUndo, takeBackCommit } from './undo-commit.js';

async function requireOp(ctx) {
  const op = await currentOp(ctx);
  if (!op) refuse(ctx, 'no_operation', 'no merge, rebase, cherry-pick or revert is in progress');
  if (op.type === 'am') refuse(ctx, 'unsupported', 'git am sessions are not handled here', { type: 'am' });
  return op;
}

/** op.continue / op.skip of what git left half-made: there is nothing to go on with, only op.abort leaves it. */
function refuseIncomplete(ctx, op) {
  if (op.incomplete) refuse(ctx, 'incomplete_operation', 'git left only part of a ' + op.type + ' behind: abort it to get the local changes back', { type: op.type });
}

async function requireConflicted(ctx, paths) {
  const u = await unmerged(ctx);
  const missing = paths.filter((p) => !u.has(p));
  if (missing.length) ctx.fail('not_found', 'no conflict on ' + missing[0], { path: missing[0], paths: missing, reason: 'not_conflicted' });
  return u;
}

const remaining = async (ctx) => Array.from((await unmerged(ctx)).keys());

/** Where an abort takes HEAD back to. */
function abortTarget(ctx, op) {
  if (op.type === 'rebase') return op.rebase.origHead || 'HEAD';
  if ((op.type === 'cherry-pick' || op.type === 'revert') && op.sequencer) {
    const head = (readGitFile(path.join(ctx.repo.gitDir, 'sequencer'), 'head') || '').trim();
    if (/^[0-9a-f]{40,64}$/.test(head)) return head;
  }
  return 'HEAD';
}

/** What a rebase's autostash is before --continue / --skip / --abort: git applies it when the rebase ends. */
async function rebaseStash(ctx) {
  const dirty = fs.existsSync(path.join(ctx.repo.gitDir, 'rebase-merge', 'autostash')) || fs.existsSync(path.join(ctx.repo.gitDir, 'rebase-apply', 'autostash'));
  return { dirty, stash: await stashTop(ctx), index: null, deleted: [], blocked: null };
}

/**
 * The work tree guard for going on (guard.js): the commits still to replay must not run over content git does not
 * track (git stops for an untracked file by itself, an ignored one it would overwrite). Returns the Would-overwrite
 * shape or null. The commit that is being applied is in the work tree already; `skipFirst` leaves it out.
 */
async function blockedAhead(ctx, op, skipFirst) {
  let ids = [];
  if (op.type === 'rebase') {
    const text = readGitFile(path.join(ctx.repo.gitDir, 'rebase-merge'), 'git-rebase-todo') || '';
    for (const line of text.split('\n')) {
      const m = /^\s*(?:pick|p|reword|r|edit|e|squash|s|fixup|f)\s+(?:-[cC]\s+)?([0-9a-f]{4,64})\b/.exec(line);
      if (m) ids.push(m[1]);
    }
  } else ids = readTodo(ctx.repo.gitDir).map((t) => t.id).slice(skipFirst ? 1 : 0);
  return blockedBy(await inTheWay(ctx, await commitWrites(ctx, ids, op.type === 'revert')));
}

/** The answer of op.continue / op.skip when content git does not track is in the way of the commits ahead: nothing ran. */
async function stoppedAhead(ctx, op, blocked) {
  const head = (await headState(ctx)).id;
  const extra = { reason: 'would-overwrite', files: blocked.files, untracked: blocked.untracked };
  if (op.type === 'rebase') return { type: op.type, result: 'stopped', conflicts: [], rebase: op.rebase, branch: op.rebase.branch, onto: op.rebase.onto, head, autostash: (await rebaseStash(ctx)).dirty ? 'pending' : 'none', ...extra };
  return { type: op.type, result: 'stopped', conflicts: [], skipped: [], current: op.theirs.id, created: [], head, ...extra };
}

async function settled(ctx, op, r, before, pre) {
  if (op.type === 'rebase') {
    const s = await settleRebase(ctx, r, pre);
    if (s.result === 'done') cleanRebaseFiles(ctx);
    const h = await headState(ctx);
    const out = { type: op.type, result: s.result, conflicts: s.conflicts, rebase: s.rebase || null, branch: op.rebase.branch, onto: op.rebase.onto, head: h.id };
    if (s.result === 'stopped' && s.stderr) out.stderr = s.stderr;
    return s.result === 'done' ? { ...out, ...autostashFields(s) } : { ...out, autostash: s.autostash || 'none' };
  }
  const s = await settleSequence(ctx, op.type, r, { before });
  const out = { type: op.type, result: s.result, conflicts: s.conflicts, skipped: s.skipped, current: s.current, created: await newCommits(ctx, before), head: (await headState(ctx)).id };
  if (s.result === 'stopped' || s.result === 'would-overwrite') Object.assign(out, { reason: s.reason || 'would-overwrite', files: s.files || [], untracked: s.untracked || [] });
  return out;
}

/** Tracked local changes (staged or not): what blocks `git rebase --continue` at a Stop to Edit. */
async function trackedChanges(ctx) {
  const st = await readStatus(ctx);
  return Array.from(st.changes.values()).filter((c) => c.status !== '?').map((c) => c.path);
}

const TITLES = { merge: 'Merging', rebase: 'Rebasing', 'cherry-pick': 'Cherry-picking', revert: 'Reverting' };

/**
 * op.abort of what git left half-made (op.incomplete: a rebase folder without `head-name`, a MERGE_AUTOSTASH without
 * MERGE_HEAD): no `git … --abort` can read it. Nothing was replayed, so there is nothing to rewind: the state goes
 * and the autostash comes back (never dropped: applied, or kept in the stash list and reported).
 */
async function abortIncomplete(ctx, op) {
  const res = await endIncomplete(ctx, { undo: true });
  cleanRebaseFiles(ctx);
  const h = await headState(ctx);
  return { type: op.type, result: 'aborted', rewound: true, incomplete: true, reason: null, head: h.id, branch: h.branch, trash: res.trash, autostash: res.autostash, conflicts: res.conflicts, undone: null };
}

export default [
  {
    name: 'op.continue', repo: true, mutating: true, params: { message: 'string?' },
    async handler(ctx, p) {
      const op = await requireOp(ctx);
      refuseIncomplete(ctx, op);
      const u = await unmerged(ctx);
      if (u.size) refuse(ctx, 'unresolved_conflicts', 'resolve the conflicts first', { paths: Array.from(u.keys()) });
      const h = await headState(ctx);
      if (op.type === 'merge') {
        // a `merge --autostash` (Smart merge, Update) applies its stash when the merge is committed
        const pre = { dirty: fs.existsSync(path.join(ctx.repo.gitDir, 'MERGE_AUTOSTASH')), stash: await stashTop(ctx) };
        // Without a message git takes MERGE_MSG; the editor (GIT_EDITOR=true) strips its "# Conflicts" comments.
        await asJob(ctx, TITLES.merge, () => (p.message && p.message.trim() ? withMessage(ctx, p.message, (file) => ctx.git(['commit', '-F', file])) : ctx.git(['commit'])));
        const after = await headState(ctx);
        const a = await stashOutcome(ctx, pre, false);
        return { type: 'merge', result: 'done', conflicts: a.autostash === 'conflicts' ? a.conflicts : [], head: after.id, id: after.id, autostash: a.autostash };
      }
      if (op.type === 'rebase' && op.rebase.action === 'edit') {
        // Stop to Edit: git's --continue refuses local changes there; amend them (changes.commit amend) or commit them
        const paths = await trackedChanges(ctx);
        if (paths.length) refuse(ctx, 'uncommitted_changes', 'commit the changes (amend the stopped commit or add a commit) before continuing the rebase', { paths, type: 'rebase' });
      }
      const blocked = await blockedAhead(ctx, op, op.pending ? !!op.concluded : true);
      if (blocked) return stoppedAhead(ctx, op, blocked);
      if (op.pending) {
        // the sequence waits before its next commit: run it (and the rest); git's --continue alone would drop it,
        // unless the commit it stopped at is committed already (op.concluded: then --continue is exactly right)
        const r = await asJob(ctx, TITLES[op.type], () => continuePending(ctx, op.type, true, op.concluded));
        return settled(ctx, op, r, h.id);
      }
      const pre = op.type === 'rebase' ? await rebaseStash(ctx) : null;
      const r = await asJob(ctx, TITLES[op.type], () => tryGit(ctx, [op.type, '--continue']));
      return settled(ctx, op, r, h.id, pre);
    },
  },
  {
    name: 'op.abort', repo: true, mutating: true, params: {},
    async handler(ctx) {
      const op = await requireOp(ctx);
      if (op.incomplete) return abortIncomplete(ctx, op);
      const u = await unmerged(ctx);
      const target = abortTarget(ctx, op);
      const before = await headState(ctx);
      const undo = op.type === 'rebase' ? readUndo(ctx) : null;
      const pre = op.type === 'rebase' ? await rebaseStash(ctx) : { dirty: fs.existsSync(path.join(ctx.repo.gitDir, 'MERGE_AUTOSTASH')), stash: await stashTop(ctx) };
      const saved = trash(ctx, Array.from(new Set((await pathsDifferingFrom(ctx, target)).concat(Array.from(u.keys())))), op.type + ' --abort');
      const r = await tryGit(ctx, [op.type, '--abort']);
      if (r.exitCode !== 0) throw failedAfterSaving(ctx, saved, r.fail());
      // A sequence git ends without rewinding keeps the marker of its current pick (CHERRY_PICK_HEAD / REVERT_HEAD)
      // when git had been killed between that pick's commit and its own cleanup: a second abort ends that pick.
      const left = op.sequencer ? await currentOp(ctx) : null;
      if (left && left.type === op.type && !left.sequencer && !left.incomplete) await tryGit(ctx, [op.type, '--abort']);
      let h = await headState(ctx);
      // What really happened: git does not rewind a sequence whose HEAD moved since it stopped (commits were made on
      // top: "You seem to have moved HEAD"); it only ends it. Then nothing was thrown away either.
      const targetId = target === 'HEAD' ? before.id : await refId(ctx, target);
      const rewound = h.id === targetId || !/You seem to have moved HEAD/.test(r.stderr || '') && h.id !== before.id;
      const kept = rewound ? saved : settleTrash(ctx, saved);
      const a = await stashOutcome(ctx, pre, false);
      // commit.fixup's own commit: an aborted fold leaves HEAD, index and work tree as they were before the command
      const undone = undo && undo.commit === op.rebase.origHead && await takeBackCommit(ctx, undo) ? undo.commit : null;
      if (undone) h = await headState(ctx);
      cleanRebaseFiles(ctx);
      return {
        type: op.type, result: rewound ? 'aborted' : 'ended', rewound, incomplete: false, reason: rewound ? null : 'head_moved', head: h.id, branch: h.branch,
        trash: kept, autostash: a.autostash, conflicts: a.conflicts, undone,
      };
    },
  },
  {
    name: 'op.skip', repo: true, mutating: true, params: {},
    async handler(ctx) {
      const op = await requireOp(ctx);
      refuseIncomplete(ctx, op);
      if (op.type === 'merge') refuse(ctx, 'unsupported', 'a merge has no commit to skip', { type: 'merge' });
      const u = await unmerged(ctx);
      const h = await headState(ctx);
      // (for a waiting sequence the commit that is skipped is the first one ahead: it brings nothing)
      const blocked = await blockedAhead(ctx, op, true);
      if (blocked) return { ...(await stoppedAhead(ctx, op, blocked)), skippedId: null, trash: null };
      if (op.pending) {
        // nothing of the waiting commit is applied: the local changes are the user's and stay; the rest runs
        const r = await asJob(ctx, TITLES[op.type], () => continuePending(ctx, op.type, false, op.concluded));
        const res = await settled(ctx, op, r, h.id);
        return { ...res, skippedId: op.theirs.id, trash: null };
      }
      const saved = trash(ctx, Array.from(new Set((await pathsDifferingFrom(ctx, 'HEAD')).concat(Array.from(u.keys())))), op.type + ' --skip');
      const pre = op.type === 'rebase' ? await rebaseStash(ctx) : null;
      let res;
      try {
        const r = await asJob(ctx, TITLES[op.type], () => tryGit(ctx, [op.type, '--skip']));
        res = await settled(ctx, op, r, h.id, pre);
      } catch (e) { throw failedAfterSaving(ctx, saved, e); }
      return { ...res, skippedId: op.theirs.id, trash: saved };
    },
  },
  {
    name: 'conflict.resolve', repo: true, mutating: true,
    params: { path: 'path', text: 'string', encoding: { type: 'enum', values: ['utf-8', 'latin1'], default: 'utf-8' }, bom: 'bool?' },
    async handler(ctx, p) {
      await requireConflicted(ctx, [p.path]);
      const abs = workPath(ctx.repo, p.path);
      // A conflicted symlink (every side that exists is a link) stays a link: the text is its target.
      const stages = (await ctx.git(['ls-files', '-u', '-z', '--', p.path])).stdout.split('\0').filter(Boolean)
        .map((rec) => rec.slice(0, rec.indexOf('\t')).split(' ')).filter((f) => f[2] === '2' || f[2] === '3');
      const link = stages.length > 0 && stages.every((f) => f[0] === '120000');
      let buf = Buffer.from(p.text, p.encoding === 'latin1' ? 'latin1' : 'utf8');
      if (p.bom && p.encoding === 'utf-8') buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]);
      // what the file holds now (the conflict markers, with whatever was typed between them) is saved first, and a
      // file standing where its folder goes with it
      const saved = trash(ctx, [p.path], 'conflict.resolve');
      try {
        for (let d = path.dirname(abs); d.length > ctx.repo.root.length; d = path.dirname(d)) {
          const st = fs.lstatSync(d, { throwIfNoEntry: false });
          if (st && !st.isDirectory()) fs.rmSync(d, { force: true });
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const st = fs.lstatSync(abs, { throwIfNoEntry: false });
        if (st && (st.isSymbolicLink() || link || st.isDirectory())) fs.rmSync(abs, { force: true, recursive: true });
        if (link) fs.symlinkSync(p.text.replace(/\r?\n$/, ''), abs);
        else fs.writeFileSync(abs, buf);
        await ctx.git(['add', '--force', '--', p.path]);
      } catch (e) { throw failedAfterSaving(ctx, saved, e); }
      return { result: 'resolved', path: p.path, remaining: await remaining(ctx), trash: saved };
    },
  },
  {
    name: 'conflict.accept', repo: true, mutating: true,
    params: { paths: 'paths', side: { type: 'enum', values: ['yours', 'theirs'] } },
    async handler(ctx, p) {
      if (!p.paths.length) ctx.fail('invalid_params', 'no paths given', { param: 'paths', reason: 'must not be empty' });
      const u = await requireConflicted(ctx, p.paths);
      const stage = p.side === 'yours' ? 2 : 3;
      const take = p.paths.filter((x) => u.get(x).includes(stage));
      const remove = p.paths.filter((x) => !u.get(x).includes(stage)); // that side deleted the file
      const saved = trash(ctx, p.paths, 'conflict.accept ' + p.side);
      try {
        if (take.length) {
          await ctx.git(['checkout', p.side === 'yours' ? '--ours' : '--theirs', ...PATHS_FROM_STDIN], { input: pathInput(take) });
          await ctx.git(['add', '--force', ...PATHS_FROM_STDIN], { input: pathInput(take) });
        }
        if (remove.length) await ctx.git(['rm', '--quiet', '--force', ...PATHS_FROM_STDIN], { input: pathInput(remove) });
      } catch (e) { throw failedAfterSaving(ctx, saved, e); }
      return { result: 'accepted', side: p.side, paths: p.paths, taken: take, deleted: remove, remaining: await remaining(ctx), trash: saved };
    },
  },
  {
    name: 'conflict.unresolve', repo: true, mutating: true, params: { path: 'path' },
    async handler(ctx, p) {
      const before = await unmerged(ctx);
      if (before.has(p.path)) refuse(ctx, 'not_resolved', 'the file is still conflicted', { path: p.path });
      const saved = trash(ctx, [p.path], 'conflict.unresolve');
      await tryGit(ctx, ['update-index', '--unresolve', '--', p.path]);
      const u = await unmerged(ctx);
      if (!u.has(p.path)) {
        settleTrash(ctx, saved);
        refuse(ctx, 'cannot_unresolve', 'git has no record of a conflict on this file', { path: p.path });
      }
      const stages = u.get(p.path);
      // Both sides exist: write the conflict markers again. Otherwise the work tree file stays as it is.
      if (stages.includes(2) && stages.includes(3)) await tryGit(ctx, ['checkout', '--merge', '--', p.path]);
      return { result: 'unresolved', path: p.path, stages, remaining: await remaining(ctx), trash: saved };
    },
  },
];
