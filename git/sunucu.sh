#!/bin/sh
# The Git plugin's launcher in the market copy. Cave runs `sh ./sunucu.sh serve` as the plugin's service in this
# folder (manifest `service`, `port: true`): the server runs in the foreground on CAVE_PLUGIN_PORT, so Cave's SIGTERM
# reaches it, and keeps its settings in CAVE_PLUGIN_DATA (host.json). The server is in this folder (bin/, server/,
# core/, ui/); nothing outside it is needed but a node.
# Which node: CAVE_RUNTIME_NODE (an absolute path Cave provides to a plugin that `requires` the runtime), then
# CAVE_GIT_NODE, then what bin/git-panel finds (PATH, ~/.nvm, Homebrew).

case "$1" in
  serve) ;;
  *) echo "usage: sunucu.sh serve" >&2; exit 64 ;;
esac
if [ -z "$CAVE_PLUGIN_PORT" ]; then echo "git plugin: serve needs CAVE_PLUGIN_PORT (Cave sets it for a service with port: true)" >&2; exit 64; fi
case "$CAVE_PLUGIN_PORT" in
  *[!0-9]*) echo "git plugin: CAVE_PLUGIN_PORT is not a number: $CAVE_PLUGIN_PORT" >&2; exit 64 ;;
esac

here=$(cd "$(dirname "$0")" && pwd -P)

if [ -n "$CAVE_RUNTIME_NODE" ] && [ -x "$CAVE_RUNTIME_NODE" ]; then
  GIT_PANEL_NODE="$CAVE_RUNTIME_NODE"; export GIT_PANEL_NODE
elif [ -n "$CAVE_GIT_NODE" ]; then
  GIT_PANEL_NODE="$CAVE_GIT_NODE"; export GIT_PANEL_NODE
fi

if [ ! -f "$here/bin/git-panel" ] || [ ! -f "$here/server/cli.js" ]; then
  echo "git plugin: the server files are missing in $here" >&2
  exit 127
fi

exec sh "$here/bin/git-panel" serve --port "$CAVE_PLUGIN_PORT" --identity "$here/host.json"
