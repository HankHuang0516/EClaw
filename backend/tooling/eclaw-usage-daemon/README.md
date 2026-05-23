# eclaw-usage-daemon (Plan B Phase 2)

Polls local Claude Code (`~/.claude/projects/**/*.jsonl`) and Codex CLI
(`~/.codex/sessions/**/*.jsonl`) usage data once a minute and pushes an
aggregated `UsageSnapshot` to `POST /api/usage/snapshot` on eclawbot.com.

Runs under `launchd` as a user agent (`com.eclaw.usage-daemon`) — starts on
login, auto-restarts on crash, logs to `~/Library/Logs/eclaw-usage-daemon.log`.

## Quickstart

```bash
# 1. Provision credentials (chmod 600, NEVER committed)
mkdir -p ~/.eclaw && chmod 700 ~/.eclaw
cat > ~/.eclaw/credentials.json <<'EOF'
{
  "apiUrl":   "https://eclawbot.com",
  "deviceId": "<your-device-id>",
  "entityId": 2,
  "botSecret": "<entity-bot-secret>"
}
EOF
chmod 600 ~/.eclaw/credentials.json

# 2. Install + start under launchd
cd backend/tooling/eclaw-usage-daemon
bash install.sh

# 3. Watch logs
tail -F ~/Library/Logs/eclaw-usage-daemon.log
```

After ~1 minute you should see lines like:
```
2026-05-23T16:42:55+0800 INFO eclaw-usage-daemon POST 200 received_at=... claude_sessions=14 codex_sessions=7
```

Then verify on the server:
```bash
curl -s "https://eclawbot.com/api/usage/snapshot?deviceId=<id>&entityId=2&botSecret=<bot-secret>" | jq '.latest.claude.sessions | length'
curl -s "https://eclawbot.com/api/usage/timeline?deviceId=<id>&entityId=2&botSecret=<bot-secret>&hours=1"  | jq '.points | length'
```

## Authentication

The daemon authenticates via the Phase 1 endpoint's two-mode auth:

| Mode | Required fields |
|------|----------------|
| device-secret  | `deviceId`, `deviceSecret` |
| bot-secret     | `deviceId`, `entityId`, `botSecret` |

Either one works. The recommended mode is **bot-secret**, since rotating a
bot secret has tighter blast radius than rotating the device secret.

Credentials are read in this order; first complete set wins:

1. **Environment variables** (`ECLAW_DEVICE_ID` + `ECLAW_DEVICE_SECRET`, or
   `ECLAW_DEVICE_ID` + `ECLAW_ENTITY_ID` + `ECLAW_BOT_SECRET`). Set in the
   plist `EnvironmentVariables` block only if you really need it — embedding
   secrets in the plist makes them readable by anyone who can read the file.
2. **`~/.eclaw/credentials.json`** (chmod 600) — recommended.
3. **`backend/.env`** (`DEVICE_ID` + `DEVICE_SECRET`) — kept as a manual
   ops fallback; not the recommended path.

The daemon never logs the secrets themselves — only the field names and the
auth mode (`deviceSecret` or `botSecret+entityId`).

## Files installed

| Path | Purpose |
|------|---------|
| `~/Library/Application Support/eclaw-usage-daemon/*.py` | daemon runtime (copied from repo by `install.sh`) |
| `~/Library/LaunchAgents/com.eclaw.usage-daemon.plist`   | launchd job definition |
| `~/Library/Logs/eclaw-usage-daemon.log`                 | stdout + stderr |
| `~/.cache/eclaw-usage-daemon/pending/*.json`            | offline buffer (≤5 consecutive POST failures lands here) |

`install.sh` does NOT touch `~/.eclaw/credentials.json` if it already exists.

### Why the runtime copy

macOS TCC (Transparency, Consent, Control) blocks launchd-managed user
agents from reading files under `~/Desktop`, `~/Documents`, `~/Downloads`,
iCloud Drive, etc. — without an explicit user grant. Running Python
directly from this repo (which is under `~/Desktop` on Hank's machine)
hangs in `__open` syscall during interpreter startup with no error
message, because the TCC prompt is never surfaced to a background agent.

`install.sh` works around this by copying the runtime `*.py` files to
`~/Library/Application Support/eclaw-usage-daemon/` and pointing the plist
there. The repo remains the source of truth — re-run `install.sh` after
any code change to sync the runtime copy.

## Behaviour

* Tick every `INTERVAL` seconds (default 60). Each tick:
  1. Drain up to 20 pending snapshots from the offline buffer.
  2. Build a fresh snapshot (Claude + Codex sessions, costs from
     `pricing.py` fallback table, Codex rate_limits if present).
  3. POST to `/api/usage/snapshot` with exponential backoff (1, 2, 4, 8, 30s).
* After **5** consecutive POST failures the snapshot is written to
  `~/.cache/eclaw-usage-daemon/pending/<ts>-<pid>.json` and the loop continues.
* SIGTERM / SIGINT cleanly stops the loop within ≤1 second of the next sleep
  slice.

## Troubleshoot

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `401 Invalid credentials` (log) | wrong botSecret/entityId, or stale `ECLAW_BOT_SECRET` env var shadowing the file | Verify `~/.eclaw/credentials.json` posts via `curl` first; unset stale env vars |
| `403` (log)                      | device blocked / not registered | Check device exists on server, contact admin |
| Repeated `network error: URLError` | DNS or Cloudflare 5xx | Daemon retries; pending buffer flushes when network recovers |
| `launchctl list \| grep com.eclaw` returns empty | plist didn't bootstrap (syntax error or path typo) | `plutil ~/Library/LaunchAgents/com.eclaw.usage-daemon.plist`; re-run `install.sh` |
| Log file empty after `kickstart` | bootstrap failed early (python not found) | Inspect `launchctl print gui/$UID/com.eclaw.usage-daemon` |
| Log empty AND `sample <pid>` shows hang in `__open` | TCC blocking access to a path under `~/Desktop`, `~/Documents`, etc. | Re-run `install.sh` — it syncs the runtime to `~/Library/Application Support/eclaw-usage-daemon/`, which is not TCC-restricted |

## Uninstall

```bash
cd backend/tooling/eclaw-usage-daemon
bash uninstall.sh
```

Removes the plist + boots out the service. Leaves `credentials.json` and the
log file alone.

## Tests

```bash
python3 -m venv /tmp/venv && /tmp/venv/bin/pip install pytest
/tmp/venv/bin/python -m pytest backend/tooling/eclaw-usage-daemon/tests
```

16 unit tests cover the two loaders + pricing fallback. Loader tests use
`tmp_path` fixtures so they don't depend on the developer's real
`~/.claude` / `~/.codex` state.

## Phase 3 handoff

Once enough snapshots are in the database, the dashboard widget (separate
card) will read `GET /api/usage/snapshot` and `/api/usage/timeline` to
render the live Claude/Codex usage panel.
