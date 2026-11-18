// The per-repository commit-walk cache behind the Log group (docs/ARCHITECTURE.md §5.2).
//
// One `git log --date-order` walk over a set of heads is kept in memory, so log.page is a slice, log.order a copy of
// the ids and log.search a scan over messages read once. The key is everything that decides the walk: the work tree
// root, the heads (ids, in order), the replace refs and the shallow/grafts files. Refs that move give a new key; the
// old walk ages out of a small LRU (createWalkCache({ max })), so memory stays bounded by `max` walks of at most
// LOG_CAP + 1 commits each. A walk is shared by every call that asks for the same key while it is being read; it is
// aborted only when every caller waiting for it has gone away.
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { COMMIT_FORMAT, COMMIT_FIELDS } from '../parse.js';

export const LOG_CAP = 100000;
const stdinOf = (ids) => ids.join('\n') + '\n';

function cancelledError() {
  const e = new Error('cancelled');
  e.name = 'GitError';
  e.cancelled = true;
  return e;
}

/** Resolves like `promise`, or rejects as cancelled when `signal` aborts first. */
function waitFor(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(cancelledError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); }, (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}

export function createWalkCache({ max = 3, maxResults = 32 } = {}) {
  const walks = new Map(); // key -> { promise, ctl, waiters, done }
  const results = new Map(); // walk key + extra -> Promise (log.paths answers)
  const touch = (map, key, v) => { map.delete(key); map.set(key, v); };

  function shared(map, key, build, signal, cap) {
    let ent = map.get(key);
    if (ent) touch(map, key, ent);
    else {
      const ctl = new AbortController();
      ent = { ctl, waiters: 0, done: false };
      ent.promise = build(ctl.signal);
      ent.promise.then(() => { ent.done = true; }, () => { ent.done = true; if (map.get(key) === ent) map.delete(key); });
      map.set(key, ent);
      while (map.size > cap) map.delete(map.keys().next().value);
    }
    ent.waiters++;
    return waitFor(ent.promise, signal).finally(() => {
      ent.waiters--;
      if (!ent.waiters && !ent.done && signal && signal.aborted) {
        ent.ctl.abort();
        if (map.get(key) === ent) map.delete(key);
      }
    });
  }

  return {
    /**
     * The walk for `key` (build(signal) -> walk, see startWalk, runs once per key), resolved once `need` records are
     * there (default: complete). When the last caller waiting for an unfinished walk aborts, the walk is stopped.
     */
    walk(key, build, signal, need = Infinity) {
      let ent = walks.get(key);
      if (ent) touch(walks, key, ent);
      else {
        const ctl = new AbortController();
        ent = { ctl, waiters: 0, w: build(ctl.signal) };
        const mine = ent;
        ent.w.complete.catch(() => { if (walks.get(key) === mine) walks.delete(key); });
        walks.set(key, ent);
        while (walks.size > max) walks.delete(walks.keys().next().value);
      }
      const e = ent;
      e.waiters++;
      return waitFor(need === Infinity ? e.w.complete : e.w.until(need), signal).finally(() => {
        e.waiters--;
        if (!e.waiters && !e.w.done && signal && signal.aborted) {
          e.ctl.abort();
          if (walks.get(key) === e) walks.delete(key);
        }
      });
    },
    /** A memoized answer that depends on a walk key (log.paths). */
    result: (key, build, signal) => shared(results, key, build, signal, maxResults),
    clear() { walks.clear(); results.clear(); },
    get size() { return walks.size; },
    get resultsSize() { return results.size; },
  };
}

/** What decides the walk besides the heads: replace refs and the shallow / grafts files. */
export async function walkFingerprint(ctx, replaceRefs) {
  const replace = replaceRefs !== undefined ? replaceRefs
    : (await ctx.git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/replace/'])).stdout;
  const stamp = (rel) => {
    try { const st = fs.statSync(path.join(ctx.repo.commonDir, rel)); return st.ino + ':' + st.size + ':' + st.mtimeMs; } catch { return '-'; }
  };
  return replace + '\0' + stamp('shallow') + '\0' + stamp('info/grafts');
}

/**
 * Starts reading the walk and returns it at once; records arrive as git writes them, so the first page is served
 * before the whole history is parsed. Walk: { ids, index: Map(id -> position), parents, author, time, committer,
 * commitTime, subject, people ([name, email]; author/committer are indices into it), count, done, truncated,
 * until(n) -> Promise (resolves once n records are there or the walk is complete), complete: Promise }.
 */
export function startWalk(ctx, heads, signal) {
  const w = { ids: [], parents: [], author: [], time: [], committer: [], commitTime: [], subject: [], people: [], index: new Map(), count: 0, done: false, truncated: false, failed: null, messages: null };
  const waiting = [];
  const notify = () => {
    for (let i = waiting.length - 1; i >= 0; i--) {
      const x = waiting[i];
      if (w.failed) { waiting.splice(i, 1); x.reject(w.failed); } else if (w.done || w.count >= x.n) { waiting.splice(i, 1); x.resolve(w); }
    }
  };
  const who = new Map();
  const person = (name, email) => {
    const k = name + '\0' + email;
    let i = who.get(k);
    if (i === undefined) { i = w.people.length; w.people.push([name, email]); who.set(k, i); }
    return i;
  };
  const decoder = new StringDecoder('utf8');
  let tail = '';
  let fields = [];
  const feed = (text) => {
    const parts = (tail + text).split('\0');
    tail = parts.pop();
    for (const t of parts) {
      fields.push(fields.length ? t : t.replace(/^\n/, ''));
      if (fields.length < COMMIT_FIELDS) continue;
      const r = fields;
      fields = [];
      const i = w.count++;
      w.ids.push(r[0]);
      w.parents.push(r[1]);
      w.author.push(person(r[2], r[3]));
      w.time.push(Number(r[4]) * 1000);
      w.committer.push(person(r[5], r[6]));
      w.commitTime.push(Number(r[7]) * 1000);
      w.subject.push(r[8]);
      w.index.set(r[0], i);
    }
    notify();
  };
  w.complete = ctx.git(['log', '-z', '--date-order', '--format=' + COMMIT_FORMAT, '-n', String(LOG_CAP + 1), '--stdin'],
    { input: stdinOf(heads), signal, limitKey: 'walk:' + ctx.repo.root, onStdout: (b) => feed(decoder.write(b)) })
    .then(() => {
      feed(decoder.end() + (tail ? '\0' : ''));
      w.truncated = w.count > LOG_CAP;
      w.done = true;
      notify();
      return w;
    }, (e) => { w.failed = e; notify(); throw e; });
  w.complete.catch(() => {});
  w.until = (n) => (w.failed ? Promise.reject(w.failed) : w.done || w.count >= n ? Promise.resolve(w) : new Promise((resolve, reject) => waiting.push({ n, resolve, reject })));
  return w;
}

/** The whole walk (for callers that need every commit). */
export async function readWalk(ctx, heads, signal) { return startWalk(ctx, heads, signal).complete; }

/** Commits [from, to) of a walk in the wire shape, with their own people table (log.page). */
export function sliceCommits(w, from, to) {
  const people = [];
  const map = new Map();
  const local = (i) => {
    let j = map.get(i);
    if (j === undefined) { j = people.length; people.push({ name: w.people[i][0], email: w.people[i][1] }); map.set(i, j); }
    return j;
  };
  const commits = [];
  for (let i = from; i < to; i++) {
    commits.push({
      id: w.ids[i], parents: w.parents[i] ? w.parents[i].split(' ') : [], author: local(w.author[i]), time: w.time[i],
      committer: local(w.committer[i]), commitTime: w.commitTime[i], subject: w.subject[i],
    });
  }
  return { commits, people };
}

/**
 * Full messages of the walk's commits (aligned with w.ids), read once per walk. A message that holds a NUL byte
 * cannot shift the records: a token is taken for an id only when it names a commit of this walk.
 */
export function walkMessages(ctx, w, heads, signal) {
  if (!w.messages) {
    w.messages = ctx.git(['log', '-z', '--date-order', '--format=%H%x00%B', '-n', String(LOG_CAP + 1), '--stdin'],
      // Shared by every search on this walk, so it is not tied to one caller's signal (a caller can stop waiting).
      { input: stdinOf(heads), signal: null, limitKey: 'walk:' + ctx.repo.root, maxBytes: 1024 * 1024 * 1024 })
      .then((out) => {
        const msgs = new Array(w.ids.length).fill('');
        const tok = out.stdout.split('\0');
        let cur = -1;
        for (let i = 0; i < tok.length; i++) {
          const at = w.index.get(tok[i].replace(/^\n/, ''));
          if (at !== undefined) { cur = at; msgs[cur] = tok[i + 1] === undefined ? '' : tok[i + 1]; i++; continue; }
          if (cur >= 0 && i < tok.length - 1) msgs[cur] += '\0' + tok[i];
        }
        return msgs;
      });
    w.messages.catch(() => { w.messages = null; });
  }
  return waitFor(w.messages, signal);
}

/** Case folding for search: NFC, every I/İ/ı/i the same letter (lenient Turkish), then lower case. */
export function foldCase(s) { return s.normalize('NFC').replace(/[İIı]/g, 'i').toLowerCase(); }

/**
 * Builds the message test of log.search. Plain text: substring; regex: JavaScript (ECMAScript) syntax, multiline
 * (`^`/`$` match at line ends, as git's --grep matches per line). Without caseSensitive the comparison folds case for
 * every script, Turkish included (see foldCase). Returns null for an invalid regular expression.
 */
export function messageMatcher(text, regex, caseSensitive) {
  // Without caseSensitive the test gets foldCase(message) (see foldedMessages).
  if (!regex) {
    const t = caseSensitive ? text.normalize('NFC') : foldCase(text);
    return (m) => m.includes(t);
  }
  const src = caseSensitive ? text : text.replace(/[İIı]/g, 'i');
  const flags = caseSensitive ? 'm' : 'mi';
  let re = null;
  for (const f of [flags + 'u', flags]) { try { re = new RegExp(src, f); break; } catch { /* try without u */ } }
  if (!re) return null;
  return (m) => re.test(m);
}

/** The walk's messages as the matcher wants them: NFC (case sensitive) or folded; computed once per walk. */
export function searchable(w, msgs, caseSensitive) {
  if (caseSensitive) return (w.nfc ||= msgs.map((m) => m.normalize('NFC')));
  return (w.folded ||= msgs.map(foldCase));
}
