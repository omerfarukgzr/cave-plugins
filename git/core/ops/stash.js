// Stash group (mutating): stash.save, stash.apply, stash.pop, stash.drop, stash.clear — IntelliJ's Stash dialog,
// Stash tab and Unstash dialog on git's stash (docs/spec-stash.md "Engine design"). A stash is addressed by its commit
// id; a dropped, popped or cleared stash is a trash entry that keeps it reachable (core/stash-trash.js).
import { readStashList } from '../read/stash.js';
import { saveStashTrash, dropStashTrash, pruneStashTrash, stashTrashSummary } from '../stash-trash.js';
import { refuse, tryGit, headState, refuseIfBusy, readStatus, refId, checkRefName, asJob, isCancel, wouldOverwriteResult } from './util.js';
import { prepareStash, undoStashSideEffects } from './autostash.js';
import { treeWrites } from './guard.js';
import { OID, STASH_OPTS, stashById, findPushed, dropVerified, stashBlocked, applyById } from './stash-core.js';

/** A stash message as one line: NUL and line breaks become spaces (a reflog message is one line). */
export const oneLine = (m) => String(m || '').replace(/[\0\r\n]+/g, ' ').trim();

/** The checks every method that writes the work tree makes first. */
async function refuseUnusable(ctx, what) {
  await refuseIfBusy(ctx, what);
}

/** apply / pop / pop as a new branch (`branch`): the shared handler. */
async function unstash(ctx, p, pop) {
  await pruneStashTrash(ctx);
  await refuseUnusable(ctx, pop ? 'pop the stash' : 'apply the stash');
  const { stash } = await stashById(ctx, p.id);
  let extra = [];
  if (p.branch) {
    await checkRefName(ctx, p.branch, 'branch', 'branch');
    const old = await refId(ctx, 'refs/heads/' + p.branch);
    if (old) refuse(ctx, 'exists', "branch '" + p.branch + "' already exists", { branch: p.branch, head: old });
    const h = await headState(ctx);
    // git checks out the stash's base first: what that brings in must not run over content git does not track
    extra = await treeWrites(ctx, h.id, stash.base);
  }
  const blocked = await stashBlocked(ctx, stash, extra);
  if (blocked) return wouldOverwriteResult(blocked, { id: stash.id, dropped: false });
  const before = await headState(ctx);
  const out = await applyById(ctx, stash, { index: !!p.index, branch: p.branch || null, title: 'Unstashing…' });
  const after = await headState(ctx);
  const branch = p.branch && after.branch === p.branch ? p.branch : null;
  if (out.result === 'would-overwrite') return { ...wouldOverwriteResult(out, { id: stash.id, dropped: false }), index: out.index, branch };
  if (out.result !== 'applied') return { result: out.result, id: stash.id, conflicts: out.conflicts, dropped: false, index: out.index, branch };
  if (p.branch && !branch) throw ctx.fail('git_failed', 'git did not check out ' + p.branch, { stash: stash.id, head: after });
  if (!pop) return { result: 'applied', id: stash.id, conflicts: [], dropped: false, index: out.index, branch: null };
  let trash = null;
  let moved = null;
  let dropError = null;
  // The changes ARE applied now: whatever the drop meets, the answer is never an error (a person would pop again and
  // get conflicts). The stash simply stays listed, with the reason.
  try { trash = await dropVerified(ctx, stash.id, p.branch ? 'stash.branch' : 'stash.pop'); } catch (e) {
    if (e && e.code === 'refused' && e.data && e.data.reason === 'stash_moved') moved = e.data;   // another program moved the list
    else dropError = { code: (e && e.code) || 'internal', message: (e && e.message) || String(e) };
  }
  const previous = p.branch ? { branch: before.branch, id: before.id } : undefined;
  if (!trash) return { result: 'applied', id: stash.id, conflicts: [], dropped: false, reason: moved ? 'stash_moved' : 'drop_failed', moved, dropError, index: out.index, branch, previous };
  return { result: p.branch ? 'branched' : 'popped', id: stash.id, conflicts: [], dropped: true, trash, index: out.index, branch, previous };
}

export default [
  {
    name: 'stash.save', repo: true, mutating: true,
    params: { message: { type: 'string', optional: true, maxLength: 4096 }, keepIndex: 'bool?', includeUntracked: 'bool?' },
    async handler(ctx, p) {
      await pruneStashTrash(ctx);
      await refuseUnusable(ctx, 'stash');
      const h = await headState(ctx);
      if (h.unborn || !h.id) refuse(ctx, 'unborn', 'you do not have the initial commit yet');
      const message = oneLine(p.message);
      const status = await readStatus(ctx);
      const tracked = status.entries.some((e) => e.type === '1' || e.type === '2');
      if (!tracked && !(p.includeUntracked && status.untracked.size)) refuse(ctx, 'nothing_to_stash', 'no local changes to save');
      const pre = await prepareStash(ctx);
      if (pre.blocked) return wouldOverwriteResult(pre.blocked);
      const before = (await readStashList(ctx)).map((s) => s.id);
      const args = ['stash', 'push', ...(p.keepIndex ? ['--keep-index'] : []), ...(p.includeUntracked ? ['--include-untracked'] : []),
        ...(message ? ['--message=' + message] : [])];
      let r = null;
      let failure = null;
      try { r = await asJob(ctx, 'Stashing changes…', () => tryGit(ctx, args, STASH_OPTS)); } catch (e) { failure = e; }
      const found = await findPushed(ctx, before, h.id, message || null);
      if (failure || r.exitCode !== 0) {
        // killed or failed: the changes are where git left them, in the work tree or in the stash it named (nothing is lost)
        const err = failure && isCancel(failure) ? failure : (failure || r.fail());
        if (err && typeof err === 'object') err.data = { ...(err.data || {}), stash: found.stash ? found.stash.id : null, candidates: found.candidates };
        if (!found.fresh.length) await undoStashSideEffects(ctx, pre);
        throw err;
      }
      if (!found.fresh.length) refuse(ctx, 'nothing_to_stash', 'no local changes to save');
      const s = found.stash;
      return { result: 'stashed', id: s ? s.id : null, ref: s ? s.ref : null, subject: s ? s.subject : null, candidates: found.candidates };
    },
  },
  {
    name: 'stash.apply', repo: true, mutating: true,
    params: { id: 'string', index: 'bool?' },
    handler: (ctx, p) => unstash(ctx, p, false),
  },
  {
    name: 'stash.pop', repo: true, mutating: true,
    params: { id: 'string', index: 'bool?', branch: 'string?' },
    handler: (ctx, p) => unstash(ctx, p, true),
  },
  {
    name: 'stash.drop', repo: true, mutating: true,
    params: { id: 'string' },
    async handler(ctx, p) {
      await pruneStashTrash(ctx);
      const trash = await dropVerified(ctx, p.id, 'stash.drop');
      return { result: 'dropped', id: p.id, trash };
    },
  },
  {
    name: 'stash.clear', repo: true, mutating: true,
    params: { expect: 'string' },
    async handler(ctx, p) {
      await pruneStashTrash(ctx);
      if (!OID.test(p.expect)) ctx.fail('invalid_params', 'not a full stash id: ' + p.expect, { param: 'expect', reason: 'not a full object id' });
      const list = await readStashList(ctx);
      if (!list.length) refuse(ctx, 'no_stashes', 'there are no stashes');
      if (list[0].id !== p.expect) refuse(ctx, 'stash_moved', 'the stash list changed since it was read', { top: list[0].id });
      // the entry and its refs first; any failure here throws before anything is removed
      const entry = await saveStashTrash(ctx, list.map((s) => ({ id: s.id, subject: s.subject })), 'stash.clear');
      // what `git stash clear` does, but compare-and-delete: a stash pushed after the read above is never removed unseen
      const r = await tryGit(ctx, ['update-ref', '-d', 'refs/stash', list[0].id]);
      if (r.exitCode !== 0) {
        await dropStashTrash(ctx, entry);
        if (await refId(ctx, 'refs/stash') !== list[0].id) refuse(ctx, 'stash_moved', 'the stash list changed while clearing', { top: await refId(ctx, 'refs/stash') });
        throw r.fail();
      }
      const left = await readStashList(ctx);
      if (left.length || await refId(ctx, 'refs/stash')) {
        throw ctx.fail('git_failed', 'the stash list is not empty after clearing', { left: left.map((s) => s.id), trash: stashTrashSummary(entry) });
      }
      return { result: 'cleared', count: list.length, trash: stashTrashSummary(entry) };
    },
  },
];
