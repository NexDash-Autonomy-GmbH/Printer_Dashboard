#!/bin/sh
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/LaunchAgents/com.nexdash.printer-dashboard.plist"
for p in $(lsof -tiTCP:8765 -sTCP:LISTEN 2>/dev/null); do
  kill "$p" 2>/dev/null || true
done
sleep 1
cp "$ROOT/deploy/com.nexdash.printer-dashboard.plist" "$DEST"
launchctl bootout "gui/$(id -u)/com.nexdash.printer-dashboard" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$DEST"
launchctl enable "gui/$(id -u)/com.nexdash.printer-dashboard"
echo "dashboard will stay up after login: http://127.0.0.1:8765/"
