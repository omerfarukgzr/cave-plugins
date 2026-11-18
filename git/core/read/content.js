// Content group: file.read, file.pair, blame.
//
// A source is exactly one of { rev: '<commit-ish>' } (a committed version), { stage: 0|1|2|3 } (the index; 1/2/3 are
// a conflict's base/ours/theirs) or { worktree: true } (the file on disk), plus `path`.
//
// Text decoding never throws: a NUL byte in the first 8000 bytes makes the file `binary` (git's own heuristic, text
// null). Otherwise the bytes are decoded as strict UTF-8 (a BOM is stripped and reported as `bom: true`); when that
// fails the bytes are decoded as Latin-1 and `encoding: 'latin1'` is reported. Latin-1 maps every byte to one code
// point, so the text is lossless: a writer re-encodes it with Latin-1 and gets the exact bytes back.
// Line ends are left as they are; `eol` says what the file uses ('lf' | 'crlf' | 'mixed' | 'none').
import fs from 'node:fs';
import { workPath } from '../repo.js';
import { parseBlame } from '../parse.js';
import { commitId } from './commit.js';

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const HARD_MAX_BYTES = 64 * 1024 * 1024;

const SOURCE = {
  path: 'path',
  rev: 'rev?',
  stage: { type: 'int', min: 0, max: 3, optional: true },
  worktree: 'bool?',
};

export function decodeContent(buf) {
  const head = buf.subarray(0, 8000);
  if (head.includes(0)) return { binary: true, text: null, encoding: null, bom: false, eol: null, finalNewline: null };
  let bytes = buf;
  let bom = false;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { bytes = bytes.subarray(3); bom = true; }
  let text;
  let encoding = 'utf-8';
  // ignoreBOM: one BOM was taken off above and reported; a second one is content and must stay in the text.
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { text = bytes.toString('latin1'); encoding = 'latin1'; }
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/\n/g) || []).length - crlf;
  const eol = crlf && lf ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none';
  return { binary: false, text, encoding, bom, eol, finalNewline: text.length ? text.endsWith('\n') : true };
}

function sourceOf(ctx, s, param) {
  const n = (s.rev !== undefined ? 1 : 0) + (s.stage !== undefined ? 1 : 0) + (s.worktree ? 1 : 0);
  if (n !== 1) ctx.fail('invalid_params', 'give exactly one of rev, stage, worktree', { param, reason: 'one source' });
  return s.rev !== undefined ? { rev: s.rev } : s.stage !== undefined ? { stage: s.stage } : { worktree: true };
}

const missing = (path, source) => ({ path, source, exists: false, kind: null, id: null, mode: null, size: 0, binary: false, tooLarge: false, text: null, encoding: null, bom: false, eol: null, finalNewline: null });

async function blob(ctx, base, oid, size, maxBytes) {
  if (size > maxBytes) return { ...base, size, tooLarge: true, text: null };
  const out = await ctx.git(['cat-file', 'blob', oid], { encoding: 'buffer' });
  return { ...base, size, ...decodeContent(out.stdout) };
}

const kindOfMode = (mode) => (mode === '160000' ? 'gitlink' : mode === '120000' ? 'symlink' : 'file');

/** Reads one side. Returns the wire shape documented in PROTOCOL.md `file.read`. */
export async function readSource(ctx, spec, maxBytes) {
  const source = sourceOf(ctx, spec, 'source');
  const path = spec.path;
  const base = { path, source, exists: true, kind: 'file', id: null, mode: null, size: 0, binary: false, tooLarge: false, text: null, encoding: null, bom: false, eol: null, finalNewline: null };
  if (source.rev !== undefined) {
    const id = await commitId(ctx, source.rev, 'rev');
    const out = await ctx.git(['ls-tree', '-z', '-l', '--full-tree', id, '--', path]);
    const rec = out.stdout.split('\0').find((r) => r && r.slice(r.indexOf('\t') + 1) === path);
    if (!rec) return missing(path, source);
    const [mode, type, oid, sizeStr] = rec.slice(0, rec.indexOf('\t')).split(/\s+/);
    if (type === 'tree') return { ...missing(path, source), exists: true, kind: 'dir', mode };
    if (type === 'commit') return { ...base, kind: 'gitlink', mode, id: oid, text: 'Subproject commit ' + oid + '\n', encoding: 'utf-8', eol: 'lf', finalNewline: true };
    return blob(ctx, { ...base, kind: kindOfMode(mode), mode, id: oid }, oid, Number(sizeStr), maxBytes);
  }
  if (source.stage !== undefined) {
    const out = await ctx.git(['ls-files', '-s', '-z', '--', path]);
    const rec = out.stdout.split('\0').find((r) => {
      if (!r) return false;
      const tab = r.indexOf('\t');
      return r.slice(tab + 1) === path && r.slice(0, tab).split(' ')[2] === String(source.stage);
    });
    if (!rec) return missing(path, source);
    const [mode, oid] = rec.slice(0, rec.indexOf('\t')).split(' ');
    if (mode === '160000') return { ...base, kind: 'gitlink', mode, id: oid, text: 'Subproject commit ' + oid + '\n', encoding: 'utf-8', eol: 'lf', finalNewline: true };
    const sz = await ctx.git(['cat-file', '-s', oid]);
    return blob(ctx, { ...base, kind: kindOfMode(mode), mode, id: oid }, oid, Number(sz.stdout.trim()), maxBytes);
  }
  let abs;
  try { abs = workPath(ctx.repo, path); } catch (e) {
    if (e.data && e.data.reason === 'beyond_symlink') return missing(path, source); // git sees no file there either
    throw e;
  }
  let st;
  try { st = fs.lstatSync(abs); } catch { return missing(path, source); }
  if (st.isSymbolicLink()) {
    const target = fs.readlinkSync(abs);
    return { ...base, kind: 'symlink', mode: '120000', size: Buffer.byteLength(target), text: target, encoding: 'utf-8', eol: 'none', finalNewline: false };
  }
  if (st.isDirectory()) {
    // A submodule folder: the commit checked out in it, as `git diff` reports it from the superproject (git is not
    // run inside the submodule); the index's commit when the submodule has not moved.
    const idx = await ctx.git(['ls-files', '-s', '-z', '--', path]);
    const rec = idx.stdout.split('\0').find((r) => r.startsWith('160000 ') && r.slice(r.indexOf('\t') + 1) === path);
    if (!rec) return { ...missing(path, source), exists: true, kind: 'dir' };
    let oid = rec.split(' ')[1];
    const d = await ctx.git(['diff', '--no-ext-diff', '--no-color', '--submodule=short', '--ignore-submodules=none', '--', path], { okCodes: [0, 1] });
    const m = /^\+Subproject commit ([0-9a-f]{40,64})/m.exec(d.stdout);
    if (m) oid = m[1];
    return { ...base, kind: 'gitlink', mode: '160000', id: oid, text: 'Subproject commit ' + oid + '\n', encoding: 'utf-8', eol: 'lf', finalNewline: true };
  }
  if (!st.isFile()) return missing(path, source);
  const mode = st.mode & 0o111 ? '100755' : '100644';
  if (st.size > maxBytes) return { ...base, mode, size: st.size, tooLarge: true };
  let bytes;
  try { bytes = fs.readFileSync(abs); } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') ctx.fail('not_found', 'the file cannot be read: ' + path, { path, reason: 'unreadable' });
    if (e.code === 'ENOENT') return missing(path, source);
    throw e;
  }
  return { ...base, mode, size: bytes.length, ...decodeContent(bytes) };
}

const MAX = { type: 'int', min: 1, max: HARD_MAX_BYTES, default: DEFAULT_MAX_BYTES };

export default [
  {
    name: 'file.read', repo: true, mutating: false, params: { ...SOURCE, maxBytes: MAX },
    handler: (ctx, p) => readSource(ctx, p, p.maxBytes),
  },
  {
    name: 'file.pair', repo: true, mutating: false,
    params: { left: { type: 'object', props: SOURCE }, right: { type: 'object', props: SOURCE }, maxBytes: MAX },
    async handler(ctx, p) {
      const [left, right] = await Promise.all([readSource(ctx, p.left, p.maxBytes), readSource(ctx, p.right, p.maxBytes)]);
      return { left, right, same: !!(left.id && left.id === right.id) };
    },
  },
  {
    name: 'blame', repo: true, mutating: false, params: { path: 'path', rev: 'rev?' },
    async handler(ctx, p) {
      const id = p.rev !== undefined ? await commitId(ctx, p.rev, 'rev') : null;
      const args = ['blame', '--porcelain'];
      if (id) args.push(id);
      args.push('--', p.path);
      let out;
      try { out = await ctx.git(args, { maxBytes: 256 * 1024 * 1024 }); } catch (e) {
        if (e.name === 'GitError' && /no such path|no such file|cannot stat/i.test(e.stderr || '')) ctx.fail('not_found', 'file is not in the repository: ' + p.path, { path: p.path, reason: 'not_tracked' });
        throw e;
      }
      const r = parseBlame(out.stdout);
      // blame's `summary` is the first line only; the Log shows git's subject (%s: the first paragraph joined).
      const ids = Object.keys(r.commits);
      if (ids.length) {
        const s = await ctx.git(['log', '-z', '--no-walk=unsorted', '--format=%H%x00%s', '--stdin'], { input: ids.join('\n') + '\n' });
        const tok = s.stdout.split('\0');
        for (let i = 0; i + 1 < tok.length; i += 2) {
          const cid = tok[i].replace(/^\n/, '');
          if (Object.prototype.hasOwnProperty.call(r.commits, cid)) r.commits[cid].subject = tok[i + 1];
        }
      }
      return { path: p.path, rev: id, lines: r.lines, commits: r.commits };
    },
  },
];
