// Read additions of the working tree area (docs/PROTOCOL.md):
//   files.ignored — the ignored files and folders, for the Commit view's "Ignored Files" node and the Files tool window's
//                   ignored color (IntelliJ's FILESTATUS_IGNORED). Folders git ignores as a whole come back as one entry.
//   annotate      — `blame` with IntelliJ's annotation options (Ignore Whitespaces -w, Detect Movements Within File -M,
//                   Detect Movements Across Files -C) and the file's current revision (the lines IntelliJ marks bold
//                   with "*": the last commit that changed the file at the annotated revision).
import fs from 'node:fs';
import { workPath } from '../repo.js';
import { parseBlame } from '../parse.js';
import { commitId } from './commit.js';

const MAX_IGNORED = 5000;

/** `git status --ignored` entries ("!! path"), folders with a trailing '/'. */
async function ignoredByStatus(ctx, dir, max) {
  const args = ['status', '--porcelain=v1', '-z', '--ignored=traditional', '--untracked-files=normal', '--no-renames'];
  if (dir) args.push('--', dir);
  const out = await ctx.git(args, { maxBytes: 64 * 1024 * 1024 });
  const entries = [];
  let truncated = false;
  for (const rec of out.stdout.split('\0')) {
    if (!rec.startsWith('!! ')) continue;
    if (entries.length >= max) { truncated = true; break; }
    const p = rec.slice(3);
    entries.push(p.endsWith('/') ? { path: p.slice(0, -1), dir: true } : { path: p, dir: false });
  }
  return { entries, truncated };
}

/** The folder's own entries when git ignores the folder as a whole (git status shows it as one line). */
function listFolder(ctx, dir, max) {
  const abs = workPath(ctx.repo, dir);
  let names = [];
  try { names = fs.readdirSync(abs, { withFileTypes: true }); } catch { return { entries: [], truncated: false }; }
  names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const entries = [];
  for (const d of names) {
    if (d.name === '.git') continue;
    if (entries.length >= max) return { entries, truncated: true };
    entries.push({ path: dir + '/' + d.name, dir: d.isDirectory() });
  }
  return { entries, truncated: false };
}

export default [
  {
    name: 'files.ignored', repo: true, mutating: false,
    params: { path: 'path?', max: { type: 'int', min: 1, max: 50000, default: MAX_IGNORED } },
    async handler(ctx, p) {
      const dir = p.path ? p.path.replace(/\/$/, '') : '';
      if (dir) {
        // inside a folder git ignores as a whole: everything in it is ignored, git lists only the folder
        // (check-ignore refuses literal pathspecs; the path goes in on stdin, as core/engine.js does it)
        const r = await ctx.git(['check-ignore', '-z', '--stdin'], { okCodes: [0, 1], input: dir + '\0', env: { GIT_LITERAL_PATHSPECS: '0' } });
        if (r.exitCode === 0 && r.stdout.split('\0').includes(dir)) return { path: dir, ignoredFolder: true, ...listFolder(ctx, dir, p.max) };
      }
      return { path: dir, ignoredFolder: false, ...(await ignoredByStatus(ctx, dir, p.max)) };
    },
  },
  {
    name: 'annotate', repo: true, mutating: false,
    params: { path: 'path', rev: 'rev?', ignoreWhitespace: 'bool?', movesInFile: 'bool?', movesAcrossFiles: 'bool?' },
    async handler(ctx, p) {
      const id = p.rev !== undefined ? await commitId(ctx, p.rev, 'rev') : null;
      const args = ['blame', '--porcelain'];
      if (p.ignoreWhitespace) args.push('-w');
      if (p.movesInFile) args.push('-M');
      if (p.movesAcrossFiles) args.push('-C');
      if (id) args.push(id);
      args.push('--', p.path);
      let out;
      try { out = await ctx.git(args, { maxBytes: 256 * 1024 * 1024 }); } catch (e) {
        if (e.name === 'GitError' && /no such path|no such file|cannot stat/i.test(e.stderr || '')) ctx.fail('not_found', 'file is not in the repository: ' + p.path, { path: p.path, reason: 'not_tracked' });
        throw e;
      }
      const r = parseBlame(out.stdout);
      const ids = Object.keys(r.commits);
      if (ids.length) {
        const s = await ctx.git(['log', '-z', '--no-walk=unsorted', '--format=%H%x00%s', '--stdin'], { input: ids.join('\n') + '\n' });
        const tok = s.stdout.split('\0');
        for (let i = 0; i + 1 < tok.length; i += 2) {
          const cid = tok[i].replace(/^\n/, '');
          if (Object.prototype.hasOwnProperty.call(r.commits, cid)) r.commits[cid].subject = tok[i + 1];
        }
      }
      // the file's current revision: the newest commit at `rev` (or HEAD) that changed it
      const last = await ctx.git(['log', '-1', '--format=%H', id || 'HEAD', '--', p.path], { okCodes: [0, 128] });
      const current = last.exitCode === 0 ? last.stdout.trim() || null : null;
      return { path: p.path, rev: id, current, lines: r.lines, commits: r.commits,
        options: { ignoreWhitespace: !!p.ignoreWhitespace, movesInFile: !!p.movesInFile, movesAcrossFiles: !!p.movesAcrossFiles } };
    },
  },
];
