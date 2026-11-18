// The system's part of a problem report's "Environment" (ui/git/report.js): what every bug report needs and nothing
// about the person's work. The operating system by its own name and version, git's version, node's. Shared by a
// host's worker (which adds its app's version) and the standalone server (server/report.js).
//   createSystem({ platform?, run? }) -> { read() -> Promise<{ os, arch, git, node }> }    read once, then kept
//   version(text) · plain(text, max) · firstLine(cmd, args) · osName(platform?) · bundleVersion(execPath?, platform?)
// A value that cannot be read is 'unknown'; nothing here throws. Only version-like text leaves (sanitised).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** The first version number in a text ("git version 2.47.0" → "2.47.0"), or null. */
export const version = (s) => { const m = /\d+(?:\.\d+){1,3}(?:[-+][\w.]{1,20})?/.exec(String(s || '')); return m ? m[0] : null; };
/** A text as plain words: letters, digits and a few marks, at most `max` characters. */
export const plain = (s, max) => String(s || '').replace(/[^\w .()+/-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const plistValue = (file, key) => {
  try {
    const m = new RegExp('<key>' + key + '</key>\\s*<string>([^<]{1,60})</string>').exec(fs.readFileSync(file, 'utf8'));
    return m ? m[1] : null;
  } catch (e) { return null; }
};

/** The first line a command prints, or null (not found, failed, slower than 4 s). No shell, no input. */
export function firstLine(cmd, args) {
  return new Promise((resolve) => {
    let out = '', done = false;
    const end = (v) => { if (!done) { done = true; resolve(v); } };
    let child;
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { end(null); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } end(null); }, 4000);
    child.stdout.on('data', (d) => { if (out.length < 400) out += String(d); });
    child.on('error', () => { clearTimeout(timer); end(null); });
    child.on('exit', (code) => { clearTimeout(timer); end(code === 0 ? out.split('\n')[0] : null); });
  });
}

/** "macOS 15.2", "Windows 11 Pro 10.0.22631", "Ubuntu 24.04.1 LTS": the system as its owner knows it. */
export function osName(platform = process.platform) {
  if (platform === 'darwin') {
    const v = version(plistValue('/System/Library/CoreServices/SystemVersion.plist', 'ProductVersion'));
    return v ? 'macOS ' + v : 'macOS (Darwin ' + plain(os.release(), 20) + ')';
  }
  if (platform === 'win32') return plain((typeof os.version === 'function' ? os.version() : 'Windows') + ' ' + os.release(), 60);
  try {
    const m = /^PRETTY_NAME="?([^"\n]{1,60})"?$/m.exec(fs.readFileSync('/etc/os-release', 'utf8'));
    if (m) return plain(m[1], 60);
  } catch (e) { /* no such file */ }
  return plain(platform + ' ' + os.release(), 60);
}

/** An app's version from its own bundle on macOS, for a process that runs inside one (`execPath` under
    `<Name>.app/Contents/`); null elsewhere or when unreadable. */
export function bundleVersion(execPath = process.execPath, platform = process.platform) {
  if (platform !== 'darwin' || typeof execPath !== 'string') return null;
  const i = execPath.indexOf('.app/Contents/');
  if (i <= 0) return null;
  return version(plistValue(path.join(execPath.slice(0, i + 4), 'Contents', 'Info.plist'), 'CFBundleShortVersionString'));
}

export function createSystem(o = {}) {
  const platform = o.platform || process.platform, run = o.run || firstLine;
  let kept = null;
  async function read() {
    if (kept) return kept;
    const git = version(await run('git', ['--version']));
    kept = { os: osName(platform), arch: plain(process.arch, 12), git: git || 'unknown', node: plain(process.versions.node, 20) };
    return kept;
  }
  return { read };
}
