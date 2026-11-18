/* The standalone host (docs/ARCHITECTURE.md §6.2). Loaded before any ui/git/ file (after host/product.js and the
   host adapter, host/adapter.js, whose Git.host fields are kept).
   Git.backend = { call(method, params) -> Promise<result>, on(event, fn) -> off }
     call: POST /rpc { method, params } with the stream's client id in X-Git-Panel-Client (PROTOCOL.md "Transport").
           Rejects with a GitError: an Error with `code`, `message`, `data` (engine codes, plus `unreachable` when the
           server cannot be reached and `transport` for a 4xx without a body). Nothing in the UI reads `message`.
     on:   engine events `changed`, `console`, `progress`, `job`, and `connection` { state: 'open'|'lost'|'reconnected',
           client } from this file. After `reconnected` the subscriptions of the old stream are gone: the store
           subscribes again and does a full resync. A stream that comes back from another build of the server
           (hello.build.hash) reloads the page instead, rate-limited (below; docs/ARCHITECTURE.md §6.2 "Recovery").
   Git.host = in-page defaults a host may replace: openFile(path, { line }) -> bool, openExternal(url), copy(text),
     prefs.get(key, fallback) / prefs.set(key, value) (JSON in localStorage under Git.storagePrefix(), "git-panel:" by default), startCommand, hooks: {}. */
(function () {
  'use strict';
  const Git = (window.Git = window.Git || {});

  // ---------------------------------------------------------------- errors
  /** The one error type the UI sees from the engine. Branch on `code` only. */
  function GitError(code, message, data) {
    const e = new Error(message || code);
    e.name = 'GitError';
    e.code = code;
    e.data = data == null ? null : data;
    return e;
  }
  Git.GitError = GitError;

  // ---------------------------------------------------------------- event stream
  const subs = {};
  function emit(ev, data) {
    (subs[ev] || []).slice().forEach((fn) => { try { fn(data); } catch (e) { console.error('Git.backend listener (' + ev + ')', e); } });
  }
  const EVENTS = ['changed', 'console', 'progress', 'job'];
  let source = null, client = null, opened = false, retry = 0, timer = null, build = null;

  // ---------------------------------------------------------------- a new build of the server
  // The stream's hello names the server's build (server/build.js). A page whose server came back as ANOTHER build
  // (an install while it was open) runs old scripts against a new engine: it reloads itself, so its scripts are the
  // server's again. Its place survives (the Log's selection and scroll are in localStorage, ui/git/log-place.js; a
  // host keeps more through the `recovered` mark). Rate limit, kept in sessionStorage across the reloads: at most 3
  // in 10 minutes and none within 20 s of the last one; beyond it the page stays and resyncs like after any reconnect.
  const RELOAD_KEY = () => Git.storagePrefix() + 'reloads';
  const RELOAD_WINDOW_MS = 600000, RELOAD_MAX = 3, RELOAD_GAP_MS = 20000;
  function mayReload(now) {
    let list = [];
    try { list = JSON.parse(sessionStorage.getItem(RELOAD_KEY()) || '[]'); } catch (e) { return false; }   // no storage: no limit, no reload
    if (!Array.isArray(list)) list = [];
    list = list.filter((t) => typeof t === 'number' && now - t < RELOAD_WINDOW_MS);
    if (list.length >= RELOAD_MAX || (list.length && now - list[list.length - 1] < RELOAD_GAP_MS)) return false;
    list.push(now);
    try {
      sessionStorage.setItem(RELOAD_KEY(), JSON.stringify(list));
      sessionStorage.setItem(Git.storagePrefix() + 'recovered', String(now));
    } catch (e) { return false; }
    return true;
  }
  /** true when the page reloads (the caller stops); false: it stays on this build's scripts. */
  function newBuild(next) {
    if (!build || !next || next === build) { if (next) build = next; return false; }
    if (Git.host && Git.host.reloadOnNewBuild === false) { build = next; return false; }
    if (!mayReload(Date.now())) { build = next; return false; }
    try { location.reload(); } catch (e) { build = next; return false; }
    return true;
  }
  let ready = null, readyResolve = null;
  function resetReady() { ready = new Promise((r) => { readyResolve = r; }); }
  resetReady();

  function connect() {
    clearTimeout(timer);
    if (source) { try { source.close(); } catch (e) { /* closed */ } }
    if (typeof EventSource === 'undefined') { readyResolve(null); return; }
    source = new EventSource('/events');
    source.addEventListener('hello', (e) => {
      let data = {};
      try { data = JSON.parse(e.data); } catch (err) { /* keep {} */ }
      if (newBuild(data.build && typeof data.build.hash === 'string' ? data.build.hash : null)) { try { source.close(); } catch (err) { /* closed */ } return; }
      client = data.client || null;
      retry = 0;
      const again = opened;
      opened = true;
      readyResolve(client);
      emit('connection', { state: again ? 'reconnected' : 'open', client });
    });
    EVENTS.forEach((ev) => source.addEventListener(ev, (e) => {
      let data = null;
      try { data = JSON.parse(e.data); } catch (err) { return; }
      emit(ev, data);
    }));
    source.onerror = () => {
      // EventSource retries on its own with a fixed delay; we take over to back off and to resync after.
      try { source.close(); } catch (e) { /* closed */ }
      source = null;
      if (client !== null || retry === 0) emit('connection', { state: 'lost', client });
      client = null;
      resetReady();
      const wait = Math.min(10000, 500 * Math.pow(2, retry++));
      timer = setTimeout(connect, wait);
    };
  }

  // ---------------------------------------------------------------- calls
  async function call(method, params) {
    // Wait (briefly) for the stream's hello so the call belongs to it; a dead stream must not block reads.
    const id = await Promise.race([ready, new Promise((r) => setTimeout(() => r(client), 1500))]);
    const headers = { 'Content-Type': 'application/json' };
    if (id) headers['X-Git-Panel-Client'] = id;
    let res;
    try {
      res = await fetch('/rpc', { method: 'POST', headers, body: JSON.stringify({ method, params: params || {} }), cache: 'no-store' });
    } catch (e) {
      throw GitError('unreachable', 'cannot reach the server', { method });
    }
    let body = null;
    try { body = await res.json(); } catch (e) { body = null; }
    if (body && body.error) throw GitError(body.error.code || 'internal', body.error.message, body.error.data);
    if (!res.ok || !body) throw GitError(res.ok ? 'internal' : 'transport', 'HTTP ' + res.status, { status: res.status, method });
    return body.result;
  }

  Git.backend = {
    call,
    on(ev, fn) {
      (subs[ev] = subs[ev] || []).push(fn);
      return () => { subs[ev] = (subs[ev] || []).filter((f) => f !== fn); };
    },
    /** The stream's client id (null while disconnected). */
    client: () => client,
    /** Closes the stream and reconnects at once (tests; the "Retry" of the unreachable page). */
    reconnect() { retry = 0; connect(); },
  };

  // ---------------------------------------------------------------- host defaults
  const memory = {};
  const prefs = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(Git.storagePrefix() + key);
        return v == null ? fallback : JSON.parse(v);
      } catch (e) {
        return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : fallback;
      }
    },
    set(key, value) {
      memory[key] = value;
      try { localStorage.setItem(Git.storagePrefix() + key, JSON.stringify(value)); } catch (e) { /* storage blocked: memory only */ }
    },
  };
  function copy(text) {
    try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).catch(() => fallbackCopy(text)); return; } } catch (e) { /* fall back */ }
    fallbackCopy(text);
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* refused */ }
    ta.remove();
  }
  Git.host = Object.assign({
    name: 'standalone',
    /** No editor in the standalone page: the caller shows the file itself (returns false). */
    openFile() { return false; },
    openExternal(url) { try { window.open(url, '_blank', 'noopener'); } catch (e) { /* blocked */ } },
    copy,
    prefs,
    /** The standalone server's own command (bin/git-panel); named when the server cannot be reached. */
    startCommand: Git.PRODUCT.command + ' start',
    hooks: {},
  }, Git.host || {});

  connect();
})();
