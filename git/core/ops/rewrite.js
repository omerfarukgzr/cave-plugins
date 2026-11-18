// History editing: rebase.apply (interactive rebase), commit.editMessage, commit.drop, commit.undo, and
// changes.applyFromCommit (IntelliJ's "Cherry-Pick Selected Changes").
//
// Interactive rebase never opens an editor (docs/ARCHITECTURE.md §3.6): the todo list is written to a file and
// GIT_SEQUENCE_EDITOR is `cp '<plan file>'` (git appends the todo path). New messages (reword, squash) are applied by
// `exec git commit --amend --allow-empty -F '<message file>'` lines; squash and fixup both become `fixup` lines, so git
// never asks for a combined message. The plan and message files live in <gitDir>/<dataDir>/rebase/ until the rebase
// ends (a conflict stop still needs them); cleanRebaseFiles() removes them once no rebase is in progress.
import fs from 'node:fs';
import path from 'node:path';
import { commitId, changesAgainst } from '../read/commit.js';
import { splitNulRecords } from '../parse.js';
import { workPath, dataDir } from '../repo.js';
import {
  refuse, tryGit, headState, refuseIfBusy, isAncestor, revList, protectedContaining, withMessage, checkMessage,
  writeTemp, removeQuietly, readStatus, unmerged, pathsBetween, asJob, trash, settleTrash, failedAfterSaving,
} from './util.js';
import { prepareStash } from './autostash.js';
import { rebaseWrites, rebaseStart } from './guard.js';
import { runRebase, autostashFields } from './sequence.js';

const ACTIONS = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];

/** Quotes a string for sh: '…' with every ' written as '\''. */
export const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

export function cleanRebaseFiles(ctx) {
  const dir = path.join(ctx.repo.gitDir, dataDir(ctx.repo), 'rebase');
  if (!fs.existsSync(dir)) return;
  if (fs.existsSync(path.join(ctx.repo.gitDir, 'rebase-merge')) || fs.existsSync(path.join(ctx.repo.gitDir, 'rebase-apply'))) return;
  removeQuietly(dir);
}

async function parentsOf(ctx, id) {
  const r = await ctx.git(['log', '-1', '-z', '--format=%P', '--end-of-options', id]);
  return r.stdout.replace(/\0$/, '').split(' ').filter(Boolean);
}

/** Commits base..HEAD (or everything up to HEAD when base is null), oldest first: [{ id, parents, message }]. */
async function rangeRows(ctx, base, head) {
  const out = await ctx.git(['log', '-z', '--reverse', '--topo-order', '--format=%H%x00%P%x00%B', '--end-of-options', base ? base + '..' + head : head]);
  return splitNulRecords(out.stdout, 3).map(([id, parents, message]) => ({ id, parents: parents.split(' ').filter(Boolean), message: message.replace(/\s+$/, '') }));
}

function refuseMerges(ctx, rows) {
  const merges = rows.filter((r) => r.parents.length > 1).map((r) => r.id);
  if (merges.length) refuse(ctx, 'merge_commit', 'the range contains a merge commit', { ids: merges });
}

async function refuseProtected(ctx, id) {
  const prot = await protectedContaining(ctx, id);
  if (prot.length) refuse(ctx, 'pushed_to_protected', 'the commit is already pushed to a protected branch', { branches: prot, id });
}

/** Turns plan entries into todo lines (see the header). Exported for tests. */
export function buildTodo(entries, rows, messageFile) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const lines = [];
  let group = null;
  const flush = () => {
    if (!group) return;
    const msg = group.explicit != null ? group.explicit : group.squashed ? group.messages.join('\n\n') : null;
    if (msg != null) lines.push('exec git commit --amend --allow-empty -F ' + shq(messageFile(msg)));
    group = null;
  };
  for (const e of entries) {
    const row = byId.get(e.id);
    if (e.action === 'drop') { lines.push('drop ' + e.id); continue; }
    if (e.action === 'squash' || e.action === 'fixup') {
      lines.push('fixup ' + e.id);
      if (e.action === 'squash') { group.squashed = true; group.messages.push(row.message); }
      if (e.message != null) group.explicit = e.message;
      continue;
    }
    flush();
    lines.push((e.action === 'edit' ? 'edit ' : 'pick ') + e.id);
    group = { messages: [row.message], squashed: false, explicit: e.message != null && (e.action !== 'pick' || e.message !== row.message) ? e.message : null };
  }
  flush();
  return lines.join('\n') + '\n';
}

/**
 * Runs an interactive rebase of base..HEAD with `entries` ({ id, action, message? }, the full range in the new order).
 * Checks are done by the callers that need others; this one validates the plan against the range.
 */
async function applyPlan(ctx, h, baseId, entries, opts = {}) {
  const rows = await rangeRows(ctx, baseId, h.id);
  refuseMerges(ctx, rows);
  const full = [];
  const unknown = [];
  for (const e of entries) {
    const matches = rows.filter((r) => r.id.startsWith(e.id));
    if (matches.length !== 1) { unknown.push(e.id); continue; }
    full.push({ ...e, id: matches[0].id });
  }
  if (unknown.length) refuse(ctx, 'unknown_commit', 'the plan names commits that are not in the range', { ids: unknown });
  if (new Set(full.map((e) => e.id)).size !== full.length) ctx.fail('invalid_params', 'a commit is listed twice', { param: 'entries', reason: 'duplicate commit' });
  const missing = rows.filter((r) => !full.some((e) => e.id === r.id)).map((r) => r.id);
  if (missing.length) refuse(ctx, 'plan_incomplete', 'the plan leaves out commits of the range', { ids: missing });
  const firstKept = full.find((e) => e.action !== 'drop');
  if (firstKept && (firstKept.action === 'squash' || firstKept.action === 'fixup')) {
    refuse(ctx, 'squash_first', 'the first commit cannot be squashed into a previous one', { id: firstKept.id });
  }
  if (!firstKept && !baseId) refuse(ctx, 'nothing_left', 'dropping every commit of the branch would leave it empty');
  for (const e of full) if (e.message != null) checkMessage(ctx, e.message);
  if (rows.length && !opts.allowPushed) await refuseProtected(ctx, rows[0].id);
  // The work tree guard (guard.js): nothing has run yet. The autostash's reset, the checkout of the commit the replay
  // starts on and every replayed commit must not run over content git does not track.
  const from = rebaseStart(baseId, rows, full);
  const pre = await prepareStash(ctx, await rebaseWrites(ctx, h.id, from.start, from.commits));
  if (pre.blocked) return { s: { result: 'would-overwrite', files: pre.blocked.files, untracked: pre.blocked.untracked, autostash: 'none' }, rows, full, before: h.id, after: h.id, branch: h.branch };
  cleanRebaseFiles(ctx);
  const todo = buildTodo(full, rows, (msg) => writeTemp(ctx, msg.endsWith('\n') ? msg : msg + '\n', 'rebase'));
  const plan = writeTemp(ctx, todo, 'rebase', 'plan-');
  const args = ['rebase', '--interactive', '--autostash', '--no-autosquash', ...(baseId ? ['--end-of-options', baseId] : ['--root'])];
  let s;
  try {
    s = await runRebase(ctx, args, { env: { GIT_SEQUENCE_EDITOR: 'cp ' + shq(plan) }, pre, start: { branch: h.branch, id: h.id } });
  } catch (e) { cleanRebaseFiles(ctx); throw e; }   // (the plan files stay while a rebase is in progress)
  if (s.result === 'done' || s.result === 'would-overwrite') cleanRebaseFiles(ctx);
  const after = await headState(ctx);
  return { s, rows, full, before: h.id, after: after.id, branch: h.branch };
}

/** The result of a plan: rebase.apply's shape (plus `autostash`, and its `conflicts` when it could not be applied). */
function planResult(x, done) {
  if (x.s.result === 'would-overwrite') return { result: 'would-overwrite', files: x.s.files, untracked: x.s.untracked, before: x.before, autostash: 'none' };
  const out = { result: x.s.result === 'done' ? done : x.s.result, before: x.before, after: x.after, branch: x.branch, conflicts: x.s.conflicts, rebase: x.s.rebase || null };
  return x.s.result === 'done' ? { ...out, ...autostashFields(x.s) } : { ...out, autostash: x.s.autostash || 'none' };
}

async function prepare(ctx, what) {
  await refuseIfBusy(ctx, what);
  const h = await headState(ctx);
  if (h.unborn) refuse(ctx, 'unborn', 'HEAD has no commit yet');
  return h;
}

async function inHead(ctx, h, id) {
  if (!(await isAncestor(ctx, id, h.id))) refuse(ctx, 'not_in_current_branch', 'the commit is not in the current branch', { id });
}

export default [
  {
    name: 'rebase.apply', repo: true, mutating: true,
    params: {
      base: 'rev?', head: 'oid?', allowPushed: 'bool?',
      entries: { type: 'any' },
    },
    async handler(ctx, p) {
      if (!Array.isArray(p.entries) || !p.entries.length) ctx.fail('invalid_params', 'entries must be a non-empty array', { param: 'entries', reason: 'must be a non-empty array' });
      const entries = p.entries.map((e, i) => {
        const where = 'entries[' + i + ']';
        if (!e || typeof e !== 'object' || typeof e.id !== 'string' || !/^[0-9a-f]{4,64}$/.test(e.id)) ctx.fail('invalid_params', where + '.id must be a commit id', { param: where + '.id', reason: 'must be a hex object id' });
        if (!ACTIONS.includes(e.action)) ctx.fail('invalid_params', where + '.action is not one of ' + ACTIONS.join(', '), { param: where + '.action', reason: 'unknown action' });
        if (e.message != null && typeof e.message !== 'string') ctx.fail('invalid_params', where + '.message must be a string', { param: where + '.message', reason: 'must be a string' });
        const extra = Object.keys(e).filter((k) => !['id', 'action', 'message'].includes(k));
        if (extra.length) ctx.fail('invalid_params', where + '.' + extra[0] + ' is not a field of an entry', { param: where + '.' + extra[0], reason: 'is not a field of an entry' });
        return { id: e.id, action: e.action, message: e.message == null ? null : e.message };
      });
      const h = await prepare(ctx, 'rebase');
      if (p.head && !h.id.startsWith(p.head)) refuse(ctx, 'head_moved', 'HEAD moved since the plan was made', { head: h.id });
      const baseId = p.base ? await commitId(ctx, p.base, 'base') : null;
      if (baseId) await inHead(ctx, h, baseId);
      return planResult(await applyPlan(ctx, h, baseId, entries, { allowPushed: p.allowPushed }), 'rebased');
    },
  },
  {
    name: 'commit.editMessage', repo: true, mutating: true, params: { id: 'rev', message: 'string' },
    async handler(ctx, p) {
      checkMessage(ctx, p.message);
      const h = await prepare(ctx, 'edit the commit message');
      const id = await commitId(ctx, p.id);
      await inHead(ctx, h, id);
      const parents = await parentsOf(ctx, id);
      if (parents.length > 1) refuse(ctx, 'merge_commit', 'the commit has ' + parents.length + ' parents', { ids: [id] });
      await refuseProtected(ctx, id);
      if (id === h.id) {
        await asJob(ctx, 'Amending', () => withMessage(ctx, p.message, (file) => ctx.git(['commit', '--amend', '--only', '--allow-empty', '-F', file])));
        const after = (await headState(ctx)).id;
        return { result: 'reworded', id: after, before: h.id, after, branch: h.branch, conflicts: [] };
      }
      const rows = await rangeRows(ctx, parents[0] || null, h.id);
      const entries = rows.map((r) => (r.id === id ? { id: r.id, action: 'reword', message: p.message } : { id: r.id, action: 'pick', message: null }));
      const x = await applyPlan(ctx, h, parents[0] || null, entries, { allowPushed: true });
      const res = planResult(x, 'reworded');
      if (res.result === 'reworded') {
        const now = await revList(ctx, ['--reverse', '--end-of-options', parents[0] ? parents[0] + '..' + x.after : x.after]);
        res.id = now[rows.findIndex((r) => r.id === id)] || null;
      }
      return res;
    },
  },
  {
    name: 'commit.drop', repo: true, mutating: true, params: { ids: { type: 'oids', maxItems: 10000 } },
    async handler(ctx, p) {
      if (!p.ids.length) ctx.fail('invalid_params', 'no commits given', { param: 'ids', reason: 'must not be empty' });
      const h = await prepare(ctx, 'drop commits');
      const ids = [];
      for (const x of p.ids) ids.push(await commitId(ctx, x, 'ids'));
      for (const id of ids) await inHead(ctx, h, id);
      const depth = [];
      for (const id of ids) depth.push(Number((await ctx.git(['rev-list', '--count', '--end-of-options', id + '..' + h.id])).stdout.trim()));
      const oldest = ids[depth.indexOf(Math.max(...depth))];
      const parents = await parentsOf(ctx, oldest);
      for (const id of ids) if ((await parentsOf(ctx, id)).length > 1) refuse(ctx, 'merge_commit', 'merge commits cannot be dropped', { ids: [id] });
      await refuseProtected(ctx, oldest);
      const base = parents[0] || null;
      const rows = await rangeRows(ctx, base, h.id);
      const entries = rows.map((r) => ({ id: r.id, action: ids.includes(r.id) ? 'drop' : 'pick', message: null }));
      const res = planResult(await applyPlan(ctx, h, base, entries, { allowPushed: true }), 'dropped');
      res.count = new Set(ids).size;
      return res;
    },
  },
  {
    name: 'commit.undo', repo: true, mutating: true, params: { id: 'rev?' },
    async handler(ctx, p) {
      const h = await prepare(ctx, 'undo the commit');
      if (p.id && (await commitId(ctx, p.id)) !== h.id) refuse(ctx, 'not_last_commit', 'the selected commit is not the last in the current branch', { head: h.id });
      const parents = await parentsOf(ctx, h.id);
      if (!parents.length) refuse(ctx, 'root_commit', 'the first commit of the repository cannot be undone', { id: h.id });
      if (parents.length > 1) refuse(ctx, 'merge_commit', 'the commit has ' + parents.length + ' parents', { ids: [h.id] });
      await refuseProtected(ctx, h.id);
      const pushed = (await ctx.git(['for-each-ref', '--count=1', '--contains', h.id, 'refs/remotes'])).stdout.trim() !== '';
      const message = (await ctx.git(['log', '-1', '--format=%B', '--end-of-options', h.id])).stdout.replace(/\s+$/, '');
      const files = await pathsBetween(ctx, parents[0], h.id);
      await ctx.git(['reset', '--soft', '--end-of-options', parents[0], '--']);
      return { result: 'undone', id: h.id, head: parents[0], branch: h.branch, message, files, pushed };
    },
  },
  {
    name: 'changes.applyFromCommit', repo: true, mutating: true, params: { id: 'rev', paths: 'paths' },
    async handler(ctx, p) {
      const id = await commitId(ctx, p.id);
      const parents = await parentsOf(ctx, id);
      const parent = parents[0] || null;
      const changes = await changesAgainst(ctx, parent, id);
      const selected = changes.filter((c) => p.paths.includes(c.path) || (c.oldPath && p.paths.includes(c.oldPath)));
      const base = { id, paths: selected.map((c) => c.path), conflicts: [], trash: null };
      if (!selected.length) return { result: 'nothing', ...base };
      const touched = Array.from(new Set(selected.flatMap((c) => (c.oldPath ? [c.oldPath, c.path] : [c.path]))));
      const diffArgs = ['diff-tree', '-p', '--binary', '--full-index', '--no-commit-id', '--no-color', '--no-ext-diff', '-M'];
      diffArgs.push(...(parent ? ['--end-of-options', parent, id] : ['--root', '--end-of-options', id]), '--', ...touched);
      const patch = (await ctx.git(diffArgs, { encoding: 'buffer' })).stdout;
      if (!patch.length) return { result: 'nothing', ...base };
      const status = await readStatus(ctx);
      const dirty = touched.filter((x) => status.changes.has(x) && status.changes.get(x).status !== '?');
      // the files change in place (a local edit of another line stays, but its bytes are no longer the file's): what
      // they hold now is saved first; an entry for a patch that did not apply is not kept
      const onDisk = (rel) => { try { fs.lstatSync(workPath(ctx.repo, rel)); return true; } catch { return false; } };
      const saved = trash(ctx, touched.filter(onDisk), 'changes.applyFromCommit', { blockers: false });
      const plain = await tryGit(ctx, ['apply', '--whitespace=nowarn', '-'], { input: patch });
      if (plain.exitCode === 0) {
        const added = selected.filter((c) => c.status === 'A' || c.status === 'R').map((c) => c.path);
        if (added.length) await ctx.git(['add', '--force', '--', ...added]);
        return { result: 'applied', ...base, trash: saved };
      }
      if (dirty.length) { settleTrash(ctx, saved); refuse(ctx, 'does_not_apply', 'the changes do not apply over the local changes', { paths: dirty, stderr: plain.stderr }); }
      const three = await tryGit(ctx, ['apply', '--3way', '--whitespace=nowarn', '-'], { input: patch });
      const u = await unmerged(ctx);
      if (u.size) return { result: 'conflicts', ...base, conflicts: Array.from(u.keys()), trash: saved };
      if (three.exitCode !== 0) throw failedAfterSaving(ctx, saved, three.fail());
      return { result: 'applied', ...base, trash: saved };
    },
  },
];
