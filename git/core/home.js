// The engine's own settings folder: ~/.config/git-panel (GIT_PANEL_HOME or createEngine({ home }) overrides it; a host
// passes its own home explicitly).
//   config.json   { port, discoveryRoots: [folders] }  user settings, written by hand or by the host
//   recent.json   [{ root, name, openedAt }]           repositories opened through repos.open, newest first
//   server.json   { pid, port, url, startedAt }        written by server/cli.js while a server runs
// Nothing is created until something is written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PRODUCT } from './product.js';

export const DEFAULT_CONFIG = Object.freeze({ port: 5210, discoveryRoots: ['~/Developer'] });
const RECENT_CAP = 20;

export function homeDir(explicit) {
  return explicit || process.env[PRODUCT.homeEnv] || path.join(os.homedir(), '.config', PRODUCT.id);
}

export function expandHome(p) {
  if (p === '~') return os.homedir();
  if (typeof p === 'string' && p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function createHome(explicit) {
  const dir = homeDir(explicit);
  const file = (name) => path.join(dir, name);

  function readJson(name, fallback) {
    try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
  }

  function writeJson(name, data) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file(name + '.' + process.pid + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
    fs.renameSync(tmp, file(name));
  }

  function removeFile(name) {
    try { fs.unlinkSync(file(name)); } catch { /* not there */ }
  }

  function config() {
    const c = readJson('config.json', {});
    return { ...DEFAULT_CONFIG, ...(c && typeof c === 'object' ? c : {}) };
  }

  function recent() {
    const list = readJson('recent.json', []);
    return Array.isArray(list) ? list.filter((r) => r && typeof r.root === 'string') : [];
  }

  function remember(repo) {
    const list = recent().filter((r) => r.root !== repo.root);
    list.unshift({ root: repo.root, name: repo.name, openedAt: Date.now() });
    writeJson('recent.json', list.slice(0, RECENT_CAP));
  }

  return { dir, file, readJson, writeJson, removeFile, config, recent, remember };
}
