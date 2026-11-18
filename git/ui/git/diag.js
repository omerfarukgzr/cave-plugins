/* The page's errors for the engine's log on disk (docs/ARCHITECTURE.md §3.7, docs/PROTOCOL.md `diag.report`):
   uncaught errors, unhandled rejections and the error notices the UI shows (Git.notify with kind 'error'), sent with
   one backend call each. A page that keeps failing sends at most 10 reports a minute and the same text once in 10 s
   (the engine has its own limit). Nothing here may throw or bring another error: a report that fails is dropped.
   Git.diag.report({ kind: 'error'|'rejection'|'notice'|'host', message, … }) lets a host adapter report its own events
   (e.g. a centre tab the host did not open). Only titles and short texts go out, never file content. */
(function () {
  'use strict';
  const Git = (window.Git = window.Git || {});
  const PER_MINUTE = 10;
  const SAME_MS = 10000;
  let windowStart = 0;
  let used = 0;
  const recent = new Map(); // text -> time it was last sent
  let sending = false;

  let view = null;
  try { view = new URLSearchParams(location.search).get('view') || 'workbench'; } catch (e) { view = null; }
  const str = (v, n) => (v == null ? undefined : String(v).slice(0, n));

  function report(entry) {
    try {
      if (sending || !entry || !Git.backend || typeof Git.backend.call !== 'function') return false;
      const now = Date.now();
      const key = entry.kind + '|' + (entry.title || '') + '|' + entry.message;
      if (recent.has(key) && now - recent.get(key) < SAME_MS) return false;
      if (now - windowStart >= 60000) { windowStart = now; used = 0; }
      if (used >= PER_MINUTE) return false;
      used++;
      recent.set(key, now);
      if (recent.size > 100) recent.delete(recent.keys().next().value);
      const params = { kind: entry.kind, message: str(entry.message, 4000) || '(no message)' };
      if (entry.title) params.title = str(entry.title, 1000);
      if (entry.source) params.source = str(entry.source, 1000);
      if (Number.isInteger(entry.line) && entry.line >= 0) params.line = entry.line;
      if (Number.isInteger(entry.column) && entry.column >= 0) params.column = entry.column;
      if (entry.stack) params.stack = str(entry.stack, 8000);
      if (view) params.view = str(view, 40);
      const root = Git.repo && Git.repo.root;
      if (typeof root === 'string' && root) params.root = root;
      sending = true; // an error raised while handing over the report must not report itself
      let p;
      try { p = Git.backend.call('diag.report', params); } finally { sending = false; }
      Promise.resolve(p).catch(() => {});
      return true;
    } catch (e) {
      sending = false;
      return false;
    }
  }

  window.addEventListener('error', (ev) => {
    const err = ev && ev.error;
    report({ kind: 'error', message: (err && err.message) || (ev && ev.message) || 'error', source: ev && ev.filename, line: ev && ev.lineno, column: ev && ev.colno, stack: err && err.stack });
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev && ev.reason;
    report({ kind: 'rejection', message: (r && (r.message || r.code)) || String(r), stack: r && r.stack });
  });
  if (typeof Git.on === 'function') {
    Git.on('notify', (n) => {
      if (!n || n.kind !== 'error') return;
      report({ kind: 'notice', title: n.title, message: str(n.text, 300) || n.title || 'error notice' });
    });
  }

  Git.diag = { report };
})();
