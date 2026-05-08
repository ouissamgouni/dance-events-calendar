#!/usr/bin/env bash
# Open browser instance(s) at URL.
#
# Usage: open-browsers.sh <url> <count>
#   count=0  → reuse existing Chrome window/tab (open-browser.sh)
#   count>=1 → open N fresh isolated Chrome sessions (open-fresh-session.sh)

set -euo pipefail

URL="${1:-}"
COUNT="${2:-0}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -z "$URL" ]; then
  echo "Usage: open-browsers.sh <url> <count>"
  exit 1
fi

if [ "$COUNT" = "0" ]; then
  "$SCRIPT_DIR/open-browser.sh" "$URL"
else
  for i in $(seq 1 "$COUNT"); do
    "$SCRIPT_DIR/open-fresh-session.sh" "$URL" "session-$i"
  done
fi
