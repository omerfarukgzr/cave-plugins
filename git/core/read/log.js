// Log group: log.page, log.order, log.commits, log.search, log.paths, log.fileHistory (docs/ARCHITECTURE.md §5.2).
// Order is always `git log --date-order` over the heads (default: HEAD, local and remote branches, tags). Every result
// returns the head ids it used; passing them back as `heads` keeps later pages consistent while refs move.
// The walk itself is cached per repository and refs state (core/read/walk.js): pages are slices of one walk.
import { COMMIT_FORMAT, COMMIT_FIELDS, splitNulRecords, createPeople, commitFromRecord } from '../parse.js';
import { readRefs } from '../snapshot.js';
import { LOG_CAP, startWalk, sliceCommits, walkFingerprint, walkMessages, messageMatcher, searchable } from './walk.js';

export { LOG_CAP };

/** Default heads: HEAD, local branches, remote branches, tags (each id once). Also returns the replace refs. */
export async function defaultHeads(ctx) {
  const [refs, head] = await Promise.all([
    readRefs(ctx.git, { replace: true }),
    ctx.git(['rev-parse', '--verify', '--quiet', 'HEAD'], { okCodes: [0, 1, 128] }),
  ]);
  const ids = [];
  const seen = new Set();
  const add = (id) => { if (id && !seen.has(id)) { seen.add(id); ids.push(id); } };
  add(head.exitCode === 0 ? head.stdout.trim() : null);
  Object.keys(refs.branches).sort().forEach((n) => add(refs.branches[n].head));
  Object.keys(refs.remotes).sort().forEach((n) => add(refs.remotes[n]));
  Object.keys(refs.tags).sort().forEach((n) => add(refs.tags[n]));
  ids.replace = refs.replace;
  return ids;
}

const stdinOf = (ids) => ids.join('\n') + '\n';

/** Keeps the ids that name existing commits (abbreviated ids are expanded). */
export async function existingCommits(ctx, ids) {
  if (!ids.length) return { found: [], missing: [] };
  const out = await ctx.git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: stdinOf(ids) });
  const rows = out.stdout.split('\n').filter(Boolean);
  const found = [];
  const missing = [];
  ids.forEach((id, i) => {
    const r = (rows[i] || '').split(' ');
    if (r[1] === 'commit') found.push(r[0]); else missing.push(id);
  });
  return { found, missing };
}

/** The heads of a call: given ones (checked to be commits) or the defaults; plus the walk cache key. */
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
  const key = ctx.repo.root + '\0' + heads.join(',') + '\0' + (await walkFingerprint(ctx, replace));
  return { heads, key };
}

/** The cached walk for these heads, once `need` commits of it are read (default: all of it). */
function walkOf(ctx, h, need) {
  return ctx.walks.walk(h.key, (signal) => startWalk(ctx, h.heads, signal), ctx.signal, need);
}

async function commitsFor(ctx, ids) {
  const people = createPeople();
  if (!ids.length) return { commits: [], people: people.list };
  const out = await ctx.git(['log', '-z', '--no-walk=unsorted', '--format=' + COMMIT_FORMAT, '--stdin'], { input: stdinOf(ids) });
  const commits = splitNulRecords(out.stdout, COMMIT_FIELDS).map((r) => commitFromRecord(r, people));
  return { commits, people: people.list };
}

async function idList(ctx, heads, extra, paths) {
  if (!heads.length) return { ids: [], truncated: false };
  const args = ['rev-list', '--date-order', '-n', String(LOG_CAP + 1)].concat(extra, ['--stdin']);
  if (paths) args.push('--', ...paths);
  const out = await ctx.git(args, { input: stdinOf(heads) });
  const ids = out.stdout.split('\n').filter(Boolean);
  const truncated = ids.length > LOG_CAP;
  if (truncated) ids.length = LOG_CAP;
  return { ids, truncated };
}

const HEADS = { type: 'oids', optional: true, maxItems: 200000 };

export default [
  {
    name: 'log.page', repo: true, mutating: false,
    params: { heads: HEADS, offset: { type: 'int', min: 0, max: 1e9, default: 0 }, limit: { type: 'int', min: 1, max: LOG_CAP, default: 2000 } },
    async handler(ctx, p) {
      const h = await headsOf(ctx, p);
      const heads = h.heads;
      if (!heads.length) return { heads, offset: p.offset, commits: [], people: [], more: false };
      // One record past the page tells whether there is more. The walk holds LOG_CAP + 1 records at most.
      const need = p.offset + p.limit + 1;
      const w = await walkOf(ctx, h, need <= LOG_CAP + 1 ? need : Infinity);
      if (need <= LOG_CAP + 1 || !w.truncated) {
        const to = Math.min(w.count, p.offset + p.limit);
        const { commits, people } = sliceCommits(w, Math.min(p.offset, to), to);
        return { heads, offset: p.offset, commits, people, more: w.count > to };
      }
      // Beyond the cached walk (more than LOG_CAP commits): ask git for that page.
      const people = createPeople();
      const args = ['log', '-z', '--date-order', '--format=' + COMMIT_FORMAT, '--skip=' + p.offset, '-n', String(p.limit + 1), '--stdin'];
      const out = await ctx.git(args, { input: stdinOf(heads) });
      const commits = splitNulRecords(out.stdout, COMMIT_FIELDS).map((r) => commitFromRecord(r, people));
      const more = commits.length > p.limit;
      if (more) commits.length = p.limit;
      return { heads, offset: p.offset, commits, people: people.list, more };
    },
  },
  {
    name: 'log.order', repo: true, mutating: false, params: { heads: HEADS },
    async handler(ctx, p) {
      const h = await headsOf(ctx, p);
      if (!h.heads.length) return { heads: h.heads, ids: [], truncated: false };
      const w = await walkOf(ctx, h);
      return { heads: h.heads, ids: w.ids.slice(0, LOG_CAP), truncated: w.truncated };
    },
  },
  {
    name: 'log.commits', repo: true, mutating: false, params: { ids: { type: 'oids', maxItems: LOG_CAP } },
    async handler(ctx, p) {
      const { found, missing } = await existingCommits(ctx, p.ids);
      const r = await commitsFor(ctx, found);
      return { commits: r.commits, people: r.people, missing };
    },
  },
  {
    name: 'log.search', repo: true, mutating: false,
    params: { text: { type: 'string', nonEmpty: true, maxLength: 10000 }, regex: 'bool?', caseSensitive: 'bool?', heads: HEADS },
    async handler(ctx, p) {
      const test = messageMatcher(p.text, !!p.regex, !!p.caseSensitive);
      if (!test) ctx.fail('invalid_params', 'invalid regular expression', { param: 'text', reason: 'invalid regex' });
      const h = await headsOf(ctx, p);
      if (!h.heads.length) return { heads: h.heads, ids: [], truncated: false };
      const w = await walkOf(ctx, h);
      const msgs = searchable(w, await walkMessages(ctx, w, h.heads, ctx.signal), !!p.caseSensitive);
      const n = Math.min(w.ids.length, LOG_CAP);
      let ids = [];
      for (let i = 0; i < n; i++) {
        if (test(msgs[i])) ids.push(w.ids[i]);
        if ((i & 8191) === 8191 && ctx.signal && ctx.signal.aborted) ctx.fail('cancelled', 'cancelled');
      }
      if (/^[0-9a-fA-F]{4,64}$/.test(p.text)) {
        // A hash (prefix) finds its commit as well, as IntelliJ's text filter does.
        const out = await ctx.git(['rev-parse', '--disambiguate=' + p.text.toLowerCase()], { okCodes: [0, 128] });
        const byHash = out.stdout.split('\n').filter(Boolean);
        const { found } = await existingCommits(ctx, byHash);
        const hit = new Set(ids);
        ids = found.filter((id) => w.index.has(id) && w.index.get(id) < n && !hit.has(id)).concat(ids);
      }
      return { heads: h.heads, ids, truncated: w.truncated };
    },
  },
  {
    name: 'log.paths', repo: true, mutating: false, params: { paths: { type: 'paths', maxItems: 1000 }, heads: HEADS },
    async handler(ctx, p) {
      if (!p.paths.length) ctx.fail('invalid_params', 'paths must not be empty', { param: 'paths', reason: 'empty' });
      const h = await headsOf(ctx, p);
      const key = h.key + '\0paths\0' + p.paths.join('\0');
      const r = await ctx.walks.result(key, (signal) => idList({ git: (a, o) => ctx.git(a, { ...o, signal, limitKey: 'walk:' + ctx.repo.root }) }, h.heads, ['--full-history', '--simplify-merges'], p.paths), ctx.signal);
      return { heads: h.heads, ids: r.ids.slice(), truncated: r.truncated };
    },
  },
  {
    name: 'log.fileHistory', repo: true, mutating: false,
    params: { path: 'path', rev: { type: 'rev', default: 'HEAD' }, limit: { type: 'int', min: 1, max: LOG_CAP, default: 10000 } },
    async handler(ctx, p) {
      const head = await ctx.git(['rev-parse', '--verify', '--quiet', '--end-of-options', p.rev + '^{commit}'], { okCodes: [0, 1, 128] });
      if (head.exitCode !== 0) {
        if (p.rev === 'HEAD') return { rev: p.rev, entries: [], truncated: false };
        ctx.fail('not_found', 'unknown revision ' + p.rev, { rev: p.rev });
      }
      const out = await ctx.git(['log', '--follow', '-M', '-z', '--name-status', '--format=%H', '-n', String(p.limit + 1), '--end-of-options', head.stdout.trim(), '--', p.path]);
      const entries = parseFollow(out.stdout, p.path);
      const truncated = entries.length > p.limit;
      if (truncated) entries.length = p.limit;
      return { rev: p.rev, entries, truncated };
    },
  },
];

/**
 * `git log --follow -z --name-status --format=%H` -> [{ id, path, status, oldPath? }]. The stream is NUL-separated:
 * `<id>`, then optionally `\n<status>` and one path (two for R/C). Read by position, so any byte in a path is safe.
 */
export function parseFollow(text, startPath) {
  const entries = [];
  let current = startPath;
  const tok = text.split('\0');
  for (let i = 0; i < tok.length; i++) {
    if (!tok[i]) continue;
    const id = tok[i].replace(/^[\n\x01]+/, ''); // (older callers prefixed the id with \x01)
    const e = { id, path: current, status: null };
    const st = /^\n([A-Z])\d*$/.exec(tok[i + 1] || '');
    if (st) {
      const letter = st[1];
      i += 1;
      if (letter === 'R' || letter === 'C') {
        e.status = letter === 'R' ? 'R' : 'A';
        e.oldPath = tok[i + 1];
        e.path = tok[i + 2];
        current = tok[i + 1];
        i += 2;
      } else {
        e.status = letter === 'T' ? 'M' : letter;
        e.path = tok[i + 1];
        current = tok[i + 1];
        i += 1;
      }
    }
    entries.push(e);
  }
  return entries;
}
