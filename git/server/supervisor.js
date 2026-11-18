// The server's supervisor (docs/ARCHITECTURE.md §7 "Supervisor"): `start` runs this in a detached process of its own,
// and it runs the server (`serve`) as its child. When the server dies — a crash, an uncaught exception, kill -9 — it is
// started again after a backoff, with at most MAX_PER_MINUTE restarts in any minute; every start, end and restart is
// written to the log on disk with its reason. A server that dies before it ever listened (the port is taken, a broken
// install) is tried GIVE_UP_AFTER times in a row and then given up, logged. SIGTERM / SIGINT stop both for good.
// No launchd and no npm dependency: plain child_process.
//
// State: <home>/supervisor.json { pid, startedAt, build } while it runs. Whether a pid in it is still this supervisor
// is asked of the system (`ps`), so a file left by a reboot or a kill -9 never passes for a running one.
import { spawn, spawnSync } from 'node:child_process';

export const BACKOFF_MS = Object.freeze([500, 1000, 2000, 5000, 10000]);
export const MAX_PER_MINUTE = 5;
export const GIVE_UP_AFTER = 5;
const STOP_GRACE_MS = 4000;

/**
 * How long to wait before the next start, given the times of the starts so far (oldest first; entries older than a
 * minute are dropped from the array): the backoff step of the starts in the last minute, and never more than
 * MAX_PER_MINUTE starts in any 60 s.
 */
export function nextDelay(starts, t) {
  while (starts.length && t - starts[0] >= 60000) starts.shift();
  let wait = BACKOFF_MS[Math.min(Math.max(starts.length - 1, 0), BACKOFF_MS.length - 1)];
  if (starts.length >= MAX_PER_MINUTE) wait = Math.max(wait, starts[starts.length - MAX_PER_MINUTE] + 60000 - t);
  return wait;
}

/** true when `pid` is a living process. */
export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** The command line of a living process (ps), or null. */
export function commandOf(pid) {
  if (!alive(pid)) return null;
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** supervisor.json when its pid is a supervisor of this home (`…/cli.js supervise … --home <home>`, whichever copy
    of the code it runs: an install's or a working tree's), else null (a stale file, or a pid that is now another
    process). */
export function supervisorOf(home) {
  const s = home.readJson('supervisor.json', null);
  if (!s || !Number.isInteger(s.pid)) return null;
  const cmd = commandOf(s.pid);
  return cmd && /\bcli\.js supervise\b/.test(cmd) && (cmd.endsWith('--home ' + home.dir) || cmd.includes('--home ' + home.dir + ' ')) ? s : null;
}

/**
 * Runs the supervisor loop in this process until it is told to stop.
 *   cli      the CLI file to run `serve` with
 *   args     the arguments after `serve` (identity, home); the port is added per start
 *   port     the port of the first start; later starts keep the port the server really took (port 0 in tests)
 *   home     core/home.js store; log: core/disklog.js log; build: the stamp written into supervisor.json
 */
export function supervise({ cli, args, port, home, log, build = null, now = Date.now }) {
  let child = null, stopping = false, timer = null, failures = 0, total = 0, last = null;
  const starts = [];
  let currentPort = port;
  const info = { pid: process.pid, startedAt: now(), build: build && build.hash ? build.hash : null };
  home.writeJson('supervisor.json', info);
  log.write({ kind: 'supervisor', phase: 'start', pid: process.pid, build: info.build });

  function run() {
    timer = null;
    if (stopping) return;
    starts.push(now());
    total++;
    const a = [...process.execArgv, cli, 'serve', ...args];
    if (Number.isInteger(currentPort)) a.push('--port', String(currentPort));
    let ready = false;
    const c = spawn(process.execPath, a, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], env: { ...process.env, GIT_PANEL_SUPERVISED: '1' } });
    child = c;
    last = { pid: c.pid, at: now() };
    c.on('message', (m) => {
      if (m && m.ready) { ready = true; failures = 0; if (Number.isInteger(m.port)) currentPort = m.port; }
    });
    c.on('error', (e) => log.write({ kind: 'supervisor', phase: 'error', error: e.message }));
    c.on('exit', (code, sig) => {
      if (child === c) child = null;
      const reason = sig ? 'signal ' + sig : 'exit ' + code;
      if (stopping) { finish(0); return; }
      if (!ready) failures++;
      if (failures >= GIVE_UP_AFTER) {
        log.write({ kind: 'supervisor', phase: 'gave-up', reason, failures, port: currentPort });
        process.stderr.write('supervisor: the server did not start ' + failures + ' times in a row (' + reason + '); giving up\n');
        finish(1);
        return;
      }
      const t = now();
      const wait = nextDelay(starts, t);
      log.write({ kind: 'supervisor', phase: 'restart', reason, pid: c.pid, ranMs: t - last.at, ready, inMs: wait, restarts: total });
      process.stderr.write('supervisor: server ' + c.pid + ' ended (' + reason + '), starting again in ' + wait + ' ms\n');
      timer = setTimeout(run, wait);
    });
  }

  let finishing = false;
  function finish(code) {
    if (finishing) return;
    finishing = true;
    const cur = home.readJson('supervisor.json', null);
    if (cur && cur.pid === process.pid) home.removeFile('supervisor.json');
    log.write({ kind: 'supervisor', phase: 'stop', pid: process.pid, restarts: Math.max(0, total - 1) });
    const t = setTimeout(() => process.exit(code), 2000);
    t.unref();
    log.close().finally(() => process.exit(code));
  }

  function stop() {
    if (stopping) return;
    stopping = true;
    if (timer) { clearTimeout(timer); timer = null; }
    if (!child) { finish(0); return; }
    const c = child;
    try { c.kill('SIGTERM'); } catch { /* gone */ }
    setTimeout(() => { if (child === c) { try { c.kill('SIGKILL'); } catch { /* gone */ } } }, STOP_GRACE_MS).unref();
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('SIGHUP', () => {});   // a closing terminal does not end it; only stop does
  run();
  return { stop, get child() { return child; } };
}
