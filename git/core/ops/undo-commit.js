// Taking back a commit an operation made on the way. commit.fixup commits the chosen local changes and then folds
// that commit into its target with a rebase; when the rebase does not happen (refused, cancelled) or is aborted, HEAD,
// the index and the work tree must be exactly what they were before the command: the commit is taken back
// (`reset --soft`) and the index file from before it is put back, so the changes are uncommitted again and what was
// staged, unstaged or untracked is as it was.
//
// While the rebase is stopped the record lives beside its plan (<gitDir>/<dataDir>/rebase/undo.json, removed with the
// folder when the rebase ends): op.abort reads it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { headState, unmerged, removeQuietly } from './util.js';
import { dataDir } from '../repo.js';

const rebaseDir = (ctx) => path.join(ctx.repo.gitDir, dataDir(ctx.repo), 'rebase');

/** A copy of the index file as it is now (null when there is none). */
export function keepIndex(ctx) {
  const index = path.join(ctx.repo.gitDir, 'index');
  if (!fs.existsSync(index)) return null;
  const dir = path.join(ctx.repo.gitDir, dataDir(ctx.repo), 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  const copy = path.join(dir, 'index-' + crypto.randomBytes(6).toString('hex'));
  fs.copyFileSync(index, copy);
  return copy;
}

/** Keeps the record for op.abort while the rebase is stopped: { before, commit, branch, index }. */
export function recordUndo(ctx, rec) {
  const dir = rebaseDir(ctx);
  fs.mkdirSync(dir, { recursive: true });
  let index = null;
  if (rec.index && fs.existsSync(rec.index)) { index = path.join(dir, 'undo-index'); fs.renameSync(rec.index, index); }
  fs.writeFileSync(path.join(dir, 'undo.json'), JSON.stringify({ before: rec.before, commit: rec.commit, branch: rec.branch, index }) + '\n');
}

export function readUndo(ctx) {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(rebaseDir(ctx), 'undo.json'), 'utf8'));
    return rec && typeof rec.before === 'string' && typeof rec.commit === 'string' ? rec : null;
  } catch { return null; }
}

/**
 * Takes the commit back when HEAD is exactly that commit (on the branch it was made on): HEAD goes to `rec.before`
 * without touching the work tree, and the index file from before the commit comes back (written the way git writes
 * it: `index.lock`, then a rename). Returns true when it did.
 */
export async function takeBackCommit(ctx, rec) {
  const h = await headState(ctx);
  if (!rec || h.id !== rec.commit || (rec.branch || null) !== (h.branch || null)) { if (rec) removeQuietly(rec.index); return false; }
  await ctx.git(['reset', '--soft', '--end-of-options', rec.before, '--']);
  if (rec.index && fs.existsSync(rec.index) && !(await unmerged(ctx)).size) {
    const lock = path.join(ctx.repo.gitDir, 'index.lock');
    let mine = false;
    try {
      fs.writeFileSync(lock, fs.readFileSync(rec.index), { flag: 'wx' });
      mine = true;
      fs.renameSync(lock, path.join(ctx.repo.gitDir, 'index'));
    } catch {
      // another git holds the index: the reset alone stands (the changes are then staged); a lock of ours goes
      if (mine) removeQuietly(lock);
    }
    await ctx.git(['update-index', '-q', '--refresh'], { okCodes: [0, 1] });
  }
  if (rec.index) removeQuietly(rec.index);
  return true;
}
