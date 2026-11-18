// THE REGISTRATION LIST. Every method module is listed here once; core/engine.js registers what this exports.
// The method definition contract is documented at the top of core/engine.js and in docs/PROTOCOL.md ("Registry").
// A test fails when a registered method is missing from docs/PROTOCOL.md, or documented there but not registered.
import host from './read/host.js';
import state from './read/state.js';
import log from './read/log.js';
import commit from './read/commit.js';
import content from './read/content.js';
import compare from './read/compare.js';
import history from './read/history.js';
import conflict from './read/conflict.js';
import worktreeOps from './ops/worktree.js';
import branchOps from './ops/branches.js';
import remoteOps from './ops/remote.js';
import historyOps from './ops/history.js';
import rewriteOps from './ops/rewrite.js';
import inProgressOps from './ops/inprogress.js';
import extraBranchesRead from './read/extra-branches.js';
import extraBranchesOps from './ops/extra-branches.js';
import extraChangesOps from './ops/extra-changes.js';
import extraLogOps from './ops/extra-log.js';
import extraLogRead from './read/extra-log.js';
import extraChangesRead from './read/extra-changes.js';
import diag from './read/diag.js';
import locate from './read/locate.js';
import worktrees from './read/worktrees.js';
import stashRead from './read/stash.js';
import stashOps from './ops/stash.js';
import lineStats from './read/line-stats.js';

// Mutating operations (core/ops/*.js) are imported above and appended here.
export const METHODS = [
  ...host,
  ...state,
  ...log,
  ...commit,
  ...content,
  ...compare,
  ...history,
  ...conflict,
  ...worktreeOps,
  ...branchOps,
  ...remoteOps,
  ...historyOps,
  ...rewriteOps,
  ...inProgressOps,
  ...extraChangesOps,
  ...extraLogOps,
  ...extraLogRead,
  ...extraBranchesRead,
  ...extraBranchesOps,
  ...extraChangesRead,
  ...diag,
  ...locate,
  ...worktrees,
  ...stashRead,
  ...stashOps,
  ...lineStats,
];
