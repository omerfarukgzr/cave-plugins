// Compare group: compare.branches, compare.files; Remote: push.outgoing.
import { parseRawDiff, changeFromRaw } from '../parse.js';
import { readRefs, hasName } from '../snapshot.js';
import { pushTarget, branchOf } from '../ops/util.js';
import { commitId } from './commit.js';
import { LOG_CAP } from './log.js';

export default [
  {
    name: 'compare.branches', repo: true, mutating: false, params: { a: 'rev', b: 'rev' },
    async handler(ctx, p) {
      const [a, b] = await Promise.all([commitId(ctx, p.a, 'a'), commitId(ctx, p.b, 'b')]);
      const [lr, base] = await Promise.all([
        ctx.git(['rev-list', '--left-right', '--date-order', '-n', String(LOG_CAP + 1), '--end-of-options', a + '...' + b]),
        ctx.git(['merge-base', a, b], { okCodes: [0, 1] }),
      ]);
      const onlyA = [];
      const onlyB = [];
      const rows = lr.stdout.split('\n').filter(Boolean);
      const truncated = rows.length > LOG_CAP;
      rows.slice(0, LOG_CAP).forEach((r) => (r[0] === '<' ? onlyA : onlyB).push(r.slice(1)));
      return { a: { rev: p.a, id: a }, b: { rev: p.b, id: b }, onlyA, onlyB, mergeBase: base.exitCode === 0 ? base.stdout.trim() : null, truncated };
    },
  },
  {
    name: 'compare.files', repo: true, mutating: false, params: { a: 'rev', b: 'rev?' },
    async handler(ctx, p) {
      const a = await commitId(ctx, p.a, 'a');
      const b = p.b !== undefined ? await commitId(ctx, p.b, 'b') : null;
      // --no-abbrev: full blob ids (the protocol's cache keys), whatever core.abbrev says.
      const args = ['diff', '--raw', '--no-abbrev', '-z', '-M', '--no-color', '--no-ext-diff', '--end-of-options', a];
      if (b) args.push(b);
      args.push('--');
      const out = await ctx.git(args);
      const files = parseRawDiff(out.stdout).map(changeFromRaw);
      // Against the work tree git names the index blob for a file that is staged and unchanged since: the work tree
      // side has no blob id (PROTOCOL: newId null).
      if (!b) files.forEach((f) => { f.newId = null; });
      return { a, b, worktree: !b, files };
    },
  },
  {
    name: 'push.outgoing', repo: true, mutating: false, params: { branch: 'rev?' },
    async handler(ctx, p) {
      const refs = await readRefs(ctx.git);
      // full ref, never --short: that prints `heads/x` when a tag `x` exists
      const current = await ctx.git(['symbolic-ref', '--quiet', 'HEAD'], { okCodes: [0, 1, 128] });
      const currentBranch = current.exitCode === 0 ? branchOf(current.stdout.trim()) : null;
      let branch = p.branch ? branchOf(p.branch) || p.branch : null;
      if (!branch) {
        if (!currentBranch) ctx.fail('refused', 'HEAD is detached', { reason: 'detached' });
        branch = currentBranch;
      }
      if (!hasName(refs.branches, branch)) ctx.fail('not_found', 'no local branch ' + branch, { param: 'branch', branch });
      const b = refs.branches[branch];
      const upstream = b.upstream && !b.gone && hasName(refs.remotes, b.upstream) ? b.upstream : null;
      const remoteNames = (await ctx.git(['remote'])).stdout.split('\n').filter(Boolean);
      const t = await pushTarget(ctx, branch, remoteNames, null, branch === currentBranch);
      const remote = t.remote;
      const target = remote ? remote + '/' + t.targetBranch : null;
      const args = ['rev-list', '--date-order', '-n', String(LOG_CAP + 1)];
      const exists = target && hasName(refs.remotes, target) ? refs.remotes[target] : null;
      if (exists) args.push('--end-of-options', exists + '..' + b.head);
      else args.push(b.head, '--not', '--remotes');
      const out = await ctx.git(args);
      const ids = out.stdout.split('\n').filter(Boolean);
      const truncated = ids.length > LOG_CAP;
      if (truncated) ids.length = LOG_CAP;
      let behind = 0;
      if (exists) behind = (await ctx.git(['rev-list', '--count', '--end-of-options', b.head + '..' + exists])).stdout.trim() * 1;
      return { branch, head: b.head, upstream, remote, target, newBranch: !exists, ids, behind, truncated };
    },
  },
];
