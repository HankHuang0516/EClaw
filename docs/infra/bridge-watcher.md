# bridge-watcher

5-minute launchd cron that sweeps Terminal windows hosting `claude` bridge
sessions and (a) pings Hank when a bridge is stuck on an elicitation prompt,
(b) closes windows whose backing kanban card has reached `status=done`.

The watcher is intentionally Mac-specific (Terminal.app + osascript + launchd).
Other deployments would need to port the window-enumeration layer; the kanban
API calls are portable as-is.

## Files

| Role | Path |
|------|------|
| Script | `~/.claude/bin/bridge-watcher.sh` |
| LaunchAgent plist | `~/Library/LaunchAgents/com.eclaw.bridge-watcher.plist` |
| Heartbeat (overwritten each run) | `/tmp/bridge-watcher-last.json` |
| Run log (appends) | `~/.claude/logs/bridge-watcher.log` |
| Debounce table | `~/.claude/state/bridge-watcher-seen.json` |
| launchd stdout | `/tmp/bridge-watcher.out.log` |
| launchd stderr | `/tmp/bridge-watcher.err.log` |

## Enable / disable / pause

```bash
# Enable (run-at-load fires immediately, then every 300s):
launchctl load ~/Library/LaunchAgents/com.eclaw.bridge-watcher.plist

# Pause (preserves plist on disk):
launchctl unload ~/Library/LaunchAgents/com.eclaw.bridge-watcher.plist

# Disable for good — unload then delete:
launchctl unload ~/Library/LaunchAgents/com.eclaw.bridge-watcher.plist
rm ~/Library/LaunchAgents/com.eclaw.bridge-watcher.plist

# Manual one-shot run (no launchd):
bash ~/.claude/bin/bridge-watcher.sh

# Manual dry-run — logs intended closures + fakechats without sending:
DRY_RUN=1 bash ~/.claude/bin/bridge-watcher.sh

# Disable the outbound fakechat ping while keeping detection active:
FAKECHAT=0 bash ~/.claude/bin/bridge-watcher.sh
```

## What it does each run

1. Enumerates Terminal windows via `osascript`. Empty if Terminal isn't running.
2. For each window:
   - Extracts `card_<hex>` from the window name (if present).
   - Reads the last 30 lines of the tab via `contents of first tab of …`.
   - **Phase A — elicitation match.** Pattern set (case-insensitive unless noted):
     | Label | Trigger |
     |-------|---------|
     | `permission_dialog` | line containing `Approve` AND line containing `Recommended)` |
     | `trust_prompt` | `Is this a project you trust` |
     | `mcp_request_access` | `Allow all apps` or `Allow this tool` |
     | `numbered_menu` | `❯ 1.` (literal arrow + numbered menu cursor) |
   - On match, computes `sha256` of the last 200 chars and consults the
     debounce table; only fires fakechat if `(winId, hash)` hasn't been seen
     in 24h.
   - **Phase B — auto-GC.** If a `card_<hex>` slug was extracted, queries
     `GET /api/mission/card/<slug>` and closes the window via `term-close`
     when the status is `done`. Capped at `MAX_CLOSURES` (default 5) per run
     so a status sweep can't mass-kill unrelated long-runners.
3. **Phase C — heartbeat.** Writes a JSON object to
   `/tmp/bridge-watcher-last.json` (timestamp, run id, windows scanned,
   elicitations found, gc closed/attempts, dry-run flag).
4. If any windows were closed, a single "🧹 bridge-watcher GC: closed N
   done-card window(s) — slug/wid …" fakechat is sent to entity #2.

## Adding a new elicitation pattern

Two changes:

1. Add a `PATTERN_<NEW>_LABEL` + grep expression to `bridge-watcher.sh` and
   extend the `scan_elicitation()` `if/elif` chain so the new label wins
   when its pattern hits.
2. Add a row to the trigger table above with a one-line description so the
   next maintainer can grep for it.

Quote the literal text you want to catch using `grep -qiE` regex. Avoid
patterns short enough to match normal output — the watcher debounces by
`(winId + hash)`, so a noisy pattern is annoying for one window but quiet
afterwards; an overly broad pattern can still trigger across many windows
on the first run.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Heartbeat file missing | `tail /tmp/bridge-watcher.err.log` — usually a missing dep or PATH issue inside launchd's env |
| Heartbeat shows `windowsScanned:0` but Terminal is open | macOS Automation permission for `osascript` is denied. Grant Terminal → System Events automation in System Settings → Privacy & Security → Automation |
| `fakechat[skip] no channel api key in env` | `ECLAW_API_KEY` not resolvable. Either drop `~/.claude/secrets/eclaw.env` with `CHANNEL_API_KEY=eck_…` or keep `~/Desktop/Project/claude-code-eclaw-channel/.env` populated |
| `fakechat[sent]` log shows `invalid_channel_key` | API key was rotated server-side. Update the channel `.env` (memory: `fakechat_creds.md`) |
| GC ran but nothing closed | Cards may not actually be at `status=done`; check `~/.claude/logs/bridge-watcher.log` for the per-card status echo |
| Windows close that shouldn't | The window name contained a stale `card_<hex>` slug pointing at a card that's already `done`. Rename the window or move the card back out of done |

## State / observability

```bash
# Latest heartbeat (compact JSON):
cat /tmp/bridge-watcher-last.json | jq .

# Tail run log:
tail -50 ~/.claude/logs/bridge-watcher.log

# launchd's view of the job (RunAtLoad means it fires once at load + every 300s):
launchctl list | grep com.eclaw.bridge-watcher

# Inspect debounce table:
jq . ~/.claude/state/bridge-watcher-seen.json

# Clear debounce table (every elicit on next run will re-fakechat):
echo '{}' > ~/.claude/state/bridge-watcher-seen.json
```

## Operational caveats

- **Cap closures at 5 per run.** Deliberate: a mis-cached "all done" sweep
  should never wipe out the work surface in one shot. If you genuinely need
  to close more, run the script repeatedly or use `cleanup-terminals`.
- **`DRY_RUN=1` does not silence fakechat-on-match.** Both `DRY_RUN=1` and
  `FAKECHAT=0` suppress outbound HTTP; the difference is `DRY_RUN=1` also
  skips `term-close`.
- **Debounce is per `(winId, sha256(last-200-chars))`.** A re-rendered TUI
  that changes its trailing whitespace will rehash and re-notify. If a
  prompt is noisy enough to flap, widen the tail window or shrink the
  hashed prefix in `scan_elicitation()`.
- **No orphan-window closure yet.** The current build only auto-GC's
  windows whose name contains a recognisable `card_<hex>` slug at `done`.
  Idle-orphan closure (the "no card, idle > N min" branch in the original
  card spec) is intentionally deferred — the existing
  `~/.claude/bin/cleanup-terminals` script already handles broader idle
  sweeps, and stacking two killers on the same set of windows is how you
  lose work.
