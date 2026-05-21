#!/usr/bin/env bash
# Open browser instance(s) at URL.
#
# Usage: open-browsers.sh <url> <mode> <count> <label> [reset]
#   mode    none      → no-op (servers-only workflow)
#           shared    → focus an existing Chrome tab matching URL, else open
#                       one tab in your default Chrome profile (cookies +
#                       localStorage shared with your normal browsing).
#                       Calls open-shared-tab.sh.
#           isolated  → open <count> sessions, each with its own
#                       --user-data-dir under /tmp/chrome-profiles/<label>-<i>.
#                       Stable per-label dirs: re-running focuses the existing
#                       window instead of duplicating it.
#                       Calls open-isolated-session.sh.
#   count   positive integer; only consulted when mode=isolated. Default 1.
#   label   short identifier used in isolated profile dir paths. Default "session".
#   reset   if "1", wipe matching profile dirs before launching (isolated only).

set -euo pipefail

URL="${1:-}"
MODE="${2:-none}"
COUNT="${3:-1}"
LABEL="${4:-session}"
RESET="${5:-0}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ -z "$URL" ]; then
  echo "Usage: open-browsers.sh <url> <mode> <count> <label> [reset]"
  exit 1
fi

case "$MODE" in
  none)
    exit 0
    ;;
  shared)
    "$SCRIPT_DIR/open-shared-tab.sh" "$URL"
    ;;
  isolated)
    if ! echo "$COUNT" | grep -Eq '^[0-9]+$' || [ "$COUNT" -lt 1 ]; then
      echo "❌ COUNT must be a positive integer (got '$COUNT')"
      exit 1
    fi
    if [ "$RESET" = "1" ]; then
      "$SCRIPT_DIR/_browser_cleanup.sh" "$LABEL"
    fi
    for i in $(seq 1 "$COUNT"); do
      "$SCRIPT_DIR/open-isolated-session.sh" "$URL" "${LABEL}-${i}"
    done
    ;;
  *)
    echo "❌ Unknown BROWSER mode: '$MODE' (expected: none|shared|isolated)"
    exit 1
    ;;
esac
