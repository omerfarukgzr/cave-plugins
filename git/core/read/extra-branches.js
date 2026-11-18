// Read additions of the branches / merge / rebase wave (docs/PROTOCOL.md): rebase.planOnto — the commits the Rebase
// dialog's --interactive covers (`upstream..branch`, or the whole branch with --root), for the Rebasing Commits dialog.
// With --autosquash (or rebase.autoSquash in the config, unless --no-autosquash) the plan comes the way git prepares
// its todo list: `fixup!` / `squash!` / `amend!` commits are moved under the commit they name and marked.
import { splitNulRecords } from '../parse.js';
import { commitId } from './commit.js';
import { resolveRef, branchOf } from '../ops/util.js';

const MARK = /^(fixup|squash|amend)! /;

/**
 * git's autosquash rearrangement (sequencer.c todo_list_rearrange_squash) over `rows` ([{ id, subject, message }],
 * oldest first): a commit whose subject starts with `fixup! `, `squash! ` or `amend! ` (repeated prefixes allowed) melts
 * into the earlier commit it names — by its exact subject, by a hash prefix, else by the start of a subject — and is
 * moved right after it (after the ones already melted in). Returns [{ id, action: 'pick'|'fixup'|'squash', message? }];
 * an `amend!` commit's body replaces its target's message (git's `fixup -C`), carried on the target as `message`.
 */
export function autosquash(rows) {
  const out = rows.map((r) => ({ id: r.id, action: 'pick', target: -1, message: null }));
  const bySubject = new Map();
  rows.forEach((r, i) => {
    let rest = r.subject, kind = null;
    for (let m = MARK.exec(rest); m; m = MARK.exec(rest)) { if (!kind) kind = m[1]; rest = rest.slice(m[0].length); }
    if (kind) {
      let at = bySubject.has(rest) ? bySubject.get(rest) : -1;
      if (at < 0 && /^[0-9a-f]{4,40}$/i.test(rest)) at = rows.findIndex((x, k) => k < i && x.id.startsWith(rest.toLowerCase()));
      if (at < 0 && rest) at = rows.findIndex((x, k) => k < i && x.subject.startsWith(rest));
      if (at >= 0) {
        const root = out[at].target >= 0 ? out[at].target : at;
        out[i].action = kind === 'squash' ? 'squash' : 'fixup';
        out[i].target = root;
        if (kind === 'amend') {
          const body = String(r.message || '').split('\n').slice(1).join('\n').replace(/^\s+|\s+$/g, '');
          if (body) out[root].message = body;
        }
      }
    }
    if (!bySubject.has(r.subject)) bySubject.set(r.subject, i);
  });
  const children = new Map();
  out.forEach((e, i) => { if (e.target >= 0) { if (!children.has(e.target)) children.set(e.target, []); children.get(e.target).push(i); } });
  const order = [];
  out.forEach((e, i) => { if (e.target < 0) order.push(i, ...(children.get(i) || [])); });
  return order.map((i) => (out[i].message != null ? { id: out[i].id, action: out[i].action, message: out[i].message } : { id: out[i].id, action: out[i].action }));
}

export default [
  {
    // Which remotes have tag `name` (git ls-remote): the Deleted Tag notification offers "Delete on Remote" for them.
    name: 'tag.remotes', repo: true, mutating: false, params: { name: 'string' },
    async handler(ctx, p) {
      if (!/^[^\s~^:?*[\\]+$/.test(p.name) || p.name.startsWith('-')) ctx.fail('invalid_params', 'not a tag name', { param: 'name', reason: 'not a tag name' });
      const list = (await ctx.git(['remote'])).stdout.split('\n').filter(Boolean);
      const remotes = [];
      for (const remote of list) {
        const r = await ctx.git(['ls-remote', '--tags', '--end-of-options', remote, 'refs/tags/' + p.name], { okCodes: [0, 1, 2, 128] });
        if (r.exitCode === 0 && r.stdout.trim()) remotes.push(remote);
      }
      return { tag: p.name, remotes };
    },
  },
  {
    name: 'rebase.planOnto', repo: true, mutating: false,
    params: { upstream: 'rev', branch: 'rev?', root: 'bool?', autosquash: 'bool?', noAutosquash: 'bool?' },
    async handler(ctx, p) {
      // Ref names: a bare name is the local branch before a tag of that name; `branch` is a name or refs/heads/…
      const upstream = (await resolveRef(ctx, p.upstream, 'upstream')).id;
      let head, branch;
      if (p.branch) {
        const name = branchOf(p.branch) || p.branch;
        const r = await ctx.git(['rev-parse', '--verify', '--quiet', '--end-of-options', 'refs/heads/' + name], { okCodes: [0, 1, 128] });
        if (r.exitCode !== 0) ctx.fail('not_found', 'no local branch ' + name, { param: 'branch', rev: name });
        head = r.stdout.trim();
        branch = name;
      } else {
        head = await commitId(ctx, 'HEAD', 'branch');
        const br = await ctx.git(['symbolic-ref', '--quiet', 'HEAD'], { okCodes: [0, 1, 128] }); // full: --short says heads/x beside a tag x
        branch = br.exitCode === 0 && br.stdout.startsWith('refs/heads/') ? br.stdout.trim().slice(11) : null;
      }
      const cfg = await ctx.git(['config', '--type=bool', '--get', 'rebase.autoSquash'], { okCodes: [0, 1, 128] });
      const squash = !!p.autosquash || (!p.noAutosquash && cfg.exitCode === 0 && cfg.stdout.trim() === 'true');
      const [list, notPushed] = await Promise.all([
        ctx.git(['log', '-z', '--reverse', '--topo-order', '--format=%H%x00%P%x00%B', '--end-of-options', p.root ? head : upstream + '..' + head]),
        ctx.git(['rev-list', head, '--not', '--remotes']),
      ]);
      const rows = splitNulRecords(list.stdout, 3).map(([id, parents, message]) => ({ id, parents: parents.split(' ').filter(Boolean),
        message: message.replace(/\s+$/, ''), subject: message.split('\n')[0] }));
      const merges = rows.filter((r) => r.parents.length > 1).map((r) => r.id);
      if (merges.length) ctx.fail('refused', 'the range contains a merge commit', { reason: 'merge_commit', ids: merges });
      const unpushed = new Set(notPushed.stdout.split('\n').filter(Boolean));
      const byId = new Map(rows.map((r) => [r.id, r]));
      const plan = squash ? autosquash(rows) : rows.map((r) => ({ id: r.id, action: 'pick' }));
      const entries = plan.map((e) => Object.assign({ id: e.id, subject: byId.get(e.id).subject, action: e.action, pushed: !unpushed.has(e.id) },
        e.message != null ? { message: e.message } : {}));
      return { upstream, head, branch, root: !!p.root, autosquash: squash, entries, pushed: entries.some((e) => e.pushed) };
    },
  },
];
