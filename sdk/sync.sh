#!/usr/bin/env bash
# Copy the shared SDK into every plugin folder (each plugin folder must work on its own):
#   sdk/cave_plugin.py          -> <plugin>/cave_plugin.py                (every plugin)
#   sdk/panel_server.py         -> <plugin>/panel_server.py               (plugins with a ui/ folder)
#   sdk/panel/panel.css, .js    -> <plugin>/ui/panel.css, <plugin>/ui/panel.js
# `sync.sh --check` only reports copies that differ and exits 1 if there is one.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
sdk=$root/sdk
bad=0
one() {   # one <source> <target>
  if [ "$mode" = check ]; then
    cmp -s "$1" "$2" || { echo "differs: $2"; bad=1; }
  else
    cp "$1" "$2"
    echo "synced: $2"
  fi
}
mode=copy
[ "${1:-}" = "--check" ] && mode=check
for dir in "$root"/*/; do
  dir=${dir%/}
  [ -f "$dir/cave-plugin.json" ] || continue
  one "$sdk/cave_plugin.py" "$dir/cave_plugin.py"
  if [ -d "$dir/ui" ]; then
    one "$sdk/panel_server.py" "$dir/panel_server.py"
    one "$sdk/panel/panel.css" "$dir/ui/panel.css"
    one "$sdk/panel/panel.js" "$dir/ui/panel.js"
  fi
done
exit $bad
