#!/usr/bin/env bash
# Open a URL in your default Chrome profile (cookies + localStorage shared
# with your normal browsing). Used by BROWSER=shared.
#
#   - If a tab with this URL (exact, or a path/query/fragment of it) already
#     exists → focus + reload it
#   - Otherwise → open a new Chrome window
#
# Usage: open-shared-tab.sh <url>

URL="$1"
if [ -z "$URL" ]; then
  echo "Usage: open-shared-tab.sh <url>"
  exit 1
fi

osascript -e "
set targetURL to \"$URL\"

if application \"Google Chrome\" is running then
  tell application \"Google Chrome\"
    set found to false
    repeat with w in windows
      set tabIndex to 0
      repeat with t in tabs of w
        set tabIndex to tabIndex + 1
        set tu to URL of t
        if tu is targetURL or tu starts with (targetURL & \"/\") or tu starts with (targetURL & \"?\") or tu starts with (targetURL & \"#\") then
          set found to true
          set active tab index of w to tabIndex
          set index of w to 1
          reload t
          activate
          return
        end if
      end repeat
    end repeat
    if not found then
      make new window
      set URL of active tab of front window to targetURL
      activate
    end if
  end tell
else
  do shell script \"open -na 'Google Chrome' --args --new-window \" & quoted form of targetURL
end if
" 2>/dev/null
