// Host group: app.info, repos.recent, repos.open, repos.discover, fs.complete; Jobs: job.cancel.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGit } from '../git.js';
import { expandHome } from '../home.js';
import { toNFC } from '../watch.js';
import { foldCase } from './walk.js';

const PKG = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
let gitVersion = null;

async function readGitVersion() {
  if (gitVersion) return gitVersion;
  const r = await runGit(os.tmpdir(), ['version'], { quiet: true });
  gitVersion = r.stdout.trim().replace(/^git version /, '');
  return gitVersion;
}

const isRepoDir = (dir) => { try { fs.statSync(path.join(dir, '.git')); return true; } catch { return false; } };
const SKIP = new Set(['node_modules', 'Library', 'build', 'dist', 'vendor', 'Pods', 'DerivedData', '.build']);

function absFolder(p, param) {
  const v = expandHome(p);
  if (!path.isAbsolute(v)) {
    const e = new Error(param + ' must be absolute');
    e.param = param;
    throw e;
  }
  return path.resolve(v);
}

export default [
  {
    name: 'app.info', repo: false, mutating: false, params: {},
    async handler(ctx) {
      return { name: PKG.name, version: PKG.version, node: process.versions.node, git: await readGitVersion(), platform: process.platform, home: ctx.home.dir, pid: process.pid };
    },
  },
  {
    name: 'repos.recent', repo: false, mutating: false, params: {},
    async handler(ctx) {
      return { repos: ctx.home.recent().map((r) => ({ root: r.root, name: r.name, openedAt: r.openedAt, exists: isRepoDir(r.root) })) };
    },
  },
  {
    name: 'repos.open', repo: false, mutating: false, params: { path: { type: 'string', nonEmpty: true }, remember: { type: 'bool', default: true } },
    async handler(ctx, p) {
      let folder;
      try { folder = absFolder(p.path, 'path'); } catch { ctx.fail('invalid_params', 'path must be absolute', { param: 'path', reason: 'must be absolute' }); }
      const repo = await ctx.openRepo(folder);
      if (p.remember) ctx.home.remember(repo);
      return { root: repo.root, name: repo.name, gitDir: repo.gitDir, commonDir: repo.commonDir, linked: repo.linked };
    },
  },
  {
    name: 'repos.discover', repo: false, mutating: false,
    params: { roots: { type: 'any', optional: true }, depth: { type: 'int', min: 1, max: 6, default: 3 }, limit: { type: 'int', min: 1, max: 2000, default: 500 } },
    async handler(ctx, p) {
      const rootsIn = p.roots === undefined ? ctx.home.config().discoveryRoots : p.roots;
      if (!Array.isArray(rootsIn) || rootsIn.some((r) => typeof r !== 'string')) ctx.fail('invalid_params', 'roots must be an array of folders', { param: 'roots', reason: 'must be an array of strings' });
      const roots = [];
      for (const r of rootsIn) {
        try { roots.push(absFolder(r, 'roots')); } catch { ctx.fail('invalid_params', 'roots must be absolute folders', { param: 'roots', reason: 'must be absolute' }); }
      }
      const found = [];
      const seen = new Set(); // real paths: overlapping roots list a repository once
      const deadline = Date.now() + 3000;
      let more = false; // something was left unvisited (limit or deadline)
      // Asynchronous, one folder per turn of the event loop: other requests and events are served meanwhile.
      const walk = async (dir, depth) => {
        if (more) return;
        if (Date.now() > deadline) { more = true; return; }
        if (isRepoDir(dir)) {
          let real = dir;
          try { real = await fs.promises.realpath(dir); } catch { /* keep it */ }
          if (seen.has(real)) return;
          if (found.length >= p.limit) { more = true; return; }
          seen.add(real);
          found.push({ root: dir, name: path.basename(dir) });
          return;
        }
        if (depth <= 0) return;
        let list;
        try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const d of list) {
          if (!d.isDirectory() || d.name.startsWith('.') || SKIP.has(d.name)) continue;
          await walk(path.join(dir, d.name), depth - 1);
          if (more) return;
        }
      };
      for (const r of roots) await walk(r, p.depth);
      return { repos: found, truncated: more };
    },
  },
  {
    name: 'fs.complete', repo: false, mutating: false, params: { prefix: { type: 'string', nonEmpty: true }, limit: { type: 'int', min: 1, max: 500, default: 100 } },
    async handler(ctx, p) {
      // "~" and "~/…" keep what follows the tilde as typed: "~/" lists the home folder itself.
      const v = p.prefix === '~' || p.prefix.startsWith('~/') ? os.homedir() + p.prefix.slice(1) : p.prefix;
      if (!path.isAbsolute(v)) ctx.fail('invalid_params', 'prefix must be absolute or start with ~', { param: 'prefix', reason: 'must be absolute' });
      // Split at the last '/' as typed (no path.resolve first: "folder/." asks for the hidden folders in it).
      const slash = v.lastIndexOf('/');
      const dir = path.resolve(v.slice(0, slash + 1) || '/');
      const base = v.slice(slash + 1);
      let list;
      try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return { dir, entries: [] }; }
      const want = foldCase(base);
      const entries = list
        .filter((d) => (d.isDirectory() || (d.isSymbolicLink() && isDir(path.join(dir, d.name)))) && foldCase(d.name).startsWith(want) && (base.startsWith('.') || !d.name.startsWith('.')))
        .map((d) => ({ name: toNFC(d.name), path: toNFC(path.join(dir, d.name)), repo: isRepoDir(path.join(dir, d.name)) }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, p.limit);
      return { dir, entries };
    },
  },
  {
    name: 'job.cancel', repo: false, mutating: false, params: { job: { type: 'int', min: 1 } },
    async handler(ctx, p) {
      if (!ctx.jobs.get(p.job)) ctx.fail('not_found', 'no such job', { job: p.job });
      return { cancelled: ctx.jobs.cancel(p.job) };
    },
  },
];

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
