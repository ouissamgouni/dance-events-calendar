#!/usr/bin/env bash
# Open an isolated Chrome session pointing at URL.
#
# Uses a stable per-label profile dir (/tmp/chrome-profiles/<label>) so the
# session has its own cookie jar / localStorage AND re-running with the same
# label is idempotent: if Chrome is already running with that profile, this
# script prints a message and exits 0 instead of spawning a duplicate window.
#
# To force a clean profile, delete the dir first (use _browser_cleanup.sh
# <label> or `task open:clean*`), then re-run.
#
# Launches Chrome via its binary directly (not `open -na`) so macOS Launch
# Services does not activate the Chrome app and steal focus from other
# isolated sessions (e.g. parallel scenarios).
#
# Profile dirs persist until removed by `task open:clean*` or by `stop:*`
# tasks that wire in browser cleanup.
#
# Usage: open-isolated-session.sh <url> [label]
#   label  short name embedded in the dir path for easier identification

set -euo pipefail

URL="${1:-}"
LABEL="${2:-session}"

if [ -z "$URL" ]; then
  echo "Usage: open-isolated-session.sh <url> [label]"
  exit 1
fi

CHROME_BIN="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ ! -x "$CHROME_BIN" ]; then
  echo "❌ Chrome binary not found at: $CHROME_BIN"
  echo "   Install Google Chrome or adjust CHROME_BIN in $0"
  exit 1
fi

PROFILE_ROOT="/tmp/chrome-profiles"
PROFILE_DIR="${PROFILE_ROOT}/${LABEL}"
mkdir -p "$PROFILE_DIR"

# Idempotency: if a Chrome process is already using this profile dir, don't
# spawn a duplicate window.
if pgrep -f "user-data-dir=${PROFILE_DIR}([^/]|$)" >/dev/null 2>&1; then
  echo "ℹ️  Isolated session already open: $LABEL  ($PROFILE_DIR)"
  exit 0
fi

echo "🌐  Opening isolated Chrome session → $URL"
echo "    Label:       $LABEL"
echo "    Profile dir: $PROFILE_DIR"

"$CHROME_BIN" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --new-window \
  "$URL" >/dev/null 2>&1 &
disown
