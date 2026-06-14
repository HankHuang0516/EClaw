# Hourly Auto-Process Cron + Terminal GC

> **Scope** Single Mac (Hank's workstation). Macros use `osascript` + `launchd`, so this is **not portable** to Linux/Railway. The card-filter API call itself (`GET /api/mission/cards`) is standard EClaw and portable; only the bridge-spawn mechanism is Mac-specific.

## What it does

Every hour at minute 0 the LaunchAgent runs two shell scripts back-to-back:

1. **`backend/scripts/hourly-auto-process-cards.sh`** — fetches `GET /api/mission/cards?status=todo`, filters cards assigned to entity #2 (commander) that have been stuck in `todo` for more than 1 hour, then spawns up to `MAX_CARDS` (default 2) bridge-auth terminals via `~/.claude/bin/unit.py spawn` + `dispatch`. Each spawned terminal claims the card and works it.
2. **`backend/scripts/terminal-gc.sh`** — reads `vm_stat`. If free memory is below `FREE_MB_THRESHOLD` MB (default 200), walks `~/.claude/bin/units.json`, looks up each `auto-<prefix>` unit's card status, and closes terminals whose card is already `done`/`archived` (or whose window is dead).

Both scripts log to `/tmp/`. Both honor `DRY_RUN=1`.

## Files

| Path | Purpose |
|------|---------|
| `backend/scripts/hourly-auto-process-cards.sh` | Card scanner + bridge spawner |
| `backend/scripts/terminal-gc.sh` | Memory janitor for `U##` worker windows |
| `infra/launchd/com.eclaw.hourly-auto-process.plist` | LaunchAgent template |
| `docs/infra/hourly-cron.md` | This guide |

## Enable on a fresh Mac

```bash
# 1. Copy the template
cp infra/launchd/com.eclaw.hourly-auto-process.plist ~/Library/LaunchAgents/

# 2. Edit the four REPLACE_ME values
#    - REPLACE_ME_REPO_PATH    → /Users/<you>/Desktop/Project/EClaw  (no trailing slash)
#    - REPLACE_ME_DEVICE_ID    → your owner deviceId (UUID)
#    - REPLACE_ME_BOT_SECRET   → the matching botSecret for entity #2
#    (ENTITY_ID defaults to 2; change only if your commander is a different slot)
vim ~/Library/LaunchAgents/com.eclaw.hourly-auto-process.plist

# 3. Load it
launchctl load ~/Library/LaunchAgents/com.eclaw.hourly-auto-process.plist

# 4. Verify
launchctl list | grep eclaw
#   →  -    0    com.eclaw.hourly-auto-process
```

The first fire happens at the next top-of-hour. Force a one-shot run with:

```bash
launchctl start com.eclaw.hourly-auto-process
```

## Disable / pause

```bash
# Stop the schedule (keeps the plist)
launchctl unload ~/Library/LaunchAgents/com.eclaw.hourly-auto-process.plist

# Permanently remove
rm ~/Library/LaunchAgents/com.eclaw.hourly-auto-process.plist
```

## Check last-run log

```bash
tail -50 /tmp/hourly-auto-process.log
tail -50 /tmp/terminal-gc.log

# launchd stdout/stderr (rarely needed)
tail -50 /tmp/eclaw-hourly.launchd.out.log
tail -50 /tmp/eclaw-hourly.launchd.err.log
```

A healthy fire ends with `── done. dispatched=<N>` and `── done. scanned=<N> closed=<M> ...`.

## Manual smoke test

```bash
# Dry-run (no terminals spawned, no kills)
DRY_RUN=1 BOT_SECRET=… backend/scripts/hourly-auto-process-cards.sh
DRY_RUN=1 FORCE=1 BOT_SECRET=… backend/scripts/terminal-gc.sh
```

`DRY_RUN=1` prints the plan to `/tmp/hourly-auto-process.log` and `/tmp/terminal-gc.log` without touching Terminal.app. `FORCE=1` on the GC bypasses the free-memory threshold so the scan still runs.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `launchctl list \| grep eclaw` shows nothing | Plist not loaded, or filename mismatch | `launchctl load …` again; check `~/Library/LaunchAgents/com.eclaw.hourly-auto-process.plist` exists |
| Logs say `ERROR: BOT_SECRET unset` | `BOT_SECRET` env var not baked into the plist | Edit the `<key>BOT_SECRET</key>` value in the plist, then `launchctl unload && load` |
| Logs say `ERROR: cards fetch failed` | API endpoint unreachable or wrong `DEVICE_ID` | `curl` the URL by hand; check Railway is up; verify deviceId+botSecret pair via `/api/auth/me` |
| Logs say `ERROR: unit.py not executable` | `~/.claude/bin/unit.py` missing | Re-clone the Claude harness, or `chmod +x ~/.claude/bin/unit.py` |
| `dispatched=0` every hour, but cards are stuck | Cards younger than `MIN_AGE_SECONDS` (default 3600), or not assigned to entity #2 | Lower `MIN_AGE_SECONDS` in the plist; double-check the assigned entity on the card |
| GC closes nothing even with low memory | Cards still `todo`/`in_progress`, or role name isn't `auto-<hex>` | Only `auto-`-spawned units are managed. Manual `unit.py spawn` terminals are left alone by design |
| Plist runs but no terminals appear | `osascript` lacks Automation permission for the launchd process | macOS → System Settings → Privacy & Security → Automation → allow the shell helper to control Terminal |
| Terminals stack up overnight | `MAX_CARDS` too high, or GC `FREE_MB_THRESHOLD` too low | Tune the two env vars in the plist and `launchctl unload && load` |

## Globe-user generalization

The `GET /api/mission/cards` filter is portable EClaw API — any client (Linux cron + Python, Windows Task Scheduler + PowerShell, Railway worker) can fetch the same eligible-card list. What is **not** portable:

- `osascript` Terminal.app driver → would need a tmux/screen replacement (`tmux new-window`, `tmux send-keys`)
- `~/.claude/bin/unit.py` registry → would need a session-id store for the chosen multiplexer
- `launchd` schedule → swap for `cron`, `systemd-timer`, or a managed scheduler

The two shell scripts in `backend/scripts/` are written so the API-call path is independent of the spawn path; a port can replace the spawn block (`"$UNIT_PY" spawn` / `dispatch`) without rewriting the filter loop.
