#!/usr/bin/env bash
# Open a fresh, fully-isolated Chrome session pointing at URL.
#
# Each call creates its own temp --user-data-dir so the new window has a
# completely separate cookie jar and localStorage from every other window —
# better than incognito (which shares state within the same Chrome process).
#
# The temp dir is intentionally NOT cleaned up so the session survives until
# you explicitly close the window. Run 'task open:clean' to remove all of them.
#
# Usage: open-fresh-session.sh <url> [label]
#   label  short name embedded in the dir path for easier identification

set -euo pipefail

URL="${1:-}"
LABEL="${2:-session}"

if [ -z "$URL" ]; then
  echo "Usage: open-fresh-session.sh <url> [label]"
  exit 1
fi

TMPDIR=$(mktemp -d "/tmp/chrome-${LABEL}-XXXXXX")
echo "🌐  Opening fresh Chrome session → $URL"
echo "    Profile dir: $TMPDIR"

open -na "Google Chrome" --args \
  --user-data-dir="$TMPDIR" \
  --no-first-run \
  --no-default-browser-check \
  "$URL"
