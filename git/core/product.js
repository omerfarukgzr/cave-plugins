// The engine's neutral name for itself: the one place in core/ that names the product family. A host gives its own
// values through createEngine({ home, dataDir, label }) and never edits this file.
//   id          the engine's folder inside every git dir (<git dir>/git-panel/) and the settings home's folder name
//   name        what the engine writes into git messages (reflog, stash): "Git Panel: smart checkout"
//   homeEnv     the variable that moves the settings home (~/.config/git-panel)
//   ceilingEnv  the variable whose value becomes GIT_CEILING_DIRECTORIES (core/git.js; the test fixtures use it)
export const PRODUCT = Object.freeze({
  id: 'git-panel',
  name: 'Git Panel',
  homeEnv: 'GIT_PANEL_HOME',
  ceilingEnv: 'GIT_PANEL_CEILING_DIRECTORIES',
});
