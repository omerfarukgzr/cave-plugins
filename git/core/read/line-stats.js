// changes.lineStats: added and deleted lines of every local change, HEAD against the work tree (staging ignored, as the
// snapshot's `local` is), for the Commit view's "Changes  5 files  +120 −34". One `git diff --numstat`; untracked files
// are not in it (they are not in the Changes group either), binary files carry nulls, submodules are left out.
// A quiet background read; nothing is written (the empty tree id of an unborn HEAD is hashed, not stored).

const MAX_BYTES = 64 * 1024 * 1024;

/** `git diff --numstat -z` → [{ path, added, deleted }] (`added`/`deleted` null for a binary file; a rename by its new path). */
export function parseNumstatZ(out) {
  const tok = out.split('\0');
  const files = [];
  let i = 0;
  while (i < tok.length) {
    const rec = tok[i++].replace(/^\n/, '');
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/.exec(rec);
    if (!m) continue;
    let p = m[3];
    if (p === '') { i++; p = tok[i++]; }        // a rename or copy: "A\tD\t\0old\0new"
    if (p === undefined || p === '') continue;
    const bin = m[1] === '-' || m[2] === '-';
    files.push({ path: p, added: bin ? null : Number(m[1]), deleted: bin ? null : Number(m[2]) });
  }
  return files;
}

/** HEAD's commit, or the empty tree (in the repository's hash format) when HEAD is unborn. */
async function base(ctx) {
  const head = await ctx.git(['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { okCodes: [0, 1, 128] });
  const id = head.exitCode === 0 ? head.stdout.trim() : '';
  if (id) return id;
  const empty = await ctx.git(['hash-object', '-t', 'tree', '--stdin'], { input: '' });
  return empty.stdout.trim();
}

export default [
  {
    name: 'changes.lineStats', repo: true, mutating: false,
    params: {},
    async handler(ctx) {
      const from = await base(ctx);
      const out = await ctx.git(['diff', '--numstat', '-z', '--find-renames', '--no-ext-diff', '--no-textconv',
        '--ignore-submodules=all', from, '--'], { maxBytes: MAX_BYTES });
      return { base: from, files: parseNumstatZ(out.stdout) };
    },
  },
];
