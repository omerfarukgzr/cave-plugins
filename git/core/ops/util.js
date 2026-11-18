// Helpers shared by the mutating operations (core/ops/*.js). Nothing here is registered as a method.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EngineError } from '../errors.js';
import { GIT_CONFIG_ARGS, displayCommand } from '../git.js';
import { parseStatusV2, localChange, conflictKind, cUnquote, parseFieldLines } from '../parse.js';
import { detectOp } from '../op-state.js';
import { saveTrash, dropTrashIfUnchanged } from '../trash.js';
import { commitId } from '../read/commit.js';
import { dataDir } from '../repo.js';

/** Branch names IntelliJ treats as protected by default (Settings | Git | Protected branches). */
export const DEFAULT_PROTECTED = ['main', 'master'];
/** Every exit code: for commands whose outcome is read from the repository afterwards. */
export const ANY_EXIT = Array.from({ length: 256 }, (_, i) => i);
const NUL = '\0';

export const refuse = (ctx, reason, message, data) => ctx.fail('refused', message, { reason, ...(data || {}) });

/** git_failed for a result of ctx.git(…, { okCodes: ANY_EXIT }) that turned out to be a failure. */
export function gitFailed(args, r) {
  const first = (r.stderr || '').split('\n').find((l) => l.trim()) || 'git exited with code ' + r.exitCode;
  return new EngineError('git_failed', first.trim(), { command: displayCommand(GIT_CONFIG_ARGS.concat(args)), exitCode: r.exitCode, stderr: r.stderr });
}

/** Runs git and never throws for an exit code; the caller reads the outcome. */
export async function tryGit(ctx, args, opts = {}) {
  const r = await ctx.git(args, { ...opts, okCodes: ANY_EXIT });
  r.args = args;
  r.fail = () => gitFailed(args, r);
  return r;
}

/** Input for `--pathspec-from-file=- --pathspec-file-nul` (paths are literal: GIT_LITERAL_PATHSPECS=1). */
export const pathInput = (paths) => paths.join(NUL) + NUL;
export const PATHS_FROM_STDIN = ['--pathspec-from-file=-', '--pathspec-file-nul'];

/** The local branch a full ref names ('refs/heads/x' -> 'x'), null for anything else. */
export const branchOf = (full) => (typeof full === 'string' && full.startsWith('refs/heads/') ? full.slice(11) : null);

/**
 * HEAD: { id, branch, ref, detached, unborn }. `ref` is the full symbolic ref, `branch` its name when it is a local
 * branch (never `symbolic-ref --short`, which prints `heads/x` when a tag `x` exists). HEAD on a ref outside
 * refs/heads (a remote branch) is detached, as the snapshot reports it.
 */
export async function headState(ctx) {
  const [id, sym] = await Promise.all([
    ctx.git(['rev-parse', '--verify', '--quiet', 'HEAD'], { okCodes: [0, 1, 128] }),
    ctx.git(['symbolic-ref', '--quiet', 'HEAD'], { okCodes: [0, 1, 128] }),
  ]);
  const headId = id.exitCode === 0 ? id.stdout.trim() : null;
  const ref = sym.exitCode === 0 ? sym.stdout.trim() : null;
  const branch = branchOf(ref);
  return { id: headId, branch, ref: branch ? ref : null, detached: !branch, unborn: !headId };
}

const REF_KINDS = [['refs/heads/', 'local'], ['refs/remotes/', 'remote'], ['refs/tags/', 'tag']];

/**
 * What a revision parameter names: { kind: 'local'|'remote'|'tag'|'revision', ref: full ref|null, name: short
 * name|null, id: commit id }. A full ref name (refs/heads/…, refs/remotes/…, refs/tags/…) is exact; a bare name prefers
 * a local branch, then a remote-tracking branch, then a tag (git itself prefers the tag), then any revision (`HEAD`,
 * `HEAD~2`, an id). Names git would read as an option (`-x`) arrive as full ref names.
 */
export async function resolveRef(ctx, rev, param = 'rev') {
  const full = REF_KINDS.find(([prefix]) => rev.startsWith(prefix));
  const tries = full ? [[rev, full[1], rev.slice(full[0].length)]]
    : rev === 'HEAD' || /[~^@{}]/.test(rev) ? [] : REF_KINDS.map(([prefix, kind]) => [prefix + rev, kind, rev]);
  for (const [ref, kind, name] of tries) {
    if (await refExists(ctx, ref)) return { kind, ref, name, id: await commitId(ctx, ref, param) };
  }
  return { kind: 'revision', ref: null, name: null, id: await commitId(ctx, rev, param) };
}

/** True when `name` (short) means `ref` to git without ambiguity (so it can be passed as it is: nicer messages). */
export async function unambiguous(ctx, name, ref) {
  const r = await ctx.git(['rev-parse', '--symbolic-full-name', '--end-of-options', name], { okCodes: [0, 1, 128] });
  return r.exitCode === 0 && r.stdout.trim() === ref && !/ambiguous/.test(r.stderr || '');
}

/** Paths with unmerged index entries: Map(path -> sorted stage numbers). */
export async function unmerged(ctx) {
  const out = await ctx.git(['ls-files', '-u', '-z']);
  const map = new Map();
  for (const rec of out.stdout.split(NUL)) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const p = rec.slice(tab + 1);
    const stage = Number(rec.slice(0, tab).split(' ')[2]);
    if (!map.has(p)) map.set(p, []);
    map.get(p).push(stage);
  }
  for (const v of map.values()) v.sort();
  return map;
}

/** The operation in progress (op-state.js) or null. */
export async function currentOp(ctx) {
  const h = await headState(ctx);
  return detectOp(ctx.repo.gitDir, h.branch, h.id, (args, opts) => ctx.git(args, opts));
}

/** Refuses when a merge/rebase/cherry-pick/revert is in progress or unmerged files exist. */
export async function refuseIfBusy(ctx, what) {
  const op = await currentOp(ctx);
  if (op) refuse(ctx, 'op_in_progress', 'cannot ' + what + ': a ' + op.type + ' is in progress', { type: op.type, incomplete: !!op.incomplete });
  const u = await unmerged(ctx);
  if (u.size) refuse(ctx, 'unmerged_files', 'cannot ' + what + ': there are unmerged files', { paths: Array.from(u.keys()) });
}

/** Work tree status: { changes: Map(path -> local change), untracked: Set, conflicts: Map(path -> kind), entries }. */
export async function readStatus(ctx) {
  const out = await ctx.git(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--find-renames', '--ignore-submodules=none']);
  const st = parseStatusV2(out.stdout);
  const changes = new Map();
  const untracked = new Set();
  const conflicts = new Map();
  for (const e of st.entries) {
    if (e.type === 'u') { conflicts.set(e.path, conflictKind(e.xy)); continue; }
    if (e.type === '!') continue;
    const c = localChange(e);
    if (!c) continue;
    if (c.status === '?') untracked.add(c.path);
    changes.set(c.path, c);
  }
  return { changes, untracked, conflicts, entries: st.entries };
}

/** Writes `text` to a new file under <gitDir>/<engine folder>/<sub>/ and returns its absolute path. */
export function writeTemp(ctx, text, sub = 'tmp', prefix = 'msg-') {
  const dir = path.join(ctx.repo.gitDir, dataDir(ctx.repo), sub);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, prefix + crypto.randomBytes(6).toString('hex'));
  fs.writeFileSync(file, text);
  return file;
}

export function removeQuietly(file) { try { fs.rmSync(file, { force: true, recursive: true }); } catch { /* gone */ } }

/** Runs fn(messageFile) with the message written to a temporary file (messages never go through argv). */
export async function withMessage(ctx, message, fn) {
  const file = writeTemp(ctx, message.endsWith('\n') ? message : message + '\n');
  try { return await fn(file); } finally { removeQuietly(file); }
}

export function checkMessage(ctx, message) {
  if (typeof message !== 'string' || !message.trim()) refuse(ctx, 'empty_message', 'the commit message is empty');
  return message;
}

/** Validates a branch or tag name with git check-ref-format; throws invalid_params. */
export async function checkRefName(ctx, name, kind = 'branch', param = 'name') {
  const prefix = kind === 'tag' ? 'refs/tags/' : 'refs/heads/';
  const ok = typeof name === 'string' && name && !name.startsWith('-') && name !== 'HEAD' && !/[\0\n]/.test(name) &&
    (await ctx.git(['check-ref-format', prefix + name], { okCodes: [0, 1] })).exitCode === 0;
  if (!ok) throw new EngineError('invalid_params', 'not a valid ' + kind + ' name: ' + name, { param, reason: 'invalid ref name' });
  return name;
}

export async function refExists(ctx, full) {
  return (await ctx.git(['show-ref', '--verify', '--quiet', full], { okCodes: [0, 1, 128] })).exitCode === 0;
}

export async function refId(ctx, full) {
  const r = await ctx.git(['rev-parse', '--verify', '--quiet', '--end-of-options', full], { okCodes: [0, 1, 128] });
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

export async function remoteNames(ctx) {
  return (await ctx.git(['remote'])).stdout.split('\n').filter(Boolean);
}

/** 'origin/feature/x' -> { remote: 'origin', branch: 'feature/x' } using the configured remote names (longest wins). */
export function splitRemoteRef(name, remotes) {
  const r = remotes.filter((n) => name.startsWith(n + '/')).sort((a, b) => b.length - a.length)[0];
  return r ? { remote: r, branch: name.slice(r.length + 1) } : null;
}

export async function configValue(ctx, key) {
  const r = await ctx.git(['config', '--get', key], { okCodes: [0, 1] }); // keys are built here, never start with '-'
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

/** All config entries (`git config -z --list`): get(key) -> last value | null, all(key) -> [values]. */
export async function readConfig(ctx) {
  const out = await ctx.git(['config', '-z', '--list'], { okCodes: [0, 1] });
  // Section and variable are case-insensitive (git lists them lower case), the subsection is not.
  const norm = (k) => { const a = k.indexOf('.'); const b = k.lastIndexOf('.'); return a === b ? k.toLowerCase() : k.slice(0, a).toLowerCase() + k.slice(a, b + 1) + k.slice(b + 1).toLowerCase(); };
  const map = new Map();
  for (const rec of out.stdout.split(NUL)) {
    if (!rec) continue;
    const nl = rec.indexOf('\n');
    const key = norm(nl < 0 ? rec : rec.slice(0, nl));
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(nl < 0 ? '' : rec.slice(nl + 1));
  }
  return {
    get: (k) => { const v = map.get(norm(k)); return v ? v[v.length - 1] : null; },
    all: (k) => (map.get(norm(k)) || []).slice(),
  };
}

/** Where a refspec list (remote.<r>.push) sends refs/heads/<branch>: the remote branch name, or null. */
export function mapPushRefspec(specs, branch, current) {
  const src = 'refs/heads/' + branch;
  let hit = null;
  for (const raw of specs) {
    const spec = raw.replace(/^\+/, '');
    if (spec.startsWith('^')) continue;
    const [s, d = s] = spec.split(':');
    const full = (x) => (x === 'HEAD' ? (current ? src : null) : x.startsWith('refs/') ? x : 'refs/heads/' + x);
    const from = full(s);
    if (!from) continue;
    let dst = null;
    if (from.includes('*')) {
      const [pre, post] = from.split('*');
      if (src.startsWith(pre) && src.endsWith(post) && src.length >= pre.length + post.length) dst = d.replace('*', src.slice(pre.length, src.length - post.length));
    } else if (from === src) dst = d;
    if (dst !== null) hit = dst === 'HEAD' ? src : dst.startsWith('refs/') ? dst : 'refs/heads/' + dst;
  }
  return hit && hit.startsWith('refs/heads/') ? hit.slice(11) : null;
}

/**
 * Where a plain `git push` of `branch` goes (push.outgoing and push agree on it):
 *   remote: branch.<b>.pushRemote, remote.pushDefault, branch.<b>.remote (not '.'), origin, the first remote;
 *   target: remote.<remote>.push refspecs when configured; otherwise, pushing to the upstream's own remote
 *           (centralized) with push.default simple/upstream: the upstream branch; else (triangular, current,
 *           matching) the same name.
 * `remoteOverride` (push's `remote` parameter) replaces the remote and the rules apply to it.
 */
export async function pushTarget(ctx, branch, remotes, remoteOverride, isCurrent = true) {
  const cfg = await readConfig(ctx);
  const upRemote = cfg.get('branch.' + branch + '.remote');
  const upMerge = cfg.get('branch.' + branch + '.merge');
  const upBranch = upMerge && upMerge.startsWith('refs/heads/') ? upMerge.slice(11) : null;
  const remote = remoteOverride || cfg.get('branch.' + branch + '.pushRemote') || cfg.get('remote.pushDefault') ||
    (upRemote && upRemote !== '.' ? upRemote : null) || (remotes.includes('origin') ? 'origin' : remotes[0] || null);
  const mode = (cfg.get('push.default') || 'simple').toLowerCase();
  const centralized = !!remote && upRemote === remote;
  let targetBranch = remote ? mapPushRefspec(cfg.all('remote.' + remote + '.push'), branch, isCurrent) : null;
  if (!targetBranch) targetBranch = centralized && upBranch && ['simple', 'upstream', 'tracking'].includes(mode) ? upBranch : branch;
  return { remote, targetBranch, upstreamRemote: upRemote, upstreamBranch: upBranch, centralized, mode };
}

/** Protected branch names: `protectedBranches` in the engine's repository state, IntelliJ's default otherwise. */
export function protectedNames(ctx) {
  const saved = ctx.repoState.read().protectedBranches;
  return Array.isArray(saved) ? saved.filter((n) => typeof n === 'string') : DEFAULT_PROTECTED;
}

/** Remote branches named like a protected branch ('origin/main') that contain commit `id`. */
export async function protectedContaining(ctx, id) {
  if (!id) return [];
  const names = protectedNames(ctx);
  const remotes = await remoteNames(ctx);
  const out = await ctx.git(['for-each-ref', '--format=%(refname)%00%(symref)', '--contains', id, 'refs/remotes']);
  return parseFieldLines(out.stdout, 2).filter(([, sym]) => !sym).map(([ref]) => ref.slice(13))
    .filter((n) => { const s = splitRemoteRef(n, remotes); return s && names.includes(s.branch); });
}

/** Worktree (other than this one) where refs/heads/<branch> is checked out, or null. */
export async function checkedOutElsewhere(ctx, branch) {
  const out = await ctx.git(['worktree', 'list', '--porcelain', '-z']);
  let cur = null;
  for (const line of out.stdout.split(NUL)) {
    if (line.startsWith('worktree ')) cur = line.slice(9);
    else if (line === 'branch refs/heads/' + branch && cur) {
      let real = cur;
      try { real = fs.realpathSync(cur); } catch { /* missing worktree */ }
      if (real !== ctx.repo.root) return real;
    }
  }
  return null;
}

/**
 * Reads git's "would be overwritten" refusal: { files: [tracked paths], untracked: [paths] } or null.
 * Messages are stable because every command runs with LC_ALL=C.
 */
export function parseWouldOverwrite(stderr) {
  if (!stderr) return null;
  const files = [];
  const untracked = [];
  let target = null;
  let found = false;
  for (const line of stderr.split('\n')) {
    if (/would be overwritten by/.test(line)) {
      found = true;
      target = /untracked working tree files/.test(line) ? untracked : /following files/.test(line) ? files : null;
      continue;
    }
    const entry = /^error: Entry '(.+)' (?:not uptodate\. Cannot merge|would be overwritten by merge\. Cannot merge)\.$/.exec(line);
    if (entry) { found = true; files.push(entry[1]); continue; }
    if (target && line.startsWith('\t')) { target.push(cUnquote(line.slice(1))); continue; }
    target = null;
  }
  return found ? { files, untracked } : null;
}

export const wouldOverwriteResult = (w, extra) => ({ result: 'would-overwrite', files: w.files, untracked: w.untracked, ...(extra || {}) });

/** Paths whose work tree or index content differs from `rev` (tracked in either; untracked files in rev's tree too). */
export async function pathsDifferingFrom(ctx, rev) {
  const [wt, idx] = await Promise.all([
    ctx.git(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=all', '--end-of-options', rev, '--']),
    ctx.git(['diff', '--cached', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=all', '--end-of-options', rev, '--']),
  ]);
  return Array.from(new Set(wt.stdout.split(NUL).concat(idx.stdout.split(NUL)).filter(Boolean)));
}

/** Paths that differ between two commits. */
export async function pathsBetween(ctx, a, b) {
  const out = await ctx.git(['diff', '--name-only', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=all', '--end-of-options', a, b, '--']);
  return out.stdout.split(NUL).filter(Boolean);
}

/** Saves the given paths to the trash (null when nothing existed). opts as saveTrash's (`take`, `blockers`). */
export const trash = (ctx, paths, op, opts) => saveTrash(ctx.repo, paths, op, opts);

/**
 * For an operation that saved content and then failed or was refused: the entry goes when everything it holds is
 * still on disk unchanged (nothing was thrown away: no entry is left, docs/PROTOCOL.md "Trash"); otherwise it stays,
 * because then it is the only copy. Returns the entry that stays, or null.
 */
export function settleTrash(ctx, saved) {
  if (!saved) return null;
  try { return dropTrashIfUnchanged(ctx.repo, saved.id) ? null : saved; } catch { return saved; }
}

/**
 * The error to throw when an operation fails AFTER it saved content: the entry is settled (settleTrash), and when it
 * stays — git had already changed files before it failed — the error carries it (`data.trash`), so what was thrown
 * away can still be restored although the call failed.
 */
export function failedAfterSaving(ctx, saved, err) {
  const kept = settleTrash(ctx, saved);
  if (!kept || !err || typeof err !== 'object') return err;
  if (err instanceof EngineError) { err.data = { ...(err.data || {}), trash: kept }; return err; }
  if (err.name === 'GitError' && err.cancelled) return new EngineError('cancelled', 'cancelled', { command: err.command, trash: kept });
  if (err.name === 'GitError' && !err.timedOut) {
    return new EngineError('git_failed', err.message, { command: err.command, exitCode: err.exitCode, stderr: err.stderr, trash: kept });
  }
  return err;
}

/** True for the error of a git command that was cancelled (a job's cancel) or killed. */
export const isCancel = (e) => !!e && (e.cancelled === true || e.code === 'cancelled');

/**
 * A cancel that came too late: git had done its work, and what was ended is something it ran afterwards (a
 * post-commit, post-checkout, post-merge or post-rewrite hook). The outcome is then the operation's, not `cancelled`
 * (a result must say what happened): callers that see the work done go on with this in place of git's result.
 */
export const lateCancel = () => ({ exitCode: 0, stdout: '', stderr: '', late: true, fail: () => new EngineError('cancelled', 'cancelled', null) });

/**
 * Runs `fn(job)` — the git command of a mutating method that can run hooks or take long — as a cancellable job
 * (docs/ARCHITECTURE.md §3.2): `job.cancel` kills git's whole process group. Whatever happens, the handler's git
 * commands run to their end again afterwards (ctx.detach), so it can tidy up and read what really happened; a cancel
 * surfaces as the `cancelled` error fn's git call rejected with. git removes its own lock files when it is ended; one
 * it could not remove because it had to be killed outright is removed here (an index.lock made after the job began).
 */
export async function asJob(ctx, title, fn) {
  const started = Date.now();
  const job = ctx.job({ title, cancellable: true });
  let failed = null;
  let out;
  try { out = await fn(job); } catch (e) { failed = e; }
  if (job.isCancellable()) job.cancellable(false);
  ctx.detach();
  if (!failed) return out;
  if (isCancel(failed) && failed.signal === 'SIGKILL') {
    const lock = path.join(ctx.repo.gitDir, 'index.lock');
    try { if (fs.statSync(lock).mtimeMs >= started - 1000) fs.rmSync(lock, { force: true }); } catch { /* none */ }
  }
  throw failed;
}

export async function isAncestor(ctx, a, b) {
  return (await ctx.git(['merge-base', '--is-ancestor', '--end-of-options', a, b], { okCodes: [0, 1, 128] })).exitCode === 0;
}

export async function revList(ctx, args) {
  return (await ctx.git(['rev-list', ...args])).stdout.split('\n').filter(Boolean);
}

/** Snapshot-like summary of what is in progress now, for results: { type, conflicts: [path], rebase } | null. */
export async function opSummary(ctx) {
  const op = await currentOp(ctx);
  const u = await unmerged(ctx);
  if (!op) return u.size ? { type: null, conflicts: Array.from(u.keys()), rebase: null } : null;
  return { type: op.type, conflicts: Array.from(u.keys()), rebase: op.rebase, sequencer: op.sequencer, incomplete: !!op.incomplete };
}
