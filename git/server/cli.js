#!/usr/bin/env node
// git-panel CLI (docs/ARCHITECTURE.md §7).
//   git-panel serve [--port N]   run the server in the foreground (--port 0 picks a free port)
//   git-panel start [--port N]   start it detached under its supervisor and return at once (a host may stop a command
//                                after a few seconds); a server of this build already running: nothing; a server of
//                                another build (or one without its supervisor): stopped, and this build started
//   git-panel stop               stop the supervisor and the server, for good
//   git-panel status             exit 0 and print the URL when a server answers, exit 1 otherwise (both are named)
//   git-panel open [folder]      remember the folder (default: the last one) as the current repository, print the URL
//   --identity <file>            run under a host's name, home and data folder (server/identity.js); default: neutral
// Internal: `supervise` (server/supervisor.js) is what `start` detaches; it runs `serve` as its child.
// State: <home>/server.json { pid, port, url, startedAt, build } while a server runs; <home>/supervisor.json while its
// supervisor runs; <home>/server.log (stdout and stderr of both); <home>/log/YYYY-MM-DD.jsonl, the log on disk.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEngine } from '../core/engine.js';
import { createHome } from '../core/home.js';
import { createDiskLog, logDir } from '../core/disklog.js';
import { startServer } from './server.js';
import { NEUTRAL, loadIdentity, resolveHome } from './identity.js';
import { buildStamp } from './build.js';
import { supervise, supervisorOf, alive } from './supervisor.js';
import { diagnosticsOf } from './diagnostics.js';
import { createReport } from './report.js';

const CLI = fileURLToPath(import.meta.url);
const HERE = path.dirname(CLI);
const ROOT = path.join(HERE, '..');
const UI_DIR = path.join(ROOT, 'ui');

/** Who this process is (server/identity.js); set by main() before anything is printed. */
let me = NEUTRAL;
const fail = (text) => process.stderr.write(me.id + ': ' + text + '\n');

/** A port given on the command line: decimal digits, 0–65535; anything else is an error (exit 2), not a fallback. */
function portArg(v) {
  if (typeof v !== 'string' || !/^\d{1,5}$/.test(v) || Number(v) > 65535) {
    fail('invalid port ' + JSON.stringify(v === undefined ? '' : v) + ' (0–65535)');
    process.exit(2);
  }
  return Number(v);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') out.port = portArg(argv[++i]);
    else if (a.startsWith('--port=')) out.port = portArg(a.slice(7));
    else if (a === '--identity') out.identity = argv[++i];
    else if (a === '--home') out.home = argv[++i];   // internal: `start` hands its home to the processes it spawns
    else out._.push(a);
  }
  return out;
}

/** The engine of this identity: its home, its folder in every git dir, its name in git messages, its log on disk. */
const engineFor = (home, log) => createEngine({ home: home.dir, dataDir: me.dataDir, label: me.label, log });

/** The log on disk of this identity: <home>/log/YYYY-MM-DD.jsonl (docs/ARCHITECTURE.md §3.7); off quietly when it
    cannot write, with one line on stderr (the server's own log, server.log for `start`). */
const openLog = (home) => createDiskLog({ dir: logDir(home.dir), host: me.id, onDisable: (e) => fail('log on disk is off: ' + ((e && e.message) || e)) });

/** The build of the code this CLI file belongs to (server/build.js), computed once. */
let BUILD = null;
const build = () => (BUILD ||= buildStamp(ROOT, me.file));

const LOCK_STALE_MS = 15000;

/** Runs fn while holding <home>/start.lock (O_EXCL), so two `start`s at once start one server. */
async function withStartLock(home, fn) {
  fs.mkdirSync(home.dir, { recursive: true });
  const file = home.file('start.lock');
  for (let i = 0; ; i++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(file).mtimeMs; } catch { continue; }
      if (age > LOCK_STALE_MS) { try { fs.unlinkSync(file); } catch { /* someone else did */ } continue; }
      if (i > 200) throw new Error('another start holds ' + file);
      await sleep(100);
    }
  }
  try { return await fn(); } finally { try { fs.unlinkSync(file); } catch { /* gone */ } }
}

function ping(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/ping', timeout: timeoutMs, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** server.json of a server that answers as this identity with that pid, with its /ping answer; else null. */
async function running(home) {
  const s = home.readJson('server.json', null);
  if (!s || !s.port) return null;
  const p = await ping(s.port);
  return p && p.name === me.id && p.pid === s.pid ? { ...s, ping: p } : null;
}

/** An uncaught exception or unhandled rejection is written (stack included) to stderr and the log on disk, and the
    process ends with 70: never swallowed, never left running in an unknown state. Its supervisor starts it again. */
function crashHandlers(log, what) {
  let dying = false;
  const die = (kind, err) => {
    if (dying) return;
    dying = true;
    const stack = String((err && err.stack) || err).split('\n').slice(0, 30);
    try { fs.writeSync(2, me.id + ': ' + what + ' ' + kind + ': ' + stack.join('\n') + '\n'); } catch { /* no stderr */ }
    try { log.write({ kind: 'crash', what: kind, process: what, pid: process.pid, message: String((err && err.message) || err).slice(0, 500), stack }); } catch { /* no log */ }
    setTimeout(() => process.exit(70), 2000).unref();
    Promise.resolve(log.close()).finally(() => process.exit(70));
  };
  process.on('uncaughtException', (e) => die('uncaughtException', e));
  process.on('unhandledRejection', (e) => die('unhandledRejection', e));
}

async function serve(home, args) {
  const port = Number.isInteger(args.port) ? args.port : home.config().port;
  const log = openLog(home);
  crashHandlers(log, 'server');
  const b = build();
  // What a problem report carries from this process (server/report.js): the engine's log also feeds its memory.
  const report = createReport({ home: home.dir, label: me.label, version: b.version, build: b.hash,
    log: (m) => log.write({ kind: 'host', text: String(m).slice(0, 500) }) });
  const engine = engineFor(home, report.tap(log));
  // whose child it is: the supervisor's pid while the IPC channel to it is open (it is gone after a kill -9 of it)
  const supervisor = () => (process.env.GIT_PANEL_SUPERVISED === '1' && process.connected ? process.ppid : null);
  const testDiag = process.env.GIT_PANEL_TEST_DIAG === '1';
  let srv;
  try {
    srv = await startServer({ engine, uiDir: UI_DIR, port, name: me.id, adapter: me.adapter, build: b, supervisor,
      diagnostics: testDiag ? diagnosticsOf({ engine, log }) : null, services: report.services });
  } catch (e) {
    fail(e.code === 'EADDRINUSE' ? 'port ' + port + ' is in use' : e.message);
    log.write({ kind: 'start-failed', version: b.version, build: b.hash, port, error: e.code || e.message });
    engine.close();
    await log.close();
    process.exit(2);
  }
  report.attach({ engine, pages: () => srv.pages() });
  const info = { pid: process.pid, port: srv.port, url: srv.url, startedAt: Date.now(), build: b.hash };
  home.writeJson('server.json', info);
  log.write({ kind: 'start', version: b.version, build: b.hash, dev: b.dev, pid: process.pid, port: srv.port, node: process.versions.node, supervisor: supervisor() });
  process.stdout.write(srv.url + '\n');
  if (process.send) { try { process.send({ ready: true, port: srv.port, pid: process.pid }); } catch { /* the supervisor went */ } }
  const stop = async () => {
    const cur = home.readJson('server.json', null);
    if (cur && cur.pid === process.pid) home.removeFile('server.json');
    await srv.close();
    report.stop();
    engine.close();
    log.write({ kind: 'stop', pid: process.pid });
    await log.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  // the supervisor going away (kill -9) does not end the server: `status` says it is not supervised, `start` mends it
  process.on('disconnect', () => {});
}

/** Runs the supervisor (`start` detaches it): server/supervisor.js. */
function runSupervisor(home, args) {
  const log = openLog(home);
  crashHandlers(log, 'supervisor');
  const port = Number.isInteger(args.port) ? args.port : home.config().port;
  const pass = [];
  if (me.file) pass.push('--identity', me.file);
  pass.push('--home', home.dir);
  supervise({ cli: CLI, args: pass, port, home, log, build: build() });
}

/** Stops the supervisor (when there is one of this CLI) and the server; waits until both are gone. */
async function stopAll(home) {
  const cur = await running(home);
  const sup = supervisorOf(home);
  if (!cur && !sup) return 'not running';
  if (sup) { try { process.kill(sup.pid, 'SIGTERM'); } catch { /* gone */ } }
  // an unsupervised server, or one whose supervisor is another (an older install's) process
  if (cur && (!sup || cur.ping.supervisor !== sup.pid)) { try { process.kill(cur.pid, 'SIGTERM'); } catch { /* gone */ } }
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const serverUp = cur ? alive(cur.pid) && !!(await ping(cur.port, 300)) : false;
    if (!serverUp && !(sup && alive(sup.pid))) return 'stopped';
  }
  for (const pid of [sup && sup.pid, cur && cur.pid]) if (pid && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  await sleep(200);
  if ((sup && alive(sup.pid)) || (cur && alive(cur.pid))) throw new Error('server ' + (cur ? cur.pid : '-') + ' / supervisor ' + (sup ? sup.pid : '-') + ' did not stop');
  return 'stopped';
}

async function start(home, args) {
  return withStartLock(home, () => startLocked(home, args));
}

async function startLocked(home, args) {
  const want = build();
  let cur = await running(home);
  let sup = supervisorOf(home);
  if (!cur && sup) {
    // its supervisor is starting it again (after a crash): wait for it rather than start a second one
    for (let i = 0; i < 40 && !cur && sup; i++) { await sleep(150); cur = await running(home); sup = supervisorOf(home); }
  }
  if (cur) {
    const same = !!(want.hash && cur.ping.build && cur.ping.build.hash === want.hash);
    const supervised = !!(sup && cur.ping.supervisor === sup.pid);
    if (same && supervised) { process.stdout.write(cur.url + '\n'); return 0; }
    const why = !same ? 'build ' + ((cur.ping.build && cur.ping.build.hash) || 'unknown') + ' runs, ' + want.hash + ' is installed' : 'not supervised';
    process.stderr.write(me.id + ': restarting the server (' + why + ')\n');
    const log = openLog(home);
    log.write({ kind: 'restart', reason: why, pid: cur.pid, build: want.hash });
    await log.close();
    try { await stopAll(home); } catch (e) { fail(e.message); return 1; }
  } else if (sup) {
    try { await stopAll(home); } catch (e) { fail(e.message); return 1; }
  }
  fs.mkdirSync(home.dir, { recursive: true });
  const out = fs.openSync(home.file('server.log'), 'a');
  const childArgs = [CLI, 'supervise'];
  if (Number.isInteger(args.port)) childArgs.push('--port', String(args.port));
  if (me.file) childArgs.push('--identity', me.file);
  childArgs.push('--home', home.dir);
  const child = spawn(process.execPath, [...process.execArgv, ...childArgs], { detached: true, stdio: ['ignore', out, out], env: process.env });
  child.unref();
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    const s = home.readJson('server.json', null);
    const p = s && s.port ? await ping(s.port) : null;
    if (p && p.name === me.id && p.supervisor === child.pid) { process.stdout.write(s.url + '\n'); return 0; }
    if (exited !== null) break;
  }
  fail('the server did not start; see ' + home.file('server.log'));
  return 1;
}

async function stop(home) {
  try {
    process.stdout.write((await stopAll(home)) + '\n');
    return 0;
  } catch (e) {
    fail(e.message);
    return 1;
  }
}

async function status(home) {
  const cur = await running(home);
  const sup = supervisorOf(home);
  const b = cur && cur.ping.build && cur.ping.build.hash ? ', build ' + cur.ping.build.hash : '';
  if (cur) {
    const by = cur.ping.supervisor ? 'supervisor ' + cur.ping.supervisor : 'not supervised';
    process.stdout.write(cur.url + ' (pid ' + cur.pid + ', ' + by + b + ')\n');
    return 0;
  }
  if (sup) { process.stdout.write('not running; its supervisor ' + sup.pid + ' is starting it again\n'); return 1; }
  process.stdout.write('not running\n');
  return 1;
}

async function open(home, args) {
  const folder = args._[1] ? path.resolve(args._[1]) : (home.recent()[0] || {}).root;
  if (!folder) { fail('no folder given and no recent repository'); return 1; }
  const engine = engineFor(home);
  try {
    const repo = await engine.call('repos.open', { path: folder });
    const cur = await running(home);
    const port = cur ? cur.port : home.config().port;
    process.stdout.write('http://127.0.0.1:' + port + '/?repo=' + encodeURIComponent(repo.root) + '\n');
    return 0;
  } catch (e) {
    fail((e.code || 'error') + ': ' + e.message);
    return 1;
  } finally {
    engine.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--identity');
  try {
    me = loadIdentity(at >= 0 ? argv[at + 1] : null);
  } catch (e) {
    fail('identity: ' + e.message);
    process.exit(2);
  }
  const args = parseArgs(argv);
  const home = createHome(args.home || resolveHome(me));
  const cmd = args._[0];
  if (cmd === 'serve') return serve(home, args);
  if (cmd === 'supervise') return runSupervisor(home, args);
  const run = { start, stop, status, open }[cmd];
  if (!run) {
    process.stderr.write('usage: ' + me.id + ' serve|start|stop|status|open [--port N] [--identity file] [folder]\n');
    process.exit(64);
  }
  process.exit(await run(home, args));
}

main();
