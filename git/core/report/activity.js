// What the product did lately, for a problem report (ui/git/report.js; the owner, 17 Nov 2026: a person may not
// have noticed the error, or cannot describe it, so the report must carry the product's own account: errors, timings,
// its state). Shared by every process that runs the engine: a host's worker and the standalone server
// (server/report.js). The log on disk already gets every engine call, git command and refresh (core/engine.js,
// core/redact.js); this keeps the last ones in memory, stripped to what says nothing about the person's work, and
// turns them into a few lines:
//   createActivity({ now?, windowMs?, cap? }) -> { take(logEntry), lines() }
// Kept of an entry: its time, the engine method or git subcommand NAME, how long it took, whether it worked, the
// error code, git's exit code. Never the repository, an argument, a parameter, a message or git's output.
const CAP = 600;
const WINDOW_MS = 60 * 60 * 1000;
const name = (v, re) => (typeof v === 'string' && re.test(v) ? v : null);
const METHOD = /^[a-z][A-Za-z]*(\.[A-Za-z]+){0,3}$/, CODE = /^[A-Za-z_]{1,40}$/, SUB = /^[a-z][a-z-]{1,30}$/;
/** Options of `git` itself that take a value in the next argument: that value may be a path. */
const VALUE_OPTIONS = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);

/** The subcommand of a git argument list ("status", "rev-parse"), never an argument of it. */
export function subcommand(args) {
  if (!Array.isArray(args)) return 'git';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (typeof a !== 'string') return 'git';
    if (VALUE_OPTIONS.has(a)) { i++; continue; }
    if (a.startsWith('-')) continue;
    return name(a, SUB) || 'git';
  }
  return 'git';
}

const ago = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 90 ? s + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago'; };
const median = (list) => { const s = list.slice().sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };

export function createActivity(o = {}) {
  const now = o.now || Date.now, windowMs = o.windowMs || WINDOW_MS, cap = o.cap || CAP;
  const kept = [];       // { t, k: 'op'|'git'|'refresh'|'page', n, ms, ok, code }
  function push(rec) {
    kept.push(rec);
    if (kept.length > cap) kept.splice(0, kept.length - cap);
  }
  /** One line of the log on disk, as it is written (an object); anything else is ignored. */
  function take(e) {
    try {
      if (!e || typeof e !== 'object') return;
      const ms = Number.isFinite(e.ms) && e.ms >= 0 ? Math.round(e.ms) : null;
      if (e.kind === 'op' && (e.phase === 'end' || e.phase === 'done')) {
        const n = name(e.method, METHOD);
        if (n) push({ t: now(), k: 'op', n, ms, ok: e.ok !== false, code: e.ok === false ? name(e.error && e.error.code, CODE) || 'error' : null });
      } else if (e.kind === 'git') {
        const killed = !!e.killed;
        push({ t: now(), k: 'git', n: subcommand(e.args), ms, ok: e.exit === 0 && !killed, code: killed ? 'killed' : Number.isInteger(e.exit) ? 'exit ' + e.exit : 'exit ?' });
      } else if (e.kind === 'refresh') {
        push({ t: now(), k: 'refresh', n: 'refresh', ms, ok: !(e.failed > 0), code: Number.isInteger(e.git) ? String(e.git) : null });
      } else if (e.kind === 'page') {
        const n = name(e.page || e.type || e.what, /^[a-z]{1,20}$/) || 'report';
        push({ t: now(), k: 'page', n, ms: null, ok: false, code: null });
      }
    } catch (err) { /* a line that cannot be read is not kept */ }
  }
  function lines() {
    const t = now(), recent = kept.filter((r) => t - r.t <= windowMs), out = [];
    const span = Math.round(windowMs / 60000) + ' min';
    const ops = recent.filter((r) => r.k === 'op');
    if (ops.length) {
      const failed = ops.filter((r) => !r.ok);
      // the slowest call of each method
      const slow = new Map();
      for (const r of ops) if (r.ms != null && (!slow.has(r.n) || slow.get(r.n) < r.ms)) slow.set(r.n, r.ms);
      const slowest = Array.from(slow).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, ms]) => n + ' ' + ms + ' ms').join(', ');
      out.push('calls (last ' + span + '): ' + (ops.length - failed.length) + ' ok, ' + failed.length + ' failed' + (slowest ? '; slowest ' + slowest : ''));
      if (failed.length) out.push('failed calls: ' + failed.slice(-6).reverse().map((r) => r.n + ' ' + r.code + ' (' + ago(t - r.t) + ')').join('; '));
      // the last calls, newest first, a run of the same call as one
      const last = [];
      for (let i = ops.length - 1; i >= 0 && last.length < 10; i--) {
        const r = ops[i], head = last[last.length - 1];
        if (head && head.n === r.n && head.ok === r.ok) head.count++;
        else last.push({ n: r.n, ok: r.ok, count: 1, ms: r.ms });
      }
      out.push('last calls: ' + last.map((g) => g.n + (g.ok ? ' ok' : ' FAILED') + (g.count > 1 ? ' ×' + g.count : g.ms != null ? ' ' + g.ms + ' ms' : '')).join(' · '));
    } else out.push('calls (last ' + span + '): none');
    const git = recent.filter((r) => r.k === 'git');
    if (git.length) {
      const by = new Map();
      for (const r of git) { if (!by.has(r.n)) by.set(r.n, []); by.get(r.n).push(r); }
      const top = Array.from(by).sort((a, b) => b[1].length - a[1].length).slice(0, 8)
        .map(([n, list]) => { const ms = list.map((r) => r.ms).filter((x) => x != null); return n + ' ' + list.length + '×' + (ms.length ? ' med ' + median(ms) + ' max ' + Math.max(...ms) + ' ms' : ''); });
      out.push('git (last ' + span + '): ' + top.join('; '));
      const bad = new Map();
      for (const r of git) if (!r.ok) { const k = r.n + ' ' + r.code; bad.set(k, (bad.get(k) || 0) + 1); }
      if (bad.size) out.push('git failed: ' + Array.from(bad).slice(0, 8).map(([k, n]) => k + ' ×' + n).join('; '));
    }
    const refresh = recent.filter((r) => r.k === 'refresh');
    if (refresh.length) {
      const ms = refresh.map((r) => r.ms).filter((x) => x != null);
      out.push('refreshes: ' + refresh.length + (ms.length ? ', med ' + median(ms) + ' max ' + Math.max(...ms) + ' ms' : '') + ', with a failed git command ' + refresh.filter((r) => !r.ok).length);
    }
    const page = recent.filter((r) => r.k === 'page');
    if (page.length) {
      const by = new Map();
      for (const r of page) by.set(r.n, (by.get(r.n) || 0) + 1);
      out.push('page reports: ' + Array.from(by).map(([k, n]) => k + ' ' + n).join(', ') + '; last ' + ago(t - page[page.length - 1].t));
    }
    return out;
  }
  /** A host event worth a line in the timeline (a focus change, a tab opened): a kind and a few words from the
      host's own vocabulary (kinds, counts, codes); anything else is dropped. */
  function note(kind, text) {
    const k = name(kind, /^[a-z][a-z.-]{0,20}$/), words = typeof text === 'string' && /^[\w .,;:()×-]{0,140}$/.test(text) ? text : null;
    if (k && words !== null) push({ t: now(), k: 'host', n: k, ms: null, ok: true, code: words });
  }
  const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
  /** One row per name: how often, how many failed, the median, the 95th percentile and the slowest. */
  function table(records, withCodes) {
    const by = new Map();
    for (const r of records) { if (!by.has(r.n)) by.set(r.n, []); by.get(r.n).push(r); }
    return Array.from(by).sort((a, b) => b[1].length - a[1].length).map(([n, list]) => {
      const ms = list.map((r) => r.ms).filter((x) => x != null).sort((a, b) => a - b);
      let row = n + ': n ' + list.length + ', failed ' + list.filter((r) => !r.ok).length + (ms.length ? ', p50 ' + pct(ms, 0.5) + ', p95 ' + pct(ms, 0.95) + ', max ' + ms[ms.length - 1] + ' ms' : '');
      if (withCodes) {
        const codes = new Map();
        for (const r of list) codes.set(r.code, (codes.get(r.code) || 0) + 1);
        row += '; ' + Array.from(codes).map(([c, k]) => c + ' ×' + k).join(', ');
      }
      return row;
    });
  }
  /**
   * The detailed account (the owner, 17 Nov 2026: the summary above is not a log): everything kept, as tables per
   * engine method and per git subcommand and as a timeline, newest first, each event with how long ago it was.
   * { head: [string] (the tables), tail: [string] (the timeline: it is what gives way when a report has no room) }
   */
  function detail() {
    const t = now(), head = [];
    const ops = kept.filter((r) => r.k === 'op'), git = kept.filter((r) => r.k === 'git'), refresh = kept.filter((r) => r.k === 'refresh');
    const since = kept.length ? Math.round((t - kept[0].t) / 1000) : 0;
    head.push('[kept] ' + kept.length + ' events over the last ' + since + ' s (at most ' + cap + ')');
    head.push('[calls by method] ' + ops.length);
    head.push(...table(ops, false));
    head.push('[git by subcommand] ' + git.length);
    head.push(...table(git, true));
    if (refresh.length) {
      const ms = refresh.map((r) => r.ms).filter((x) => x != null).sort((a, b) => a - b);
      const per = refresh.map((r) => Number(r.code)).filter(Number.isFinite);
      head.push('[refreshes] n ' + refresh.length + (ms.length ? ', p50 ' + pct(ms, 0.5) + ', p95 ' + pct(ms, 0.95) + ', max ' + ms[ms.length - 1] + ' ms' : '')
        + (per.length ? ', git commands per refresh ' + Math.round(per.reduce((a, b) => a + b, 0) / per.length) : '') + ', with a failed git command ' + refresh.filter((r) => !r.ok).length);
    }
    const tail = [];
    for (let i = kept.length - 1; i >= 0; i--) {
      const r = kept[i], age = '-' + ((t - r.t) / 1000).toFixed(1) + 's ';
      if (r.k === 'op') tail.push(age + 'call ' + r.n + (r.ok ? ' ok' : ' FAILED ' + r.code) + (r.ms != null ? ' ' + r.ms + 'ms' : ''));
      else if (r.k === 'git') tail.push(age + 'git ' + r.n + ' ' + r.code + (r.ms != null ? ' ' + r.ms + 'ms' : ''));
      else if (r.k === 'refresh') tail.push(age + 'refresh' + (r.ok ? '' : ' with a failed git command') + (r.ms != null ? ' ' + r.ms + 'ms' : '') + (r.code ? ' git ' + r.code : ''));
      else if (r.k === 'page') tail.push(age + 'page report ' + r.n);
      else if (r.k === 'host') tail.push(age + r.n + (r.code ? ' ' + r.code : ''));
    }
    return { head, tail };
  }
  return { take, lines, note, detail, size: () => kept.length };
}

/** The process itself: how long it runs, its memory, who is connected, what the engine holds. Numbers only.
    `label`: what the process is called in the line ("worker": a host's; "server": the standalone one). `pages`: a
    count of connected pages, for a process that does not know their views (`clients` is not read then). */
export function runtimeLine({ startedAt, now = Date.now, clients = [], engine = null, label = 'worker', pages = null }) {
  const up = Math.max(0, now() - startedAt), mem = process.memoryUsage();
  const mb = (n) => Math.round(n / 1024 / 1024) + ' MB';
  const views = {};
  for (const c of clients) { const v = name(c && c.view, /^[a-z]{1,20}$/) || 'other'; views[v] = (views[v] || 0) + 1; }
  let held = '';
  try {
    const s = engine && typeof engine.stats === 'function' ? engine.stats() : null;
    if (s) held = '; repositories ' + s.entries + ', watchers ' + s.watchers + ', git running ' + (s.git && Number.isFinite(s.git.count) ? s.git.count : 0) + ', jobs ' + s.jobs + ', queued ' + s.queued;
  } catch (e) { held = ''; }
  const who = Number.isInteger(pages) ? '; pages ' + pages
    : '; panels ' + clients.length + (clients.length ? ' (' + Object.keys(views).sort().map((v) => v + ' ' + views[v]).join(', ') + ')' : '');
  return (name(label, /^[a-z]{1,20}$/) || 'worker') + ': up ' + ago(up).replace(' ago', '') + ', rss ' + mb(mem.rss) + ', heap ' + mb(mem.heapUsed) + who + held;
}
