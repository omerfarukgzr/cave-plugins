// Additions of the branches / merge / rebase wave (docs/PROTOCOL.md): rebase.applyOnto (the Rebase dialog with
// --interactive: an interactive rebase onto another branch), branch.update (Update of a branch that is not checked
// out: a fast-forward from its upstream) and tag.push (Tag ▸ Push to origin). Added in a file of its own so the
// existing engine files stay untouched; it reuses their helpers.
import { splitNulRecords } from '../parse.js';
import { parseProgress } from '../git.js';
import { label } from '../repo.js';
import {
  refuse, tryGit, headState, refuseIfBusy, refId, refExists, remoteNames, configValue, isAncestor, revList,
  protectedContaining, checkMessage, writeTemp, checkedOutElsewhere, wouldOverwriteResult, pushTarget, branchOf, resolveRef,
} from './util.js';
import { prepareStash } from './autostash.js';
import { rebaseWrites, rebaseStart } from './guard.js';
import { buildTodo, shq, cleanRebaseFiles } from './rewrite.js';
import { runRebase, autostashFields } from './sequence.js';
import { parsePushLine } from './remote.js';

const ACTIONS = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];

/** The entries of a plan, validated the way rebase.apply validates them. */
function checkEntries(ctx, list) {
  if (!Array.isArray(list) || !list.length) ctx.fail('invalid_params', 'entries must be a non-empty array', { param: 'entries', reason: 'must be a non-empty array' });
  return list.map((e, i) => {
    const where = 'entries[' + i + ']';
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !/^[0-9a-f]{4,64}$/.test(e.id)) ctx.fail('invalid_params', where + '.id must be a commit id', { param: where + '.id', reason: 'must be a hex object id' });
    if (!ACTIONS.includes(e.action)) ctx.fail('invalid_params', where + '.action is not one of ' + ACTIONS.join(', '), { param: where + '.action', reason: 'unknown action' });
    if (e.message != null && typeof e.message !== 'string') ctx.fail('invalid_params', where + '.message must be a string', { param: where + '.message', reason: 'must be a string' });
    const extra = Object.keys(e).filter((k) => !['id', 'action', 'message'].includes(k));
    if (extra.length) ctx.fail('invalid_params', where + '.' + extra[0] + ' is not a field of an entry', { param: where + '.' + extra[0], reason: 'is not a field of an entry' });
    return { id: e.id, action: e.action, message: e.message == null ? null : e.message };
  });
}

/** Commits upstream..tip (every commit of tip when `upstream` is null: --root), oldest first: [{ id, parents, message }]. */
export async function rowsBetween(ctx, upstream, tip) {
  const out = await ctx.git(['log', '-z', '--reverse', '--topo-order', '--format=%H%x00%P%x00%B', '--end-of-options', upstream ? upstream + '..' + tip : tip]);
  return splitNulRecords(out.stdout, 3).map(([id, parents, message]) => ({ id, parents: parents.split(' ').filter(Boolean), message: message.replace(/\s+$/, '') }));
}

/**
 * --update-refs for a plan we write ourselves: git puts `update-ref refs/heads/<b>` after the commit a branch points to;
 * our todo replaces git's, so the lines are added here. A ref moves with the last commit of the group its commit lands
 * in (a fixup's group ends at the next pick / edit / drop), so each line goes right before the next such line, or at
 * the end. Branches checked out in another worktree stay, as git leaves them.
 */
async function addUpdateRefs(ctx, todo, rows, branch) {
  const inRange = new Set(rows.map((r) => r.id));
  const out = await ctx.git(['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads']);
  const refsAt = new Map();
  for (const line of out.stdout.split('\n')) {
    const [id, ref] = line.split(' ');
    if (!ref || !inRange.has(id) || ref === 'refs/heads/' + branch) continue;
    if (await checkedOutElsewhere(ctx, ref.slice(11))) continue;
    if (!refsAt.has(id)) refsAt.set(id, []);
    refsAt.get(id).push(ref);
  }
  if (!refsAt.size) return todo;
  const lines = [], pending = [];
  for (const line of todo.split('\n').filter(Boolean)) {
    const m = /^(pick|edit|drop|fixup) ([0-9a-f]+)/.exec(line);
    if (m && m[1] !== 'fixup') lines.push(...pending.splice(0).map((ref) => 'update-ref ' + ref));
    lines.push(line);
    if (m) pending.push(...(refsAt.get(m[2]) || []));
  }
  lines.push(...pending.map((ref) => 'update-ref ' + ref));
  return lines.join('\n') + '\n';
}
/** The options of the Rebase dialog that reach git as they are (the plan decides the order and the actions). */
const FLAGS = [['rebaseMerges', '--rebase-merges'], ['keepEmpty', '--keep-empty'], ['updateRefs', '--update-refs']];

async function upstreamOf(ctx, branch) {
  const r = await ctx.git(['for-each-ref', '--format=%(upstream)', 'refs/heads/' + branch]);
  return r.stdout.trim() || null;
}

export default [
  {
    name: 'rebase.applyOnto', repo: true, mutating: true,
    params: { onto: 'rev', upstream: 'rev?', branch: 'rev?', head: 'oid?', allowPushed: 'bool?', entries: { type: 'any' },
      rebaseMerges: 'bool?', keepEmpty: 'bool?', root: 'bool?', updateRefs: 'bool?', autosquash: 'bool?', noAutosquash: 'bool?' },
    async handler(ctx, p) {
      const entries = checkEntries(ctx, p.entries);
      await refuseIfBusy(ctx, 'rebase');
      const h = await headState(ctx);
      if (!p.branch && !h.branch) refuse(ctx, 'detached', 'rebase is not possible in the detached HEAD state');
      const branch = p.branch ? branchOf(p.branch) || p.branch : h.branch;   // a name or refs/heads/… (Ref names)
      const branchId = await refId(ctx, 'refs/heads/' + branch);
      if (!branchId) ctx.fail('not_found', 'no local branch ' + branch, { param: 'branch', rev: branch });
      if (branch !== h.branch) {
        const where = await checkedOutElsewhere(ctx, branch);
        if (where) refuse(ctx, 'checked_out_elsewhere', "branch '" + branch + "' is checked out in another worktree", { branch, path: where });
      }
      if (p.head && !branchId.startsWith(p.head)) refuse(ctx, 'head_moved', 'the branch moved since the plan was made', { head: branchId });
      // Ref names: a bare name is the local branch before a tag of that name (git's own lookup would take the tag)
      const ontoId = (await resolveRef(ctx, p.onto, 'onto')).id;
      const upstreamId = p.upstream && !p.root ? (await resolveRef(ctx, p.upstream, 'upstream')).id : ontoId;
      const rows = await rowsBetween(ctx, p.root ? null : upstreamId, branchId);
      const merges = rows.filter((r) => r.parents.length > 1).map((r) => r.id);
      if (merges.length) refuse(ctx, 'merge_commit', 'the range contains a merge commit', { ids: merges });
      const full = [], unknown = [];
      for (const e of entries) {
        const m = rows.filter((r) => r.id.startsWith(e.id));
        if (m.length !== 1) unknown.push(e.id); else full.push({ ...e, id: m[0].id });
      }
      if (unknown.length) refuse(ctx, 'unknown_commit', 'the plan names commits that are not in the range', { ids: unknown });
      if (new Set(full.map((e) => e.id)).size !== full.length) ctx.fail('invalid_params', 'a commit is listed twice', { param: 'entries', reason: 'duplicate commit' });
      const missing = rows.filter((r) => !full.some((e) => e.id === r.id)).map((r) => r.id);
      if (missing.length) refuse(ctx, 'plan_incomplete', 'the plan leaves out commits of the range', { ids: missing });
      const firstKept = full.find((e) => e.action !== 'drop');
      if (firstKept && (firstKept.action === 'squash' || firstKept.action === 'fixup')) refuse(ctx, 'squash_first', 'the first commit cannot be squashed into a previous one', { id: firstKept.id });
      for (const e of full) if (e.message != null) checkMessage(ctx, e.message);
      if (rows.length && !p.allowPushed) {
        const prot = await protectedContaining(ctx, rows[0].id);
        if (prot.length) refuse(ctx, 'pushed_to_protected', 'some commits were already pushed to a protected branch', { branches: prot, id: rows[0].id });
      }
      cleanRebaseFiles(ctx);
      let todo = buildTodo(full, rows, (msg) => writeTemp(ctx, msg.endsWith('\n') ? msg : msg + '\n', 'rebase'));
      if (p.updateRefs) todo = await addUpdateRefs(ctx, todo, rows, branch);
      const plan = writeTemp(ctx, todo.trim() ? todo : 'noop\n', 'rebase', 'plan-');
      // The plan is the todo list (the sequence editor copies it over git's), so --autosquash only tells git what was
      // asked; without a choice --no-autosquash keeps rebase.autoSquash from rearranging what we hand over.
      const args = ['rebase', '--interactive', '--autostash', p.autosquash ? '--autosquash' : '--no-autosquash'];
      FLAGS.forEach(([k, flag]) => { if (p[k]) args.push(flag); });
      if (p.root) args.push('--root', '--onto=' + ontoId, '--end-of-options');
      else args.push('--onto=' + ontoId, '--end-of-options', upstreamId);
      // the bare name: git rebase looks it up as refs/heads/<name> first (a full ref there would rebase a detached HEAD)
      if (branch !== h.branch) args.push(branch);
      // the work tree guard (guard.js): nothing runs when the autostash's reset, the checkout of the new base or a
      // replayed commit would run over content git does not track
      const from = p.rebaseMerges ? { start: ontoId, commits: full.filter((e) => e.action !== 'drop').map((e) => e.id) } : rebaseStart(ontoId, rows, full);
      const pre = await prepareStash(ctx, await rebaseWrites(ctx, h.id, from.start, from.commits));
      if (pre.blocked) { cleanRebaseFiles(ctx); return wouldOverwriteResult(pre.blocked, { before: branchId, branch, autostash: 'none' }); }
      let s;
      try {
        s = await runRebase(ctx, args, { env: { GIT_SEQUENCE_EDITOR: 'cp ' + shq(plan) }, pre, start: { branch: h.branch, id: h.id } });
      } catch (e) { cleanRebaseFiles(ctx); throw e; }
      if (s.result === 'done' || s.result === 'would-overwrite') cleanRebaseFiles(ctx);
      const after = await headState(ctx);
      const base = { before: branchId, branch, onto: p.onto, ontoId, checkedOut: branch !== h.branch, previous: { branch: h.branch, id: h.id } };
      if (s.result === 'would-overwrite') return wouldOverwriteResult(s, base);
      return { result: s.result === 'done' ? 'rebased' : s.result, ...base, after: after.id, conflicts: s.conflicts, rebase: s.rebase || null, ...(s.result === 'done' ? autostashFields(s) : { autostash: s.autostash || 'none' }) };
    },
  },
  {
    name: 'branch.update', repo: true, mutating: true, params: { name: 'rev' },
    async handler(ctx, raw) {
      const p = { ...raw, name: branchOf(raw.name) || raw.name };   // a name or refs/heads/…
      const localId = await refId(ctx, 'refs/heads/' + p.name);
      if (!localId) ctx.fail('not_found', 'no local branch ' + p.name, { param: 'name', rev: p.name });
      const h = await headState(ctx);
      if (h.branch === p.name) refuse(ctx, 'current_branch', 'the current branch is updated with `update`', { branch: p.name });
      const upFull = await upstreamOf(ctx, p.name);
      const base = { branch: p.name, before: localId };
      if (!upFull) return { result: 'no-tracked-branch', ...base, upstream: null, gone: false };
      const upstream = upFull.replace(/^refs\/(remotes|heads)\//, '');
      const remote = await configValue(ctx, 'branch.' + p.name + '.remote');
      if (remote && remote !== '.') {
        const job = ctx.job({ title: 'Updating ' + p.name, cancellable: true });
        job.progress('Fetching ' + remote, 0);
        await ctx.git(['fetch', '--progress', '--prune', '--recurse-submodules=no', '--end-of-options', remote], {
          timeoutMs: 0, onProgress: (line) => { const pr = parseProgress(line); job.progress(line, pr ? pr.fraction : null); } });
        job.cancellable(false);
      }
      const upId = await refId(ctx, upFull);
      if (!upId) return { result: 'no-tracked-branch', ...base, upstream, gone: true };
      if (upId === localId || await isAncestor(ctx, upId, localId)) return { result: 'up-to-date', ...base, upstream, after: localId, commits: 0 };
      if (!(await isAncestor(ctx, localId, upId))) return { result: 'diverged', ...base, upstream, after: localId, commits: 0 };
      const where = await checkedOutElsewhere(ctx, p.name);
      if (where) refuse(ctx, 'checked_out_elsewhere', "branch '" + p.name + "' is checked out in another worktree", { branch: p.name, path: where });
      const incoming = await revList(ctx, ['--end-of-options', localId + '..' + upId]);
      await ctx.git(['update-ref', '-m', label(ctx.repo) + ': update ' + p.name + ' from ' + upstream, '--end-of-options', 'refs/heads/' + p.name, upId, localId]);
      return { result: 'fast-forward', ...base, upstream, after: upId, commits: incoming.length, incoming: incoming.slice(0, 10000) };
    },
  },
  {
    name: 'tag.push', repo: true, mutating: true, params: { name: 'rev', remote: 'string?' },
    async handler(ctx, raw) {
      const p = { ...raw, name: raw.name.startsWith('refs/tags/') ? raw.name.slice(10) : raw.name };   // a name or refs/tags/…
      if (!(await refExists(ctx, 'refs/tags/' + p.name))) ctx.fail('not_found', 'no tag ' + p.name, { param: 'name', rev: p.name });
      const remotes = await remoteNames(ctx);
      if (!remotes.length) refuse(ctx, 'no_remotes', 'the repository has no remotes');
      if (p.remote && !remotes.includes(p.remote)) ctx.fail('not_found', 'no remote ' + p.remote, { param: 'remote', remote: p.remote });
      // the remote a plain push of the current branch goes to (push / push.outgoing: pushTarget), unless one is named
      const remote = p.remote || (await pushTarget(ctx, (await headState(ctx)).branch || '', remotes, null)).remote || remotes[0];
      const ref = 'refs/tags/' + p.name;
      const job = ctx.job({ title: 'Pushing ' + p.name, cancellable: true });
      const r = await tryGit(ctx, ['push', '--porcelain', '--progress', '--end-of-options', remote, ref + ':' + ref], {
        timeoutMs: 0, onProgress: (line) => { const pr = parseProgress(line); job.progress(line, pr ? pr.fraction : null); } });
      const line = parsePushLine(r.stdout, ref);
      if (!line) throw r.fail();
      const base = { tag: p.name, remote, message: line.summary };
      if (line.flag === '!') return { result: 'rejected', ...base };
      if (r.exitCode !== 0 && line.flag !== '=') throw r.fail();
      return { result: line.flag === '=' ? 'up-to-date' : 'pushed', ...base };
    },
  },
  {
    // The "Delete on Remote" link of IntelliJ's Deleted Tag notification: `git push <remote> :refs/tags/<name>`.
    name: 'tag.deleteRemote', repo: true, mutating: true, params: { name: 'string', remote: 'string?' },
    async handler(ctx, p) {
      if (!/^[^\s~^:?*[\\]+$/.test(p.name) || p.name.startsWith('-')) ctx.fail('invalid_params', 'not a tag name', { param: 'name', reason: 'not a tag name' });
      const remotes = await remoteNames(ctx);
      if (!remotes.length) refuse(ctx, 'no_remotes', 'the repository has no remotes');
      if (p.remote && !remotes.includes(p.remote)) ctx.fail('not_found', 'no remote ' + p.remote, { param: 'remote', remote: p.remote });
      const remote = p.remote || (await pushTarget(ctx, (await headState(ctx)).branch || '', remotes, null)).remote || remotes[0];
      const ref = 'refs/tags/' + p.name;
      // a remote that does not have the tag: IntelliJ's "Tag Doesn't Exist on Remote" (git push would report a deletion)
      const there = await tryGit(ctx, ['ls-remote', '--tags', '--end-of-options', remote, ref]);
      if (there.exitCode === 0 && !there.stdout.trim()) return { result: 'missing', tag: p.name, remote };
      const r = await tryGit(ctx, ['push', '--porcelain', '--end-of-options', remote, ':' + ref], { timeoutMs: 0 });
      const line = parsePushLine(r.stdout, ref);
      if (!line && r.exitCode !== 0) {
        if (/remote ref does not exist/.test(r.stderr || '')) return { result: 'missing', tag: p.name, remote };
        throw r.fail();
      }
      if (line && line.flag === '!') return { result: /does not exist/.test(line.summary || '') ? 'missing' : 'rejected', tag: p.name, remote, message: line.summary };
      return { result: 'deleted', tag: p.name, remote };
    },
  },
];
