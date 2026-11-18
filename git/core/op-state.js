// What is in progress in a work tree (docs/ARCHITECTURE.md §3.6, §5.1). Everything is read from the PER-WORKTREE git
// dir (repo.gitDir), never from the common dir: each linked worktree has its own merge/rebase state.
//
// Result: null | {
//   type: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'am',
//   conflicts: [{ path, kind }],                       // filled by the snapshot from status 'u' entries
//   yours:  { id, ref, subject } ,                       // stage 2 ("ours"): the current HEAD (in a rebase: the onto
//                                                        //   side plus the commits applied so far; ref = onto's ref)
//   theirs: { id, ref, subject },                        // stage 3: the incoming commit (merge head / picked / reverted)
//   rebase: null | { backend: 'merge'|'apply', branch, onto, origHead, done, step, total, current }
//   sequencer: bool                                      // a multi-commit cherry-pick / revert has more to do
//   pending: bool, concluded: id|null                    // cherry-pick / revert: the sequence waits BEFORE `theirs`;
//                                                        //   concluded: the commit it stopped at was committed outside
//   incomplete: bool                                     // git died while it set the operation up: only an autostash
//                                                        //   is left (a rebase folder without `head-name`, a
//                                                        //   MERGE_AUTOSTASH without MERGE_HEAD); only op.abort applies
//   message: string|null                                 // the commit message git prepared (MERGE_MSG, the rebase's)
// }
// `ref` is a short ref name when one is known (null otherwise); `subject` is filled in by the snapshot.
//
// Pseudo-refs (CHERRY_PICK_HEAD, REVERT_HEAD, REBASE_HEAD) are asked of git, not read as files: in a reftable
// repository they live in the ref store. MERGE_HEAD is peeled to a commit (merging an annotated tag writes the tag).
import path from 'node:path';
import { readGitFile, existsIn } from './repo.js';

const firstLine = (s) => (s == null ? null : s.split('\n')[0].trim() || null);
const shortRef = (r) => (r ? r.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '') : null);
const OID = /^[0-9a-f]{40,64}$/;

/** Name of the merged ref as git wrote it into MERGE_MSG ("Merge branch 'x'", "Merge remote-tracking branch 'origin/x'"). */
export function mergedRefFromMessage(msg) {
  const m = /^Merge (?:remote-tracking )?(?:branch|tag|commit) '([^']+)'/.exec(msg || '');
  return m ? m[1] : null;
}

/** A prepared message without git's comment lines and trailing blank lines (what `git commit` would record). */
export function cleanMessage(text, commentChar = '#') {
  if (text == null) return null;
  const lines = text.replace(/\r\n/g, '\n').split('\n').filter((l) => !l.startsWith(commentChar));
  const out = lines.map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
  return out || null;
}

function readRebase(dir, backend) {
  const rd = (n) => firstLine(readGitFile(dir, n));
  const num = (n) => { const v = rd(n); return v === null ? null : Number(v); };
  const headName = rd('head-name');
  const step = backend === 'merge' ? num('msgnum') : num('next');
  const total = backend === 'merge' ? num('end') : num('last');
  return {
    backend,
    // (no `interactive` flag: git writes rebase-merge/interactive for every merge-backend rebase since 2.26)
    branch: headName && headName !== 'detached HEAD' ? shortRef(headName) : null,
    onto: rd('onto'),
    origHead: rd('orig-head'),
    step,
    total,
    done: step ? Math.max(0, step - 1) : 0,
    current: null,
    // The todo command git stopped after ('edit' at a Stop to Edit, 'pick'/'fixup'… at a conflict, 'exec'), null when
    // unknown (the apply backend).
    action: backend === 'merge' ? lastDone(dir) : null,
  };
}

function lastDone(dir) {
  const lines = (readGitFile(dir, 'done') || '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const m = lines.length ? /^(\S+)/.exec(lines[lines.length - 1]) : null;
  if (!m) return null;
  const short = { p: 'pick', e: 'edit', r: 'reword', s: 'squash', f: 'fixup', x: 'exec', b: 'break', d: 'drop' };
  return short[m[1]] || m[1];
}

/** Resolves names to commit ids with one `git cat-file --batch-check` (missing names -> null). */
async function resolveCommits(git, names) {
  if (!git || !names.length) return names.map(() => null);
  const out = await git(['cat-file', '--batch-check=%(objectname) %(objecttype)'], { input: names.join('\n') + '\n', okCodes: [0, 128] });
  const rows = out.stdout.split('\n');
  return names.map((_, i) => {
    const [id, type] = (rows[i] || '').split(' ');
    return type === 'commit' && OID.test(id) ? id : null;
  });
}

/**
 * `git` is (args, opts) => runGit in the work tree (background options); without it the pseudo-refs are read as
 * files (enough for the files backend). Returns the op or null.
 */
export async function detectOp(gitDir, headBranch, headId, git, commentChar = '#') {
  const file = (n) => firstLine(readGitFile(gitDir, n));
  const yoursHere = { id: headId, ref: headBranch || null, subject: null };
  const sequencer = existsIn(gitDir, 'sequencer');
  const mergeFile = file('MERGE_HEAD');
  const names = ['CHERRY_PICK_HEAD^{commit}', 'REVERT_HEAD^{commit}', 'REBASE_HEAD^{commit}'];
  if (mergeFile) names.push(mergeFile + '^{commit}');
  const viaGit = git ? await resolveCommits(git, names) : [file('CHERRY_PICK_HEAD'), file('REVERT_HEAD'), file('REBASE_HEAD'), mergeFile];
  const [pick, revert, rebaseHead, mergeHead] = viaGit;
  const mergeMsg = readGitFile(gitDir, 'MERGE_MSG');

  const nobody = { id: null, ref: null, subject: null };
  for (const backend of ['merge', 'apply']) {
    const dirName = backend === 'merge' ? 'rebase-merge' : 'rebase-apply';
    if (!existsIn(gitDir, dirName)) continue;
    const dir = path.join(gitDir, dirName);
    if (backend === 'apply' && existsIn(dir, 'applying')) {
      return { type: 'am', incomplete: false, conflicts: [], yours: yoursHere, theirs: nobody, rebase: null, sequencer: false, message: cleanMessage(readGitFile(dir, 'final-commit') || readGitFile(dir, 'msg'), commentChar) };
    }
    if (!existsIn(dir, 'head-name')) {
      // git died while it set the rebase up (after its autostash, before `head-name`): no commit was replayed, and
      // `git rebase --abort / --continue / --skip` cannot read this state. Only op.abort leaves it (autostash.js).
      const rebase = { backend, branch: null, onto: null, origHead: null, step: null, total: null, done: 0, current: null, action: null };
      return { type: 'rebase', incomplete: true, conflicts: [], yours: yoursHere, theirs: nobody, rebase, sequencer: false, message: null };
    }
    const rebase = readRebase(dir, backend);
    const stopped = backend === 'merge' ? readGitFile(dir, 'stopped-sha') : readGitFile(dir, 'original-commit');
    rebase.current = rebaseHead || firstLine(stopped);
    if (rebase.current && !OID.test(rebase.current)) rebase.current = (await resolveCommits(git, [rebase.current + '^{commit}']))[0] || rebase.current;
    // Stage 2 of a rebase is HEAD (onto plus the commits applied so far); the snapshot names it after onto's ref.
    const message = cleanMessage(readGitFile(dir, 'message') || mergeMsg, commentChar);
    return { type: 'rebase', incomplete: false, conflicts: [], yours: { id: headId || rebase.onto, ref: null, subject: null }, theirs: { id: rebase.current, ref: rebase.branch, subject: null }, rebase, sequencer: false, message };
  }
  if (mergeFile) {
    const ref = mergedRefFromMessage(mergeMsg);
    return { type: 'merge', incomplete: false, conflicts: [], yours: yoursHere, theirs: { id: mergeHead || mergeFile, ref, subject: null }, rebase: null, sequencer: false, message: cleanMessage(mergeMsg, commentChar) };
  }
  if (pick) return { type: 'cherry-pick', incomplete: false, conflicts: [], yours: yoursHere, theirs: { id: pick, ref: null, subject: null }, rebase: null, sequencer, pending: false, concluded: null, message: cleanMessage(mergeMsg, commentChar) };
  if (revert) return { type: 'revert', incomplete: false, conflicts: [], yours: yoursHere, theirs: { id: revert, ref: null, subject: null }, rebase: null, sequencer, pending: false, concluded: null, message: cleanMessage(mergeMsg, commentChar) };
  if (sequencer) {
    // A multi-commit cherry-pick / revert without CHERRY_PICK_HEAD / REVERT_HEAD: the sequence waits BEFORE a commit
    // (`pending`, `theirs`; nothing of that commit is applied). git keeps the commit it stopped at as the first line
    // of the todo list in two different situations, which `concludedPick` tells apart:
    //   - it could not start that commit (local changes in the way, or it turned out empty): it waits before it;
    //   - it stopped on a conflict in that commit, and the user resolved it and committed with plain `git commit`
    //     (`concluded`: that commit's id): the sequence waits before the NEXT line, as `git cherry-pick --continue`
    //     sees it.
    const seqDir = path.join(gitDir, 'sequencer');
    const todo = readTodo(gitDir);
    const fullId = async (t) => (OID.test(t.id) ? t.id : (await resolveCommits(git, [t.id + '^{commit}']))[0] || t.id);
    const type = todo[0] ? (todo[0].action === 'revert' ? 'revert' : 'cherry-pick') : /revert/.test(readGitFile(seqDir, 'opts') || '') ? 'revert' : 'cherry-pick';
    const safety = firstLine(readGitFile(seqDir, 'abort-safety'));
    let concluded = null;
    if (todo[0] && git && headId && safety && OID.test(safety) && safety !== headId) {
      const first = await fullId(todo[0]);
      if (await concludedPick(git, type, first, safety, headId)) concluded = first;
    }
    const next = todo[concluded ? 1 : 0] || null;
    const id = next ? await fullId(next) : null;
    return { type, incomplete: false, conflicts: [], yours: yoursHere, theirs: { id, ref: null, subject: null }, rebase: null, sequencer: true, pending: true, concluded, message: null };
  }
  if (existsIn(gitDir, 'MERGE_AUTOSTASH')) {
    // A `git merge --autostash` that died before it recorded the merge (or a squash merge made outside): the user's
    // local changes are in an autostash nobody will apply. op.abort puts them back (autostash.js).
    return { type: 'merge', incomplete: true, conflicts: [], yours: yoursHere, theirs: nobody, rebase: null, sequencer: false, message: null };
  }
  return null;
}

/**
 * True when the commit `id` a sequence stopped at has been committed since (git wrote `abort-safety` = HEAD when it
 * stopped, and HEAD moved): one of the commits `safety..head` is its conclusion. What git records of that:
 *   - `git commit` while CHERRY_PICK_HEAD exists keeps the picked commit's author and author date, and writes the
 *     reflog message "commit (cherry-pick): …" (the sequencer's own commit: "cherry-pick: …");
 *   - a revert's prepared message says "This reverts commit <id>." (the sequencer's own reflog: "revert: …").
 * A commit the user made of something else in between (their own local edit) has none of these.
 */
async function concludedPick(git, type, id, safety, head) {
  try {
    const log = await git(['log', '-z', '--first-parent', '-n', '64', '--format=%H%x00%an%x00%ae%x00%ad%x00%B', '--date=raw', '--end-of-options', safety + '..' + head]);
    const rows = [];
    const parts = log.stdout.split('\0');
    for (let i = 0; i + 4 < parts.length; i += 5) rows.push({ id: parts[i].replace(/^\n/, ''), who: parts.slice(i + 1, i + 4).join('\0'), message: parts[i + 4] });
    if (!rows.length) return false;
    if (type === 'revert') {
      if (rows.some((r) => r.message.includes('This reverts commit ' + id))) return true;
    } else {
      const src = await git(['log', '-1', '-z', '--format=%an%x00%ae%x00%ad', '--date=raw', '--end-of-options', id]);
      const who = src.stdout.replace(/\0$/, '');
      if (who && rows.some((r) => r.who === who)) return true;
    }
    // the first commit made after the stop, by its reflog entry
    const oldest = rows[rows.length - 1].id;
    const reflog = await git(['reflog', 'show', '-z', '-n', '200', '--format=%H%x00%gs', 'HEAD', '--'], { okCodes: [0, 128] });
    const entries = reflog.stdout.split('\0');
    for (let i = 0; i + 1 < entries.length; i += 2) {
      if (entries[i].replace(/^\n/, '') !== oldest) continue;
      return type === 'revert' ? /^revert: /.test(entries[i + 1]) : /^(commit \(cherry-pick\)|cherry-pick): /.test(entries[i + 1]);
    }
    return false;
  } catch { return false; }
}

/** The todo list of a stopped cherry-pick / revert sequence: [{ action: 'pick'|'revert', id (as written, may be short) }]. */
export function readTodo(gitDir) {
  const text = readGitFile(path.join(gitDir, 'sequencer'), 'todo') || '';
  const out = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(pick|p|revert)\s+([0-9a-f]{4,64})\b/.exec(line);
    if (m) out.push({ action: m[1] === 'p' ? 'pick' : m[1], id: m[2] });
  }
  return out;
}

/** The message git prepared while no operation is in progress (a squash merge's SQUASH_MSG, a leftover MERGE_MSG). */
export function pendingMessage(gitDir, commentChar = '#') {
  return cleanMessage(readGitFile(gitDir, 'SQUASH_MSG') || readGitFile(gitDir, 'MERGE_MSG'), commentChar);
}
