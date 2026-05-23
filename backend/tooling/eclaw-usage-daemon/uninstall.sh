#!/usr/bin/env bash
# Stop + remove com.eclaw.usage-daemon. Leaves credentials.json + log file
# alone (they belong to the user, not this script).

set -euo pipefail

PLIST_LABEL="com.eclaw.usage-daemon"
PLIST_DEST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
RUNTIME_DIR="$HOME/Library/Application Support/eclaw-usage-daemon"
DOMAIN="gui/$(id -u)"
SERVICE_TARGET="$DOMAIN/$PLIST_LABEL"

if launchctl print "$SERVICE_TARGET" >/dev/null 2>&1; then
    launchctl bootout "$SERVICE_TARGET" || true
    echo "[uninstall] booted out $SERVICE_TARGET"
fi

if [[ -f "$PLIST_DEST" ]]; then
    rm "$PLIST_DEST"
    echo "[uninstall] removed $PLIST_DEST"
fi

if [[ -d "$RUNTIME_DIR" ]]; then
    rm -rf "$RUNTIME_DIR"
    echo "[uninstall] removed $RUNTIME_DIR"
fi

if launchctl list | grep -F "$PLIST_LABEL" >/dev/null; then
    echo "[uninstall] WARN: $PLIST_LABEL still listed; try logging out + back in." >&2
else
    echo "[uninstall] done"
fi
