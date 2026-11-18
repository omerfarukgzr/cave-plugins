// What a problem report carries from the standalone server (ui/git/report.js "Report a Problem", for a host whose
// page adapter offers reports: `Git.host.report`). The same account a host's worker gives, from the same code
// (core/report/): the server's own state, what the engine did lately as names, counts, durations and codes, the
// system's and git's version, and the way for a screenshot to reach the clipboard. Never a path, a repository,
// branch or file name, an argument, a parameter, a message or git's output.
//   createReport({ home, label, version, build?, log?, picture?, system? })
//     -> { tap(diskLog), attach({ engine, pages }), services, picture, stop() }
//   tap(diskLog)   the log to hand the engine: what the engine writes also feeds this memory (core/report/activity.js)
//   attach(...)    once the engine and the server exist: `pages()` counts the connected pages
//   services       what POST /rpc answers itself, before the engine (server/server.js `services`):
//     report.diagnostics      -> { environment: [string], lines: [string], detail: { head, tail }, pictures: bool }
//     report.picture.put      { id, seq, last, data }  -> { ok } | { ok: false, code }   (core/report/picture.js)
//     report.picture.copy     -> { ok } | { ok: false, code }      puts the kept PNG on the system clipboard (macOS)
//     report.picture.clear    -> { ok: true }
// `picture` and `system` are passed on to createPicture and createSystem (tests: a `run` of their own, so no test
// touches the real clipboard).
import os from 'node:os';
import { createActivity, runtimeLine } from '../core/report/activity.js';
import { createJournal } from '../core/report/journal.js';
import { createPicture } from '../core/report/picture.js';
import { createSystem } from '../core/report/environment.js';

// one call carries a whole picture here (the page talks to this server over HTTP, not through a host's small calls)
const PIECE = 9 * 1024 * 1024;
const word = (v, re, fallback) => (typeof v === 'string' && re.test(v) ? v : fallback);

export function createReport(o = {}) {
  const log = typeof o.log === 'function' ? o.log : () => {};
  const label = word(o.label, /^[\w .-]{1,40}$/, 'git-panel');
  const version = word(o.version, /^[\w.+-]{1,40}$/, 'unknown');
  const build = word(o.build, /^[0-9a-f]{4,64}$/, null);
  const activity = createActivity();
  const startedAt = Date.now();
  const system = createSystem(o.system || {});
  const none = (code) => ({ ok: false, code });
  // without a home there is nowhere to keep a picture: the page is told so and offers none
  const picture = typeof o.home === 'string' && o.home
    ? createPicture({ home: o.home, log, maxPiece: PIECE, ...(o.picture || {}) })
    : { can: false, file: null, put: () => none('unsupported'), copy: async () => none('unsupported'), clear: () => ({ ok: true }) };
  let engine = null, pages = () => 0, journal = null;

  function tap(diskLog) {
    return Object.assign(Object.create(diskLog), { write(entry) { activity.take(entry); return diskLog.write(entry); } });
  }
  function attach(a = {}) {
    engine = a.engine || null;
    if (typeof a.pages === 'function') pages = a.pages;
    if (journal) journal.stop();
    journal = createJournal({ activity, engine, startedAt, label: 'server', pages });
  }
  async function diagnostics() {
    const s = await system.read();
    const environment = [label + ' ' + version + (build ? ' (build ' + build + ')' : ''), s.os + ' (' + s.arch + ')', 'Git ' + s.git];
    let lines = ['runtime: node ' + s.node + ', ' + process.platform + ' ' + os.release()];
    try {
      let n = 0;
      try { n = Number(pages()); } catch (e) { n = 0; }
      lines = lines.concat(runtimeLine({ startedAt, engine, label: 'server', pages: Number.isInteger(n) ? n : 0 }), activity.lines());
    } catch (e) { lines.push('server: not readable'); }
    let detail;
    try { detail = journal ? journal.detail() : activity.detail(); } catch (e) { detail = { head: ['[server] not readable'], tail: [] }; }
    return { environment, lines, detail, pictures: picture.can };
  }
  const services = {
    'report.diagnostics': () => diagnostics(),
    'report.picture.put': (input) => picture.put(input),
    'report.picture.copy': () => picture.copy(),
    'report.picture.clear': () => picture.clear(),
  };
  return { tap, attach, services, picture, activity, stop() { if (journal) journal.stop(); journal = null; } };
}
