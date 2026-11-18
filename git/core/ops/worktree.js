// Working tree group: changes.commit, changes.rollback, changes.add, changes.unversion, changes.delete, trash.restore, files.list.
// IntelliJ's model without staging (docs/ARCHITECTURE.md §3.6): a change is HEAD against the work tree.
import fs from 'node:fs';
import path from 'node:path';
import { workPath } from '../repo.js';
import { restoreTrash, trashRoot } from '../trash.js';
import { readStashTrash, restoreStashTrash } from '../stash-trash.js';
import { readStashList } from '../read/stash.js';

const hasWorktreeTrash = (repo, id) => fs.existsSync(path.join(trashRoot(repo), id, 'manifest.json'));
import { lstat } from '../fsname.js';
import {
  refuse, headState, currentOp, unmerged, readStatus, withMessage, checkMessage, tryGit, pathInput, PATHS_FROM_STDIN, trash,
  asJob, failedAfterSaving, isCancel, lateCancel,
} from './util.js';
import { stashTop, stashOutcome } from './autostash.js';
import { readTracked } from './guard.js';

const FILES_CAP = 200000;

/** Change entries for the requested paths (a rename is found by either of its paths). */
function pick(status, paths) {
  const byOld = new Map();
  for (const c of status.changes.values()) if (c.status === 'R') byOld.set(c.oldPath, c);
  const found = [];
  const missing = [];
  const seen = new Set();
  for (const p of paths) {
    const c = status.changes.get(p) || byOld.get(p);
    if (!c) { missing.push(p); continue; }
    if (seen.has(c.path)) continue;
    seen.add(c.path);
    found.push(c);
  }
  return { found, missing };
}

async function unstage(ctx, paths) {
  if (!paths.length) return;
  await ctx.git(['rm', '--cached', '--force', '--quiet', '-r', '--ignore-unmatch', ...PATHS_FROM_STDIN], { input: pathInput(paths) });
}

function exists(ctx, rel) {
  try { fs.lstatSync(workPath(ctx.repo, rel)); return true; } catch { return false; }
}

function removeFromDisk(ctx, rel) {
  try {
    fs.rmSync(workPath(ctx.repo, rel), { recursive: true, force: true });
  } catch (e) {
    // gone already: its folder is a file now (a restored file took the folder's place)
    if (e.code !== 'ENOTDIR' && e.code !== 'ENOENT') throw e;
  }
}

async function commitMerge(ctx, p) {
  if (p.amend) refuse(ctx, 'op_in_progress', 'cannot amend while a merge is in progress', { type: 'merge' });
  if (p.paths.length) await ctx.git(['add', '-A', ...PATHS_FROM_STDIN], { input: pathInput(p.paths) });
  // a Smart merge's autostash (MERGE_AUTOSTASH) is applied by git when the merge is committed
  const pre = { dirty: fs.existsSync(path.join(ctx.repo.gitDir, 'MERGE_AUTOSTASH')), stash: await stashTop(ctx) };
  const before = await headState(ctx);
  try {
    await asJob(ctx, 'Committing', () => withMessage(ctx, p.message, (file) => ctx.git(['commit', '-F', file])));
  } catch (e) {
    if (!(isCancel(e) && (await headState(ctx)).id !== before.id)) throw e;   // (the merge commit exists: only a hook after it was ended)
  }
  const h = await headState(ctx);
  const a = await stashOutcome(ctx, pre, false);
  return {
    result: 'committed', id: h.id, subject: await recordedSubject(ctx), amended: false, merge: true, branch: h.branch, files: p.paths,
    autostash: a.autostash, conflicts: a.conflicts,
  };
}

/** The subject git recorded (a commit-msg hook may have rewritten the message). */
async function recordedSubject(ctx) {
  return (await ctx.git(['log', '-1', '--format=%s', 'HEAD', '--'])).stdout.replace(/\n$/, '');
}

export default [
  {
    name: 'changes.commit', repo: true, mutating: true,
    params: { paths: { type: 'paths', default: () => [] }, message: 'string', amend: 'bool?', expectHead: 'oid?' },
    async handler(ctx, p) {
      checkMessage(ctx, p.message);
      const h = await headState(ctx);
      // Amend what the user saw: HEAD must still be the commit the dialog was opened for.
      if (p.expectHead && (!h.id || !h.id.startsWith(p.expectHead))) refuse(ctx, 'head_moved', 'HEAD moved since the commit was chosen', { head: h.id });
      const op = await currentOp(ctx);
      // A rebase stopped to edit a commit (IntelliJ's Stop to Edit) takes commits: amend the stopped commit or add one.
      const editStop = op && op.type === 'rebase' && op.rebase && op.rebase.action === 'edit';
      if (op && op.type !== 'merge' && !editStop) {
        refuse(ctx, 'op_in_progress', 'finish the ' + op.type + ' with op.continue', { type: op.type });
      }
      const u = await unmerged(ctx);
      if (u.size) refuse(ctx, 'unresolved_conflicts', 'resolve the conflicts first', { paths: Array.from(u.keys()) });
      if (op && op.type === 'merge') return commitMerge(ctx, p);
      if (p.amend && h.unborn) refuse(ctx, 'nothing_to_amend', 'there is no commit to amend');
      const status = await readStatus(ctx);
      const { found } = pick(status, p.paths);
      if (!found.length && !p.amend) refuse(ctx, 'nothing_to_commit', 'none of the paths has a change to commit', { paths: p.paths });
      const untracked = found.filter((c) => c.status === '?').map((c) => c.path);
      const paths = [];
      for (const c of found) { if (c.status === 'R') paths.push(c.oldPath); paths.push(c.path); }
      if (untracked.length) await ctx.git(['add', '--force', ...PATHS_FROM_STDIN], { input: pathInput(untracked) });
      const args = ['commit', '--only', '-F', null];
      if (p.amend) args.push('--amend');
      if (paths.length) args.push(...PATHS_FROM_STDIN);
      let r;
      try {
        // a cancellable job: a hook that hangs (pre-commit, commit-msg…) is ended with git's whole process group
        r = await asJob(ctx, p.amend ? 'Amending' : 'Committing', () => withMessage(ctx, p.message, (file) => { args[3] = file; return tryGit(ctx, args, paths.length ? { input: pathInput(paths) } : {}); }));
      } catch (e) {
        // cancelled after the commit was made (a post-commit hook was ended): it is a commit, and its files stay added
        if (isCancel(e) && (await headState(ctx)).id !== h.id) r = lateCancel();
        else {
          if (untracked.length) await unstage(ctx, untracked).catch(() => {}); // cancelled or killed: unversioned again
          throw e;
        }
      }
      if (r.exitCode !== 0) {
        if (untracked.length) await unstage(ctx, untracked); // they go back to being unversioned
        throw r.fail();
      }
      const after = await headState(ctx);
      return { result: 'committed', id: after.id, subject: await recordedSubject(ctx), amended: !!p.amend, merge: false, branch: after.branch, files: found.map((c) => c.path) };
    },
  },
  {
    name: 'changes.rollback', repo: true, mutating: true,
    params: { paths: 'paths', deleteAdded: 'bool?' },
    async handler(ctx, p) {
      const status = await readStatus(ctx);
      const { found, missing } = pick(status, p.paths);
      const restore = [];
      const remove = [];
      const unstaged = [];
      const unversioned = [];
      const skipped = missing.slice();
      const submodules = [];
      for (const c of found) {
        // A submodule whose checkout moved: git restore puts its index entry back but never touches the submodule's
        // own work tree, so its files are not saved; whether anything changed is read back below.
        if (c.kind === 'gitlink' && c.status === 'M') { restore.push(c.path); submodules.push(c.path); }
        else if (c.status === 'M' || c.status === 'D') restore.push(c.path);
        else if (c.status === 'R') { restore.push(c.oldPath); unstaged.push(c.path); remove.push(c.path); }
        else if (c.status === 'A') { unstaged.push(c.path); if (p.deleteAdded) remove.push(c.path); else unversioned.push(c.path); }
        else if (c.status === '?') { if (p.deleteAdded) remove.push(c.path); else skipped.push(c.path); }
      }
      // Saved first: what changes (and a file standing where a restored folder goes), what is removed (a repository in
      // a removed folder is moved into the trash whole, .git included).
      const saved = trash(ctx, restore.filter((x) => !submodules.includes(x)).concat(remove), 'changes.rollback', { take: remove });
      try {
        if (restore.length) {
          await ctx.git(['restore', '--source=HEAD', '--staged', '--worktree', ...PATHS_FROM_STDIN], { input: pathInput(restore) });
        }
        await unstage(ctx, unstaged);
        remove.forEach((x) => removeFromDisk(ctx, x));
      } catch (e) {
        // nothing was thrown away: the entry goes (taken trees go back); git failed half way: the error carries it
        throw failedAfterSaving(ctx, saved, e);
      }
      let restored = restore;
      if (submodules.length) {
        const now = await readStatus(ctx);
        const still = submodules.filter((x) => now.changes.has(x));
        restored = restore.filter((x) => !still.includes(x));
        skipped.push(...still);
      }
      return { result: 'rolled-back', paths: found.map((c) => c.path), restored, deleted: remove, unversioned, skipped, trash: saved };
    },
  },
  {
    name: 'changes.add', repo: true, mutating: true, params: { paths: 'paths' },
    async handler(ctx, p) {
      if (!p.paths.length) return { result: 'added', paths: [] };
      await ctx.git(['add', '--ignore-errors', '-A', '--force', ...PATHS_FROM_STDIN], { input: pathInput(p.paths) });
      return { result: 'added', paths: p.paths };
    },
  },
  {
    // The Commit view's drag from Changes onto Unversioned Files: an added file (in the index, not in HEAD) leaves the
    // index and stays on disk as it is (`git rm --cached`). Only the index changes: a path that is anything but an
    // added file now (a snapshot the UI read before a commit, a modified tracked file) is skipped, never rolled back.
    name: 'changes.unversion', repo: true, mutating: true, params: { paths: 'paths' },
    async handler(ctx, p) {
      const status = await readStatus(ctx);
      const added = [];
      const skipped = [];
      for (const x of p.paths) {
        const c = status.changes.get(x);
        if (c && c.status === 'A') added.push(x); else skipped.push(x);
      }
      await unstage(ctx, added);
      return { result: 'unversioned', paths: added, skipped };
    },
  },
  {
    name: 'changes.delete', repo: true, mutating: true, params: { paths: 'paths' },
    async handler(ctx, p) {
      const status = await readStatus(ctx);
      const present = p.paths.filter((x) => exists(ctx, x));
      const skipped = p.paths.filter((x) => !present.includes(x));
      // a nested repository or a submodule's checkout among them is moved into the trash whole (.git included); a FIFO,
      // socket or device the user deletes holds nothing to keep (it is deleted, the trash does not list it)
      const saved = trash(ctx, present, 'changes.delete', { take: present, blockers: false, special: 'skip' });
      try { present.forEach((x) => removeFromDisk(ctx, x)); } catch (e) { throw failedAfterSaving(ctx, saved, e); }
      // Added files (in the index, not in HEAD) disappear completely; tracked ones become deleted changes.
      const added = Array.from(status.changes.values()).filter((c) => c.status === 'A' &&
        present.some((x) => c.path === x || c.path.startsWith(x + '/'))).map((c) => c.path);
      await unstage(ctx, added);
      return { result: 'deleted', deleted: present, skipped, trash: saved };
    },
  },
  {
    name: 'trash.restore', repo: true, mutating: true, params: { id: 'string' },
    async handler(ctx, p) {
      // What is in the way of a saved path and is content git tracks (what the operation that made the entry put
      // there) is replaced, after being saved in the entry this returns; anything else blocks (core/trash.js).
      // A dropped stash's entry lives in the common dir (core/stash-trash.js): any worktree's panel can restore it.
      const stashEntry = readStashTrash(ctx.repo, p.id);
      if (stashEntry && !hasWorktreeTrash(ctx.repo, p.id)) {
        const listed = (await readStashList(ctx)).map((s) => s.id);
        const back = await restoreStashTrash(ctx, p.id, listed);
        return { result: 'restored', id: p.id, files: [], skipped: [], blocked: back.blocked, replaced: [], complete: !back.blocked.length,
          trash: null, stashes: back.stashes, stashesSkipped: back.skipped };
      }
      const index = await readTracked(ctx);
      const tracked = (rel, isFolder) => { const st = lstat(path.join(ctx.repo.root, rel)); return !!st && (isFolder ? index.folder(rel, st) : index.file(rel, st)); };
      return { result: 'restored', ...restoreTrash(ctx.repo, p.id, { tracked }) };
    },
  },
  {
    name: 'files.list', repo: true, mutating: false, params: {},
    async handler(ctx) {
      const [cached, others, deleted] = await Promise.all([
        ctx.git(['ls-files', '-z', '--cached']),
        ctx.git(['ls-files', '-z', '--others', '--exclude-standard']),
        ctx.git(['ls-files', '-z', '--deleted']),
      ]);
      const gone = new Set(deleted.stdout.split('\0').filter(Boolean));
      const untrackedSet = new Set(others.stdout.split('\0').filter(Boolean));
      const all = Array.from(new Set(cached.stdout.split('\0').filter((x) => x && !gone.has(x)).concat(Array.from(untrackedSet)))).sort();
      const truncated = all.length > FILES_CAP;
      if (truncated) all.length = FILES_CAP;
      const dirs = [];
      const dirIndex = new Map();
      const files = [];
      const untracked = [];
      all.forEach((f, i) => {
        const slash = f.lastIndexOf('/');
        const dir = slash < 0 ? '' : f.slice(0, slash);
        let d = dirIndex.get(dir);
        if (d === undefined) { d = dirs.length; dirs.push(dir); dirIndex.set(dir, d); }
        files.push(d, f.slice(slash + 1));
        if (untrackedSet.has(f)) untracked.push(i);
      });
      return { dirs, files, untracked, count: all.length, truncated };
    },
  },
];
