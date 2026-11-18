# Git

IntelliJ-style Git panels for Cave: Commit and Git tabs in the right column, the diff in the centre. It runs the real
`git` of your Mac on the folder of the selected project.

- Needs Node 20 or newer (`node` on your shell's PATH). Cave runs the server itself, on a port it picks; nothing is
  started by hand.
- Needs `git` (the one that comes with the Xcode command line tools is enough).
- It keeps its settings and logs in the plugin's own data folder (`CAVE_PLUGIN_DATA`) and, per repository, a small
  folder inside the git directory (trash of discarded changes, favourites).
- Fetch, pull and push talk to the remotes of your repository through your own git, as they would in a terminal.
