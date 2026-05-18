#!/usr/bin/env bash
# Close Chrome processes whose --user-data-dir lives under
# /tmp/chrome-profiles/<prefix>* and remove those profile dirs.
#
# Usage: _browser_cleanup.sh <prefix>
#   prefix  matches profile dir names. Trailing "*" implied.
#           e.g. "scenario-share-im-going" matches scenario-share-im-going-1, -2...
#                "scenario-"               matches all scenario-* profiles.

set -euo pipefail

PREFIX="${1:-}"
if [ -z "$PREFIX" ]; then
  echo "Usage: _browser_cleanup.sh <prefix>"
  exit 1
fi

ROOT="/tmp/chrome-profiles"
if [ ! -d "$ROOT" ]; then
  exit 0
fi

MATCHES=$(find "$ROOT" -mindepth 1 -maxdepth 1 -type d -name "${PREFIX}*" 2>/dev/null)
if [ -z "$MATCHES" ]; then
  exit 0
fi

echo "🧹 Closing Chrome sessions: ${PREFIX}*"
for DIR in $MATCHES; do
  # Kill Chrome processes using this exact profile dir
  pkill -f "user-data-dir=${DIR}([^/]|$)" 2>/dev/null || true
done

# Give Chrome a moment to release file locks before removing
sleep 1

for DIR in $MATCHES; do
  rm -rf "$DIR" 2>/dev/null || true
  echo "   removed $DIR"
done
