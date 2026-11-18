/* The Orca host (docs/ARCHITECTURE.md §6.2, hosts/orca/README.md). Loaded first by hosts/orca/panel.js, before
   any ui/git/ file, inside an Orca panel frame (global `orca`, no network).
   Git.backend = { call(method, params) -> Promise<result>, on(event, fn) -> off, client(), reconnect() }
     The engine runs in the plugin's worker (hosts/orca/worker.mjs). Calls are batched into one `send` request; one
     `poll` request at a time brings their results and the engine events (`changed`, `console`, `progress`, `job`)
     in order (hosts/orca/bridge.mjs explains why: Orca's size and rate limits). Big params go ahead in parts
     (`put`), big results come back in parts (`part`); the UI never sees any of it.
     Rejects with a GitError (`code`, `message`, `data`) as ui/host/standalone.js does: the engine's codes, plus
     `unreachable` (the worker cannot be reached or stopped during a mutating call), `timeout`, `too_large`,
     `rate_limited` (Orca's limits, after bounded retries).
     `connection` { state: 'open'|'lost'|'reconnected', client }: after `reconnected` (the worker was restarted)
     the old subscriptions are gone; the store subscribes again and resyncs. Reads in flight are asked again.
   Git.host = Orca's hooks: openFile → Orca's editor (editor.open through the worker, when the repository is the
     focused workspace), look / onLookChange → the editor's font (editor.readTypography) as the code font, Orca's default interface font (Geist), fileIcon → hosts/orca/look/file-icons.js (set before this file), openExternal → orca.shell.openExternal, copy, prefs (localStorage, else memory),
     hooks.showInLog → the Git Log panel.
   Git.orca = { start(view) -> Promise<hello>, request(name, input, o), onMessage(type, fn), workspace, stats() }
     (hosts/orca/panel.js). The product name the user sees (Git.host.product) and the storage prefix (Git.host.storagePrefix) are set by panel.js. */
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
  const ORCA_CODES = { timeout: 'timeout', too_large: 'too_large', rate_limited: 'rate_limited', cancelled: 'cancelled' };
  const fromOrca = (e, what) => GitError(ORCA_CODES[e && e.code] || 'unreachable', 'Orca: ' + ((e && e.message) || 'request failed') + ' (' + what + ')',
    { host: 'orca', orcaCode: (e && e.code) || null, request: what });

  // ---------------------------------------------------------------- events
  const subs = {};
  function emit(ev, data) {
    (subs[ev] || []).slice().forEach((fn) => { try { fn(data); } catch (e) { console.error('Git.backend listener (' + ev + ')', e); } });
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const bytes = (s) => (s.length * 3 <= 16384 || !enc ? s.length * 3 : enc.encode(s).length);
  /** Pieces of at most `max` UTF-8 bytes, never splitting a surrogate pair (same rule as the worker's). */
  function splitBytes(text, max) {
    const out = [];
    let i = 0;
    while (i < text.length) {
      let n = Math.min(text.length - i, max);
      for (;;) {
        let end = i + n;
        const c = text.charCodeAt(end - 1);
        if (end < text.length && c >= 0xd800 && c <= 0xdbff) end -= 1;
        const piece = text.slice(i, end);
        if (!enc || enc.encode(piece).length <= max || n <= 1) { out.push(piece); i = end; break; }
        n = Math.max(1, Math.floor(n / 2));
      }
    }
    return out.length ? out : [''];
  }

  // ---------------------------------------------------------------- requests to the worker
  const stats = { send: 0, poll: 0, part: 0, put: 0, hello: 0, retried: 0 };
  /** orca.plugin.request with Orca's rate limit handled (wait `retryAfterMs`, bounded); other failures reject. */
  async function request(name, input, o) {
    o = o || {};
    const orca = window.orca;
    if (!orca || !orca.plugin) throw GitError('unreachable', 'not inside an Orca panel', { host: 'orca' });
    const retries = o.retries == null ? 12 : o.retries;
    for (let attempt = 0; ; attempt++) {
      try {
        if (stats[name] !== undefined) stats[name]++;
        return await orca.plugin.request(name, input, { timeoutMs: o.timeoutMs || 60000 });
      } catch (e) {
        if (e && e.code === 'rate_limited' && attempt < retries) {
          stats.retried++;
          await sleep(Math.min(10000, Math.max(25, Number(e.retryAfterMs) || 200 * (attempt + 1))));
          continue;
        }
        throw e;
      }
    }
  }

  let view = '', client = null, instance = null, inputBudget = 40 * 1024, reads = new Set();
  let generation = 0, delivered = 0, opened = false, connecting = null, lostShown = false;
  let nextId = 1, flushTimer = null;
  const pending = new Map();      // id -> { id, method, params (JSON), resolve, reject, sent }
  const queue = [];
  let readyResolve;
  let ready = new Promise((r) => { readyResolve = r; });

  function connect() {
    if (connecting) return connecting;
    connecting = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          const h = await request('hello', { view }, { retries: 40 });
          if (h && h.client) {
            client = h.client; instance = h.instance; delivered = 0;
            if (h.limits && h.limits.inputBudget > 1024) inputBudget = h.limits.inputBudget;
            reads = new Set(h.reads || []);
            const gen = ++generation;
            connecting = null;
            readyResolve(client);
            pollLoop(gen);
            schedule();
            if (!opened) { opened = true; emit('connection', { state: 'open', client }); }
            return h;
          }
        } catch (e) { /* the worker may still be starting */ }
        await sleep(Math.min(10000, 300 * Math.pow(2, Math.min(attempt, 6))));
      }
    })();
    return connecting;
  }

  /** The worker forgot us (restarted, or the lease ran out): reads are asked again, mutating calls fail. */
  async function recover() {
    if (connecting) return connecting;
    generation++;
    const old = client;
    client = null;
    ready = new Promise((r) => { readyResolve = r; });
    emit('connection', { state: 'lost', client: old });
    for (const p of Array.from(pending.values())) {
      if (!p.sent) continue;
      if (reads.has(p.method)) { p.sent = false; queue.push(p.id); }
      else { pending.delete(p.id); p.reject(GitError('unreachable', 'the Orca worker stopped while ' + p.method + ' ran', { host: 'orca', method: p.method })); }
    }
    await connect();
    emit('connection', { state: 'reconnected', client });
  }

  // ---------------------------------------------------------------- the mailbox (results, events, host messages)
  async function itemValue(it) {
    if (!it.chunk) return JSON.parse(it.json);
    const parts = [];
    for (let i = 0; i < it.chunk.parts; i++) {
      const res = await request('part', { client, key: it.chunk.key, index: i }, { retries: 40 });
      if (!res || typeof res.data !== 'string') throw GitError('unreachable', 'a part of a result is missing', { host: 'orca' });
      parts.push(res.data);
    }
    return JSON.parse(parts.join(''));
  }
  async function deliver(it) {
    if (!it || !(it.seq > delivered)) return;          // a duplicate of an answer that was sent again
    let value, failed = null;
    try { value = await itemValue(it); } catch (e) { failed = e; }
    delivered = it.seq;
    if (it.t === 'r') {
      const p = pending.get(it.id);
      if (!p) return;
      pending.delete(it.id);
      if (failed) p.reject(failed.code ? failed : GitError('internal', String(failed)));
      else if (it.ok) p.resolve(value);
      else p.reject(GitError((value && value.code) || 'internal', value && value.message, value && value.data));
    } else if (failed) {
      console.error('Orca host: an engine event was lost', failed);
    } else if (it.t === 'e') emit(value.event, value.data);
    else if (it.t === 'h') hostMessage(value);
  }
  async function pollLoop(gen) {
    let failures = 0;
    while (gen === generation) {
      let res;
      try {
        res = await request('poll', { client, ack: delivered, settled: settledMark() }, { timeoutMs: 110000, retries: 1000 });
      } catch (e) {
        if (gen !== generation) return;
        failures++;
        if (failures === 2 && !lostShown) { lostShown = true; emit('connection', { state: 'lost', client }); }
        await sleep(Math.min(10000, 250 * Math.pow(2, Math.min(failures, 6))));
        continue;
      }
      if (gen !== generation) return;
      if (!res || (res.error && res.error.code === 'unknown_client') || (instance && res.instance && res.instance !== instance)) { lostShown = false; recover(); return; }
      failures = 0;
      if (lostShown) { lostShown = false; emit('connection', { state: 'open', client }); }
      for (const it of res.items || []) {
        if (gen !== generation) return;
        await deliver(it);
      }
    }
  }

  // ---------------------------------------------------------------- calls
  /**
   * The watermark every request carries: all call ids below it are settled here (answered or given up). Ids only grow
   * and `pending` keeps them in that order, so it is the oldest call still waiting, or the next id when none is. The
   * worker never runs an id below it, so a `send` that Orca delivers again much later cannot run a call twice.
   */
  function settledMark() { const first = pending.keys().next(); return first.done ? nextId : first.value; }
  function schedule() { if (!flushTimer) flushTimer = setTimeout(flush, 0); }
  function flush() {
    flushTimer = null;
    if (!client) return;
    let batch = [], used = 0;
    for (const id of queue.splice(0)) {
      const p = pending.get(id);
      if (!p || p.sent) continue;
      const size = bytes(p.params) + p.method.length + 32;
      if (size > inputBudget) { sendBig(p); continue; }
      if (batch.length && used + size > inputBudget) { sendBatch(batch); batch = []; used = 0; }
      batch.push(p);
      used += size;
    }
    if (batch.length) sendBatch(batch);
  }
  function requeue(list) { list.forEach((p) => { if (pending.get(p.id) === p) { p.sent = false; queue.push(p.id); } }); }
  function fail(list, err) { list.forEach((p) => { if (pending.get(p.id) === p) { pending.delete(p.id); p.reject(err); } }); }
  async function sendBatch(list, uploads) {
    const c = client;
    list.forEach((p) => { p.sent = true; });
    let res;
    try {
      res = await request('send', { client: c, settled: settledMark(), calls: list.map((p) => (uploads && uploads[p.id] ? { id: p.id, method: p.method, upload: uploads[p.id] } : { id: p.id, method: p.method, params: p.params })) });
    } catch (e) { fail(list, fromOrca(e, 'send')); return; }
    if (res && res.error) {
      if (res.error.code === 'unknown_client') { requeue(list); recover(); return; }
      fail(list, GitError(res.error.code || 'internal', res.error.message, null));
    }
  }
  async function sendBig(p) {
    p.sent = true;
    const key = 'u' + p.id, c = client;
    const parts = splitBytes(p.params, inputBudget - 512);
    try {
      for (let i = 0; i < parts.length; i++) {
        const res = await request('put', { client: c, key, index: i, total: parts.length, data: parts[i] }, { retries: 40 });
        if (res && res.error) {
          if (res.error.code === 'unknown_client') { requeue([p]); recover(); return; }
          fail([p], GitError(res.error.code || 'internal', res.error.message, null));
          return;
        }
      }
    } catch (e) { fail([p], fromOrca(e, 'put')); return; }
    await sendBatch([p], { [p.id]: key });
  }
  function call(method, params) {
    return new Promise((resolve, reject) => {
      let json;
      try { json = JSON.stringify(params || {}); } catch (e) { reject(GitError('invalid_params', 'params are not JSON', { method })); return; }
      const id = nextId++;
      pending.set(id, { id, method: String(method), params: json, resolve, reject, sent: false });
      queue.push(id);
      if (client) schedule();
    });
  }

  Git.backend = {
    call,
    on(ev, fn) {
      (subs[ev] = subs[ev] || []).push(fn);
      return () => { subs[ev] = (subs[ev] || []).filter((f) => f !== fn); };
    },
    /** The worker's client id for this panel (null while not connected). */
    client: () => client,
    /** Starts over with a new client (the "Retry" of the unreachable page). */
    reconnect() { if (client) recover(); else connect(); },
  };

  // ---------------------------------------------------------------- host messages, theme, panel lifetime
  const hostHandlers = {
    showInLog(data) { if (data && data.id && Git.log && Git.log.reveal) Git.log.reveal(data.id); },
  };
  function hostMessage(msg) {
    const fn = msg && Object.prototype.hasOwnProperty.call(hostHandlers, msg.type) ? hostHandlers[msg.type] : null;
    if (fn) { try { fn(msg.data); } catch (e) { console.error('Orca host: host message ' + msg.type, e); } }
  }
  /** Orca puts `light` or `dark` on <html>; the UI draws its own (dark) skin and keeps the host's in data-git-host-theme. */
  function applyTheme() {
    const el = document.documentElement;
    el.dataset.gitHostTheme = el.classList.contains('light') ? 'light' : 'dark';
    emit('host-theme', el.dataset.gitHostTheme);
  }
  window.addEventListener('pagehide', () => {
    if (client && window.orca && window.orca.plugin) { try { window.orca.plugin.request('bye', { client }).catch(() => {}); } catch (e) { /* closing */ } }
  });

  // ---------------------------------------------------------------- Git.host
  const memory = {};
  const prefs = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(Git.storagePrefix() + key);
        return v == null ? (Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : fallback) : JSON.parse(v);
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
  // The code font of Orca's file editor (ui/git/look.js): `editor.readTypography` (no capability; panels and the custom
  // editor; host API 1.6) and its `editor.typography.changed` event. lineHeight is pixels, 0 when automatic. Orca
  // hands frames no interface font (its frame tokens are colours and the radius) and no file icon theme. So the
  // interface font is Orca's default one, its stack as Orca builds it (buildAppFontFamily, DEFAULT_APP_FONT_FAMILY
  // 'Geist'; the font file ships in hosts/orca/look/), and the file icons are its explorer's default ones
  // (hosts/orca/look/file-icons.js); a font or icon theme the user picked in Orca stays out of reach. An Orca without
  // the editor method (feature-detected with host.has, or a refused call) keeps the skin's code font.
  const UI_FONT = '"Geist", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  // (no `icons` key: the icons never change while a page lives, and a new key would redraw the page once for nothing)
  const own = () => ({ ui: { family: UI_FONT } });
  const lookOf = (ty) => Object.assign(own(), ty && typeof ty === 'object'
    ? { code: { family: ty.cssFontFamily || ty.fontFamily || '', size: ty.fontSize, lineHeight: ty.lineHeight } } : {});
  function look() {
    const host = window.orca && window.orca.host;
    if (!host || typeof host.call !== 'function') return own();
    try { if (typeof host.has === 'function' && !host.has('editor.readTypography')) return own(); } catch (e) { return own(); }
    let answer;
    try { answer = host.call('editor.readTypography', {}); } catch (e) { return own(); }
    return Promise.resolve(answer).then(lookOf, () => own());
  }
  function onLookChange(fn) {
    try { if (window.orca && window.orca.on) window.orca.on('editor.typography.changed', (ty) => { if (ty && typeof ty === 'object') fn(lookOf(ty)); }); } catch (e) { /* no editor events */ }
    return () => {};
  }
  const within = (a, b) => a === b || a.indexOf(b.replace(/\/$/, '') + '/') === 0;
  /** Orca's editor when the open repository is the focused workspace's; otherwise the caller shows the file itself. */
  function openFile(path, o) {
    const ws = O.workspace, root = Git.repo && Git.repo.root;
    if (!ws || ws.status !== 'local' || !ws.workspaceId || !root || !(within(root, ws.path) || within(ws.path, root))) return false;
    const fallback = () => { if (Git.actions && Git.actions.showFile) Git.actions.showFile(path, o || {}); };
    request('openFile', { workspaceId: ws.workspaceId, root, path }).then((res) => { if (!res || !res.opened) fallback(); }, fallback);
    return true;
  }
  Git.host = Object.assign({
    name: 'orca',
    openFile,
    look,
    onLookChange,
    openExternal(url) {
      // → Promise<boolean>: false when Orca did not open it (it asks the person before a site a plugin opens for the
      // first time, and answers `opened: false` when they cancel)
      // A link written to be read (letters as they are, hosts/orca/panel.js) goes as it is; if Orca refuses that
      // spelling, the same address goes once more in its standard ASCII one.
      const open = (u) => Promise.resolve().then(() => window.orca.shell.openExternal(u)).then((r) => !(r && r.opened === false));
      try {
        if (window.orca && window.orca.shell) {
          const text = String(url);
          return open(text).catch(() => {
            let ascii = text;
            try { ascii = new URL(text).href; } catch (e) { /* not an address: as it is */ }
            return ascii !== text ? open(ascii).catch(() => false) : false;
          });
        }
      } catch (e) { /* refused */ }
      return Promise.resolve(false);
    },
    copy,
    prefs,
    hooks: {
      showInLog(id) {
        if (!client) return;
        request('relay', { client, view: 'log', type: 'showInLog', data: { id } }).catch(() => {});
      },
    },
  }, Git.host || {});

  const O = (Git.orca = {
    workspace: null,
    /** Connects this panel (`view`: commit|log|branches|… or '' for the workbench) to the worker. */
    start(v) {
      view = v || '';
      applyTheme();
      try { if (window.orca && window.orca.on) window.orca.on('theme', applyTheme); } catch (e) { /* no theme events */ }
      return connect();
    },
    ready: () => ready,
    /** Stops polling (tests; a closing page just goes away). */
    stop() { generation++; connecting = null; client = null; },
    request,
    /** Handles the worker's or another panel's host message `type` (the center tab: `tab` { root, spec }). */
    onMessage(type, fn) { hostHandlers[type] = fn; },
    instance: () => instance,
    stats: () => Object.assign({ pending: pending.size }, stats),
  });
})();
