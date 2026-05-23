#!/usr/bin/env bash
# Install com.eclaw.usage-daemon under launchd (user agent).
# Idempotent: safe to re-run; will bootout an existing service before bootstrap.
#
# Side effects:
#   ~/Library/Application Support/eclaw-usage-daemon/*.py   (daemon runtime copy)
#   ~/Library/LaunchAgents/com.eclaw.usage-daemon.plist     (rendered)
#   ~/Library/Logs/eclaw-usage-daemon.log                   (created empty)
#   ~/.eclaw/credentials.json                               (only if missing)
#
# Why the runtime copy: macOS TCC blocks launchd-managed user agents from
# reading files under ~/Desktop, ~/Documents, ~/Downloads, etc. Running the
# daemon directly from this repo (which lives under ~/Desktop on Hank's
# machine) hangs in __open syscall on TCC-protected paths. We copy the *.py
# files to ~/Library/Application Support/ at install time and run from
# there. The repo remains the source of truth; re-run install.sh to update.
#
# Will NOT overwrite credentials.json if it already exists.

set -euo pipefail

DAEMON_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_LABEL="com.eclaw.usage-daemon"
PLIST_DEST="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
PLIST_TEMPLATE="$DAEMON_DIR/${PLIST_LABEL}.plist.template"
LOG_PATH="$HOME/Library/Logs/eclaw-usage-daemon.log"
RUNTIME_DIR="$HOME/Library/Application Support/eclaw-usage-daemon"
CREDS_DIR="$HOME/.eclaw"
CREDS_PATH="$CREDS_DIR/credentials.json"

# Python: prefer python3.13 (battle-tested), else python3.
PYTHON_BIN="$(command -v python3.13 || command -v python3 || true)"
if [[ -z "$PYTHON_BIN" ]]; then
    echo "[install] python3 not found in PATH; install Python 3.10+ first." >&2
    exit 1
fi
echo "[install] python: $PYTHON_BIN"
echo "[install] daemon dir: $DAEMON_DIR"

# 1. Provision credentials if missing.
mkdir -p "$CREDS_DIR"
chmod 700 "$CREDS_DIR"
if [[ ! -f "$CREDS_PATH" ]]; then
    echo "[install] $CREDS_PATH not found." >&2
    echo "[install] Create it with the following structure (chmod 600), then re-run:" >&2
    cat <<'EOF' >&2
  {
    "apiUrl":      "https://eclawbot.com",
    "deviceId":    "<your-device-id>",
    "entityId":    <integer>,           // omit if using deviceSecret
    "botSecret":   "<entity-bot-secret>", // omit if using deviceSecret
    "deviceSecret":"<optional-device-secret>"
  }
EOF
    exit 1
fi
chmod 600 "$CREDS_PATH" || true
echo "[install] credentials present: $CREDS_PATH"

# 2. Sync daemon runtime to TCC-unrestricted location.
mkdir -p "$RUNTIME_DIR"
cp "$DAEMON_DIR"/*.py "$RUNTIME_DIR/"
echo "[install] daemon runtime synced → $RUNTIME_DIR"

# 3. Render the plist from template.
mkdir -p "$(dirname "$PLIST_DEST")"
touch "$LOG_PATH"
PYTHON_BIN_ESCAPED=$(printf '%s' "$PYTHON_BIN" | sed -e 's/[\/&]/\\&/g')
RUNTIME_DIR_ESCAPED=$(printf '%s' "$RUNTIME_DIR" | sed -e 's/[\/&]/\\&/g')
LOG_PATH_ESCAPED=$(printf '%s' "$LOG_PATH"      | sed -e 's/[\/&]/\\&/g')

sed \
    -e "s/__PYTHON_BIN__/$PYTHON_BIN_ESCAPED/g" \
    -e "s|__DAEMON_PATH__|$RUNTIME_DIR|g" \
    -e "s|__LOG_PATH__|$LOG_PATH|g" \
    "$PLIST_TEMPLATE" > "$PLIST_DEST"
echo "[install] plist rendered → $PLIST_DEST"

# 4. Load under launchd.
DOMAIN="gui/$(id -u)"
SERVICE_TARGET="$DOMAIN/$PLIST_LABEL"

# bootout ignores errors when the service isn't already loaded.
launchctl bootout "$SERVICE_TARGET" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST_DEST"
launchctl enable "$SERVICE_TARGET"
launchctl kickstart -k "$SERVICE_TARGET"
echo "[install] launchctl bootstrapped + kickstarted"

# 5. Smoke check.
sleep 2
if launchctl list | grep -F "$PLIST_LABEL" >/dev/null; then
    echo "[install] STATUS:"
    launchctl list | grep -F "$PLIST_LABEL"
else
    echo "[install] WARN: $PLIST_LABEL not visible in launchctl list (yet)." >&2
fi

echo "[install] log: tail -F $LOG_PATH"
