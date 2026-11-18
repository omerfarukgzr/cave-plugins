# cave-plugins

Official plugins for Cave and the list Cave reads to offer them.

Cave reads `plugins.json` from this repository by default and shows its plugins on the Eklentiler page with the
"Resmî" badge. Each release is pinned to a commit and the digest of the plugin folder, so Cave installs exactly
those bytes. Problems and requests: open an issue here.

## Layout

| Path | What it is |
|---|---|
| `plugins.json` | The official plugin list (`catalogVersion` 1, format in Cave's `docs/plugins.md`). |
| `git/` | Git: an IntelliJ-style Git UI (Commit and Git panels, diff in the centre). Needs Node, which Cave provides. Built from its own source by a publishing script; do not edit by hand. |
| `sdk/` | Shared kit for plugins written in Python: `cave_plugin.py` (client for Cave's plugin service protocol, manifest format 2, stdio JSON-RPC), `panel_server.py` (loopback HTTP server for a right-column panel) and `panel/` (the panels' shared CSS and JS). Standard library only. |

Every plugin folder must work on its own, so the kit is copied into each plugin: `sdk/sync.sh` copies it,
`sdk/sync.sh --check` reports copies that differ.
