// Branches and tags: checkout, branch.create, branch.rename, branch.delete, branch.setFavorite, tag.create, tag.delete.
import { commitId } from '../read/commit.js';
import {
  refuse, tryGit, headState, refuseIfBusy, checkRefName, refExists, refId, remoteNames, splitRemoteRef, checkedOutElsewhere,
  parseWouldOverwrite, wouldOverwriteResult, pathsDifferingFrom, trash, revList, withMessage,
  resolveRef, branchOf, asJob, failedAfterSaving, unambiguous, readConfig, isCancel, lateCancel,
} from './util.js';
import { prepareStash, undoStashSideEffects } from './autostash.js';
import { readStashList } from '../read/stash.js';
import { EngineError } from '../errors.js';
import { findPushed, applyById, dropVerified, STASH_OPTS } from './stash-core.js';
import { inTheWay, blockedBy, treeWrites } from './guard.js';

const UNMERGED_CAP = 1000;

/**
 * What `target` names: a local branch, a remote branch, a tag or any other revision (all resolved to commits). Full
 * ref names are exact; a bare name prefers the local branch, then the remote branch, then the tag (resolveRef).
 */
async function resolveTarget(ctx, target) {
  const t = await resolveRef(ctx, target, 'target');
  if (t.kind === 'local') return { kind: 'local', branch: t.name, id: t.id };
  if (t.kind === 'remote') {
    const s = splitRemoteRef(t.name, await remoteNames(ctx));
    if (s) return { kind: 'remote', ref: t.name, remote: s.remote, branch: s.branch, id: t.id };
    return { kind: 'revision', id: t.id };
  }
  if (t.kind === 'tag') return { kind: 'tag', tag: t.name, id: t.id };
  return { kind: 'revision', id: t.id };
}

/** A branch name parameter: 'refs/heads/x' or 'x' -> 'x'. */
const localName = (name) => branchOf(name) || name;

async function upstreamOf(ctx, branch) {
  const r = await ctx.git(['for-each-ref', '--format=%(upstream)', 'refs/heads/' + branch]);
  return r.stdout.trim() || null;
}

/** The remote, and the ref on it, that the remote-tracking ref `full` mirrors (the remotes' fetch refspecs): { remote, merge } | null. */
async function trackedSource(ctx, full) {
  const cfg = await readConfig(ctx);
  const remotes = (await remoteNames(ctx)).sort((a, b) => b.length - a.length);
  for (const remote of remotes) {
    for (const raw of cfg.all('remote.' + remote + '.fetch')) {
      const spec = raw.replace(/^\+/, '');
      const colon = spec.indexOf(':');
      if (colon < 0) continue;
      const src = spec.slice(0, colon);
      const dst = spec.slice(colon + 1);
      if (!dst.includes('*')) { if (dst === full) return { remote, merge: src }; continue; }
      const [pre, post] = dst.split('*');
      if (full.startsWith(pre) && full.endsWith(post) && full.length >= pre.length + post.length) return { remote, merge: src.replace('*', full.slice(pre.length, full.length - post.length)) };
    }
  }
  return null;
}

/**
 * Makes `branch` track the FULL ref `full` (refs/heads/… or refs/remotes/…). git's `--set-upstream-to` and `--track`
 * look a name up through the short-name rules and call even a full ref ambiguous when a local branch is literally
 * named like it (a branch `refs/remotes/origin/main`, a branch `origin/main` beside the remote's): then the two
 * config values are written as git writes them (`exactRef` tells which way a ref must go).
 */
async function setUpstream(ctx, branch, full) {
  if (await exactRef(ctx, full)) { await ctx.git(['branch', '--set-upstream-to=' + full, '--end-of-options', branch]); return; }
  const src = full.startsWith('refs/heads/') ? { remote: '.', merge: full } : await trackedSource(ctx, full);
  if (!src || src.remote.startsWith('-')) ctx.fail('not_found', 'no remote fetches into ' + full, { param: 'upstream', rev: full });
  await ctx.git(['config', 'branch.' + branch + '.remote', src.remote]);
  await ctx.git(['config', 'branch.' + branch + '.merge', src.merge]);
}

/** True when git reads the full ref `full` as exactly that ref (no other ref answers to the same name). */
const exactRef = (ctx, full) => unambiguous(ctx, full, full);

async function favoritesOf(ctx) {
  const saved = ctx.repoState.read();
  if (Array.isArray(saved.favorites)) return saved.favorites.filter((n) => typeof n === 'string');
  const out = [];
  for (const n of ['main', 'master']) if (await refExists(ctx, 'refs/heads/' + n)) out.push(n);
  return out;
}

function saveFavorites(ctx, list) {
  const saved = ctx.repoState.read();
  ctx.repoState.write({ ...saved, favorites: Array.from(new Set(list)) });
}

/** Runs a checkout command with IntelliJ's Smart / Force handling. Returns { r, w, smart, trash }. */
async function runCheckout(ctx, args, p, targetRev) {
  const from = await headState(ctx);
  // A cancellable job; a cancel that only ended a post-checkout hook (HEAD is where it was to go) is a checkout.
  const go = async (cmd) => {
    try { return await asJob(ctx, 'Checking out', () => tryGit(ctx, cmd)); } catch (e) {
      const now = await headState(ctx);
      if (isCancel(e) && (now.id !== from.id || now.ref !== from.ref)) return lateCancel();
      throw e;
    }
  };
  if (p.force) {
    const saved = trash(ctx, await pathsDifferingFrom(ctx, targetRev), 'checkout --force');
    let r;
    try { r = await go([args[0], '--force', ...args.slice(1)]); } catch (e) { throw failedAfterSaving(ctx, saved, e); }
    if (r.exitCode !== 0) throw failedAfterSaving(ctx, saved, r.fail());   // failed half way: what it removed is in `data.trash`
    return { trash: saved, smart: null };
  }
  // The work tree guard (guard.js): what the target brings in must not run over content git does not track. git
  // refuses for untracked files by itself; ignored ones it would overwrite (--no-overwrite-ignore is the second net).
  const incoming = blockedBy(await inTheWay(ctx, await treeWrites(ctx, from.id, targetRev)));
  if (incoming) return { overwrite: incoming };
  const cmd = [args[0], '--no-overwrite-ignore', ...args.slice(1)];
  const r = await go(cmd);
  if (r.exitCode === 0) return { trash: null, smart: null };
  const w = parseWouldOverwrite(r.stderr);
  if (!w) throw r.fail();
  if (!p.smart || w.untracked.length) return { overwrite: w };
  // content git's stash would destroy (a replaced folder / file, a path out of the index) makes it a Would-overwrite
  const pre = await prepareStash(ctx);
  if (pre.blocked) return { overwrite: { files: w.files, untracked: pre.blocked.untracked } };
  // Smart checkout: stash, check out, unstash (IntelliJ: "stash the changes, checkout and unstash them after that").
  // refs/stash is shared by every worktree: the stash is found and put back BY ID (stash-core.js), so a stash another
  // session pushes in between is never applied here or dropped.
  const before = (await readStashList(ctx)).map((s) => s.id);
  const message = smartMessage();
  await ctx.git(['stash', 'push', '--quiet', '--message=' + message], STASH_OPTS);
  const found = await findPushed(ctx, before, from.id, message);
  // nothing of ours was stashed (no new entry, or only entries another session pushed): git's refusal stands, nothing
  // is put back and nothing is said to be in the stash
  if (!found.candidates.length) return { overwrite: w };
  const ours = found.stash;      // null: more than one candidate (ambiguous) — the changes stay in the stash
  /**
   * Put back = apply by id, then the verified drop. Never throws: the answer is the `smart` shape — `ok`, or where the
   * local changes are now (`conflicts` with the paths; `kept`: still in the stash, which is named).
   */
  const putBack = async () => {
    try {
      const a = await applyById(ctx, ours, { title: 'Unstashing…' });
      if (a.result === 'applied') {
        try { await dropVerified(ctx, ours.id, 'checkout'); } catch (e) { return { stash: ours.id, unstash: 'kept', conflicts: [], reason: (e && e.data && e.data.reason) || (e && e.code) || 'drop_failed' }; }
        return { stash: ours.id, unstash: 'ok', conflicts: [] };
      }
      if (a.result === 'conflicts') return { stash: ours.id, unstash: 'conflicts', conflicts: a.conflicts };
      // the stash did not apply (content in the way): it stays in the list, nothing is lost
      return { stash: ours.id, unstash: 'kept', conflicts: [], files: a.files || [], untracked: a.untracked || [], reason: a.result };
    } catch (e) {
      return { stash: ours.id, unstash: 'kept', conflicts: [], reason: (e && e.code) || 'failed' };
    }
  };
  /** Error data naming where the local changes are when they are not back (PROTOCOL git_failed `autostash`). */
  const keptData = (smart) => ({ autostash: smart.unstash === 'conflicts' ? 'conflicts' : 'stashed', stash: smart.stash, unstash: smart.unstash,
    conflicts: smart.conflicts, candidates: smart.candidates || [] });
  const ambiguous = { stash: null, candidates: found.candidates, unstash: 'kept', conflicts: [] };
  /** After a checkout that did not happen: put back; the staging too, but only when the stash came back cleanly. */
  const backAfterFailure = async () => {
    if (!ours) return ambiguous;
    const smart = await putBack();
    if (smart.unstash === 'ok') await undoStashSideEffects(ctx, pre);
    return smart;
  };
  let again;
  try {
    again = await go(cmd);
  } catch (e) {
    // cancelled or killed before git switched: the local changes come back, with what was staged
    const smart = await backAfterFailure();
    if (smart.unstash !== 'ok') {
      if (e instanceof EngineError) e.data = { ...(e.data || {}), ...keptData(smart) };
      else throw new EngineError(isCancel(e) ? 'cancelled' : 'git_failed', isCancel(e) ? 'cancelled' : (e && e.message) || 'checkout failed',
        { command: (e && e.command) || null, exitCode: e && e.exitCode, stderr: e && e.stderr, ...keptData(smart) });
    }
    throw e;
  }
  if (again.exitCode !== 0) {
    // the checkout did not run: the stash comes back, with what was staged (an apply alone loses the staging)
    const smart = await backAfterFailure();
    const blocked = parseWouldOverwrite(again.stderr);
    if (blocked) return smart.unstash === 'ok' ? { overwrite: blocked } : { overwrite: blocked, smart };
    const err = again.fail();
    if (smart.unstash !== 'ok') err.data = { ...(err.data || {}), ...keptData(smart) };
    throw err;
  }
  // not exactly one stash of ours (another session pushed one with the same base and message at the same moment):
  // nothing is put back on its own; the changes are kept in the stash and the result names the candidates
  if (!ours) return { trash: null, smart: ambiguous };
  return { trash: null, smart: await putBack() };
}

/** IntelliJ's stash message of a Smart Checkout (VcsBundle stash.changes.message.with.date), the local time to the second. */
function smartMessage(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return 'Uncommitted changes before Checkout at ' + now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate()) + ' ' +
    p(now.getHours()) + ':' + p(now.getMinutes()) + ':' + p(now.getSeconds());
}

export default [
  {
    name: 'checkout', repo: true, mutating: true,
    params: { target: 'rev', smart: 'bool?', force: 'bool?', overwriteLocal: 'bool?', ignoreOtherWorktrees: 'bool?' },
    async handler(ctx, p) {
      await refuseIfBusy(ctx, 'checkout');
      const before = await headState(ctx);
      const t = await resolveTarget(ctx, p.target);
      const other = p.ignoreOtherWorktrees ? ['--ignore-other-worktrees'] : [];
      let args;
      let created = false;
      let reset = false;
      let branch = null;
      let trackAfter = null;       // the upstream to set by hand: git cannot be given the remote ref unambiguously (setUpstream)
      if (t.kind === 'local') {
        branch = t.branch;
        args = ['checkout', ...other, '--end-of-options', t.branch, '--'];
      } else if (t.kind === 'remote') {
        branch = t.branch;
        const full = 'refs/remotes/' + t.ref;
        const exact = await exactRef(ctx, full);
        if (!exact) trackAfter = full;
        const localId = await refId(ctx, 'refs/heads/' + t.branch);
        if (!localId) {
          await checkRefName(ctx, t.branch, 'branch', 'target');
          created = true;
          args = exact ? ['checkout', '--track', '-b', t.branch, '--end-of-options', full, '--'] : ['checkout', '-b', t.branch, '--end-of-options', t.id, '--'];
        } else {
          // A local branch of that name exists: IntelliJ resets it silently when nothing is lost, asks otherwise.
          const upstream = await upstreamOf(ctx, t.branch);
          const lost = await revList(ctx, ['-n', String(UNMERGED_CAP), localId, '--not', t.id]);
          if ((lost.length || upstream !== 'refs/remotes/' + t.ref) && !p.overwriteLocal) {
            refuse(ctx, 'local_branch_exists', "local branch '" + t.branch + "' exists", {
              branch: t.branch, head: localId, upstream: upstream ? upstream.replace(/^refs\/(remotes|heads)\//, '') : null, commits: lost,
            });
          }
          reset = localId !== t.id;
          args = exact ? ['checkout', ...other, '--track', '-B', t.branch, '--end-of-options', full, '--'] : ['checkout', ...other, '-B', t.branch, '--end-of-options', t.id, '--'];
        }
      } else {
        args = ['checkout', '--detach', '--end-of-options', t.id, '--'];
      }
      if (branch && !p.ignoreOtherWorktrees && await refExists(ctx, 'refs/heads/' + branch)) {
        const where = await checkedOutElsewhere(ctx, branch);
        if (where) refuse(ctx, 'checked_out_elsewhere', "branch '" + branch + "' is checked out in another worktree", { branch, path: where });
      }
      const out = await runCheckout(ctx, args, p, t.id);
      // `smart` beside a Would-overwrite: the checkout did not run and the local changes did not all come back (in the stash)
      if (out.overwrite) return wouldOverwriteResult(out.overwrite, { target: p.target, kind: t.kind, ...(out.smart ? { smart: out.smart } : {}) });
      if (trackAfter) await setUpstream(ctx, branch, trackAfter);
      const after = await headState(ctx);
      return {
        result: 'checked-out', kind: t.kind, target: p.target, branch: after.branch, detached: after.detached, id: after.id,
        created, reset, previous: { branch: before.branch, id: before.id }, smart: out.smart, trash: out.trash,
      };
    },
  },
  {
    name: 'branch.create', repo: true, mutating: true,
    params: { name: 'string', from: 'rev?', checkout: { type: 'bool', default: true }, overwrite: 'bool?', upstream: 'rev?' },
    async handler(ctx, p) {
      await checkRefName(ctx, p.name);
      const before = await headState(ctx);
      const old = await refId(ctx, 'refs/heads/' + p.name);
      if (old && !p.overwrite) refuse(ctx, 'exists', "branch '" + p.name + "' already exists", { branch: p.name, head: old });
      if (!p.from && before.unborn) refuse(ctx, 'unborn', 'HEAD has no commit yet');
      const from = p.from ? await resolveRef(ctx, p.from, 'from') : { kind: 'revision', id: await commitId(ctx, 'HEAD', 'from') };
      const id = from.id;
      const fromRemote = from.kind === 'remote';
      // `upstream` follows Ref names like every ref parameter (a full ref is exact; a bare name is the local branch,
      // then the remote-tracking one) and is checked before anything is created
      let upstreamRef = null;
      if (p.upstream) {
        const u = await resolveRef(ctx, p.upstream, 'upstream');
        if (u.kind !== 'local' && u.kind !== 'remote') ctx.fail('not_found', 'no branch ' + p.upstream, { param: 'upstream', rev: p.upstream });
        upstreamRef = u.ref;
      }
      // git gets the remote ref itself only when it reads that name as exactly that ref (setUpstream); otherwise the
      // branch starts at the commit and its upstream is set afterwards
      const exact = fromRemote && await exactRef(ctx, from.ref);
      const start = exact ? from.ref : id;
      const track = exact ? ['--track'] : [];
      if (old && p.checkout && before.branch !== p.name) {
        const where = await checkedOutElsewhere(ctx, p.name);
        if (where) refuse(ctx, 'checked_out_elsewhere', "branch '" + p.name + "' is checked out in another worktree", { branch: p.name, path: where });
      }
      if (p.checkout) {
        await refuseIfBusy(ctx, 'checkout');
        // the work tree guard (guard.js): what the start point brings in must not run over content git does not track
        const incoming = blockedBy(await inTheWay(ctx, await treeWrites(ctx, before.id, id)));
        if (incoming) return wouldOverwriteResult(incoming, { branch: p.name });
        let r;
        try {
          r = await asJob(ctx, 'Checking out', () => tryGit(ctx, ['checkout', '--no-overwrite-ignore', ...track, old ? '-B' : '-b', p.name, '--end-of-options', start, '--']));
        } catch (e) {
          // cancelled after git had created and switched to the branch (a post-checkout hook was ended): it is created
          if (!(isCancel(e) && (await headState(ctx)).branch === p.name && before.branch !== p.name)) throw e;
          r = lateCancel();
        }
        if (r.exitCode !== 0) {
          const w = parseWouldOverwrite(r.stderr);
          if (w) return wouldOverwriteResult(w, { branch: p.name });
          throw r.fail();
        }
      } else {
        if (old && before.branch === p.name) refuse(ctx, 'current_branch', 'cannot overwrite the current branch without checking it out', { branch: p.name });
        await ctx.git(['branch', ...track, ...(old ? ['--force'] : []), '--end-of-options', p.name, start]);
      }
      if (upstreamRef) await setUpstream(ctx, p.name, upstreamRef);
      else if (fromRemote && !exact) await setUpstream(ctx, p.name, from.ref);
      const up = await upstreamOf(ctx, p.name);
      return {
        result: 'created', branch: p.name, id, checkedOut: !!p.checkout, upstream: up ? up.replace(/^refs\/(remotes|heads)\//, '') : null,
        upstreamRef: up, overwritten: old, previous: { branch: before.branch, id: before.id },
      };
    },
  },
  {
    name: 'branch.rename', repo: true, mutating: true, params: { from: 'rev', to: 'string', unsetUpstream: 'bool?' },
    async handler(ctx, raw) {
      const p = { ...raw, from: localName(raw.from) };
      await checkRefName(ctx, p.to, 'branch', 'to');
      if (!(await refExists(ctx, 'refs/heads/' + p.from))) ctx.fail('not_found', 'no local branch ' + p.from, { param: 'from', rev: p.from });
      if (p.to === p.from) return { result: 'renamed', from: p.from, to: p.to };
      const existing = await refId(ctx, 'refs/heads/' + p.to);
      if (existing) refuse(ctx, 'exists', "branch '" + p.to + "' already exists", { branch: p.to, head: existing });
      const favs = await favoritesOf(ctx);
      await ctx.git(['branch', '--move', '--end-of-options', p.from, p.to]);
      if (favs.includes(p.from)) saveFavorites(ctx, favs.map((n) => (n === p.from ? p.to : n)));
      if (p.unsetUpstream && await upstreamOf(ctx, p.to)) await ctx.git(['branch', '--unset-upstream', '--end-of-options', p.to]);
      return { result: 'renamed', from: p.from, to: p.to };
    },
  },
  {
    name: 'branch.delete', repo: true, mutating: true, params: { name: 'rev', remote: 'bool?' },
    async handler(ctx, raw) {
      // full ref names say which one is meant: refs/heads/x (local), refs/remotes/origin/x (on the remote)
      const p = raw.name.startsWith('refs/remotes/') ? { ...raw, name: raw.name.slice(13), remote: true }
        : branchOf(raw.name) ? { ...raw, name: branchOf(raw.name), remote: false } : raw;
      if (p.remote) {
        const s = splitRemoteRef(p.name, await remoteNames(ctx));
        const head = s && await refId(ctx, 'refs/remotes/' + p.name);
        if (!head) ctx.fail('not_found', 'no remote branch ' + p.name, { param: 'name', rev: p.name });
        const job = ctx.job({ title: 'Deleting ' + p.name, cancellable: true });
        job.progress('git push ' + s.remote + ' --delete ' + s.branch, null);
        await ctx.git(['push', '--porcelain', '--end-of-options', s.remote, ':refs/heads/' + s.branch], { timeoutMs: 0 });
        return { result: 'deleted', kind: 'remote', branch: p.name, remote: s.remote, remoteBranch: s.branch, head };
      }
      const head = await refId(ctx, 'refs/heads/' + p.name);
      if (!head) ctx.fail('not_found', 'no local branch ' + p.name, { param: 'name', rev: p.name });
      const h = await headState(ctx);
      if (h.branch === p.name) refuse(ctx, 'current_branch', 'cannot delete the current branch', { branch: p.name });
      const where = await checkedOutElsewhere(ctx, p.name);
      if (where) refuse(ctx, 'checked_out_elsewhere', "branch '" + p.name + "' is checked out in another worktree", { branch: p.name, path: where });
      const up = await upstreamOf(ctx, p.name);
      const upExists = up && await refExists(ctx, up);
      const against = [];
      if (h.id) against.push(h.id);
      if (upExists) against.push(up);
      const ids = await revList(ctx, ['-n', String(UNMERGED_CAP), head, '--not', ...against, '--']);
      await ctx.git(['branch', '--delete', '--force', '--end-of-options', p.name]);
      return {
        result: 'deleted', kind: 'local', branch: p.name, head,
        upstream: upExists ? up.replace(/^refs\/(remotes|heads)\//, '') : null,
        upstreamRef: upExists ? up : null,   // the full ref: pass it to branch.create `upstream` to restore exactly
        unmerged: ids.length > 0, unmergedIds: ids,
      };
    },
  },
  {
    name: 'branch.setFavorite', repo: true, mutating: true, params: { name: 'rev', favorite: 'bool' },
    async handler(ctx, raw) {
      const p = { ...raw, name: localName(raw.name) };
      const favs = await favoritesOf(ctx);
      const next = p.favorite ? favs.concat(favs.includes(p.name) ? [] : [p.name]) : favs.filter((n) => n !== p.name);
      saveFavorites(ctx, next);
      return { result: 'saved', favorites: next };
    },
  },
  {
    name: 'tag.create', repo: true, mutating: true, params: { name: 'string', at: 'rev?', message: 'string?', force: 'bool?' },
    async handler(ctx, p) {
      await checkRefName(ctx, p.name, 'tag');
      const previous = await refId(ctx, 'refs/tags/' + p.name);
      if (previous && !p.force) refuse(ctx, 'exists', "tag '" + p.name + "' already exists", { tag: p.name, object: previous });
      const target = await refId(ctx, p.at || 'HEAD');
      if (!target) ctx.fail('not_found', 'unknown revision ' + (p.at || 'HEAD'), { param: 'at', rev: p.at || 'HEAD' });
      const run = (msg) => ctx.git(['tag', ...(p.force ? ['--force'] : []), ...(msg ? ['--annotate', '-F', msg] : []), '--end-of-options', p.name, target]);
      if (p.message && p.message.trim()) await withMessage(ctx, p.message, run); else await run(null);
      return {
        result: 'created', tag: p.name, object: await refId(ctx, 'refs/tags/' + p.name),
        id: await commitId(ctx, 'refs/tags/' + p.name, 'at'), annotated: !!(p.message && p.message.trim()), previous,
      };
    },
  },
  {
    name: 'tag.delete', repo: true, mutating: true, params: { name: 'rev' },
    async handler(ctx, raw) {
      const p = { ...raw, name: raw.name.startsWith('refs/tags/') ? raw.name.slice(10) : raw.name };
      const object = await refId(ctx, 'refs/tags/' + p.name);
      if (!object) ctx.fail('not_found', 'no tag ' + p.name, { param: 'name', rev: p.name });
      const type = (await ctx.git(['cat-file', '-t', object])).stdout.trim();
      const peeled = await refId(ctx, 'refs/tags/' + p.name + '^{}');
      await ctx.git(['tag', '--delete', '--end-of-options', p.name]);
      return { result: 'deleted', tag: p.name, object, id: peeled, annotated: type === 'tag' };
    },
  },
];
