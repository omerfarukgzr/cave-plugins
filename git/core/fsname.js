// Which name is which entry is a question for the file system, not for string comparison: on a case-insensitive
// disk (the macOS default) `case` and `Case` are one entry, and so are the composed and the decomposed spelling of
// `Çay`. Everything that asks "is something on disk where this path goes" uses lstat on the path as git spells it;
// these helpers turn what was found back into the name the disk has, and tell whether two spellings are one entry.
import fs from 'node:fs';
import path from 'node:path';

/** A name as results show it: the form git reports (NFC on macOS; docs/PROTOCOL.md "One Unicode form for paths"). */
export const shownName = process.platform === 'darwin' ? (s) => s.normalize('NFC') : (s) => s;

export const lstat = (abs) => { try { return fs.lstatSync(abs); } catch { return null; } };

/** A key under which spellings that MAY be one entry meet (candidates only: sameEntry decides). */
export const foldName = (s) => s.normalize('NFC').toLowerCase();

/** True when both stats are the same file system entry. */
export const sameEntry = (a, b) => !!a && !!b && a.ino === b.ino && a.dev === b.dev;

/**
 * `rel` (a path that exists, spelled in any way the file system accepts) exactly as the disk names it: each part is
 * looked up in its folder, by its spelling first, then by identity. Parts that cannot be looked up stay as given.
 */
export function realRel(root, rel) {
  const out = [];
  for (const part of rel.split('/')) {
    const dir = path.join(root, ...out);
    let names = null;
    try { names = fs.readdirSync(dir); } catch { /* unreadable: keep the spelling */ }
    if (!names || names.includes(part)) { out.push(part); continue; }
    const st = lstat(path.join(dir, part));
    const hit = st ? names.find((n) => sameEntry(lstat(path.join(dir, n)), st)) : null;
    out.push(hit || part);
  }
  return out.join('/');
}
