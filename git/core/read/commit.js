// Commit details group: commit.details, commit.containing.
import { parseRawDiff, changeFromRaw, splitNulRecords, parseFieldLines } from '../parse.js';

/** Resolves a revision to a full commit id or fails with not_found. */
export async function commitId(ctx, rev, param = 'id') {
  const r = await ctx.git(['rev-parse', '--verify', '--quiet', '--end-of-options', rev + '^{commit}'], { okCodes: [0, 1, 128] });
  if (r.exitCode !== 0) ctx.fail('not_found', 'unknown commit ' + rev, { param, rev });
  return r.stdout.trim();
}

/** Changes of a commit against one parent (null = root commit: everything added). Renames detected. */
export async function changesAgainst(ctx, parent, id) {
  const args = parent
    ? ['diff-tree', '-r', '-z', '--raw', '--no-abbrev', '-M', '--no-commit-id', '--end-of-options', parent, id]
    : ['diff-tree', '-r', '-z', '--raw', '--no-abbrev', '--root', '--no-commit-id', '--end-of-options', id];
  const out = await ctx.git(args);
  return parseRawDiff(out.stdout).map(changeFromRaw);
}

export default [
  {
    name: 'commit.details', repo: true, mutating: false, params: { id: 'rev' },
    async handler(ctx, p) {
      const id = await commitId(ctx, p.id);
      // %B is the message as it was written: `subject` (%s) folds a first paragraph of several lines into one line
      const out = await ctx.git(['log', '-1', '-z', '--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%s%x00%b%x00%B', '--end-of-options', id]);
      const [rec] = splitNulRecords(out.stdout, 11);
      const parents = rec[1] ? rec[1].split(' ') : [];
      const changes = [];
      if (!parents.length) changes.push({ parent: null, files: await changesAgainst(ctx, null, id) });
      for (const parent of parents) changes.push({ parent, files: await changesAgainst(ctx, parent, id) });
      return {
        id,
        parents,
        author: { name: rec[2], email: rec[3] },
        time: Number(rec[4]) * 1000,
        committer: { name: rec[5], email: rec[6] },
        commitTime: Number(rec[7]) * 1000,
        subject: rec[8],
        body: rec[9].replace(/\n+$/, ''),
        message: rec[10].replace(/\n+$/, ''),
        root: parents.length === 0,
        merge: parents.length > 1,
        changes,
      };
    },
  },
  {
    name: 'commit.containing', repo: true, mutating: false, params: { id: 'rev' },
    async handler(ctx, p) {
      const id = await commitId(ctx, p.id);
      const [refsOut, inHead] = await Promise.all([
        ctx.git(['for-each-ref', '--format=%(refname)%00%(symref)', '--contains', id, 'refs/heads', 'refs/remotes', 'refs/tags']),
        ctx.git(['merge-base', '--is-ancestor', id, 'HEAD'], { okCodes: [0, 1, 128] }),
      ]);
      const branches = [];
      const remotes = [];
      const tags = [];
      for (const [ref, symref] of parseFieldLines(refsOut.stdout, 2)) {
        if (ref.startsWith('refs/heads/')) branches.push(ref.slice(11));
        else if (ref.startsWith('refs/remotes/')) { if (!symref) remotes.push(ref.slice(13)); }
        else if (ref.startsWith('refs/tags/')) tags.push(ref.slice(10));
      }
      return { id, head: inHead.exitCode === 0, branches, remotes, tags, pushed: remotes.length > 0 };
    },
  },
];
