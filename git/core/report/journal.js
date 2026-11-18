// The detailed log of a problem report, the part of the process that runs the engine (ui/git/report.js; the owner,
// 17 Nov 2026: "detailed logs", not a summary). Shared by a host's worker and the standalone server
// (server/report.js). It puts together what the process knows about itself over time (its memory every minute, how
// late its event loop runs), what the engine holds, who is connected, and the account of activity.js (tables per
// engine method and git subcommand, the timeline of every call, git command, refresh and page error). Numbers, names
// of the product's own things and codes only: no path, no repository, branch or file name, no argument, no message.
//   createJournal({ activity, engine, startedAt, bridge?, pages?, label?, now?, sampleMs? }) -> { detail(), stop() }
//     bridge   a host's bridge to its panels (`clients()`): the [panels] section says each one's view and state
//     pages    () -> number, for a process that only counts its pages: a [pages] section instead
//     label    the process's name in its sections: "worker" (default) or "server"
//   detail() -> { head: [string], tail: [string] }   head: the sections; tail: the timeline, newest first
import { monitorEventLoopDelay } from 'node:perf_hooks';

const SAMPLES = 60;
const mb = (n) => Math.round(n / 1024 / 1024);
const view = (v) => (typeof v === 'string' && /^[a-z]{1,20}$/.test(v) ? v : 'other');

export function createJournal(o) {
  const { activity, bridge, engine, startedAt } = o;
  const label = typeof o.label === 'string' && /^[a-z]{1,20}$/.test(o.label) ? o.label : 'worker';
  const pages = typeof o.pages === 'function' ? o.pages : null;
  const now = o.now || Date.now;
  const samples = [];          // { t, rss, heap }
  let loop = null;
  try { loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable(); } catch (e) { loop = null; }
  const sample = () => {
    const m = process.memoryUsage();
    samples.push({ t: now(), rss: mb(m.rss), heap: mb(m.heapUsed) });
    if (samples.length > SAMPLES) samples.shift();
  };
  sample();
  const timer = setInterval(sample, o.sampleMs || 60000);
  if (timer.unref) timer.unref();

  function detail() {
    const head = [];
    const m = process.memoryUsage();
    const ns = (v) => Math.round(v / 1e6);
    head.push('[' + label + '] up ' + Math.round((now() - startedAt) / 1000) + ' s; rss ' + mb(m.rss) + ' MB, heap ' + mb(m.heapUsed) + ' of ' + mb(m.heapTotal) + ' MB, external ' + mb(m.external) + ' MB'
      + (loop ? '; event loop delay p50 ' + ns(loop.percentile(50)) + ', p99 ' + ns(loop.percentile(99)) + ', max ' + ns(loop.max) + ' ms' : ''));
    if (samples.length > 1) {
      const step = Math.round((samples[samples.length - 1].t - samples[0].t) / (samples.length - 1) / 1000);
      head.push('[' + label + ' memory] every ' + step + ' s, newest first, rss/heap MB: ' + samples.slice().reverse().map((s) => s.rss + '/' + s.heap).join(' '));
    }
    try {
      const s = engine && typeof engine.stats === 'function' ? engine.stats() : null;
      if (s) {
        head.push('[engine] repositories ' + s.entries + ', resolved ' + s.resolved + ', gone ' + s.gone + ', watchers ' + s.watchers + ', watched folders ' + s.watchedDirs
          + ', subscriptions ' + s.subscriptions + ', snapshots ' + s.snapshots + ', in use ' + s.inUse + ', walks ' + s.walks + ', jobs ' + s.jobs + ', queued ' + s.queued
          + ', listeners ' + s.listeners + ', reads running ' + (s.reads ? s.reads.running : 0) + ' waiting ' + (s.reads ? s.reads.waiting : 0) + ', git running ' + (s.git ? s.git.count : 0));
      }
    } catch (e) { head.push('[engine] not readable'); }
    if (pages) {
      try { const n = Number(pages()); head.push('[pages] ' + (Number.isInteger(n) && n >= 0 ? n : 0) + ' connected'); } catch (e) { head.push('[pages] not readable'); }
    } else try {
      const clients = bridge && typeof bridge.clients === 'function' ? bridge.clients() : [];
      head.push('[panels] ' + clients.length + (clients.length ? ': ' + clients.map((c) => view(c.view) + (c.polling ? ' polling' : ' idle') + ', waiting to go out ' + (c.outbox || 0) + ', calls running ' + (c.calls || 0)).join('; ') : ''));
    } catch (e) { head.push('[panels] not readable'); }
    const a = activity.detail();
    return { head: head.concat(a.head), tail: a.tail };
  }
  return { detail, sample, stop() { clearInterval(timer); try { if (loop) loop.disable(); } catch (e) { /* gone */ } } };
}
