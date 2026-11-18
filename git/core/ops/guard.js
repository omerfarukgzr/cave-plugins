// THE WORK TREE GUARD (docs/ARCHITECTURE.md §3.5).
//
// The guarantee: no operation of the engine removes or overwrites a file or folder on disk whose content is not
// recoverable from the object database, the stash it reports, or the trash it returns; and a Would-overwrite or
// refused result changed nothing on disk and nothing in `.git`.
//
// git itself does not give that. Three of its habits destroy content it does not track:
//   1. a stash (every --autostash, `git stash push`, the state a failed merge strategy puts back) records tracked
//      content only and then resets the work tree to HEAD: whatever stands where a changed tracked path goes — a file
//      where its folder was, files in a folder where the file was, a file at a path that is out of the index — is
//      removed, or makes git die half way;
//   2. ignored files are expendable for git: checkout, merge, rebase, cherry-pick and revert overwrite an ignored file
//      (and remove ignored files in a folder) standing where a tracked path arrives;
//   3. names are compared as bytes, the disk compares them its own way (case, Unicode normalization).
//
// So one question is asked before git runs, and it is asked of the FILE SYSTEM (inTheWay): "git is about to write
// these tracked paths; what on disk stands at such a path, above it (a non-folder where a folder is needed) or below
// it (inside a folder standing where the path is a file) that the index does not track?" Whether git calls that
// content untracked or ignored makes no difference: it is the user's bytes. lstat decides what is the same path, so a
// name that differs only by case or normalization is found on a disk that treats them as one, and only there.
//
// Who asks:
//   - the paths a stash rewrites are the changed entries of `git status` (stashWrites);
//   - the paths an operation brings in are read from the trees involved (treeWrites, commitWrites, mergeWrites,
//     rebaseWrites): the "after" side of each difference;
//   - prepareStash (autostash.js) asks both for the operations that stash; checkout, merge, cherry-pick, revert and
//     op.continue / op.skip ask for what they bring in. An answer that is not empty is a Would-overwrite result
//     naming that content, and nothing runs.
// Operations that discard on purpose (rollback, reset --hard, force checkout…) do not ask: they save what stands in
// the way to the trash (core/trash.js finds it with the same lstat walk).
import fs from 'node:fs';
import path from 'node:path';
import { lstat, realRel, shownName, foldName, sameEntry } from '../fsname.js';

const NUL = '\0';
const clean = (rel) => rel.replace(/\/+$/, '');
const ancestorsOf = (p) => { const out = []; let i = p.indexOf('/'); while (i > 0) { out.push(p.slice(0, i)); i = p.indexOf('/', i + 1); } return out; };

/**
 * What the index tracks, asked the way the disk compares names: file(rel, st) — the entry on disk at `rel` is a path
 * of the index; folder(rel, st) — the index has paths inside the folder on disk at `rel`. A spelling the index does
 * not have counts only when it is the same file system entry as a path it has.
 */
export async function readTracked(ctx) {
  const root = ctx.repo.root;
  const files = new Set((await ctx.git(['ls-files', '-z', '--cached'])).stdout.split(NUL).filter(Boolean));
  let folded = null;
  let dirs = null;
  let foldedDirs = null;
  const bucket = (map, key, value) => { const l = map.get(key); if (l) l.push(value); else map.set(key, [value]); };
  return {
    files,
    file(rel, st) {
      if (files.has(rel)) return true;
      if (!folded) { folded = new Map(); for (const f of files) bucket(folded, foldName(f), f); }
      const c = folded.get(foldName(rel));
      return !!c && c.some((q) => sameEntry(lstat(path.join(root, q)), st));
    },
    folder(rel, st) {
      if (!dirs) { dirs = new Set(); for (const f of files) for (const a of ancestorsOf(f)) dirs.add(a); }
      if (dirs.has(rel)) return true;
      if (!foldedDirs) { foldedDirs = new Map(); for (const d of dirs) bucket(foldedDirs, foldName(d), d); }
      const c = foldedDirs.get(foldName(rel));
      return !!c && c.some((q) => sameEntry(lstat(path.join(root, q)), st));
    },
  };
}

/**
 * What on disk stands in the way of writing the tracked paths `writes` ([{ path, gitlink? }]) and is not tracked by the
 * index: [{ path (as results show it; a nested repository as `folder/`), disk (as the disk names it), kind:
 * 'file'|'symlink'|'special'|'repo', of (the written path) }], sorted by path. A FIFO, socket or device counts always
 * (nothing can hold it), a folder with a repository of its own counts whole. `gitlink` paths are submodules: git
 * leaves the folder standing there alone.
 */
export async function inTheWay(ctx, writes) {
  const root = ctx.repo.root;
  const found = new Map();
  const cache = new Map();
  const stat = (rel) => { if (!cache.has(rel)) cache.set(rel, lstat(path.join(root, rel))); return cache.get(rel); };
  let tracked = null;
  const add = async (rel, st, of, real) => {
    const kind = st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : st.isDirectory() ? 'repo' : 'special';
    if (kind === 'file' || kind === 'symlink') {
      if (!tracked) tracked = await readTracked(ctx);
      if (tracked.file(rel, st)) return;
    }
    const disk = real ? rel : realRel(root, rel);
    if (!found.has(disk)) found.set(disk, { path: shownName(disk) + (kind === 'repo' ? '/' : ''), disk, kind, of });
  };
  /** Everything inside the folder `rel` (named as the disk names it) that the index does not track. */
  const below = async (rel, of) => {
    if (lstat(path.join(root, rel, '.git'))) { await add(rel, stat(rel), of, true); return; }
    let names = [];
    try { names = fs.readdirSync(path.join(root, rel)).sort(); } catch {
      // a folder that cannot be read cannot be shown to hold nothing: it counts as in the way itself
      if (!found.has(rel)) found.set(rel, { path: shownName(rel) + '/', disk: rel, kind: 'special', of });
      return;
    }
    for (const name of names) {
      const child = rel + '/' + name;
      const st = stat(child);
      if (!st) continue;
      if (st.isDirectory()) await below(child, of); else await add(child, st, of, true);
    }
  };
  const seen = new Set();
  for (const w of writes) {
    const p = clean(w.path);
    if (!p || seen.has(p)) continue;
    seen.add(p);
    let open = true;                       // every folder of the path exists as a folder
    for (const a of ancestorsOf(p)) {
      const st = stat(a);
      if (!st) { open = false; break; }
      if (!st.isDirectory()) { await add(a, st, p, false); open = false; break; }
    }
    if (!open) continue;
    const st = stat(p);
    if (!st) continue;
    if (!st.isDirectory()) await add(p, st, p, false);
    else if (!w.gitlink) await below(realRel(root, p), p);
  }
  return Array.from(found.values()).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The Would-overwrite shape for content in the way (`untracked` names every path git does not track, ignored ones too), or null. */
export const blockedBy = (hazards) => (hazards && hazards.length ? { files: [], untracked: Array.from(new Set(hazards.map((h) => h.path))).sort() } : null);

/** The paths a stash's reset rewrites: every tracked path whose index or work tree differs from HEAD. */
export function stashWrites(status) {
  const out = [];
  for (const e of status.entries) {
    if (e.type !== '1' && e.type !== '2') continue;
    const gitlink = e.modeHead === '160000';
    out.push({ path: e.path, gitlink });
    if (e.origPath) out.push({ path: e.origPath, gitlink });
  }
  return out;
}

/** Records of `git diff-tree --raw -z`: the side that exists afterwards (`reverse`: the side that existed before). */
function sideOf(stdout, reverse) {
  const tok = stdout.split(NUL);
  const out = [];
  for (let i = 0; i + 1 < tok.length; i++) {
    const m = /^:(\d{6}) (\d{6}) /.exec(tok[i]);
    if (!m) continue;
    const mode = reverse ? m[1] : m[2];
    if (!/^0+$/.test(mode)) out.push({ path: tok[i + 1], gitlink: mode === '160000' });
    i++;
  }
  return out;
}

const RAW = ['diff-tree', '-r', '--raw', '-z', '--no-renames', '--no-ext-diff', '--no-commit-id'];

/** The paths that going from tree `from` to tree `to` writes: everything `to` has that differs from `from`. */
export async function treeWrites(ctx, from, to) {
  if (!to || from === to) return [];
  if (!from) return (await ctx.git(['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', to])).stdout.split(NUL).filter(Boolean)
    .map((rec) => ({ path: rec.slice(rec.indexOf('\t') + 1), gitlink: rec.startsWith('160000') }));
  return sideOf((await ctx.git([...RAW, '--end-of-options', from, to])).stdout, false);
}

/** The paths that applying the commits `ids` writes (each against its first parent); `reverse`: that reverting them writes. */
export async function commitWrites(ctx, ids, reverse = false) {
  if (!ids.length) return [];
  let full = ids;
  if (ids.some((x) => !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(x))) {
    // a todo list writes abbreviated ids; `diff-tree --stdin` reads full ones
    const names = await ctx.git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: ids.map((x) => x + '^{commit}').join('\n') + '\n', okCodes: [0, 128] });
    full = names.stdout.split('\n').map((l) => l.split(' ')).filter((f) => f[1] === 'commit').map((f) => f[0]);
    if (!full.length) return [];
  }
  const out = await ctx.git([...RAW, '--root', '--stdin'], { input: full.join('\n') + '\n' });
  return sideOf(out.stdout, reverse);
}

/** The paths that merging `theirs` into `head` can write: what `theirs` changed since each merge base (all of it without one). */
export async function mergeWrites(ctx, head, theirs) {
  if (!head) return treeWrites(ctx, null, theirs);
  const mb = await ctx.git(['merge-base', '--all', '--end-of-options', head, theirs], { okCodes: [0, 1] });
  const bases = mb.stdout.split('\n').filter(Boolean);
  if (!bases.length) return treeWrites(ctx, null, theirs);
  const out = [];
  for (const b of bases) out.push(...await treeWrites(ctx, b, theirs));
  return out;
}

/**
 * The paths a rebase writes: the checkout of its starting point (`start`: the commit the replay begins on) and what
 * each replayed commit brings. Callers pass as `commits` only the ones git really replays (rebaseStart).
 */
export async function rebaseWrites(ctx, head, start, commits) {
  return (await treeWrites(ctx, head, start)).concat(await commitWrites(ctx, commits));
}

/**
 * Where an interactive rebase of `rows` (the range, oldest first: [{ id, parents }]) onto `onto` starts replaying, for
 * a plan `entries` ([{ id, action, message }]): git fast-forwards over the leading picks that stay what they are (same
 * parent, same order, no new message). Returns { start, commits: [ids replayed] }.
 */
export function rebaseStart(onto, rows, entries) {
  let start = onto;
  let i = 0;
  while (i < entries.length && i < rows.length && entries[i].id === rows[i].id && entries[i].action === 'pick' && entries[i].message == null &&
    rows[i].parents.length === 1 && rows[i].parents[0] === start) { start = rows[i].id; i++; }
  return { start, commits: entries.slice(i).filter((e) => e.action !== 'drop').map((e) => e.id) };
}
