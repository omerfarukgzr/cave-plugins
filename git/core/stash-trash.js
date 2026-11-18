// Dropped stashes are trash entries (docs/ARCHITECTURE.md §3.5, docs/spec-stash.md "Engine design").
//
// A stash belongs to the repository (refs/stash and its reflog live in the COMMON dir, every worktree sees the same
// list), so its trash entry does too: <common dir>/<dataDir>/stash-trash/<id>/manifest.json, found by the panel of
// every worktree (trash.restore looks here when the worktree's own trash has no such entry). The entry names the
// stashes; each stash commit is kept reachable by a ref of its own, refs/<dataDir>/stash-trash/<id>/<n>, made BEFORE
// the stash is dropped (a dropped stash commit is unreachable at once, and git gc may prune it the same day when its
// objects are older than gc.pruneExpire). Entries are kept like the work tree trash: 14 days, at most 30; their refs go
// with them. Restore puts each stash back with `git stash store` (oldest first, so their order stays as it was).
//
// Layout:  <commonDir>/<dataDir>/stash-trash/<id>/manifest.json
//            { id, time, op, files: [], stashes: [{ id, subject, ref (the keeping ref) }] }   (top of the list first)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './repo.js';
import { EngineError } from './errors.js';
import { TRASH_KEEP, TRASH_MAX_AGE_MS } from './trash.js';

const ID_RE = /^[0-9a-z]{6,16}-[0-9a-f]{8}$/;
const OID_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

export const stashTrashRoot = (repo) => path.join(repo.commonDir, dataDir(repo), 'stash-trash');
export const stashTrashRefs = (repo) => 'refs/' + dataDir(repo) + '/stash-trash/';
const manifestFile = (repo, id) => path.join(stashTrashRoot(repo), id, 'manifest.json');

export function readStashTrash(repo, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  try { return JSON.parse(fs.readFileSync(manifestFile(repo, id), 'utf8')); } catch { return null; }
}

/** The result shape of an entry (as the work tree trash's, plus the stash ids). */
export const stashTrashSummary = (m) => ({ id: m.id, files: [], trees: [], stashes: m.stashes.map((s) => s.id) });

/**
 * Makes an entry for `stashes` ([{ id, subject }], top first): one ref per stash, then the manifest. Any failure
 * removes what was made and throws: the caller drops nothing then. Returns the manifest.
 */
export async function saveStashTrash(ctx, stashes, op, now = Date.now()) {
  const repo = ctx.repo;
  if (!stashes.length) return null;
  for (const s of stashes) if (!OID_RE.test(s.id)) throw new EngineError('internal', 'not a stash id: ' + s.id);
  const id = now.toString(36) + '-' + crypto.randomBytes(4).toString('hex');
  const base = stashTrashRefs(repo) + id + '/';
  const made = [];
  try {
    for (let n = 0; n < stashes.length; n++) {
      // create only: an existing ref of that name is an error, never overwritten
      await ctx.git(['update-ref', base + n, stashes[n].id, '']);
      made.push({ ref: base + n, id: stashes[n].id });
    }
    const m = { id, time: now, op: op || null, files: [], stashes: stashes.map((s, n) => ({ id: s.id, subject: s.subject || '', ref: base + n })) };
    fs.mkdirSync(path.dirname(manifestFile(repo, id)), { recursive: true });
    fs.writeFileSync(manifestFile(repo, id), JSON.stringify(m, null, 1) + '\n');
    return m;
  } catch (e) {
    for (const r of made) await ctx.git(['update-ref', '-d', r.ref, r.id], { okCodes: [0, 1, 128] });
    fs.rmSync(path.join(stashTrashRoot(repo), id), { recursive: true, force: true });
    throw e;
  }
}

/** Removes an entry and its refs (the stash was not dropped after all). */
export async function dropStashTrash(ctx, m) {
  if (!m) return;
  for (const s of m.stashes) await ctx.git(['update-ref', '-d', s.ref, s.id], { okCodes: [0, 1, 128] });
  fs.rmSync(path.join(stashTrashRoot(ctx.repo), m.id), { recursive: true, force: true });
}

/**
 * Drops entries older than 14 days and all but the newest 30, with their refs, and refs whose entry is gone (an entry
 * folder removed by hand, a crash between ref and manifest).
 */
export async function pruneStashTrash(ctx, now = Date.now()) {
  const repo = ctx.repo;
  let names = [];
  try { names = fs.readdirSync(stashTrashRoot(repo)).filter((n) => ID_RE.test(n)); } catch { /* none yet */ }
  const entries = names.map((n) => readStashTrash(repo, n) || { id: n, time: 0, stashes: [] }).sort((a, b) => b.time - a.time);
  const keep = new Set();
  entries.forEach((e, i) => {
    if (i < TRASH_KEEP && now - e.time <= TRASH_MAX_AGE_MS) keep.add(e.id);
    else fs.rmSync(path.join(stashTrashRoot(repo), e.id), { recursive: true, force: true });
  });
  const pruned = new Set(entries.filter((e) => !keep.has(e.id)).map((e) => e.id));
  const refs = await ctx.git(['for-each-ref', '--format=%(refname) %(objectname)', stashTrashRefs(repo)]);
  for (const line of refs.stdout.split('\n')) {
    if (!line) continue;
    const [ref, oid] = line.split(' ');
    const entry = ref.slice(stashTrashRefs(repo).length).split('/')[0];
    if (keep.has(entry)) continue;
    // a ref whose entry was pruned just now goes; an ORPHAN (no entry folder) only when it is older than an hour: another
    // engine on this repository may be between "ref made" and "manifest written" (saveStashTrash). An id whose time
    // cannot be read is kept.
    if (!pruned.has(entry)) {
      const born = entryTime(entry);
      if (born === null || now - born < ORPHAN_GRACE_MS) continue;
    }
    await ctx.git(['update-ref', '-d', ref, oid], { okCodes: [0, 1, 128] });
  }
}

const ORPHAN_GRACE_MS = 3600 * 1000;
/** The time an entry id was made (its base-36 prefix), or null. */
export function entryTime(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  const n = parseInt(id.split('-')[0], 36);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Puts the stashes of entry `id` back into the stash list (oldest first; one that is listed again is skipped; one whose
 * commit is gone is `blocked: gone`). `listed`: the ids in the stash list now. Returns { stashes (restored), skipped,
 * blocked } or null when there is no such entry. The entry stays (like a work tree trash entry).
 */
export async function restoreStashTrash(ctx, id, listed) {
  const m = readStashTrash(ctx.repo, id);
  if (!m) return null;
  const restored = [];
  const skipped = [];
  const blocked = [];
  const there = new Set(listed);
  for (const s of m.stashes.slice().reverse()) {
    if (there.has(s.id)) { skipped.push(s.id); continue; }
    const ok = (await ctx.git(['cat-file', '-e', s.id + '^{commit}'], { okCodes: [0, 1, 128] })).exitCode === 0;
    if (!ok) { blocked.push({ stash: s.id, reason: 'gone' }); continue; }
    const subject = String(s.subject || '').replace(/[\0\r\n]+/g, ' ').trim() || 'restored stash';
    await ctx.git(['stash', 'store', '-q', '-m', subject, s.id], { env: { GIT_LITERAL_PATHSPECS: '0' } });   // see stash-core.js STASH_OPTS
    restored.push(s.id);
    there.add(s.id);
  }
  return { stashes: restored, skipped, blocked };
}
