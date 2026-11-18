// Parsers for git's machine-readable output. Pure functions: string in, plain objects out. Every command whose output
// carries paths is run with -z (or the porcelain formats), so paths with spaces, quotes, newlines and non-ASCII letters
// come through unchanged; `cUnquote` handles the few places git still quotes (blame's `filename`).

/** Fields of `git log -z --format=<fields joined by %x00>`: records end with NUL, fields are NUL-separated. */
export function splitNulRecords(text, fieldCount) {
  if (!text) return [];
  const parts = text.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  const out = [];
  for (let i = 0; i + fieldCount <= parts.length; i += fieldCount) {
    // Between records git may emit a newline (tformat) — strip it from the first field.
    const rec = parts.slice(i, i + fieldCount);
    rec[0] = rec[0].replace(/^\n/, '');
    out.push(rec);
  }
  return out;
}

export const COMMIT_FORMAT = '%H%x00%P%x00%an%x00%ae%x00%at%x00%cn%x00%ce%x00%ct%x00%s';
export const COMMIT_FIELDS = 9;

/** A people table: identical name+email pairs share one index. */
export function createPeople() {
  const list = [];
  const index = new Map();
  return {
    list,
    add(name, email) {
      const key = name + '\0' + email;
      let i = index.get(key);
      if (i === undefined) { i = list.length; list.push({ name, email }); index.set(key, i); }
      return i;
    },
  };
}

/** One commit record (COMMIT_FORMAT) -> wire commit with author/committer as people indices. */
export function commitFromRecord(rec, people) {
  return {
    id: rec[0],
    parents: rec[1] ? rec[1].split(' ') : [],
    author: people.add(rec[2], rec[3]),
    time: Number(rec[4]) * 1000,
    committer: people.add(rec[5], rec[6]),
    commitTime: Number(rec[7]) * 1000,
    subject: rec[8],
  };
}

/** `git status --porcelain=v2 -z --branch` */
export function parseStatusV2(text) {
  const branch = { oid: null, head: null, upstream: null, ahead: 0, behind: 0 };
  const entries = [];
  const tok = text.split('\0');
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    if (!t) continue;
    if (t.startsWith('# ')) {
      const sp = t.indexOf(' ', 2);
      const key = t.slice(2, sp);
      const val = t.slice(sp + 1);
      if (key === 'branch.oid') branch.oid = val === '(initial)' ? null : val;
      else if (key === 'branch.head') branch.head = val === '(detached)' ? null : val;
      else if (key === 'branch.upstream') branch.upstream = val;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) { branch.ahead = Number(m[1]); branch.behind = Number(m[2]); }
      }
      continue;
    }
    const kind = t[0];
    if (kind === '?' || kind === '!') { entries.push({ type: kind, path: t.slice(2) }); continue; }
    const fieldCount = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : -1;
    if (fieldCount < 0) continue;
    const f = splitFields(t, fieldCount);
    const e = { type: kind, xy: f[1], sub: f[2], path: f.rest };
    if (kind === '1') { e.modeHead = f[3]; e.modeIndex = f[4]; e.modeWorktree = f[5]; e.idHead = f[6]; e.idIndex = f[7]; }
    if (kind === '2') {
      e.modeHead = f[3]; e.modeIndex = f[4]; e.modeWorktree = f[5]; e.idHead = f[6]; e.idIndex = f[7];
      e.score = f[8];
      e.origPath = tok[++i];
    }
    if (kind === 'u') { e.modes = [f[3], f[4], f[5], f[6]]; e.ids = [f[7], f[8], f[9]]; }
    entries.push(e);
  }
  return { branch, entries };
}

/** First `n` space-separated fields (index 0 is the record type), the remainder as `rest` (the path). */
function splitFields(t, n) {
  const f = [];
  let pos = 0;
  for (let k = 0; k < n; k++) {
    const sp = t.indexOf(' ', pos);
    f.push(t.slice(pos, sp));
    pos = sp + 1;
  }
  f.rest = t.slice(pos);
  return f;
}

const CONFLICT_KINDS = {
  DD: 'both-deleted', AU: 'added-by-us', UD: 'deleted-by-them', UA: 'added-by-them',
  DU: 'deleted-by-us', AA: 'both-added', UU: 'both-modified',
};
export const conflictKind = (xy) => CONFLICT_KINDS[xy] || 'both-modified';

/**
 * A status entry as IntelliJ's local change (HEAD against the work tree, staging ignored).
 * Returns null when there is no difference to HEAD (added, then deleted from disk).
 */
export function localChange(e) {
  if (e.type === '?') return { path: e.path, status: '?' };
  if (e.type !== '1' && e.type !== '2') return null; // ignored files; unmerged entries are conflicts, not changes
  const X = e.xy[0];
  const Y = e.xy[1];
  const kindOf = (mode) => (mode === '160000' ? 'gitlink' : mode === '120000' ? 'symlink' : undefined);
  let out;
  if (e.type === '2') {
    if (Y === 'D') out = { path: e.origPath, status: 'D' };
    else if (X === 'C') out = { path: e.path, status: 'A' };
    else out = { path: e.path, status: 'R', oldPath: e.origPath };
  } else if (X === 'A' || (X === '.' && Y === 'A')) {
    // ".A" is an intent-to-add entry (git add -N): new against HEAD
    if (Y === 'D') return null;
    out = { path: e.path, status: 'A' };
  } else if (X === 'D' || Y === 'D') {
    out = { path: e.path, status: 'D' };
  } else {
    out = { path: e.path, status: 'M' };
  }
  // The kind of the side that is shown: the work tree's (the index's when the work tree has no file), HEAD's for a
  // deletion. A symlink replaced by a regular file is a file now.
  const zero = (m) => !m || /^0+$/.test(m);
  const mode = out.status === 'D' ? e.modeHead : !zero(e.modeWorktree) ? e.modeWorktree : !zero(e.modeIndex) ? e.modeIndex : e.modeHead;
  const kind = kindOf(mode);
  if (kind) out.kind = kind;
  return out;
}

/** `git diff-tree -r -z --raw` / `git diff --raw -z`: [{ status, score, oldMode, newMode, oldId, newId, path, oldPath }] */
export function parseRawDiff(text) {
  const out = [];
  const tok = text.split('\0');
  for (let i = 0; i < tok.length; i++) {
    const head = tok[i].replace(/^\n/, '');
    if (!head.startsWith(':')) continue;
    const [oldMode, newMode, oldId, newId, st] = head.slice(1).split(' ');
    const letter = st[0];
    const e = { status: letter, score: st.length > 1 ? Number(st.slice(1)) : null, oldMode, newMode, oldId, newId };
    if (letter === 'R' || letter === 'C') { e.oldPath = tok[++i]; e.path = tok[++i]; } else e.path = tok[++i];
    out.push(e);
  }
  return out;
}

const ZERO = /^0+$/;
const modeKind = (mode) => (mode === '160000' ? 'gitlink' : mode === '120000' ? 'symlink' : 'file');

/** A raw diff entry as a wire change: { path, status: A|M|D|R, oldPath?, oldId, newId, kind, oldKind? } */
export function changeFromRaw(e) {
  let status = e.status;
  if (status === 'T') status = 'M';
  if (status === 'C') status = 'A';
  const c = { path: e.path, status };
  if (e.status === 'R') { c.oldPath = e.oldPath; c.similarity = e.score; }
  if (e.status === 'C') c.copiedFrom = e.oldPath;
  c.oldId = ZERO.test(e.oldId) ? null : e.oldId;
  c.newId = ZERO.test(e.newId) ? null : e.newId;
  c.kind = modeKind(status === 'D' ? e.oldMode : e.newMode);
  if (e.status === 'T') c.oldKind = modeKind(e.oldMode);
  return c;
}

/** C-style quoted name ("a\tb\303\247") -> string; unquoted input is returned as is. */
export function cUnquote(s) {
  if (!s || s[0] !== '"' || s[s.length - 1] !== '"') return s;
  const bytes = [];
  const esc = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '"': 34, '\\': 92 };
  const body = Buffer.from(s.slice(1, -1), 'utf8');
  for (let i = 0; i < body.length; i++) {
    const b = body[i];
    if (b !== 92) { bytes.push(b); continue; }
    const n = String.fromCharCode(body[i + 1]);
    if (/[0-7]/.test(n)) { bytes.push(parseInt(body.slice(i + 1, i + 4).toString('latin1'), 8)); i += 3; continue; }
    bytes.push(esc[n] !== undefined ? esc[n] : body[i + 1]);
    i += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/** `git blame --porcelain` -> { lines: [{ id, line }], commits: { id: info } }; uncommitted lines have id null. */
export function parseBlame(text) {
  const lines = [];
  const commits = {};
  const rows = text.split('\n');
  let cur = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.startsWith('\t')) {
      if (cur) lines.push({ id: cur.id, line: cur.orig });
      cur = null;
      continue;
    }
    const m = /^([0-9a-f]{40,64}) (\d+) (\d+)/.exec(r);
    if (m) {
      const id = ZERO.test(m[1]) ? null : m[1];
      cur = { id, orig: Number(m[2]) };
      if (id && !commits[id]) commits[id] = { author: { name: '', email: '' }, time: 0, committer: { name: '', email: '' }, commitTime: 0, subject: '', path: null, previous: null, boundary: false };
      continue;
    }
    if (!cur || !cur.id) continue;
    const info = commits[cur.id];
    const sp = r.indexOf(' ');
    const key = sp < 0 ? r : r.slice(0, sp);
    const val = sp < 0 ? '' : r.slice(sp + 1);
    if (key === 'author') info.author.name = val;
    else if (key === 'author-mail') info.author.email = val.replace(/^<|>$/g, '');
    else if (key === 'author-time') info.time = Number(val) * 1000;
    else if (key === 'committer') info.committer.name = val;
    else if (key === 'committer-mail') info.committer.email = val.replace(/^<|>$/g, '');
    else if (key === 'committer-time') info.commitTime = Number(val) * 1000;
    else if (key === 'summary') info.subject = val;
    else if (key === 'boundary') info.boundary = true;
    else if (key === 'filename') info.path = cUnquote(val);
    else if (key === 'previous') {
      const p = val.indexOf(' ');
      info.previous = { id: val.slice(0, p), path: cUnquote(val.slice(p + 1)) };
    }
  }
  return { lines, commits };
}

/** `%(upstream:track)` -> { ahead, behind, gone } */
export function parseTrack(track) {
  const r = { ahead: 0, behind: 0, gone: false };
  if (!track) return r;
  if (track.includes('gone')) { r.gone = true; return r; }
  const a = /ahead (\d+)/.exec(track);
  const b = /behind (\d+)/.exec(track);
  if (a) r.ahead = Number(a[1]);
  if (b) r.behind = Number(b[1]);
  return r;
}

/** Lines of NUL-separated fields (for-each-ref with %00 in the format). */
export function parseFieldLines(text, count) {
  return text.split('\n').filter((l) => l).map((l) => {
    const f = l.split('\0');
    while (f.length < count) f.push('');
    return f;
  });
}
