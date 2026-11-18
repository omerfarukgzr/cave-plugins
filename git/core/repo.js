// Opening a repository (docs/ARCHITECTURE.md §3.1): resolve the work tree root, refuse bare repositories, and tell the
// per-worktree git dir from the common dir.
//
// In a linked worktree (`git worktree add`) the two differ:
//   gitDir     <main>/.git/worktrees/<name>  HEAD, index, MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, REBASE_HEAD,
//                                             rebase-merge/, rebase-apply/, sequencer/, logs/HEAD
//   commonDir  <main>/.git                    refs/, packed-refs, objects/, config, worktrees/
// In a normal repository both are <root>/.git.
import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './git.js';
import { EngineError } from './errors.js';
import { PRODUCT } from './product.js';

/** The engine's own folder inside a git dir (`<gitDir>/<name>/`: trash, temporary files, state.json). The engine sets
    `repo.dataDir` from its `dataDir` option (default `git-panel`, core/product.js; a host may pass its own). */
export const DATA_DIR = PRODUCT.id;
export const dataDir = (repo) => (repo && repo.dataDir) || DATA_DIR;
/** The product name the engine writes into git (reflog and stash messages); `repo.label`, option `label`. */
export const LABEL = PRODUCT.name;
export const label = (repo) => (repo && repo.label) || LABEL;

export async function resolveRepo(folder, opts = {}) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) {
    throw new EngineError('invalid_params', 'repository path must be absolute', { param: 'repo', reason: 'must be absolute' });
  }
  let real;
  try {
    real = fs.realpathSync(folder);
    if (!fs.statSync(real).isDirectory()) throw new Error('not a folder');
  } catch {
    throw new EngineError('not_a_repo', 'folder does not exist: ' + folder, { reason: 'missing', path: folder });
  }
  const run = (args) => runGit(real, args, { quiet: true, optionalLocks: false, env: opts.env, trace: opts.trace });
  let first;
  let top;
  try {
    first = await run(['rev-parse', '--path-format=absolute', '--is-bare-repository', '--is-inside-work-tree', '--git-dir', '--git-common-dir']);
    const [bare, inside] = first.stdout.trim().split('\n');
    if (bare === 'true') throw new EngineError('not_a_repo', 'bare repositories are not supported: ' + folder, { reason: 'bare', path: folder });
    if (inside !== 'true') throw new EngineError('not_a_repo', 'not inside a work tree: ' + folder, { reason: 'not_a_repo', path: folder });
    top = await run(['rev-parse', '--show-toplevel']);
  } catch (e) {
    if (e.name === 'GitError') throw new EngineError('not_a_repo', 'not a git repository: ' + folder, { reason: 'not_a_repo', path: folder });
    throw e;
  }
  const [, , gitDir, commonDir] = first.stdout.trim().split('\n');
  let root, gd, cd;
  try {
    root = fs.realpathSync(top.stdout.trim());
    gd = fs.realpathSync(gitDir);
    cd = fs.realpathSync(commonDir);
  } catch {
    throw new EngineError('not_a_repo', 'the git directory of ' + folder + ' is missing', { reason: 'not_a_repo', path: folder });
  }
  return { root, name: path.basename(root), gitDir: gd, commonDir: cd, linked: gd !== cd, gitDirId: dirId(gd), folder: real };
}

function dirId(p) { try { const st = fs.statSync(p); return st.dev + ':' + st.ino; } catch { return null; } }

/**
 * Whether a cached resolution of `folder` still describes the repository git would find (a few stats, no git):
 * the root and both git dirs exist (the same git dir, not one created again), the root still has its `.git`, and no
 * folder between `folder` and the root has become a repository of its own.
 */
export function resolutionHolds(folder, repo) {
  if (!repo.gitDirId || dirId(repo.gitDir) !== repo.gitDirId) return false;
  if (!fs.existsSync(repo.commonDir) || !fs.existsSync(path.join(repo.gitDir, 'HEAD'))) return false;
  try { fs.lstatSync(path.join(repo.root, '.git')); } catch { return false; }
  let real;
  try { real = fs.realpathSync(folder); } catch { return false; }
  if (real !== repo.folder) return false;
  for (let d = real; d !== repo.root; d = path.dirname(d)) {
    if (!isInside(d, repo.root) || d === path.dirname(d)) return false;
    try { fs.lstatSync(path.join(d, '.git')); return false; } catch { /* not a repository of its own */ }
  }
  return true;
}

/** True when `p` is `dir` or inside it (both absolute and real). */
export function isInside(p, dir) {
  const rel = path.relative(dir, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Absolute path of a repository-relative path, after checking it stays inside the work tree. As git itself, the
 * engine never goes "beyond a symbolic link": a path whose parent folder is a symlink is refused (wherever the link
 * points, inside the tree, outside it or at the git dir), and so is a path that lands in a git dir.
 */
export function workPath(repo, rel) {
  const abs = path.join(repo.root, rel.replace(/\/+$/, ''));
  if (!isInside(abs, repo.root)) throw new EngineError('invalid_params', 'path escapes the repository', { param: 'path', reason: 'escapes' });
  const escapes = (why, reason = 'escapes') => new EngineError('invalid_params', 'path ' + why, { param: 'path', reason });
  let parent = path.dirname(abs);
  while (!fs.existsSync(parent) && parent !== repo.root) parent = path.dirname(parent);
  let realParent;
  try { realParent = fs.realpathSync(parent); } catch { throw escapes('goes through a symbolic link loop'); }
  if (!isInside(realParent, repo.root)) throw escapes('escapes the repository through a symlink');
  if ([repo.gitDir, repo.commonDir].some((d) => d && isInside(realParent, d))) throw escapes('points into the git directory');
  const parts = path.relative(repo.root, abs).split(path.sep).filter(Boolean);
  let cur = repo.root;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = path.join(cur, parts[i]);
    let st;
    try { st = fs.lstatSync(cur); } catch { break; } // the rest does not exist: nothing to follow
    // A link that stays inside the work tree: git knows no tracked path behind it (reason 'beyond_symlink').
    if (st.isSymbolicLink()) throw escapes('is beyond a symbolic link: ' + parts.slice(0, i + 1).join('/'), 'beyond_symlink');
  }
  return abs;
}

export function readGitFile(dir, name) {
  try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch { return null; }
}

export function existsIn(dir, name) {
  try { fs.statSync(path.join(dir, name)); return true; } catch { return false; }
}
