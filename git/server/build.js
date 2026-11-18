// The build stamp (docs/ARCHITECTURE.md §7 "Builds"): which code a server runs, so a launcher can tell a server of an
// older build from one of the installed build, and a page can tell that the server it talks to came back as another
// build (ui/host/standalone.js reloads then).
//
//   { version, hash, files, dev }
//     version  package.json's version
//     hash     sha256 (hex, 16 chars) over the relative path and the bytes of every file that runs: core/, ui/,
//              server/, bin/, package.json and the host's folder (the folder of its identity file, when it lies inside
//              the root); dot files and build.json are left out
//     files    how many files the hash covers
//     dev      true when computed from a working tree (no build.json); a packed copy carries build.json, written by
//              tools/server-paket.mjs with the same function, so both ways give the same hash for the same files
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const BUILD_FILE = 'build.json';
export const BASE_PARTS = Object.freeze(['core', 'ui', 'server', 'bin', 'package.json']);

function walk(root, rel, out) {
  const abs = path.join(root, rel);
  let st;
  try { st = fs.lstatSync(abs); } catch { return; }
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) if (!name.startsWith('.')) walk(root, rel ? rel + '/' + name : name, out);
  } else if (st.isFile() && path.posix.basename(rel) !== BUILD_FILE) out.push(rel);
}

/** The relative paths (sorted, '/') of what runs: the base parts plus `hostRel` (a folder relative to root, or null). */
export function buildFiles(root, hostRel = null) {
  const out = [];
  for (const p of BASE_PARTS.concat(hostRel ? [hostRel] : [])) walk(root, p, out);
  return Array.from(new Set(out)).sort();
}

export function hashFiles(root, files) {
  const h = crypto.createHash('sha256');
  for (const rel of files) { h.update(rel); h.update('\0'); h.update(fs.readFileSync(path.join(root, rel))); h.update('\0'); }
  return h.digest('hex').slice(0, 16);
}

function versionOf(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || null; } catch { return null; }
}

/** The host folder of an identity file relative to root ('/' separated), or null when it is not inside root. */
export function hostFolder(root, identityFile) {
  if (!identityFile) return null;
  const rel = path.relative(fs.realpathSync(root), fs.realpathSync(path.dirname(identityFile)));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

/** Computes the stamp of the files under root (what tools/server-paket.mjs writes into build.json). */
export function computeBuild(root, hostRel = null) {
  const files = buildFiles(root, hostRel);
  return { version: versionOf(root), hash: hashFiles(root, files), files: files.length };
}

/** The stamp of the code under root: build.json of a packed copy, else computed from the working tree (dev). */
export function buildStamp(root, identityFile = null) {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(root, BUILD_FILE), 'utf8'));
    if (b && typeof b.hash === 'string' && /^[0-9a-f]{16}$/.test(b.hash)) return { version: b.version || null, hash: b.hash, files: b.files || null, dev: false, builtAt: b.builtAt || null };
  } catch { /* not a packed copy */ }
  try { return { ...computeBuild(root, hostFolder(root, identityFile)), dev: true }; } catch { return { version: versionOf(root), hash: null, files: 0, dev: true }; }
}
