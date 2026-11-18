// Additive reads of the Log wave (registered in core/methods.js; docs/PROTOCOL.md).
// log.graphOrder: the Log's Graph Options (IntelliJ's "Sort: By Commit Date / Topologically", "Options: First Parent,
//   No Merges") as one commit walk: `git rev-list --date-order|--topo-order [--first-parent] [--no-merges]` over the
//   Log's heads. Cached with the walk key (heads, replace refs, shallow/grafts) plus the options, like log.paths.
// files.listAt: every file of a revision (Show Repository at Revision), `git ls-tree -r`.
import { LOG_CAP, walkFingerprint } from './walk.js';
import { defaultHeads, existingCommits } from './log.js';
import { commitId } from './commit.js';

const stdinOf = (ids) => ids.join('\n') + '\n';
const HEADS = { type: 'oids', optional: true, maxItems: 200000 };
const FILES_CAP = 200000;

/** The heads of a call (given ones checked to be commits, or the Log's defaults) and the walk cache key. */
async function headsOf(ctx, p) {
  let heads;
  let replace;
  if (p.heads && p.heads.length) {
    const { found, missing } = await existingCommits(ctx, p.heads);
    if (missing.length) ctx.fail('not_found', 'heads must name commits', { param: 'heads', ids: missing.slice(0, 20) });
    heads = Array.from(new Set(found));
  } else {
    heads = await defaultHeads(ctx);
    replace = heads.replace;
  }
  return { heads, key: ctx.repo.root + '\0' + heads.join(',') + '\0' + (await walkFingerprint(ctx, replace)) };
}

/** The rev-list arguments of a graph order (exported for tests). */
export function graphOrderArgs(o) {
  return ['rev-list', o.sort === 'topo' ? '--topo-order' : '--date-order', ...(o.firstParent ? ['--first-parent'] : []),
    ...(o.noMerges ? ['--no-merges'] : []), '-n', String(LOG_CAP + 1), '--stdin'];
}

export default [
  {
    name: 'log.graphOrder', repo: true, mutating: false,
    params: { heads: HEADS, sort: { type: 'enum', values: ['date', 'topo'], default: 'date' }, firstParent: 'bool?', noMerges: 'bool?' },
    async handler(ctx, p) {
      const h = await headsOf(ctx, p);
      if (!h.heads.length) return { heads: h.heads, sort: p.sort, firstParent: !!p.firstParent, noMerges: !!p.noMerges, ids: [], truncated: false };
      const o = { sort: p.sort, firstParent: !!p.firstParent, noMerges: !!p.noMerges };
      const key = h.key + '\0graph\0' + o.sort + (o.firstParent ? '\0fp' : '') + (o.noMerges ? '\0nm' : '');
      const r = await ctx.walks.result(key, async (signal) => {
        const out = await ctx.git(graphOrderArgs(o), { input: stdinOf(h.heads), signal, limitKey: 'walk:' + ctx.repo.root });
        const ids = out.stdout.split('\n').filter(Boolean);
        const truncated = ids.length > LOG_CAP;
        if (truncated) ids.length = LOG_CAP;
        return { ids, truncated };
      }, ctx.signal);
      return { heads: h.heads, ...o, ids: r.ids.slice(), truncated: r.truncated };
    },
  },
  {
    name: 'files.listAt', repo: true, mutating: false, params: { rev: 'rev' },
    async handler(ctx, p) {
      const id = await commitId(ctx, p.rev, 'rev');
      // "<mode> SP <type> SP <object> TAB <path>" per NUL-terminated record (the default format of every git version)
      const out = await ctx.git(['ls-tree', '-r', '-z', '--full-tree', '--end-of-options', id]);
      const files = [];
      const submodules = [];
      for (const rec of out.stdout.split('\0')) {
        const tab = rec.indexOf('\t');
        if (tab < 0) continue;
        const type = rec.slice(0, tab).split(' ')[1], file = rec.slice(tab + 1);
        if (type === 'blob') files.push(file); else if (type === 'commit') submodules.push(file);
      }
      const truncated = files.length > FILES_CAP;
      if (truncated) files.length = FILES_CAP;
      return { rev: p.rev, id, files, submodules, truncated };
    },
  },
];
