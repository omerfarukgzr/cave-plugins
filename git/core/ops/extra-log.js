// Additive operations of the Log + history wave (registered in core/methods.js; docs/PROTOCOL.md).
// changes.getFromRevision: IntelliJ's "Get from Branch" (Changes Between <branch> and Current Working Tree), "Get"
//   (File History) and "Get from Revision" (Log ▸ Changed Files): the work tree and the index take the files exactly
//   as they are in a revision. A file the revision does not have is removed (git restore semantics). What the work
//   tree held is saved to the trash first (docs/ARCHITECTURE.md §3.5).
// changes.revertFromCommit: "Revert Selected Changes" (Log ▸ Changed Files): those files' changes of a commit are
//   undone in the work tree (reverse patch, three-way when it does not apply cleanly), nothing is committed.
// commit.fixup: "Fixup…" / "Squash Into…": the chosen local changes are committed as "fixup! <subject>" /
//   "squash! <subject>" and folded into the target commit by an interactive rebase (rebase.apply's machinery).
// push.upTo: "Push All up to Here…": `git push <remote> <commit>:refs/heads/<target>`.
// push.commits: "Push Selected Commits…" / "Add Commits to Remote Branch…": the commits are cherry-picked in memory
//   (merge-tree + commit-tree, the work tree is not touched) on top of a remote branch, and the result is pushed there.
import fs from 'node:fs';
import { workPath } from '../repo.js';
import { commitId } from '../read/commit.js';
import {
  refuse, pathInput, PATHS_FROM_STDIN, trash, unmerged, tryGit, headState, refuseIfBusy, isAncestor, revList,
  protectedContaining, readStatus, remoteNames, refId, checkRefName, pushTarget, withMessage, wouldOverwriteResult,
  settleTrash, failedAfterSaving, checkMessage, removeQuietly, currentOp, branchOf,
} from './util.js';
import { prepareStash } from './autostash.js';
import { rebaseWrites } from './guard.js';
import { keepIndex, recordUndo, takeBackCommit } from './undo-commit.js';
import { parsePushLine } from './remote.js';
import { historyOrder } from './history.js';
import worktreeOps from './worktree.js';
import rewriteOps from './rewrite.js';

const NUL = '\0';
const list = (out) => out.stdout.split(NUL).filter(Boolean);
const handlerOf = (defs, name) => defs.find((d) => d.name === name).handler;
const REJECTED = [[/non-fast-forward/, 'non-fast-forward'], [/fetch first/, 'fetch-first'], [/stale info/, 'stale-info'], [/remote rejected/, 'remote-rejected']];

function onDisk(ctx, rel) {
  try { fs.lstatSync(workPath(ctx.repo, rel)); return true; } catch { return false; }
}

async function parentsOf(ctx, id) {
  const r = await ctx.git(['log', '-1', '-z', '--format=%P', '--end-of-options', id]);
  return r.stdout.replace(/\0$/, '').split(' ').filter(Boolean);
}

/** `git push --porcelain` of one commit to a remote branch, as the `push` method reports it. */
async function pushCommit(ctx, remote, id, targetBranch, extra) {
  const to = 'refs/heads/' + targetBranch;
  const job = ctx.job({ title: 'Pushing', cancellable: true });
  const r = await tryGit(ctx, ['push', '--porcelain', '--progress', '--end-of-options', remote, id + ':' + to], { timeoutMs: 0, onProgress: (line) => job.progress(line, null) });
  const line = parsePushLine(r.stdout, to);
  if (!line) throw r.fail();
  const base = { remote, target: remote + '/' + targetBranch, targetBranch, ...extra };
  if (line.flag === '!') return { result: 'rejected', ...base, reason: (REJECTED.find(([re]) => re.test(line.summary)) || [null, 'rejected'])[1], message: line.summary };
  if (r.exitCode !== 0 && line.flag !== '=') throw r.fail();
  return { result: line.flag === '=' ? 'up-to-date' : line.flag === '*' ? 'created' : 'pushed', ...base, reason: null, message: line.summary };
}

export default [
  {
    name: 'changes.getFromRevision', repo: true, mutating: true,
    params: { rev: 'rev', paths: { type: 'paths', maxItems: 20000 } },
    async handler(ctx, p) {
      const id = await commitId(ctx, p.rev, 'rev');
      const u = await unmerged(ctx);
      const blocked = p.paths.filter((x) => u.has(x));
      if (blocked.length) refuse(ctx, 'unmerged_files', 'resolve the conflicts first', { paths: blocked });
      if (!p.paths.length) return { result: 'nothing', id, paths: [], deleted: [], skipped: [], trash: null };
      // Which of the paths the revision has and which the index has (files under a folder path count for it).
      const [inRev, inIndex] = await Promise.all([
        ctx.git(['ls-tree', '-r', '-z', '--name-only', '--end-of-options', id, '--', ...p.paths]).then(list),
        ctx.git(['ls-files', '-z', '--cached', '--', ...p.paths]).then(list),
      ]);
      const rev = new Set(inRev), idx = new Set(inIndex);
      const covered = (x, set) => { const d = x.replace(/\/+$/, ''); return set.has(d) || Array.from(set).some((f) => f.startsWith(d + '/')); };
      const take = p.paths.filter((x) => covered(x, rev) || covered(x, idx));
      const skipped = p.paths.filter((x) => !take.includes(x));
      if (!take.length) return { result: 'nothing', id, paths: [], deleted: [], skipped, trash: null };
      const touched = Array.from(new Set(inRev.concat(inIndex)));
      const saved = trash(ctx, touched, 'changes.getFromRevision'); // missing paths are skipped; a file blocking a folder is saved
      try {
        await ctx.git(['restore', '--source=' + id, '--staged', '--worktree', ...PATHS_FROM_STDIN], { input: pathInput(take) });
      } catch (e) { throw failedAfterSaving(ctx, saved, e); }   // nothing was taken: no entry is left; taken in part: the error carries it
      const deleted = inIndex.filter((x) => !rev.has(x));
      return { result: 'got', id, paths: take, written: inRev, deleted, skipped, trash: saved };
    },
  },
  {
    name: 'changes.revertFromCommit', repo: true, mutating: true,
    params: { id: 'rev', paths: { type: 'paths', maxItems: 20000 }, parent: 'rev?' },
    async handler(ctx, p) {
      const id = await commitId(ctx, p.id);
      const parents = await parentsOf(ctx, id);
      const parent = p.parent ? await commitId(ctx, p.parent, 'parent') : parents[0] || null;
      const u = await unmerged(ctx);
      if (u.size) refuse(ctx, 'unmerged_files', 'resolve the conflicts first', { paths: Array.from(u.keys()) });
      const diffArgs = ['diff-tree', '-r', '-z', '--name-status', '-M', '--no-commit-id', ...(parent ? ['--end-of-options', parent, id] : ['--root', '--end-of-options', id])];
      const tok = list(await ctx.git(diffArgs));
      const changes = [];
      for (let i = 0; i < tok.length; i++) {
        const st = tok[i][0];
        if (st === 'R' || st === 'C') { changes.push({ status: st, oldPath: tok[i + 1], path: tok[i + 2] }); i += 2; } else { changes.push({ status: st, path: tok[i + 1] }); i += 1; }
      }
      const selected = changes.filter((c) => p.paths.includes(c.path) || (c.oldPath && p.paths.includes(c.oldPath)));
      const base = { id, paths: selected.map((c) => c.path), conflicts: [], trash: null };
      if (!selected.length) return { result: 'nothing', ...base };
      const touched = Array.from(new Set(selected.flatMap((c) => (c.oldPath ? [c.oldPath, c.path] : [c.path]))));
      const patchArgs = ['diff-tree', '-p', '--binary', '--full-index', '--no-commit-id', '--no-color', '--no-ext-diff', '-M'];
      patchArgs.push(...(parent ? ['--end-of-options', parent, id] : ['--root', '--end-of-options', id]), '--', ...touched);
      const patch = (await ctx.git(patchArgs, { encoding: 'buffer' })).stdout;
      if (!patch.length) return { result: 'nothing', ...base };
      // the files change in place: what they hold now is saved first
      base.trash = trash(ctx, touched.filter((x) => onDisk(ctx, x)), 'changes.revertFromCommit');
      // files the reverse patch brings back (deleted or renamed away by the commit) are added, as IntelliJ's revert does
      const revived = selected.filter((c) => c.status === 'D' || c.status === 'R').map((c) => c.oldPath || c.path);
      const plain = await tryGit(ctx, ['apply', '-R', '--whitespace=nowarn', '-'], { input: patch });
      if (plain.exitCode === 0) {
        if (revived.length) await ctx.git(['add', '--force', '--', ...revived]);
        return { result: 'reverted', ...base };
      }
      const status = await readStatus(ctx);
      const dirty = touched.filter((x) => status.changes.has(x) && status.changes.get(x).status !== '?');
      // refused or failed: nothing was changed, so the entry saved above is not kept (it stays only if a file differs)
      if (dirty.length) { settleTrash(ctx, base.trash); refuse(ctx, 'does_not_apply', 'the changes do not revert over the local changes', { paths: dirty, stderr: plain.stderr }); }
      const three = await tryGit(ctx, ['apply', '-R', '--3way', '--whitespace=nowarn', '-'], { input: patch });
      const after = await unmerged(ctx);
      if (after.size) return { result: 'conflicts', ...base, conflicts: Array.from(after.keys()) };
      if (three.exitCode !== 0) throw failedAfterSaving(ctx, base.trash, three.fail());
      return { result: 'reverted', ...base };
    },
  },
  {
    name: 'commit.fixup', repo: true, mutating: true,
    params: { id: 'rev', paths: { type: 'paths', maxItems: 20000 }, mode: { type: 'enum', values: ['fixup', 'squash'] }, message: 'string?', allowPushed: 'bool?' },
    async handler(ctx, p) {
      await refuseIfBusy(ctx, p.mode);
      const h = await headState(ctx);
      if (h.unborn) refuse(ctx, 'unborn', 'HEAD has no commit yet');
      const target = await commitId(ctx, p.id);
      if (!(await isAncestor(ctx, target, h.id))) refuse(ctx, 'not_in_current_branch', 'the commit is not in the current branch', { id: target });
      const tp = await parentsOf(ctx, target);
      if (tp.length > 1) refuse(ctx, 'merge_commit', 'the commit has ' + tp.length + ' parents', { ids: [target] });
      const base = tp[0] || null;
      // everything the rebase replays must be a plain commit, checked before anything is committed
      const merges = await revList(ctx, ['--merges', '--end-of-options', base ? base + '..' + h.id : h.id]);
      if (merges.length) refuse(ctx, 'merge_commit', 'the range contains a merge commit', { ids: merges });
      if (!p.allowPushed) {
        const prot = await protectedContaining(ctx, target);
        if (prot.length) refuse(ctx, 'pushed_to_protected', 'the commit is already pushed to a protected branch', { branches: prot, id: target });
      }
      const subject = (await ctx.git(['log', '-1', '--format=%s', '--end-of-options', target])).stdout.replace(/\n$/, '');
      const targetMessage = (await ctx.git(['log', '-1', '--format=%B', '--end-of-options', target])).stdout.replace(/\s+$/, '');
      const marker = p.mode + '! ' + subject;
      const own = p.message != null && p.message.trim() ? p.message.replace(/\s+$/, '') : marker;
      // squash adds what follows its "squash! …" line to the target's message; that message is checked now, before
      // anything is committed (a target without a message and nothing to add would be refused after the commit)
      // (the marker line of a target without a subject is "squash! "; a dialog that trims trailing blanks sends "squash!")
      const extra = own.split('\n').filter((l, i) => !(i === 0 && (l.startsWith('squash! ') || l.trimEnd() === 'squash!'))).join('\n').trim();
      const squashed = extra ? (targetMessage ? targetMessage + '\n\n' + extra : extra) : targetMessage;
      if (p.mode === 'squash') checkMessage(ctx, squashed);
      // The work tree guard before anything is committed (guard.js): the replay starts on the target's parent.
      const range = await revList(ctx, ['--reverse', '--topo-order', '--end-of-options', base ? base + '..' + h.id : h.id]);
      const guard = (await prepareStash(ctx, await rebaseWrites(ctx, h.id, base, range))).blocked;
      if (guard) return wouldOverwriteResult(guard, { mode: p.mode, target, before: h.id, autostash: 'none' });
      // From here on HEAD moves: when the fold does not happen (refused, failed, cancelled) or is aborted later, the
      // commit is taken back and the index put back (undo-commit.js): HEAD, index and work tree as before the command.
      const undo = { before: h.id, commit: null, branch: h.branch, index: keepIndex(ctx) };
      let committed;
      try {
        committed = await handlerOf(worktreeOps, 'changes.commit')(ctx, { paths: p.paths, message: own });
      } catch (e) { removeQuietly(undo.index); throw e; }
      undo.commit = committed.id;
      // The fixup commit goes right after its target.
      const entries = [];
      for (const r of range) {
        entries.push({ id: r, action: 'pick' });
        if (r === target) entries.push({ id: committed.id, action: p.mode, ...(p.mode === 'squash' ? { message: squashed } : {}) });
      }
      let res;
      try {
        res = await handlerOf(rewriteOps, 'rebase.apply')(ctx, { ...(base ? { base } : {}), entries, head: committed.id, allowPushed: true });
      } catch (e) {
        if (await currentOp(ctx)) recordUndo(ctx, undo); else await takeBackCommit(ctx, undo);
        throw e;
      }
      const out = { ...res, mode: p.mode, target, commit: committed.id, before: h.id, files: committed.files };
      if (res.result === 'would-overwrite') { await takeBackCommit(ctx, undo); out.commit = null; }
      else if (res.result === 'conflicts' || res.result === 'stopped') recordUndo(ctx, undo);   // op.abort takes the commit back
      else removeQuietly(undo.index);
      return out;
    },
  },
  {
    name: 'push.upTo', repo: true, mutating: true,
    params: { id: 'rev', branch: 'rev?', remote: 'string?', target: 'string?' },
    async handler(ctx, p) {
      const h = await headState(ctx);
      const branch = p.branch ? branchOf(p.branch) || p.branch : h.branch;   // a name or refs/heads/… (Ref names)
      if (!branch) refuse(ctx, 'detached', 'HEAD is detached');
      const localId = await refId(ctx, 'refs/heads/' + branch);
      if (!localId) ctx.fail('not_found', 'no local branch ' + branch, { param: 'branch', branch });
      const id = await commitId(ctx, p.id);
      if (!(await isAncestor(ctx, id, localId))) refuse(ctx, 'not_in_branch', 'the commit is not in ' + branch, { id, branch });
      const remotes = await remoteNames(ctx);
      if (!remotes.length) refuse(ctx, 'no_remotes', 'the repository has no remotes');
      if (p.remote && !remotes.includes(p.remote)) ctx.fail('not_found', 'no remote ' + p.remote, { param: 'remote', remote: p.remote });
      const t = await pushTarget(ctx, branch, remotes, p.remote, h.branch === branch);
      const targetBranch = p.target || t.targetBranch;
      await checkRefName(ctx, targetBranch, 'branch', 'target');
      const tracking = await refId(ctx, 'refs/remotes/' + t.remote + '/' + targetBranch);
      // already there: nothing to push (git would call an older commit a non-fast-forward)
      if (tracking && (await isAncestor(ctx, id, tracking))) {
        return { result: 'up-to-date', remote: t.remote, target: t.remote + '/' + targetBranch, targetBranch, branch, id, reason: null, message: 'up to date', count: 0, ids: [] };
      }
      const ids = await revList(ctx, tracking ? ['-n', '10000', '--end-of-options', id, '^' + tracking] : ['-n', '10000', '--not', '--remotes', '--not', '--end-of-options', id]);
      const res = await pushCommit(ctx, t.remote, id, targetBranch, { branch, id });
      return { ...res, count: res.result === 'pushed' || res.result === 'created' ? ids.length : 0, ids: res.result === 'pushed' || res.result === 'created' ? ids : [] };
    },
  },
  {
    name: 'push.commits', repo: true, mutating: true,
    params: { ids: { type: 'oids', maxItems: 1000 }, remote: 'string', target: 'string' },
    async handler(ctx, p) {
      if (!p.ids.length) ctx.fail('invalid_params', 'no commits given', { param: 'ids', reason: 'must not be empty' });
      const remotes = await remoteNames(ctx);
      if (!remotes.length) refuse(ctx, 'no_remotes', 'the repository has no remotes');
      if (!remotes.includes(p.remote)) ctx.fail('not_found', 'no remote ' + p.remote, { param: 'remote', remote: p.remote });
      await checkRefName(ctx, p.target, 'branch', 'target');
      const onto0 = await refId(ctx, 'refs/remotes/' + p.remote + '/' + p.target);
      if (!onto0) ctx.fail('not_found', 'no remote branch ' + p.remote + '/' + p.target, { param: 'target', target: p.remote + '/' + p.target });
      const full = [];
      for (const x of p.ids) full.push(await commitId(ctx, x, 'ids'));
      // oldest first in HISTORY order (a parent before its child whatever their commit dates), as cherryPick applies them
      const ordered = await historyOrder(ctx, Array.from(new Set(full)));
      for (const id of ordered) {
        const ps = await parentsOf(ctx, id);
        if (ps.length > 1) refuse(ctx, 'merge_commit', 'merge commits cannot be picked', { ids: [id] });
        if (!ps.length) refuse(ctx, 'root_commit', 'the first commit of the repository cannot be picked', { id });
      }
      // in memory: each commit's change three-way merged onto the remote branch, then a commit with its author and message
      let onto = onto0;
      const created = [], skipped = [];
      for (const id of ordered) {
        const parent = (await parentsOf(ctx, id))[0];
        const m = await tryGit(ctx, ['merge-tree', '--write-tree', '--merge-base=' + parent, '--end-of-options', onto, id]);
        if (m.exitCode === 1) refuse(ctx, 'conflicts', 'the commit does not apply to ' + p.remote + '/' + p.target, { id, target: p.remote + '/' + p.target });
        if (m.exitCode !== 0) throw m.fail();
        const tree = m.stdout.split('\n')[0].trim();
        const ontoTree = (await ctx.git(['rev-parse', '--verify', '--end-of-options', onto + '^{tree}'])).stdout.trim();
        if (tree === ontoTree) { skipped.push(id); continue; }
        const info = (await ctx.git(['log', '-1', '-z', '--format=%an%x00%ae%x00%ad%x00%B', '--date=raw', '--end-of-options', id])).stdout.split(NUL);
        const env = { GIT_AUTHOR_NAME: info[0], GIT_AUTHOR_EMAIL: info[1], GIT_AUTHOR_DATE: info[2] };
        onto = await withMessage(ctx, info[3].replace(/\s+$/, ''), (file) => ctx.git(['commit-tree', tree, '-p', onto, '-F', file], { env })).then((r) => r.stdout.trim());
        created.push(onto);
      }
      if (!created.length) return { result: 'nothing', remote: p.remote, target: p.remote + '/' + p.target, targetBranch: p.target, ids: ordered, created, skipped, count: 0 };
      // (git push moves refs/remotes/<remote>/<target> itself)
      const res = await pushCommit(ctx, p.remote, onto, p.target, { ids: ordered, created, skipped });
      return { ...res, count: res.result === 'pushed' || res.result === 'created' ? created.length : 0 };
    },
  },
];
