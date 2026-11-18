// Remote group: fetch, push, update (docs/ARCHITECTURE.md §3.6). Network phases are cancellable jobs with progress.
import fs from 'node:fs';
import path from 'node:path';
import { parseProgress } from '../git.js';
import { readRefs, hasName } from '../snapshot.js';
import {
  refuse, tryGit, headState, refuseIfBusy, checkRefName, refId, remoteNames, configValue, protectedNames, pushTarget,
  revList, isAncestor, opSummary, parseWouldOverwrite, wouldOverwriteResult, pathsBetween, branchOf, asJob, isCancel, lateCancel,
} from './util.js';
import { prepareStash, stashOutcome, undoStashSideEffects, stashTop, endIncomplete } from './autostash.js';
import { mergeWrites, rebaseWrites, rebaseStart } from './guard.js';
import { takeBackMerge } from './history.js';

const LIST_CAP = 10000;

function progressSink(job, base, span) {
  return (line) => {
    const pr = parseProgress(line);
    job.progress(line, pr ? base + span * pr.fraction : null);
  };
}

async function upstreamOf(ctx, branch) {
  const r = await ctx.git(['for-each-ref', '--format=%(upstream)', 'refs/heads/' + branch]);
  return r.stdout.trim() || null;
}

async function fetchRemote(ctx, job, remote, base = 0, span = 1) {
  job.progress('Fetching ' + remote, base);
  await ctx.git(['fetch', '--progress', '--prune', '--recurse-submodules=no', '--end-of-options', remote], { timeoutMs: 0, onProgress: progressSink(job, base, span) });
}

function refsDiff(before, after) {
  const updated = [];
  const created = [];
  const pruned = [];
  for (const [ref, id] of Object.entries(after.remotes)) {
    if (!hasName(before.remotes, ref)) created.push({ ref, id });
    else if (before.remotes[ref] !== id) updated.push({ ref, old: before.remotes[ref], new: id });
  }
  for (const [ref, id] of Object.entries(before.remotes)) if (!hasName(after.remotes, ref)) pruned.push({ ref, id });
  const tags = Object.keys(after.tags).filter((t) => !hasName(before.tags, t));
  return { updated, created, pruned, tags };
}

const REJECT_REASONS = [
  [/non-fast-forward/, 'non-fast-forward'], [/fetch first/, 'fetch-first'], [/stale info/, 'stale-info'],
  [/already exists/, 'already-exists'], [/remote rejected/, 'remote-rejected'],
];

/** One line of `git push --porcelain`: "<flag>\t<from>:<to>\t<summary>". */
export function parsePushLine(stdout, to) {
  for (const line of stdout.split('\n')) {
    const m = /^(.)\t([^\t]*):([^\t]*)\t(.*)$/.exec(line);
    if (m && m[3] === to) return { flag: m[1], summary: m[4] };
  }
  return null;
}

/** The tag lines of `git push --porcelain`: what was sent and what the remote refused (a tag that exists there). */
export function parsePushTags(stdout) {
  const pushed = [];
  const rejected = [];
  for (const line of stdout.split('\n')) {
    const m = /^(.)\t[^\t]*:refs\/tags\/([^\t]*)\t(.*)$/.exec(line);
    if (!m || m[1] === '=') continue;
    if (m[1] === '!') rejected.push({ tag: m[2], reason: (REJECT_REASONS.find(([re]) => re.test(m[3])) || [null, 'rejected'])[1], message: m[3] });
    else pushed.push(m[2]);
  }
  return { pushed, rejected };
}

export default [
  {
    name: 'fetch', repo: true, mutating: true, params: { remote: 'string?' },
    async handler(ctx, p) {
      const remotes = await remoteNames(ctx);
      if (!remotes.length) refuse(ctx, 'no_remotes', 'the repository has no remotes');
      if (p.remote && !remotes.includes(p.remote)) ctx.fail('not_found', 'no remote ' + p.remote, { param: 'remote', remote: p.remote });
      const list = p.remote ? [p.remote] : remotes;
      const before = await readRefs(ctx.git);
      const job = ctx.job({ title: 'Fetching', cancellable: true });
      for (let i = 0; i < list.length; i++) await fetchRemote(ctx, job, list[i], i / list.length, 1 / list.length);
      job.progress('Fetched', 1);
      const after = await readRefs(ctx.git);
      const d = refsDiff(before, after);
      return { result: 'fetched', remotes: list, ...d, changed: !!(d.updated.length || d.created.length || d.pruned.length || d.tags.length) };
    },
  },
  {
    name: 'push', repo: true, mutating: true,
    params: { branch: 'rev?', remote: 'string?', target: 'string?', force: 'bool?', tags: 'bool?', allTags: 'bool?' },
    async handler(ctx, p) {
      let branch = p.branch ? branchOf(p.branch) || p.branch : null;
      if (!branch) {
        const h = await headState(ctx);
        if (!h.branch) refuse(ctx, 'detached', 'HEAD is detached');
        branch = h.branch;
      }
      const localId = await refId(ctx, 'refs/heads/' + branch);
      if (!localId) ctx.fail('not_found', 'no local branch ' + branch, { param: 'branch', branch });
      const remotes = await remoteNames(ctx);
      if (!remotes.length) refuse(ctx, 'no_remotes', 'the repository has no remotes');
      if (p.remote && !remotes.includes(p.remote)) ctx.fail('not_found', 'no remote ' + p.remote, { param: 'remote', remote: p.remote });
      const upFull = await upstreamOf(ctx, branch);
      // The same target as push.outgoing and a plain `git push` (pushRemote, pushDefault, push.default, refspecs).
      const head = await headState(ctx);
      const t = await pushTarget(ctx, branch, remotes, p.remote, head.branch === branch);
      const remote = t.remote;
      const targetBranch = p.target || t.targetBranch;
      await checkRefName(ctx, targetBranch, 'branch', 'target');
      if (p.force && protectedNames(ctx).includes(targetBranch)) {
        refuse(ctx, 'protected_branch', 'force push to ' + remote + '/' + targetBranch + ' is prohibited', { target: remote + '/' + targetBranch });
      }
      const trackingId = await refId(ctx, 'refs/remotes/' + remote + '/' + targetBranch);
      const ids = trackingId
        ? await revList(ctx, ['-n', String(LIST_CAP), '--end-of-options', trackingId + '..' + localId])
        : await revList(ctx, ['-n', String(LIST_CAP), localId, '--not', '--remotes', '--']);
      const setUpstream = !upFull;
      const to = 'refs/heads/' + targetBranch;
      const args = ['push', '--porcelain', '--progress'];
      if (setUpstream) args.push('--set-upstream');
      if (p.force) args.push('--force-with-lease=' + to + ':' + (trackingId || ''));
      // IntelliJ's "Push tags": All (--tags) or Current Branch (--follow-tags: annotated tags on the pushed commits)
      if (p.allTags) args.push('--tags');
      else if (p.tags) args.push('--follow-tags');
      args.push('--end-of-options', remote, 'refs/heads/' + branch + ':' + to);
      const job = ctx.job({ title: 'Pushing', cancellable: true });
      const r = await tryGit(ctx, args, { timeoutMs: 0, onProgress: progressSink(job, 0, 1) });
      const line = parsePushLine(r.stdout, to);
      if (!line) throw r.fail();
      const tagLines = parsePushTags(r.stdout);
      const base = { branch, remote, target: remote + '/' + targetBranch, targetBranch, forced: !!p.force, tags: tagLines.pushed, tagsRejected: tagLines.rejected };
      if (line.flag === '!') {
        const reason = (REJECT_REASONS.find(([re]) => re.test(line.summary)) || [null, 'rejected'])[1];
        return { result: 'rejected', ...base, reason, message: line.summary, count: 0, ids: [], upstreamSet: false };
      }
      // git exits 1 when any ref was refused: a refused tag beside a pushed branch is an outcome, not a failure
      if (r.exitCode !== 0 && line.flag !== '=' && !tagLines.rejected.length) throw r.fail();
      const result = line.flag === '=' ? 'up-to-date' : line.flag === '*' ? 'created' : line.flag === '+' ? 'forced' : 'pushed';
      const sent = result === 'up-to-date' ? [] : ids;
      return { result, ...base, reason: null, message: line.summary, count: sent.length, ids: sent, upstreamSet: setUpstream };
    },
  },
  {
    name: 'update', repo: true, mutating: true, params: { method: { type: 'enum', values: ['merge', 'rebase'], default: 'merge' } },
    async handler(ctx, p) {
      await refuseIfBusy(ctx, 'update');
      const h = await headState(ctx);
      if (!h.branch) refuse(ctx, 'detached', 'HEAD is detached');
      if (h.unborn) refuse(ctx, 'unborn', 'the branch has no commit yet');
      const base = { method: p.method, branch: h.branch };
      const upFull = await upstreamOf(ctx, h.branch);
      if (!upFull) return { result: 'no-tracked-branch', ...base, gone: false };
      const remote = await configValue(ctx, 'branch.' + h.branch + '.remote');
      if (remote && remote !== '.') {
        const job = ctx.job({ title: 'Updating', cancellable: true });
        await fetchRemote(ctx, job, remote, 0, 0.8);
        job.cancellable(false);
      }
      const upId = await refId(ctx, upFull);
      const upstream = upFull.replace(/^refs\/(remotes|heads)\//, '');
      if (!upId) return { result: 'no-tracked-branch', ...base, upstream, gone: true };
      const incoming = await revList(ctx, ['--end-of-options', h.id + '..' + upId]);
      const info = { ...base, upstream, before: h.id, commits: incoming.length, incoming: incoming.slice(0, LIST_CAP) };
      if (!incoming.length) return { result: 'up-to-date', ...info, after: h.id, files: [], autostash: 'none' };
      // The work tree guard (guard.js): neither the autostash's reset nor what the upstream brings in may run over
      // content git does not track (a replaced folder / file, an ignored file where an incoming file goes).
      let writes;
      if (p.method === 'rebase') {
        const rows = (await revList(ctx, ['--reverse', '--topo-order', '--parents', '--end-of-options', upId + '..' + h.id])).map((l) => { const f = l.split(' '); return { id: f[0], parents: f.slice(1) }; });
        const from = rebaseStart(upId, rows, rows.map((x) => ({ id: x.id, action: 'pick', message: null })));
        writes = await rebaseWrites(ctx, h.id, from.start, from.commits);
      } else writes = await mergeWrites(ctx, h.id, upId);
      const pre = await prepareStash(ctx, writes);
      if (pre.blocked) return wouldOverwriteResult(pre.blocked, { ...info, autostash: 'none' });
      const ff = await isAncestor(ctx, h.id, upId);
      const args = p.method === 'rebase'
        ? ['rebase', '--autostash', '--end-of-options', upFull]
        : ['merge', '--autostash', '--no-stat', '--end-of-options', upFull];
      const start = { branch: h.branch, id: h.id };
      let r;
      try {
        r = await asJob(ctx, 'Updating', () => tryGit(ctx, args));
      } catch (e) {
        if (p.method === 'rebase') await endIncomplete(ctx, { start });
        const busy = await opSummary(ctx);
        const moved = (await headState(ctx)).id !== h.id;
        // cancelled after the update was done (a hook after it was ended): it is an update, reported as one below
        if (isCancel(e) && moved && !(busy && busy.type)) r = lateCancel();
        else {
          // cancelled or killed: an operation that got as far as its state stays (op.abort), anything less is put back
          if (p.method === 'rebase') { if (!busy) await undoStashSideEffects(ctx, pre); }
          else if (!moved && !fs.existsSync(path.join(ctx.repo.gitDir, 'MERGE_HEAD'))) await takeBackMerge(ctx, pre, true);
          throw e;
        }
      }
      let op = await opSummary(ctx);
      // git died while it stashed (only its autostash is left): nothing ran, the autostash is put back
      if (op && op.incomplete) { await endIncomplete(ctx, { start }); op = await opSummary(ctx); }
      const after = (await headState(ctx)).id;
      const stashConflict = pre.dirty && op && !op.type && (await stashTop(ctx)) !== pre.stash;
      if ((r.exitCode !== 0 || (op && op.type)) && !stashConflict) {
        if (op && op.conflicts.length) return { result: 'conflicts', ...info, after, files: [], conflicts: op.conflicts, autostash: pre.dirty ? 'pending' : 'none' };
        const w = parseWouldOverwrite(r.stderr);
        if (!(op && op.type) && after === h.id) await undoStashSideEffects(ctx, pre);   // nothing ran: staging and deletions as before
        if (w) return wouldOverwriteResult(w, { ...info, autostash: 'none' });
        throw r.fail();
      }
      const a = await stashOutcome(ctx, pre, false);
      const files = (await pathsBetween(ctx, h.id, after)).slice(0, LIST_CAP);
      const result = ff && after === upId ? 'fast-forward' : p.method === 'rebase' ? 'rebased' : 'merged';
      return { result, ...info, after, files, autostash: a.autostash, conflicts: a.autostash === 'conflicts' ? a.conflicts : [] };
    },
  },
];
