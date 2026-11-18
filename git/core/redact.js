// What the engine's log on disk may say (core/disklog.js, docs/ARCHITECTURE.md §3.7). Paths and ref names are fine;
// never a commit message (replaced by its length), credentials (user:password@ in URLs, auth headers given with -c),
// file content (the log never receives stdin, stdout, diffs or blame; content-like parameters become their length).

/** Commands whose -m / --message value is a message someone wrote (elsewhere -m is a flag: read-tree -m, checkout -m,
    or a number: cherry-pick -m 1). */
const MESSAGE_CMDS = new Set(['commit', 'merge', 'tag', 'stash', 'commit-tree', 'notes']);
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^/\s@'"]+@/gi;
const SECRET_CONFIG = /extraheader|password|passwd|token|secret|auth|credential|cookie/i;
const CONTENT_KEY = /message|content|text|body|input|patch|password|token|secret|stack/i;
const ARG_CAP = 60;
const ARG_LEN = 300;
const STRING_LEN = 200;
const ARRAY_CAP = 5;

const len = (s) => '<' + String(s).length + ' chars>';
const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);

/** Text with the user and password parts of URLs removed ("https://u:p@host/x" -> "https://host/x"). */
export function redactText(s) {
  return String(s == null ? '' : s).replace(URL_USERINFO, '$1');
}

function redactConfig(kv) {
  const at = kv.indexOf('=');
  const key = at < 0 ? kv : kv.slice(0, at);
  return SECRET_CONFIG.test(key) && at >= 0 ? key + '=<redacted>' : redactText(kv);
}

/** A git argument list as the log may show it: messages become their length, credentials go. */
export function redactArgs(args) {
  const out = [];
  let cmd = null;
  let ended = false;
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (cmd === null) {
      if (a === '-c' && i + 1 < args.length) { out.push(a, redactConfig(String(args[++i]))); continue; }
      if (a === '-C' && i + 1 < args.length) { out.push(a, String(args[++i])); continue; }
      if (!a.startsWith('-')) cmd = a;
      out.push(redactText(a));
      continue;
    }
    if (!ended && a === '--') { ended = true; out.push(a); continue; }
    if (!ended && MESSAGE_CMDS.has(cmd)) {
      if ((a === '-m' || a === '--message' || /^-[a-zA-Z]+m$/.test(a)) && i + 1 < args.length) { out.push(a, len(args[++i])); continue; }
      if (a.startsWith('--message=')) { out.push('--message=' + len(a.slice(10))); continue; }
      if (/^-m./.test(a)) { out.push('-m' + len(a.slice(2))); continue; }
    }
    out.push(cut(redactText(a), ARG_LEN));
  }
  if (out.length > ARG_CAP) return out.slice(0, ARG_CAP).concat('… ' + (out.length - ARG_CAP) + ' more');
  return out;
}

/** The first non-empty lines of git's stderr (at most 5, each cut), credentials removed. */
export function stderrHead(text, max = 5) {
  return String(text || '').split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean).slice(0, max).map((l) => cut(redactText(l), ARG_LEN));
}

/** The log line of one git command (runGit's `trace` record). */
export function gitLine(r) {
  const line = { kind: 'git', repo: r.root, args: redactArgs(r.args), ms: r.ms, exit: r.exitCode, out: r.outBytes };
  if (r.errBytes) line.errBytes = r.errBytes;
  if (r.killed) line.killed = r.killed;
  if (r.signal) line.signal = r.signal;
  if (!r.ok) { const head = stderrHead(r.stderr); if (head.length) line.stderr = head; }
  return line;
}

/** An error as the log may show it: code and a cut, credential-free message. */
export function errorSummary(e) {
  const code = (e && e.code) || 'internal';
  return { code, message: cut(redactText((e && e.message) || String(e)), ARG_LEN) };
}

/** A method's parameters as the log may show them: content-like values become their length, long values are cut. */
export function summarizeParams(value, depth = 0, key = '') {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return CONTENT_KEY.test(key) ? len(value) : cut(redactText(value), STRING_LEN);
  if (Array.isArray(value)) {
    if (depth > 2) return '[' + value.length + ']';
    const head = value.slice(0, ARRAY_CAP).map((v) => summarizeParams(v, depth + 1, key));
    return value.length > ARRAY_CAP ? head.concat('… ' + (value.length - ARRAY_CAP) + ' more') : head;
  }
  if (typeof value === 'object') {
    if (depth > 2) return '{…}';
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = CONTENT_KEY.test(k) && typeof v === 'string' ? len(v) : summarizeParams(v, depth + 1, k);
    return out;
  }
  return undefined;
}
