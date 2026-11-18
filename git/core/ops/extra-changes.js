// Working tree additions of the working tree wave (additive; core/ops/worktree.js stays as it is):
//   changes.write — writes one file of the work tree, for the diff's "Revert" / "Append" of a single change block.
//
// The UI computes the new text from the content it showed, so the write is refused when the file on disk no longer
// holds that content (`expect` = UTF-16 length + textHash of the decoded text the edit was computed from). The bytes
// it replaces go to the trash first (docs/ARCHITECTURE.md §3.5). Encoding, BOM and the file mode are kept: a Latin-1
// file is written back as Latin-1, a file with a BOM keeps it; line ends are whatever `text` holds.
import fs from 'node:fs';
import { workPath } from '../repo.js';
import { decodeContent } from '../read/content.js';
import { refuse, trash, failedAfterSaving } from './util.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * 53-bit string hash (cyrb53) over UTF-16 code units, as lower-case hex. The UI has the same function
 * (ui/git/changes-model.js `Git.changesModel.textHash`); test/ui/changes-model.test.js keeps the two equal.
 */
export function textHash(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/**
 * One .gitignore line that matches exactly `rel` from the repository root (gitignore(5) escapes), or null when no
 * line can: a pattern ends at a line feed and nothing escapes one (test/core/qa3-misc.test.js checks every other
 * character against `git check-ignore`).
 */
export function ignoreLine(rel) {
  if (rel.includes('\n')) return null;
  // the leading '/' anchors it to the root, and also keeps a name starting with '#' or '!' from being a comment / negation
  let s = '/' + rel.replace(/([\\*?[\]])/g, '\\$1');
  if (/ $/.test(s)) s = s.replace(/ +$/, (m) => m.replace(/ /g, '\\ '));
  // git drops a carriage return that ends a line (CRLF files): as a one-character class it stays part of the name
  if (s.endsWith('\r')) s = s.slice(0, -1) + '[\r]';
  return s;
}

export default [
  {
    // IntelliJ's "Add to .gitignore" (Git.Ignore.File) for unversioned files: appends one rooted line per path to the
    // repository's .gitignore (created when missing) or to .git/info/exclude. Nothing is thrown away (append only).
    name: 'changes.ignore', repo: true, mutating: true,
    params: { paths: { type: 'paths', maxItems: 10000 }, target: { type: 'enum', values: ['gitignore', 'exclude'], default: 'gitignore' } },
    async handler(ctx, p) {
      if (!p.paths.length) ctx.fail('invalid_params', 'no paths', { param: 'paths' });
      const file = p.target === 'exclude' ? `${ctx.repo.commonDir}/info/exclude` : workPath(ctx.repo, '.gitignore');
      let st = null;
      try { st = fs.lstatSync(file); } catch { /* new file */ }
      if (st && !st.isFile()) refuse(ctx, 'not_a_file', 'the ignore file is not a regular file', { path: p.target === 'exclude' ? '.git/info/exclude' : '.gitignore' });
      // a path gitignore cannot name is refused before anything is written (a line break would make two patterns,
      // the second one ignoring other files)
      const bad = p.paths.filter((x) => ignoreLine(x) === null);
      if (bad.length) refuse(ctx, 'not_ignorable', 'a .gitignore line cannot name a path with a line break in it', { paths: bad });
      const old = st ? fs.readFileSync(file, 'utf8') : '';
      const have = new Set(old.split(/\r?\n/));
      const lines = Array.from(new Set(p.paths.map((x) => ignoreLine(x.replace(/\/$/, '')) + (x.endsWith('/') ? '/' : '')))).filter((l) => !have.has(l));
      if (lines.length) {
        if (p.target === 'exclude') fs.mkdirSync(`${ctx.repo.commonDir}/info`, { recursive: true });
        const eol = /\r\n/.test(old) ? '\r\n' : '\n';
        fs.appendFileSync(file, (old && !/\n$/.test(old) ? eol : '') + lines.join(eol) + eol);
      }
      return { result: 'ignored', target: p.target, file: p.target === 'exclude' ? '.git/info/exclude' : '.gitignore', added: lines };
    },
  },
  {
    name: 'changes.write', repo: true, mutating: true,
    params: {
      path: 'path',
      text: { type: 'string', maxLength: 64 * 1024 * 1024 },
      expect: { type: 'object', props: { length: { type: 'int', min: 0 }, hash: { type: 'string', maxLength: 32 } } },
    },
    async handler(ctx, p) {
      const abs = workPath(ctx.repo, p.path);
      let st = null;
      try { st = fs.lstatSync(abs); } catch { /* gone */ }
      if (!st) refuse(ctx, 'changed_on_disk', 'the file no longer exists', { path: p.path, exists: false });
      if (!st.isFile()) refuse(ctx, 'not_a_file', 'only a regular file can be written', { path: p.path });
      const now = decodeContent(fs.readFileSync(abs));
      if (now.binary) ctx.fail('binary', 'the file is binary', { path: p.path });
      if (now.text.length !== p.expect.length || textHash(now.text) !== p.expect.hash) {
        refuse(ctx, 'changed_on_disk', 'the file changed on disk since the edit was computed', { path: p.path, exists: true });
      }
      if (now.text === p.text) return { result: 'unchanged', path: p.path, trash: null };
      if (now.encoding === 'latin1' && /[^\u0000-ÿ]/.test(p.text)) {
        refuse(ctx, 'unencodable', 'the text has characters the file\'s Latin-1 encoding cannot hold', { path: p.path, encoding: 'latin1' });
      }
      const saved = trash(ctx, [p.path], 'changes.write');
      const body = Buffer.from(p.text, now.encoding === 'latin1' ? 'latin1' : 'utf8');
      try { fs.writeFileSync(abs, now.bom ? Buffer.concat([BOM, body]) : body); } catch (e) { throw failedAfterSaving(ctx, saved, e); }
      return { result: 'written', path: p.path, trash: saved };
    },
  },
];
