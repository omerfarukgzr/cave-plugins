// file.locate: which work tree files hold exactly a given text.
//
// A host can show a file without telling its path (a host editor frame that gets the document, never a path). It asks
// with the text's identity instead of the text: its length in UTF-16 code units and its 53-bit hash (`textHash`, the
// same function the UI has), plus what narrows the search: the text's size in UTF-8 bytes, its number of line feeds and
// the file name's suffix. Candidates are the files git lists for the work tree (tracked, and untracked ones that are
// not ignored); only regular files whose size on disk can be that text are read. A file matches when its decoded text
// (content.js `decodeContent`: a BOM stripped, UTF-8 or Latin-1) is the text, or is the text once its CR LF line ends
// are read as LF (a host may hand the text over with its line ends normalized). Exact matches come first.
// Nothing is written; symbolic links are not followed.
import fs from 'node:fs';
import { workPath } from '../repo.js';
import { decodeContent } from './content.js';
import { textHash } from '../ops/extra-changes.js';

const MAX_TEXT = 32 * 1024 * 1024;   // UTF-16 units of a text worth looking for
export const MAX_READ = 400;         // candidate files read per call
export const MAX_FOUND = 8;          // paths answered per call

export default [
  {
    name: 'file.locate', repo: true, mutating: false,
    params: {
      length: { type: 'int', min: 0, max: MAX_TEXT },
      hash: { type: 'string', maxLength: 16, nonEmpty: true },
      bytes: { type: 'int', min: 0, max: 4 * MAX_TEXT, optional: true },
      lines: { type: 'int', min: 0, max: MAX_TEXT, optional: true },
      suffix: { type: 'string', maxLength: 64, optional: true },
    },
    async handler(ctx, p) {
      if (!/^[0-9a-f]{1,14}$/.test(p.hash)) ctx.fail('invalid_params', 'hash must be the hex of textHash', { param: 'hash', reason: 'format' });
      const listed = await ctx.git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBytes: 256 * 1024 * 1024 });
      let names = Array.from(new Set(listed.stdout.split('\0').filter(Boolean)));
      const suffix = (p.suffix || '').toLowerCase();
      if (suffix && !suffix.includes('/')) {
        // a suffix no listed file carries is a wrong hint, not "no file": look at all of them then
        const hit = names.filter((n) => n.toLowerCase().endsWith(suffix));
        if (hit.length) names = hit;
      }
      // The sizes on disk that can hold the text: its UTF-8 bytes (its length for a Latin-1 file), plus a BOM, plus one
      // CR per line when the asker's line ends were normalized.
      const lines = p.lines === undefined ? p.length : p.lines;
      const lo = p.bytes === undefined ? p.length : Math.min(p.bytes, p.length);
      const hi = (p.bytes === undefined ? 3 * p.length : Math.max(p.bytes, p.length)) + lines + 3;
      const exact = [];
      const loose = [];
      let read = 0;
      let truncated = false;
      for (const name of names) {
        if (exact.length >= MAX_FOUND) { truncated = true; break; }
        let abs;
        let st;
        try { abs = workPath(ctx.repo, name); st = fs.lstatSync(abs); } catch { continue; }
        if (!st.isFile() || st.size < lo || st.size > hi) continue;
        if (read >= MAX_READ) { truncated = true; break; }
        read++;
        let d;
        try { d = decodeContent(fs.readFileSync(abs)); } catch { continue; }
        if (d.binary || d.text === null) continue;
        if (d.text.length === p.length && textHash(d.text) === p.hash) { exact.push(name); continue; }
        if (d.eol === 'crlf' || d.eol === 'mixed') {
          const lf = d.text.replace(/\r\n/g, '\n');
          if (lf.length === p.length && textHash(lf) === p.hash) loose.push(name);
        }
      }
      return { paths: exact.concat(loose).slice(0, MAX_FOUND), read, truncated };
    },
  },
];
