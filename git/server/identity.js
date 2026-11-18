// Who the server is (docs/ARCHITECTURE.md §7 "Identity"). The standalone server is neutral (core/product.js); a host
// that runs it under its own name hands the CLI a JSON file with `--identity <file>`:
//   { "id":      "my-tool",            the CLI's name in its messages, the /ping name, the default home and data folder
//     "label":   "My Tool",            the name the engine writes into git messages (reflog, stash)
//     "dataDir": "my-tool",            the engine's folder inside every git dir
//     "home":    "~/.config/my-tool",  the settings home
//     "homeEnv": ["MY_TOOL_HOME"],     variables that move the home, first set one wins
//     "adapter": "page.js" }           a script the page loads first (served at /host/adapter.js), relative to the file
// Every field is optional; a missing one takes the neutral value. The base never names a host: hosts/<name>/ holds
// that host's file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PRODUCT } from '../core/product.js';
import { expandHome } from '../core/home.js';

export const NEUTRAL = Object.freeze({
  id: PRODUCT.id,
  label: PRODUCT.name,
  dataDir: PRODUCT.id,
  home: '~/.config/' + PRODUCT.id,
  homeEnv: Object.freeze([PRODUCT.homeEnv]),
  adapter: null,
  file: null,
});

const NAME = /^[a-z0-9][a-z0-9._-]{0,40}$/i;
const ENV = /^[A-Z_][A-Z0-9_]*$/;

/** Reads and checks a host's identity file; throws with the reason when a field is wrong. */
export function loadIdentity(file) {
  if (!file) return NEUTRAL;
  const abs = path.resolve(file);
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(abs + ': not an object');
  const out = { ...NEUTRAL, file: abs };
  for (const k of ['id', 'dataDir']) {
    if (raw[k] === undefined) continue;
    if (typeof raw[k] !== 'string' || !NAME.test(raw[k])) throw new Error(abs + ': ' + k + ' must be a plain name');
    out[k] = raw[k];
  }
  if (raw.id !== undefined) {
    if (raw.dataDir === undefined) out.dataDir = raw.id;
    if (raw.home === undefined) out.home = '~/.config/' + raw.id;
  }
  if (raw.label !== undefined) {
    if (typeof raw.label !== 'string' || !raw.label.trim()) throw new Error(abs + ': label must be a non-empty string');
    out.label = raw.label.trim().slice(0, 40);
  }
  if (raw.home !== undefined) {
    if (typeof raw.home !== 'string' || !(raw.home.startsWith('~/') || path.isAbsolute(raw.home))) throw new Error(abs + ': home must start with ~/ or /');
    out.home = raw.home;
  }
  if (raw.homeEnv !== undefined) {
    if (!Array.isArray(raw.homeEnv) || !raw.homeEnv.every((v) => typeof v === 'string' && ENV.test(v))) throw new Error(abs + ': homeEnv must list variable names');
    out.homeEnv = Object.freeze(raw.homeEnv.slice());
  }
  if (raw.adapter !== undefined && raw.adapter !== null) {
    if (typeof raw.adapter !== 'string' || !raw.adapter.endsWith('.js')) throw new Error(abs + ': adapter must name a .js file');
    out.adapter = path.resolve(path.dirname(abs), raw.adapter);
    if (!fs.statSync(out.adapter).isFile()) throw new Error(out.adapter + ': not a file');
  }
  return Object.freeze(out);
}

/** The settings home of `identity`: the first of its homeEnv variables that is set, else its `home`. */
export function resolveHome(identity, env = process.env) {
  for (const k of identity.homeEnv) if (env[k]) return env[k];
  return identity.home.startsWith('~/') ? expandHome(identity.home) : identity.home || path.join(os.homedir(), '.config', identity.id);
}
