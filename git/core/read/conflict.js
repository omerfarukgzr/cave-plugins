// In progress group (read side): conflict.read — the three versions of an unmerged file and what each side is.
//
// Stage 1 is the common base, stage 2 "yours" (ours), stage 3 "theirs". Which commit each side is depends on the
// operation (see the snapshot's op.yours / op.theirs): in a merge yours is the current branch; in a rebase yours is
// the branch being rebased onto and theirs the commit being applied; in a cherry-pick theirs is the picked commit;
// in a revert theirs is the parent side of the reverted commit.
import { readSource } from './content.js';

// Which stages exist -> git's two-letter kind (as `git status` prints them).
const KIND_BY_STAGES = {
  '123': 'both-modified', '23': 'both-added', '12': 'deleted-by-them', '13': 'deleted-by-us',
  '2': 'added-by-us', '3': 'added-by-them', '1': 'both-deleted',
};

export function kindFromStages(stages) {
  return KIND_BY_STAGES[Array.from(new Set(stages)).sort().join('')] || 'both-modified';
}

export default [
  {
    name: 'conflict.read', repo: true, mutating: false,
    params: { path: 'path', maxBytes: { type: 'int', min: 1, max: 64 * 1024 * 1024, default: 5 * 1024 * 1024 } },
    async handler(ctx, p) {
      const out = await ctx.git(['ls-files', '-u', '-z', '--', p.path]);
      const stages = out.stdout.split('\0').filter((r) => r && r.slice(r.indexOf('\t') + 1) === p.path)
        .map((r) => Number(r.slice(0, r.indexOf('\t')).split(' ')[2]));
      if (!stages.length) ctx.fail('not_found', 'no conflict on ' + p.path, { path: p.path, reason: 'not_conflicted' });
      const read = (stage) => (stages.includes(stage) ? readSource(ctx, { path: p.path, stage }, p.maxBytes) : Promise.resolve(null));
      const [snap, base, yours, theirs, worktree] = await Promise.all([
        ctx.snapshot(),
        read(1), read(2), read(3),
        readSource(ctx, { path: p.path, worktree: true }, p.maxBytes),
      ]);
      const op = snap.op; // null for conflicts without an operation (e.g. a stash pop that conflicted)
      const sides = [base, yours, theirs].filter(Boolean);
      return {
        path: p.path,
        kind: kindFromStages(stages),
        type: op ? op.type : null,
        labels: { yours: op ? op.yours : null, theirs: op ? op.theirs : null },
        binary: sides.some((s) => s.binary),
        tooLarge: sides.some((s) => s.tooLarge),
        base,
        yours,
        theirs,
        worktree,
      };
    },
  },
];
