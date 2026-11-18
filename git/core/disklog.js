// The engine's log on disk (docs/ARCHITECTURE.md §3.7): for looking at what happened afterwards.
//
// createDiskLog({ dir, host, now, keepDays, maxBytes, flushMs, onDisable }) -> { write(event), flush(), close(), enabled }
//   dir        the folder of the files: logDir(<settings home>), i.e. <home>/log
//   host       who writes (the identity's id, or the host's name); every line carries it
//   now        clock (tests)                       keepDays  days kept, today included (7)
//   maxBytes   cap of one day's file (20 MB)       flushMs   how long lines wait in memory before they are written (250)
//   onDisable  fn(error), called once when a write fails; logging is off from then on
//
// One file per day, <dir>/YYYY-MM-DD.jsonl (local date), one JSON object per line: { t: ISO time, host, kind, … }.
// When a day's file is opened, files of that form older than `keepDays` are deleted (nothing else in the folder is
// touched). A file that reaches `maxBytes` gets one { kind: 'truncated' } line and nothing more that day.
// Writing is buffered and asynchronous; write() never throws and never waits, so logging cannot slow or fail an
// operation. A full disk or an unwritable folder turns logging off quietly (onDisable tells the host once).
// The caller decides what goes in a line and removes what must not (core/redact.js); this module only writes.
import fs from 'node:fs';
import path from 'node:path';

export const LOG_KEEP_DAYS = 7;
export const LOG_MAX_BYTES = 20 * 1024 * 1024;
const PENDING_CAP = 4 * 1024 * 1024;
const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86400000;

/** The log folder inside a settings home. */
export const logDir = (home) => path.join(home, 'log');

/** The local date of `ms` as YYYY-MM-DD: the name of that day's file. */
export function dayOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/**
 * The rate limit of reports from the pages (diag.report): at most `perMinute` lines a minute; what is left out is
 * counted and written as { kind: 'page', suppressed: n } with the next line that is let through.
 * Returns fn(line) -> boolean (written); without a log it writes nothing.
 */
export function createReportLimit(log, { perMinute = 20, now = Date.now } = {}) {
  let windowStart = 0;
  let used = 0;
  let suppressed = 0;
  return function report(line) {
    if (!log) return false;
    const t = now();
    if (t - windowStart >= 60000) { windowStart = t; used = 0; }
    if (used >= perMinute) { suppressed++; return false; }
    used++;
    if (suppressed) { log.write({ kind: 'page', suppressed }); suppressed = 0; }
    log.write(line);
    return true;
  };
}

export function createDiskLog(opts = {}) {
  const dir = opts.dir;
  const host = String(opts.host || '');
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const keepDays = opts.keepDays || LOG_KEEP_DAYS;
  const maxBytes = opts.maxBytes || LOG_MAX_BYTES;
  const flushMs = opts.flushMs === undefined ? 250 : opts.flushMs;
  const onDisable = typeof opts.onDisable === 'function' ? opts.onDisable : () => {};
  let enabled = typeof dir === 'string' && dir !== '';
  let pending = [];
  let pendingBytes = 0;
  let dropped = 0;
  let timer = null;
  let chain = Promise.resolve();
  let day = null;     // the day whose file is open
  let size = 0;       // its size
  let capped = false; // it reached maxBytes
  const written = { lines: 0, bytes: 0, byKind: {} }; // what this process wrote (diagnostics: the log's volume)

  const fileOf = (d) => path.join(dir, d + '.jsonl');

  function disable(err) {
    if (!enabled) return;
    enabled = false;
    pending = [];
    pendingBytes = 0;
    if (timer) { clearTimeout(timer); timer = null; }
    try { onDisable(err); } catch { /* the host's own log failed too */ }
  }

  function write(event) {
    if (!enabled) return;
    try {
      const t = now();
      const line = JSON.stringify({ t: new Date(t).toISOString(), host, ...event }) + '\n';
      if (pendingBytes + line.length > PENDING_CAP) { dropped++; return; }
      pending.push({ day: dayOf(t), t, line, kind: event && event.kind });
      pendingBytes += line.length;
      if (!timer) {
        timer = setTimeout(() => { timer = null; flush(); }, flushMs);
        if (timer.unref) timer.unref();
      }
    } catch { /* an event that cannot be written is left out */ }
  }

  async function prune(t) {
    const oldest = dayOf(t - (keepDays - 1) * DAY_MS);
    let names = [];
    try { names = await fs.promises.readdir(dir); } catch { return; }
    for (const n of names) {
      const m = FILE_RE.exec(n);
      if (m && m[1] < oldest) { try { await fs.promises.unlink(path.join(dir, n)); } catch { /* gone already */ } }
    }
  }

  async function openDay(d, t) {
    day = d;
    capped = false;
    size = 0;
    await fs.promises.mkdir(dir, { recursive: true });
    try { size = (await fs.promises.stat(fileOf(d))).size; } catch { size = 0; }
    if (size >= maxBytes) capped = true; // an earlier process filled it today (and wrote the truncated line)
    await prune(t);
  }

  async function drain() {
    while (enabled && pending.length) {
      const batch = pending;
      pending = [];
      pendingBytes = 0;
      if (dropped) {
        const last = batch[batch.length - 1];
        batch.push({ day: last.day, t: last.t, kind: 'dropped', line: JSON.stringify({ t: new Date(last.t).toISOString(), host, kind: 'dropped', n: dropped }) + '\n' });
        dropped = 0;
      }
      let i = 0;
      while (i < batch.length && enabled) {
        const d = batch[i].day;
        if (d !== day) await openDay(d, batch[i].t);
        let text = '';
        for (; i < batch.length && batch[i].day === d; i++) {
          if (capped) continue;
          const n = Buffer.byteLength(batch[i].line);
          if (size + n > maxBytes) {
            text += JSON.stringify({ t: new Date(batch[i].t).toISOString(), host, kind: 'truncated', maxBytes }) + '\n';
            capped = true;
            continue;
          }
          text += batch[i].line;
          size += n;
          written.lines++;
          written.bytes += n;
          const k = String(batch[i].kind || '?');
          const w = (written.byKind[k] ||= { lines: 0, bytes: 0 });
          w.lines++;
          w.bytes += n;
        }
        if (text) await fs.promises.appendFile(fileOf(d), text);
      }
    }
  }

  /** Writes what waits; resolves when it is on disk (or logging turned off). Never rejects. */
  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    chain = chain.then(drain).catch(disable);
    return chain;
  }

  return {
    write,
    flush,
    async close() { await flush(); enabled = false; },
    get enabled() { return enabled; },
    get dir() { return dir; },
    /** What this process wrote so far and what waits (diagnostics). */
    stats: () => ({ enabled, pending: pending.length, pendingBytes, dropped, written: JSON.parse(JSON.stringify(written)) }),
  };
}
