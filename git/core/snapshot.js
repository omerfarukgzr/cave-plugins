// The repository snapshot (docs/ARCHITECTURE.md §5.1, exact shape in docs/PROTOCOL.md `repo.state`): everything cheap
// the UI reads synchronously. Built from a handful of git commands that run concurrently, all as background reads
// (quiet, no optional locks).
//
// Maps keyed by names from the repository (branches, remotes, tags, remoteUrls) get their keys with setName
// (defineProperty), so a branch called `__proto__` is an own key like any other, and are read with hasName, so
// `constructor` or `toString` is never mistaken for a branch.
import fs from 'node:fs';
import path from 'node:path';
import { parseStatusV2, localChange, conflictKind, parseFieldLines, parseTrack, splitNulRecords } from './parse.js';
import { detectOp, pendingMessage } from './op-state.js';
import { dataDir } from './repo.js';

export const LOCAL_CAP = 20000;
const RECENT_CAP = 10;

const REF_FORMAT = '%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(upstream)%00%(upstream:track)%00%(symref)';

/** A map from repository names (a plain object: JSON and deep equality treat it as any other). */
export const nameMap = () => ({});
/** Sets an own key even for `__proto__` (an assignment would change the object's prototype instead). */
export const setName = (map, name, value) => { Object.defineProperty(map, name, { value, enumerable: true, writable: true, configurable: true }); };
export const hasName = (map, name) => Object.prototype.hasOwnProperty.call(map, name);

/** Engine-owned per-repository state (favorites). Lives in the COMMON dir so all worktrees share it. */
export function stateFile(repo) { return path.join(repo.commonDir, dataDir(repo), 'state.json'); }

export function readRepoState(repo) {
  try { return JSON.parse(fs.readFileSync(stateFile(repo), 'utf8')) || {}; } catch { return {}; }
}

/** { branches, remotes, tags } (prototype-free maps); with { replace: true } also `replace` (the refs/replace list). */
export async function readRefs(git, opts = {}) {
  const patterns = ['refs/heads', 'refs/remotes', 'refs/tags', 'refs/stash'];
  if (opts.replace) patterns.push('refs/replace');
  const out = await git(['for-each-ref', '--format=' + REF_FORMAT, ...patterns]);
  const branches = nameMap();
  const remotes = nameMap();
  const tags = nameMap();
  const nested = [];
  let replace = '';
  let stash = null;
  for (const [ref, id, type, peeled, peeledType, upstream, track, symref] of parseFieldLines(out.stdout, 8)) {
    if (ref === 'refs/stash') { stash = id; continue; }
    if (ref.startsWith('refs/heads/')) {
      const name = ref.slice(11);
      const t = parseTrack(track);
      setName(branches, name, { head: id, upstream: upstream ? upstream.replace(/^refs\/(remotes|heads)\//, '') : null, ahead: t.ahead, behind: t.behind, gone: t.gone });
    } else if (ref.startsWith('refs/remotes/')) {
      if (symref) continue; // origin/HEAD -> origin/main is not a branch
      setName(remotes, ref.slice(13), id);
    } else if (ref.startsWith('refs/tags/')) {
      const name = ref.slice(10);
      if (type === 'commit') setName(tags, name, id);
      else if (type === 'tag' && peeledType === 'commit') setName(tags, name, peeled);
      else if (type === 'tag' && peeledType === 'tag') nested.push(name);
      // tags of trees and blobs are not shown in the Log
    } else if (ref.startsWith('refs/replace/')) {
      replace += ref + ' ' + id + '\n';
    }
  }
  if (nested.length) {
    // Tags of tags: peel them all with one cat-file (`<ref>^{commit}`).
    const r = await git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: nested.map((n) => 'refs/tags/' + n + '^{commit}').join('\n') + '\n', okCodes: [0, 128] });
    const rows = r.stdout.split('\n');
    nested.forEach((name, i) => {
      const [id, t] = (rows[i] || '').split(' ');
      if (t === 'commit') setName(tags, name, id);
    });
  }
  // `stash`: the top of the stash list (refs/stash) or null; never part of the Log's heads
  const result = { branches, remotes, tags, stash };
  if (opts.replace) result.replace = replace;
  return result;
}

/** Remote names as `git remote` lists them (with or without a URL) and their fetch URLs as `git remote -v` shows them. */
async function readRemotes(git) {
  const [list, verbose] = await Promise.all([git(['remote']), git(['remote', '-v'])]);
  const names = list.stdout.split('\n').filter(Boolean);
  const urls = nameMap();
  verbose.stdout.split('\n').forEach((l) => {
    // "origin\t<url> (fetch)", with a partial clone filter "origin\t<url> (fetch) [blob:none]"
    const m = /^(\S+)\t(.*) \((fetch|push)\)(?: \[[^\]]*\])?$/.exec(l);
    if (!m) return;
    if (!names.includes(m[1])) names.push(m[1]);
    if (m[3] === 'fetch' && !hasName(urls, m[1])) setName(urls, m[1], m[2]);
  });
  return { names, urls };
}

async function readMe(git) {
  const out = await git(['config', '--get-regexp', '^(user\\.(name|email)|core\\.commentchar)$'], { okCodes: [0, 1] });
  const me = { name: null, email: null };
  let commentChar = '#';
  out.stdout.split('\n').forEach((l) => {
    const sp = l.indexOf(' ');
    if (sp < 0) return;
    const k = l.slice(0, sp).toLowerCase();
    if (k === 'user.name') me.name = l.slice(sp + 1);
    if (k === 'user.email') me.email = l.slice(sp + 1);
    if (k === 'core.commentchar' && l.slice(sp + 1).length === 1) commentChar = l.slice(sp + 1);
  });
  return { me, commentChar };
}

/** Branches checked out recently, newest first, from HEAD's reflog ("checkout: moving from a to b"). */
async function readRecent(git) {
  let out;
  try { out = await git(['reflog', 'show', '--format=%gs', '-n', '400', 'HEAD', '--']); } catch { return []; }
  const seen = [];
  out.stdout.split('\n').forEach((l) => {
    const m = /^checkout: moving from (.+) to (.+)$/.exec(l);
    if (!m) return;
    [m[2], m[1]].forEach((b) => { if (!seen.includes(b)) seen.push(b); });
  });
  return seen;
}

async function subjects(git, ids) {
  const want = ids.filter((x) => x && /^[0-9a-f]{40,64}$/.test(x));
  if (!want.length) return {};
  try {
    const out = await git(['log', '-z', '--no-walk=unsorted', '--format=%H%x00%s', '--stdin'], { input: want.join('\n') + '\n' });
    const map = {};
    splitNulRecords(out.stdout, 2).forEach(([id, s]) => { map[id] = s; });
    return map;
  } catch { return {}; }
}

function refNameAt(refs, id) {
  if (!id) return null;
  const local = Object.keys(refs.branches).sort().find((n) => refs.branches[n].head === id);
  if (local) return local;
  const remote = Object.keys(refs.remotes).sort().find((n) => refs.remotes[n] === id);
  if (remote) return remote;
  return Object.keys(refs.tags).sort().find((n) => refs.tags[n] === id) || null;
}

/**
 * Entries whose index AND work tree both differ from HEAD ("MM"): the work tree may have been put back to HEAD's
 * content. IntelliJ ignores staging, so those are no change. One `git diff HEAD --name-only` over just those paths.
 */
async function stillChanged(git, entries) {
  const both = entries.filter((e) => e.type === '1' && e.xy[0] === 'M' && e.xy[1] === 'M').map((e) => e.path);
  if (!both.length) return null;
  // `git diff` has no --pathspec-from-file: the paths go after `--` (literal: GIT_LITERAL_PATHSPECS), in chunks.
  const changed = new Set();
  for (let i = 0; i < both.length; i += 500) {
    const out = await git(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=none', 'HEAD', '--', ...both.slice(i, i + 500)]);
    out.stdout.split('\0').filter(Boolean).forEach((p) => changed.add(p));
  }
  return new Set(both.filter((p) => !changed.has(p)));
}

/** The status the snapshot reads its local changes from (also worktree.list's change counts). */
export const STATUS_ARGS = ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--find-renames', '--ignore-submodules=none'];

/**
 * The Commit view's lists from one parsed status (`parseStatusV2`): `local` (changes and unversioned files, before
 * LOCAL_CAP) and `conflicts`. Entries whose work tree is back at HEAD's content are no change (stillChanged).
 */
export async function localLists(git, st) {
  const unchanged = await stillChanged(git, st.entries);
  const local = [];
  const conflicts = [];
  for (const e of st.entries) {
    if (e.type === 'u') { conflicts.push({ path: e.path, kind: conflictKind(e.xy) }); continue; }
    if (e.type === '!') continue;
    if (unchanged && unchanged.has(e.path)) continue;
    const c = localChange(e);
    if (c) local.push(c);
  }
  return { local, conflicts };
}

/** `git` is (args, opts) => runGit(repo.root, args, background options). */
export async function buildSnapshot(repo, git) {
  const [statusOut, refs, remotes, meCfg, recentRaw] = await Promise.all([
    git(STATUS_ARGS),
    readRefs(git),
    readRemotes(git),
    readMe(git),
    readRecent(git),
  ]);
  const st = parseStatusV2(statusOut.stdout);
  const headId = st.branch.oid;
  // HEAD can name a ref outside refs/heads (status prints "(null)" then): that is no local branch, so it is detached.
  const isBranch = !!st.branch.head && (hasName(refs.branches, st.branch.head) || !headId);
  const branchName = isBranch ? st.branch.head : null;
  const head = branchName ? { branch: branchName } : { detached: headId };
  if (branchName && !headId) head.unborn = true;

  const { local, conflicts } = await localLists(git, st);
  const localTruncated = local.length > LOCAL_CAP;
  if (localTruncated) local.length = LOCAL_CAP;

  const op = await detectOp(repo.gitDir, branchName, headId, git, meCfg.commentChar);
  if (op) {
    op.conflicts = conflicts;
    if (op.type === 'rebase') op.yours.ref = refNameAt(refs, op.rebase.onto);
    if (op.type === 'merge' && !op.theirs.ref) op.theirs.ref = refNameAt(refs, op.theirs.id);
    const subj = await subjects(git, [op.yours.id, op.theirs.id]);
    op.yours.subject = subj[op.yours.id] || null;
    op.theirs.subject = subj[op.theirs.id] || null;
  }

  // The stash list as ids, top first (one more git command only when there is a stash): a stash made or dropped
  // elsewhere — also a drop below the top, which rewrites only the reflog — changes the snapshot.
  const stashes = refs.stash
    ? (await git(['log', '-g', '--format=%H', 'refs/stash', '--'], { okCodes: [0, 128] })).stdout.split('\n').filter(Boolean)
    : [];

  const saved = readRepoState(repo);
  const favorites = Array.isArray(saved.favorites)
    ? saved.favorites.filter((n) => typeof n === 'string')
    : ['main', 'master'].filter((n) => hasName(refs.branches, n)); // IntelliJ marks the default branch as favorite
  const recent = recentRaw.filter((b) => hasName(refs.branches, b) && b !== branchName).slice(0, RECENT_CAP);

  return {
    root: repo.root,
    name: repo.name,
    gitDir: repo.gitDir,
    commonDir: repo.commonDir,
    linked: repo.linked,
    version: 0,
    head,
    headId,
    branches: refs.branches,
    remotes: refs.remotes,
    remoteNames: remotes.names,
    remoteUrls: remotes.urls,
    tags: refs.tags,
    favorites,
    recent,
    me: meCfg.me,
    local,
    localTruncated,
    // Every unmerged path, also when no operation is in progress (a smart checkout's unstash, a squash merge, a
    // conflicting changes.applyFromCommit): IntelliJ shows its Merge Conflicts node whenever such files exist.
    conflicts,
    stashes,
    op,
    // The message git prepared while no operation runs (a squash merge, `cherry-pick -n`): the Commit view's text.
    pendingMessage: op ? null : pendingMessage(repo.gitDir, meCfg.commentChar),
  };
}
