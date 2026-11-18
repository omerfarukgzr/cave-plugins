// Standalone host (docs/ARCHITECTURE.md §7): static files of ui/, POST /rpc, GET /events (SSE). Thin: every request
// is handed to the engine. Binds 127.0.0.1 only and defends against other web pages:
//   - Host must be 127.0.0.1:<port> or localhost:<port> (DNS rebinding)
//   - POST /rpc needs Content-Type: application/json (no simple CORS request), and when the browser sends them a
//     same-origin Origin and Sec-Fetch-Site: same-origin|none
//   - GET /events refuses a cross-site Sec-Fetch-Site or a foreign Origin
//   - no CORS headers anywhere; static files only from ui/ (no path escapes, symlinks resolved), except
//     /host/adapter.js, which is the host's adapter file when one is given (`adapter`, server/identity.js)
// `name`: what GET /ping answers as `name` (the CLI tells its own server from another program on the port by it).
//
// RPC: POST /rpc { method, params } -> 200 { result } | 200 { error: { code, message, data } }; transport problems are
// 4xx with { error }. Header `X-Git-Panel-Client: <id>` ties the call to an event stream (see GET /events).
// `services`: { "<method>": (params) => result }, methods this process answers itself, behind the same checks and
// before the engine (server/report.js: `report.diagnostics`, `report.picture.*`).
// Events: GET /events -> text/event-stream. First `hello` { client }, then `changed`, `console`, `progress`, `job`
// with JSON data, and a `: ping` comment every 15 s. When the stream closes, the client's subscriptions end.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { NEUTRAL } from './identity.js';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.map': 'application/json',
  '.ico': 'image/x-icon', '.wasm': 'application/wasm',
};
const EVENTS = ['changed', 'console', 'progress', 'job'];
const BODY_CAP = 16 * 1024 * 1024;
const ADAPTER_PATH = '/host/adapter.js';
const STREAM_BACKLOG = 4 * 1024 * 1024;

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' || Buffer.isBuffer(body) ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

const transportError = (res, status, code, message) => send(res, status, { error: { code, message, data: null } });

export function startServer({ engine, uiDir, port = 5210, host = '127.0.0.1', heartbeatMs = 15000, name = NEUTRAL.id, adapter = null, build = null, supervisor = null, diagnostics = null, services = null }) {
  const uiRoot = fs.realpathSync(uiDir);
  const adapterFile = adapter ? fs.realpathSync(adapter) : null;
  const streams = new Set();
  const liveClients = new Set();
  let boundPort = port;
  // what /ping and the stream's hello say about the code: { version, hash } (server/build.js), or null
  const buildInfo = build && typeof build === 'object' ? { version: build.version || null, hash: build.hash || null, dev: !!build.dev } : null;

  const hostOk = (req) => {
    const h = req.headers.host;
    return h === '127.0.0.1:' + boundPort || h === 'localhost:' + boundPort;
  };
  const originOk = (req) => {
    const o = req.headers.origin;
    if (o === undefined) return true;
    return o === 'http://127.0.0.1:' + boundPort || o === 'http://localhost:' + boundPort;
  };
  const fetchSiteOk = (req) => {
    const s = req.headers['sec-fetch-site'];
    return s === undefined || s === 'same-origin' || s === 'none';
  };

  async function rpc(req, res) {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') return transportError(res, 415, 'invalid_params', 'Content-Type must be application/json');
    if (!originOk(req) || !fetchSiteOk(req)) return transportError(res, 403, 'refused', 'cross-origin request refused');
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > BODY_CAP) return transportError(res, 413, 'too_large', 'request body too large');
      chunks.push(c);
    }
    let msg;
    try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return transportError(res, 400, 'invalid_params', 'body is not JSON'); }
    if (!msg || typeof msg.method !== 'string') return transportError(res, 400, 'invalid_params', 'method missing');
    // What this process answers itself never reaches the engine (`services`: server/report.js, a problem report's
    // facts and its screenshot).
    if (services && Object.prototype.hasOwnProperty.call(services, msg.method) && typeof services[msg.method] === 'function') {
      try {
        const result = await services[msg.method](msg.params && typeof msg.params === 'object' ? msg.params : {});
        return send(res, 200, { result: result === undefined ? null : result });
      } catch (e) {
        return send(res, 200, { error: { code: 'internal', message: 'the server could not answer ' + msg.method, data: null } });
      }
    }
    const client = typeof req.headers['x-git-panel-client'] === 'string' ? req.headers['x-git-panel-client'].slice(0, 64) : 'default';
    // A caller that goes away (tab closed, view moved on) aborts its call: a read's git processes are killed.
    const ctl = new AbortController();
    const onGone = () => { if (!res.writableFinished) ctl.abort(); };
    res.on('close', onGone);
    try {
      const result = await engine.call(msg.method, msg.params, { client, signal: ctl.signal });
      if (!ctl.signal.aborted) send(res, 200, { result });
    } catch (e) {
      if (!ctl.signal.aborted) send(res, 200, { error: e && e.toJSON ? e.toJSON() : { code: 'internal', message: String(e), data: null } });
    } finally {
      res.removeListener('close', onGone);
      // A call that names a stream which is not (or no longer) open must not leave a subscription behind.
      if (client !== 'default' && !liveClients.has(client)) engine.dropClient(client);
    }
  }

  function events(req, res) {
    if (!originOk(req) || !fetchSiteOk(req)) return transportError(res, 403, 'refused', 'cross-origin request refused');
    const client = 'c' + crypto.randomBytes(8).toString('hex');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff', Connection: 'keep-alive' });
    // A page that stops reading (a suspended web view keeps its connection open) must not make the server buffer its
    // events for ever: past STREAM_BACKLOG unsent bytes the stream is closed; the page reconnects and resyncs.
    let ended = false;
    const write = (event, data) => {
      if (ended) return;
      if (res.writableLength > STREAM_BACKLOG) { end(); res.destroy(); return; }
      res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
    };
    write('hello', { client, pid: process.pid, build: buildInfo });
    const offs = EVENTS.map((ev) => engine.on(ev, (data) => write(ev, data)));
    const beat = setInterval(() => { if (res.writableLength > STREAM_BACKLOG) { end(); res.destroy(); } else res.write(': ping\n\n'); }, heartbeatMs);
    liveClients.add(client);
    const stream = { res, close: () => { clearInterval(beat); offs.forEach((f) => f()); liveClients.delete(client); engine.dropClient(client); } };
    function end() { if (ended) return; ended = true; streams.delete(stream); stream.close(); }
    stream.end = end;
    streams.add(stream);
    req.on('close', end);
    res.on('close', end);
  }

  function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { return transportError(res, 400, 'invalid_params', 'bad path'); }
    if (rel.includes('\0') || rel.split('/').some((s) => s === '..')) return transportError(res, 403, 'refused', 'path refused');
    // "//x" or "/.//x": a redirect to it would be protocol-relative (http://x/). Empty and "." segments are refused.
    if (/\/\/|\/\.(\/|$)/.test(rel) || /\\/.test(rel)) return transportError(res, 403, 'refused', 'path refused');
    if (rel === '/' || rel === '') rel = '/index.html';
    let real;
    if (adapterFile && rel === ADAPTER_PATH) real = adapterFile;   // the host's file in place of ui/host/adapter.js
    else {
      try { real = fs.realpathSync(path.join(uiRoot, rel)); } catch { return send(res, 404, 'not found'); }
      const inside = path.relative(uiRoot, real);
      if (inside.startsWith('..') || path.isAbsolute(inside)) return transportError(res, 403, 'refused', 'path refused');
    }
    let st;
    try { st = fs.statSync(real); } catch { return send(res, 404, 'not found'); }
    if (st.isDirectory()) {
      if (!pathname.endsWith('/')) return send(res, 301, '', { Location: pathname + '/' });
      return serveStatic(req, res, pathname + 'index.html');
    }
    const type = TYPES[path.extname(real).toLowerCase()] || 'application/octet-stream';
    // Open first: a file that cannot be read is a 403/404 answer, never an unhandled 'error' that ends the server.
    let fd;
    try { fd = fs.openSync(real, 'r'); } catch (e) { return e.code === 'ENOENT' ? send(res, 404, 'not found') : transportError(res, 403, 'refused', 'file cannot be read'); }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') { fs.close(fd, () => {}); return res.end(); }
    const stream = fs.createReadStream(null, { fd });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  const server = http.createServer((req, res) => {
    if (!hostOk(req)) return transportError(res, 403, 'refused', 'unexpected Host header');
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/rpc') {
      if (req.method !== 'POST') return send(res, 405, { error: { code: 'refused', message: 'use POST', data: null } }, { Allow: 'POST' });
      return rpc(req, res).catch(() => { if (!res.headersSent) transportError(res, 500, 'internal', 'internal error'); });
    }
    if (url.pathname === '/events') {
      if (req.method !== 'GET') return send(res, 405, { error: { code: 'refused', message: 'use GET', data: null } }, { Allow: 'GET' });
      return events(req, res);
    }
    if (url.pathname === '/ping') {
      if (!fetchSiteOk(req)) return transportError(res, 403, 'refused', 'cross-origin request refused');
      return send(res, 200, { ok: true, name, pid: process.pid, port: boundPort, build: buildInfo, supervisor: typeof supervisor === 'function' ? supervisor() : supervisor });
    }
    // Tests only (server/diagnostics.js: the soak test's sizes after a forced GC, a crash on purpose). Exists only when
    // the host passes `diagnostics` (server/cli.js: GIT_PANEL_TEST_DIAG=1); a 404 otherwise.
    if (url.pathname.startsWith('/debug/') && typeof diagnostics === 'function') {
      return Promise.resolve(diagnostics(url.pathname.slice(7), { streams: streams.size, liveClients: liveClients.size }))
        .then((s) => (s === undefined ? send(res, 404, 'not found') : send(res, 200, s)), (e) => transportError(res, 500, 'internal', String(e && e.message)));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: { code: 'refused', message: 'method not allowed', data: null } }, { Allow: 'GET, HEAD' });
    return serveStatic(req, res, url.pathname);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      boundPort = server.address().port;
      server.removeListener('error', reject);
      resolve({
        port: boundPort,
        url: 'http://127.0.0.1:' + boundPort + '/',
        server,
        /** How many pages hold an event stream now. */
        pages: () => streams.size,
        close() {
          Array.from(streams).forEach((s) => { s.end(); s.res.end(); });
          streams.clear();
          const done = new Promise((r) => server.close(() => r()));
          server.closeAllConnections();
          return done;
        },
      });
    });
  });
}
