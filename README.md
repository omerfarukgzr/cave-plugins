# cave-plugins

Official plugins for Cave and the list Cave reads to offer them.

Work in progress: the plugin list and the first plugins are being prepared.

## Layout

| Folder | What it is |
|---|---|
| `sdk/` | Shared kit for plugins written in Python: `cave_plugin.py` (client for Cave's plugin service protocol, manifest format 2, stdio JSON-RPC), `panel_server.py` (loopback HTTP server for a right-column panel) and `panel/` (the panels' shared CSS and JS). Standard library only. |

Every plugin folder must work on its own, so the kit is copied into each plugin: `sdk/sync.sh` copies it,
`sdk/sync.sh --check` reports copies that differ.
