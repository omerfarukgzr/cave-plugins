// History group (read side): rebase.plan — the commits an interactive rebase "from here" covers.
import { splitNulRecords } from '../parse.js';
import { commitId } from './commit.js';

export default [
  {
    name: 'rebase.plan', repo: true, mutating: false, params: { from: 'rev' },
    async handler(ctx, p) {
      const from = await commitId(ctx, p.from, 'from');
      const head = await commitId(ctx, 'HEAD', 'from');
      const anc = await ctx.git(['merge-base', '--is-ancestor', from, head], { okCodes: [0, 1] });
      if (anc.exitCode !== 0) ctx.fail('refused', 'the commit is not in the current branch', { reason: 'not_in_current_branch', id: from });
      const fromInfo = await ctx.git(['log', '-1', '-z', '--format=%P', '--end-of-options', from]);
      const fromParents = fromInfo.stdout.replace(/\0$/, '').split(' ').filter(Boolean);
      if (fromParents.length > 1) ctx.fail('refused', 'the range contains a merge commit', { reason: 'merge_commit', ids: [from] });
      const base = fromParents[0] || null;
      const range = base ? [base + '..' + head] : [head];
      const [list, notPushed, br] = await Promise.all([
        ctx.git(['log', '-z', '--reverse', '--topo-order', '--format=%H%x00%P%x00%s', '--end-of-options', ...range]),
        ctx.git(['rev-list', head, '--not', '--remotes']),
        ctx.git(['symbolic-ref', '--quiet', 'HEAD'], { okCodes: [0, 1, 128] }), // full: --short says heads/x beside a tag x
      ]);
      const unpushed = new Set(notPushed.stdout.split('\n').filter(Boolean));
      const rows = splitNulRecords(list.stdout, 3);
      const merges = rows.filter((r) => r[1].split(' ').filter(Boolean).length > 1).map((r) => r[0]);
      if (merges.length) ctx.fail('refused', 'the range contains a merge commit', { reason: 'merge_commit', ids: merges });
      // Without merges the range is a straight line from `from` to HEAD.
      const entries = rows.map((r) => ({ id: r[0], subject: r[2], action: 'pick', pushed: !unpushed.has(r[0]) }));
      const full = br.exitCode === 0 ? br.stdout.trim() : '';
      return { base, head, branch: full.startsWith('refs/heads/') ? full.slice(11) : null, entries, pushed: entries.some((e) => e.pushed) };
    },
  },
];
