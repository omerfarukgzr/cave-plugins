// Stash group (read side): stash.list — git's stash list (`refs/stash` and its reflog, shared by every worktree of the
// repository) with each stash's files, the way IntelliJ's Stash tab shows them (docs/spec-stash.md): what the stash
// holds against the commit it was made on, its index commit ("Index on …") and its untracked files ("Untracked files
// on …"). Quiet background reads; nothing is written.
import { changesAgainst } from './commit.js';

const FILE_CAP = 2000;
const STASH_CAP = 500;
const FILE_LANES = 4;
const SEP = '\x01';

export const LIST_ARGS = ['stash', 'list', '-z', '--format=%H%x01%P%x01%at%x01%gs'];

/**
 * One record of LIST_ARGS → a stash without its files, or null. `index` is the record's position in git's output,
 * never git's `%gd`: with `log.date` set in the user's config git prints `stash@{<date>}` there.
 */
export function parseStashRecord(rec, index) {
  const f = rec.split(SEP);
  if (f.length < 4 || !/^[0-9a-f]{40,64}$/.test(f[0])) return null;
  const parents = f[1] ? f[1].split(' ') : [];
  const subject = f.slice(3).join(SEP);
  return { index, ref: 'stash@{' + index + '}', id: f[0], parents, base: parents[0] || null, indexId: parents[1] || null,
    untrackedId: parents[2] || null, time: Number(f[2]) * 1000, subject, ...splitSubject(subject) };
}

/**
 * git's stash subject → { branch, message } as IntelliJ reads it (StashInfo, GitStashUtils.loadStashStack): before
 * the first ':' is "WIP on <branch>" / "On <branch>" (the branch is its last word; "(no branch)" is none), after it
 * the message, with git's leading abbreviated hash removed ("WIP on main: 1a2b3c4 subject" → "subject").
 */
export function splitSubject(subject) {
  const colon = subject.indexOf(':');
  if (colon < 0) return { branch: null, message: subject.trim() };
  const head = subject.slice(0, colon).trim();
  const branch = head.endsWith('(no branch)') ? null : head.split(' ').pop() || null;
  const message = subject.slice(colon + 1).trim().replace(/^[0-9a-f]{7,64}(\s+|$)/, '').trim();
  return { branch, message };
}

/** The stash list, top first: [{ index, ref, id, parents, base, indexId, untrackedId, time, subject, branch, message }]. */
export async function readStashList(ctx) {
  const out = await ctx.git(LIST_ARGS);
  const list = [];
  const recs = out.stdout.split('\0');
  for (let i = 0; i < recs.length; i++) {
    if (!recs[i]) continue;
    // a record git could not have written stops the list: positions after it would name the wrong stash@{n}
    const s = parseStashRecord(recs[i], list.length);
    if (!s) throw ctx.fail('internal', 'unreadable stash list record', { record: recs[i].slice(0, 200) });
    list.push(s);
  }
  return list;
}

const capped = (files) => ({ files: files.slice(0, FILE_CAP), truncated: files.length > FILE_CAP });

/** The files of one stash: { changes, index, untracked } (Change lists, each capped) and `truncated`. */
async function stashFiles(ctx, s) {
  const changes = s.base ? capped(await changesAgainst(ctx, s.base, s.id)) : capped([]);
  const index = s.base && s.indexId ? capped(await changesAgainst(ctx, s.base, s.indexId)) : capped([]);
  // the untracked files' commit has no parent: everything in it is added
  const untracked = s.untrackedId ? capped(await changesAgainst(ctx, null, s.untrackedId)) : capped([]);
  return { changes: changes.files, index: index.files, untracked: untracked.files,
    truncated: changes.truncated || index.truncated || untracked.truncated };
}

async function eachLimited(items, n, fn) {
  let next = 0;
  const lane = async () => { while (next < items.length) { const i = next++; await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, lane));
}

export default [
  {
    name: 'stash.list', repo: true, mutating: false,
    params: { files: { type: 'bool', default: true } },
    async handler(ctx, p) {
      const all = await readStashList(ctx);
      const stashes = all.slice(0, STASH_CAP);
      if (p.files) await eachLimited(stashes, FILE_LANES, async (s) => { s.files = await stashFiles(ctx, s); });
      return { stashes, truncated: all.length > STASH_CAP };
    },
  },
];
