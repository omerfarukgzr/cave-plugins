// The safety net for discarded work tree content (docs/ARCHITECTURE.md §3.5).
//
// Before an operation throws work tree content away (rollback, delete, reset --hard/--keep, abort, force checkout,
// accepting a conflict side, skip, unresolve), it calls saveTrash() with the paths that will change or disappear. The
// current bytes of every existing file among them are copied to <git dir>/<dataDir>/trash/<id>/ with a manifest, and the
// operation's result carries `trash: { id, files, trees }`. restoreTrash() writes them back (first saving what it
// overwrites or replaces, so a restore can be undone the same way). Entries are kept 14 days, at most 30.
//
// What is saved for a listed path (what is "there" is asked of the file system with lstat, so a name that differs
// only by case or Unicode normalization on a disk that treats them as one is found, and saved under the name the disk
// has):
//   - a file or symlink: its bytes (a symlink as its target);
//   - a folder: every file below it; a folder below it that holds a repository of its own (a `.git` folder or file: a
//     nested repository, a submodule's checkout) is kept WHOLE as a tree, `.git` included. When the operation removes
//     that folder anyway (`take`), the tree is moved into the trash (a rename on the same file system, a copy across
//     devices), otherwise it is copied;
//   - a file (or symlink) that stands where the path needs a parent folder (`conf` when `conf/a.txt` comes back), unless
//     `blockers: false`: git removes it to make room.
// A FIFO, socket or device among them holds nothing that could be kept: the operation is refused (`special_file`)
// before anything is saved or changed, unless the caller removes exactly that path on purpose (`special: 'skip'`). An
// entry never lists nothing: saveTrash returns null then.
// A tree entry that holds a whole repository expires with the entry (30 entries / 14 days) like any other content: the
// user deleted it on purpose, and Restore was offered.
//
// Layout:  <gitDir>/<dataDir>/trash/<id>/manifest.json
//            { id, time, op, files: [{ path, kind: 'file'|'symlink'|'tree', mode?, target?, blob?, moved?, restored? }] }
//          <gitDir>/<dataDir>/trash/<id>/<n>             the bytes of the n-th file (kind 'file') or the n-th tree
// Blobs are stored by number, so any path (newlines, quotes, any UTF-8) is safe.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EngineError } from './errors.js';
import { isInside, dataDir } from './repo.js';
import { lstat, realRel, shownName } from './fsname.js';

export const TRASH_KEEP = 30;
export const TRASH_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
const ID_RE = /^[0-9a-z]{6,16}-[0-9a-f]{8}$/;

export function trashRoot(repo) { return path.join(repo.gitDir, dataDir(repo), 'trash'); }

const holdsRepository = (abs) => !!lstat(path.join(abs, '.git'));
const clean = (rel) => (typeof rel === 'string' ? rel.replace(/\/+$/, '') : '');
const kindOf = (st) => (st.isSymbolicLink() ? 'symlink' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'special');

/** Entries at or below `rel` under the names the disk has: { rel, tree, kind } (a folder holding a repository is one tree). */
function expand(repo, rel, out) {
  const st = lstat(path.join(repo.root, rel));
  if (!st) return;
  const visit = (r, s) => {
    const abs = path.join(repo.root, r);
    if (!s.isDirectory()) { out.push({ rel: r, tree: false, kind: kindOf(s) }); return; }
    if (holdsRepository(abs)) { out.push({ rel: r, tree: true, kind: 'tree' }); return; }
    for (const name of fs.readdirSync(abs).sort()) { const c = lstat(path.join(abs, name)); if (c) visit(r + '/' + name, c); }
  };
  visit(realRel(repo.root, rel), st);
}

/** The nearest parent folder of `rel` that is a file, symlink or special file on disk (git removes it to bring the folder back). */
function blockerOf(repo, rel) {
  const parts = rel.split('/');
  for (let i = 1; i < parts.length; i++) {
    const a = parts.slice(0, i).join('/');
    const st = lstat(path.join(repo.root, a));
    if (!st) return null;
    if (!st.isDirectory()) return { rel: realRel(repo.root, a), tree: false, kind: kindOf(st) };
  }
  return null;
}

/** Moves a folder (rename; copy + remove across devices). */
function moveTree(from, to) {
  try { fs.renameSync(from, to); return; } catch (e) { if (e.code !== 'EXDEV') throw e; }
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
  fs.rmSync(from, { recursive: true, force: true });
}
const copyTree = (from, to) => fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });

const inside = (rel, roots) => roots.some((r) => rel === r || rel.startsWith(r + '/'));

/**
 * Saves the current content of the existing entries among `paths`. Returns { id, files, trees } or null when none
 * exists. `op` names the operation for the manifest. opts: { take: [paths the operation removes: their repositories
 * are moved, not copied], blockers: false (do not save files standing where a parent folder is needed), special:
 * 'skip' (leave FIFOs, sockets and devices out instead of refusing), now, prune }.
 */
export function saveTrash(repo, paths, op, opts = {}) {
  const now = opts.now || Date.now();
  const take = (opts.take || []).map(clean).filter(Boolean).map((t) => (lstat(path.join(repo.root, t)) ? realRel(repo.root, t) : t));
  const found = [];
  const seen = new Set();
  const add = (e) => { if (!seen.has(e.rel)) { seen.add(e.rel); found.push(e); } };
  for (const raw of paths) {
    const rel = clean(raw);
    if (!rel) continue;
    if (opts.blockers !== false) { const b = blockerOf(repo, rel); if (b) add(b); }
    const below = [];
    expand(repo, rel, below);
    below.forEach(add);
  }
  const special = found.filter((e) => e.kind === 'special');
  if (special.length && opts.special !== 'skip') {
    const names = special.map((e) => shownName(e.rel));
    throw new EngineError('refused', 'a FIFO, socket or device is in the way and cannot be kept: ' + names[0], { reason: 'special_file', paths: names });
  }
  const list = found.filter((e) => e.kind !== 'special');
  if (!list.length) return null;
  const id = now.toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  const dir = path.join(trashRoot(repo), id);
  fs.mkdirSync(dir, { recursive: true });
  const files = [];
  list.forEach((e, n) => {
    const abs = safeAbs(repo, e.rel);
    const st = fs.lstatSync(abs);
    if (e.tree) {
      const moved = inside(e.rel, take);
      if (moved) moveTree(abs, path.join(dir, String(n))); else copyTree(abs, path.join(dir, String(n)));
      files.push({ path: e.rel, kind: 'tree', mode: st.mode & 0o777, blob: String(n), moved });
    } else if (st.isSymbolicLink()) files.push({ path: e.rel, kind: 'symlink', target: fs.readlinkSync(abs) });
    else {
      fs.copyFileSync(abs, path.join(dir, String(n)));
      files.push({ path: e.rel, kind: 'file', mode: st.mode & 0o777, blob: String(n) });
    }
  });
  writeManifest(repo, id, { id, time: now, op: op || null, files });
  if (opts.prune !== false) pruneTrash(repo, now);
  return summary({ id, files });
}

/** An entry as results carry it: names in the form git reports them. */
const summary = (m) => ({ id: m.id, files: m.files.map((f) => shownName(f.path)), trees: m.files.filter((f) => f.kind === 'tree').map((f) => shownName(f.path)) });

/** The absolute path of a manifest path, which must lie inside the work tree and outside every `.git`. */
function safeAbs(repo, rel) {
  const abs = path.join(repo.root, rel);
  if (typeof rel !== 'string' || !rel || !isInside(abs, repo.root) || abs === repo.root || rel.split('/').some((p) => p.toLowerCase() === '.git' || p === '..')) {
    throw new EngineError('invalid_params', 'path escapes the repository', { param: 'path', reason: 'escapes' });
  }
  return abs;
}

function writeManifest(repo, id, m) {
  fs.writeFileSync(path.join(trashRoot(repo), id, 'manifest.json'), JSON.stringify(m, null, 1) + '\n');
}

function readManifest(repo, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new EngineError('invalid_params', 'not a trash id: ' + id, { param: 'id', reason: 'not a trash id' });
  try {
    return JSON.parse(fs.readFileSync(path.join(trashRoot(repo), id, 'manifest.json'), 'utf8'));
  } catch {
    throw new EngineError('not_found', 'no trash entry ' + id, { reason: 'no_trash_entry', id });
  }
}

/** Entries, newest first: [{ id, time, op, files: [path] }]. */
export function listTrash(repo) {
  let names = [];
  try { names = fs.readdirSync(trashRoot(repo)).filter((n) => ID_RE.test(n)); } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(trashRoot(repo), n, 'manifest.json'), 'utf8'));
      out.push({ id: m.id, time: m.time, op: m.op, files: m.files.map((f) => f.path) });
    } catch { out.push({ id: n, time: 0, op: null, files: [] }); }
  }
  return out.sort((a, b) => b.time - a.time || (a.id < b.id ? 1 : -1));
}

/**
 * Removes one entry (an operation that saved content and then did not run). Trees the entry had moved away are put
 * back first, so nothing it took is lost.
 */
export function dropTrash(repo, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return;
  const dir = path.join(trashRoot(repo), id);
  try {
    const m = readManifest(repo, id);
    for (const f of m.files) {
      if (f.kind !== 'tree' || !f.moved || f.restored) continue;
      const abs = path.join(repo.root, f.path);
      if (lstat(abs)) continue;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      moveTree(path.join(dir, f.blob), abs);
    }
  } catch { /* nothing to put back */ }
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * For an operation that saved content and then failed or was refused: the entry goes when everything it holds is
 * still on disk with the same bytes (taken trees are put back), and stays when something differs, because then it is
 * the only copy. Returns true when the entry is gone.
 */
export function dropTrashIfUnchanged(repo, id) {
  let m;
  try { m = readManifest(repo, id); } catch { return true; }
  const dir = path.join(trashRoot(repo), id);
  for (const f of m.files) {
    const abs = path.join(repo.root, f.path);
    const st = lstat(abs);
    if (f.kind === 'tree') {
      if (f.moved && !f.restored ? !!st : !st) return false;   // a taken tree needs its place free; a copied one must still be there
    } else if (!st) return false;
    else if (f.kind === 'symlink') { if (!st.isSymbolicLink() || fs.readlinkSync(abs) !== f.target) return false; }
    else if (!st.isFile() || !fs.readFileSync(abs).equals(fs.readFileSync(path.join(dir, f.blob)))) return false;
  }
  dropTrash(repo, id);
  return true;
}

/** Drops entries older than 14 days and all but the newest 30 (trees with them). */
export function pruneTrash(repo, now = Date.now()) {
  const entries = listTrash(repo);
  entries.forEach((e, i) => {
    if (i >= TRASH_KEEP || now - e.time > TRASH_MAX_AGE_MS) {
      fs.rmSync(path.join(trashRoot(repo), e.id), { recursive: true, force: true });
    }
  });
}

/**
 * What stands where the saved entry `f` goes: [{ by (path, as the disk names it), kind: 'file'|'folder'|'special',
 * reason: 'file' (a file is where its folder goes)|'folder' (a folder is where the file goes)|'exists' (something is
 * where a saved tree goes), same: bool (a file at the very path of a saved file: it is overwritten) }].
 */
function inTheWayOf(repo, f) {
  const b = blockerOf(repo, f.path);
  if (b) return [{ by: b.rel, kind: b.kind === 'special' ? 'special' : 'file', reason: 'file', same: false }];
  const st = lstat(path.join(repo.root, f.path));
  if (!st) return [];
  const by = realRel(repo.root, f.path);
  const kind = st.isDirectory() ? 'folder' : kindOf(st) === 'special' ? 'special' : 'file';
  if (f.kind === 'tree') return [{ by, kind, reason: 'exists', same: false }];
  return [{ by, kind, reason: 'folder', same: kind === 'file' }];
}

/**
 * Writes the files of entry `id` back. Result { id, files: [restored paths], skipped: [paths not written], blocked:
 * [{ path, reason, by }], replaced: [{ path, by, kind: 'file'|'folder' }], complete: bool, trash }.
 *
 * What is in the way of a saved path (inTheWayOf):
 *   - a file at the very path of a saved file is overwritten;
 *   - content git tracks (`opts.tracked(path, isFolder)`: the index has it) — what the operation that made the entry
 *     put there, e.g. the folder it restored where the saved file had stood — is removed, so Restore undoes the
 *     operation for that path (`replaced`);
 *   - what the restore that made this entry wrote (`wrote`, unchanged since) is removed the same way: restoring the
 *     entry a restore returned undoes that restore;
 *   - anything else (content git does not know: the user made it since) blocks the path: reason 'folder' (a folder is
 *     where the file goes), 'file' (a file is where its folder goes), 'exists' (something is where a saved tree goes);
 *     also 'special' (a FIFO, socket or device is in the way) and 'gone' (the tree was restored before).
 * Everything overwritten or removed is saved first in ONE new entry, returned as `trash` (null when nothing existed):
 * nothing is lost on either side, and restoring that entry undoes the restore. A tree is moved back (the entry no
 * longer holds it afterwards); files are copied (the entry keeps them). opts.only: just these paths of the entry.
 */
export function restoreTrash(repo, id, opts = {}) {
  const m = readManifest(repo, id);
  const dir = path.join(trashRoot(repo), id);
  // An entry made by a restore (`wrote`: the paths that restore wrote) undoes it: what that restore put there is
  // removed like content git tracks (it is saved in the new entry), so "restoring that entry undoes the restore" holds
  // also where the restore put back content git does not track (a file where a tracked folder came back).
  // `wrote`: [{ path, tree } | { path, size, mtimeMs }]: a file counts while it is the one written (size and time)
  const wrote = new Map((m.wrote || []).map((w) => [w.path, w]));
  const same = (rel, w) => { if (w.tree) return true; const st = lstat(path.join(repo.root, rel)); return !!st && st.size === w.size && st.mtimeMs === w.mtimeMs; };
  const written = (rel) => (wrote.has(rel) && same(rel, wrote.get(rel))) || Array.from(wrote.values()).some((w) => w.tree && rel.startsWith(w.path + '/'));
  // a folder counts only when everything in it is what that restore wrote (a file made since in it still blocks)
  const putBack = (rel, isFolder) => {
    if (!wrote.size) return false;
    if (!isFolder || written(rel)) return written(rel);
    const inside = [];
    expand(repo, rel, inside);
    return inside.length > 0 && inside.every((e) => written(e.rel));
  };
  const tracked = (rel, isFolder) => putBack(rel, isFolder) || (opts.tracked ? opts.tracked(rel, isFolder) : false);
  m.files.forEach((f) => safeAbs(repo, f.path)); // every path must still be inside the work tree
  const blocked = [];
  const plan = [];
  for (const f of m.files) {
    if (opts.only && !opts.only.includes(f.path)) continue;
    if (f.kind === 'tree' && (f.restored || !lstat(path.join(dir, f.blob)))) { blocked.push({ path: f.path, reason: 'gone', by: null }); continue; }
    const way = inTheWayOf(repo, f);
    const stop = way.find((w) => w.kind === 'special') || way.find((w) => !w.same && !tracked(w.by, w.kind === 'folder'));
    if (stop) blocked.push({ path: f.path, reason: stop.kind === 'special' ? 'special' : stop.reason, by: stop.by });
    else plan.push({ f, way });
  }
  const victims = new Map();
  for (const p of plan) for (const w of p.way) victims.set(w.by, w);
  const removed = Array.from(victims.values()).filter((w) => !w.same);
  const before = victims.size
    ? saveTrash(repo, Array.from(victims.keys()), 'trash.restore', { prune: false, blockers: false, take: removed.filter((w) => w.kind === 'folder').map((w) => w.by) })
    : null;
  const files = [];
  const replaced = [];
  let touched = false;
  try {
    for (const w of removed) fs.rmSync(path.join(repo.root, w.by), { recursive: true, force: true });
    for (const { f, way } of plan) {
      const abs = safeAbs(repo, f.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      if (f.kind === 'tree') {
        moveTree(path.join(dir, f.blob), abs);
        f.restored = true;
        touched = true;
      } else {
        if (lstat(abs)) fs.unlinkSync(abs);
        if (f.kind === 'symlink') fs.symlinkSync(f.target, abs);
        else {
          fs.copyFileSync(path.join(dir, f.blob), abs);
          fs.chmodSync(abs, f.mode);
        }
      }
      files.push(shownName(f.path));
      for (const w of way) if (!w.same) replaced.push({ path: shownName(f.path), by: shownName(w.by), kind: w.kind });
    }
  } catch (e) {
    // the disk refused half way (a read-only folder…): what was already overwritten or removed is in `before`
    if (touched) writeManifest(repo, id, m);
    throw new EngineError('internal', 'restore failed: ' + e.message, { trash: before, files });
  }
  if (touched) writeManifest(repo, id, m);
  if (before) {
    // the new entry remembers what this restore wrote: restoring it takes exactly that out again (see `wrote` above)
    const nm = readManifest(repo, before.id);
    nm.wrote = plan.map(({ f }) => {
      if (f.kind === 'tree') return { path: f.path, tree: true };
      const st = lstat(path.join(repo.root, f.path));
      return { path: f.path, size: st ? st.size : -1, mtimeMs: st ? st.mtimeMs : -1 };
    });
    writeManifest(repo, before.id, nm);
  }
  pruneTrash(repo);
  const shownBlocked = blocked.map((b) => ({ path: shownName(b.path), reason: b.reason, by: b.by === null ? null : shownName(b.by) }));
  return { id, files, skipped: shownBlocked.map((b) => b.path), blocked: shownBlocked, replaced, complete: !blocked.length, trash: before };
}
