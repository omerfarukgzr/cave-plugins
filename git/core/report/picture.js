// A screenshot for a problem report (ui/git/report.js, report-picture.js). A report goes to the tracker as a link,
// and a link carries text only; a page may not be allowed to write a picture to the clipboard itself (a host's frame
// may be refused every clipboard write but `execCommand('copy')` of text). So the picture a person gives the dialog
// travels over the clipboard: the page hands it to the process that runs the engine (a host's worker, in pieces: a
// host call takes 64 KiB at most; the standalone server, in one), which keeps it as one PNG in its own home, and
// when the tracker's page opens it puts that PNG on the system clipboard, where the person pastes it into the page.
// Only on macOS (`osascript`, part of the system); elsewhere `can` is false and the dialog offers no picture.
//   createPicture({ home, log, platform?, run?, maxPiece? }) -> { can, put(input), clear(), copy() }
//     maxPiece  the most base64 characters one piece may have (default 60 KiB: a host call's limit)
//   put  { id, seq, last, data }  one piece (base64 text) of upload `id`; pieces come in order from 0
//        -> { ok: true, bytes? } | { ok: false, code }       codes: order, too_large, not_png, write
//   copy -> { ok: true } | { ok: false, code }                codes: none, unsupported, failed
// Nothing here reads the clipboard, and the file is the process's own: `<home>/report/screenshot.png`, replaced by the
// next picture and removed by clear().
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const MAX_BYTES = 6 * 1024 * 1024;                 // the PNG itself
const MAX_PIECE = 60 * 1024;                              // base64 characters of one piece
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OSASCRIPT = '/usr/bin/osascript';

/** The AppleScript that puts the PNG at `file` on the clipboard (the path as a quoted AppleScript string). */
export function clipboardScript(file) {
  return 'set the clipboard to (read (POSIX file "' + String(file).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '") as «class PNGf»)';
}

/** Runs `osascript -e script`; resolves true when it exits 0 within 5 s. No shell, no input. */
function runScript(script) {
  return new Promise((resolve) => {
    let done = false;
    const end = (ok) => { if (!done) { done = true; resolve(ok); } };
    let child;
    try { child = spawn(OSASCRIPT, ['-e', script], { stdio: 'ignore' }); } catch (e) { end(false); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } end(false); }, 5000);
    child.on('error', () => { clearTimeout(timer); end(false); });
    child.on('exit', (code) => { clearTimeout(timer); end(code === 0); });
  });
}

export function createPicture({ home, log = () => {}, platform = process.platform, run = runScript, maxPiece = MAX_PIECE }) {
  const dir = path.join(home, 'report'), file = path.join(dir, 'screenshot.png');
  const can = platform === 'darwin';
  let upload = null;       // { id, next, parts, chars }
  let staged = false;
  const no = (code) => ({ ok: false, code });
  function clear() {
    upload = null;
    staged = false;
    try { fs.rmSync(file, { force: true }); } catch (e) { /* not there */ }
    return { ok: true };
  }
  function put(input) {
    if (!can) return no('unsupported');
    const { id, seq, last, data } = input || {};
    if (typeof id !== 'string' || !id || id.length > 64 || !Number.isInteger(seq) || seq < 0 || typeof data !== 'string' || data.length > maxPiece) return no('order');
    if (seq === 0) { upload = { id, next: 0, parts: [], chars: 0 }; staged = false; }
    if (!upload || upload.id !== id || upload.next !== seq) { upload = null; return no('order'); }
    upload.parts.push(data);
    upload.chars += data.length;
    upload.next++;
    if (upload.chars > Math.ceil(MAX_BYTES / 3) * 4 + 4) { upload = null; return no('too_large'); }
    if (last !== true) return { ok: true };
    const bytes = Buffer.from(upload.parts.join(''), 'base64');
    upload = null;
    if (bytes.length > MAX_BYTES) return no('too_large');
    if (bytes.length < PNG.length || !bytes.subarray(0, PNG.length).equals(PNG)) return no('not_png');
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, bytes);
    } catch (e) { log('report: cannot keep the picture: ' + ((e && e.code) || 'error')); return no('write'); }
    staged = true;
    return { ok: true, bytes: bytes.length };
  }
  async function copy() {
    if (!can) return no('unsupported');
    if (!staged || !fs.existsSync(file)) return no('none');
    const ok = await run(clipboardScript(file));
    if (!ok) log('report: the picture did not reach the clipboard');
    return ok ? { ok: true } : no('failed');
  }
  // a picture left by an earlier run is nobody's any more
  try { fs.rmSync(file, { force: true }); } catch (e) { /* not there */ }
  return { can, put, clear, copy, file };
}
