// Diagnostics for tests only (server/cli.js passes it to the server when GIT_PANEL_TEST_DIAG=1; never in normal use):
//   GET /debug/stats    after a forced GC (when node runs with --expose-gc): heap and RSS, the active handles and
//                       resources by type, the engine's sizes (engine.stats(): repositories, watchers, subscriptions,
//                       caches, living git processes), the server's streams and the log on disk's counters
//   GET /debug/crash    throws an uncaught exception on the next tick (the crash handler's test)
//   GET /debug/reject   leaves a rejected promise unhandled (the same for unhandled rejections)
export function diagnosticsOf({ engine, log }) {
  return async function diagnostics(name, server) {
    if (name === 'stats') {
      if (typeof globalThis.gc === 'function') { globalThis.gc(); await new Promise((r) => setImmediate(r)); globalThis.gc(); }
      const m = process.memoryUsage();
      const resources = {};
      for (const r of process.getActiveResourcesInfo()) resources[r] = (resources[r] || 0) + 1;
      return {
        pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000), gc: typeof globalThis.gc === 'function',
        memory: { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers },
        resources, engine: engine.stats(), server, log: log && log.stats ? log.stats() : null,
      };
    }
    if (name === 'crash') { setImmediate(() => { throw new Error('test crash: an uncaught exception on purpose'); }); return { ok: true }; }
    if (name === 'reject') { setImmediate(() => { Promise.reject(new Error('test crash: an unhandled rejection on purpose')); }); return { ok: true }; }
    return undefined;
  };
}
