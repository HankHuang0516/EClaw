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

## v2 hardening (2026-06-15, card_c0e7)

Three known v1 failure modes are now bounded so a single bad Terminal window
can't sink the whole cron run.

### A. Silent close path

v1 called `term-close --id` which wraps `tell app "Terminal" to close (first
window whose id is N)`. When a child process was still attached to that
window, Terminal popped its `Are you sure you want to close this terminal?`
confirmation dialog and `osascript` hung forever, leaving `gcAttempts`
climbing while `gcClosed` stayed at 0.

v2 now:

1. Looks up the window's `tty` via osascript.
2. Runs `ps -t <tty_short> -o pid=,comm=` and `kill -TERM`s any `claude` or
   `node` child PID it finds. This detaches the process so Terminal will
   close silently when asked.
3. Sleeps 2s for graceful exit.
4. Calls `osascript … close …` directly, wrapped in a 5-second timeout. If
   that times out, falls back to `term-close` (also timeout-wrapped). If
   both time out, increments `close_dialogs_hit` and moves on — one stuck
   window no longer blocks the whole run.

There is no public macOS default to disable the "are you sure" dialog
globally — `defaults write com.apple.Terminal …` has no key for it — so
killing the child first is the only reliable workaround.

### B. AE / TCC pre-flight gate

When the commander shell loses AppleEvents access (TCC drift after a Mac
update, fresh tmux context where the GUI is not inherited, system locked
out of Automation), every `osascript` returns `AppleEvent 逾時 (-1712)` or
returns empty. v1 silently logged `windowsScanned:0` and looked like nothing
was wrong.

v2 starts each run with a 3-second-timeout probe:

```applescript
tell application "Terminal" to count windows
```

If the result is empty OR contains `-1712` / `AppleEvent` / `逾時`, the run
sets `ae_blocked:true` in the heartbeat, **skips the whole sweep**, and
fakechats Hank once per hour with:

> ⚠️ bridge-watcher AE blocked — TCC drift. Grant Terminal in System
> Settings → Privacy & Security → Automation, then `launchctl kickstart -k
> gui/$(id -u)/com.eclaw.bridge-watcher`.

The hourly debounce uses `~/.claude/state/ae_last_alert`. Delete that file
to force a fresh alert on the next blocked run.

### C. Per-osascript timeout

All osascript invocations now route through a `run_osascript <secs>` helper
that picks `gtimeout`/`timeout` if available and falls back to `perl -e
'alarm <secs>; exec @ARGV' osascript …`. Every enumeration, contents-read,
and close call gets the same 5-second cap. One hung Terminal window can no
longer keep the cron worker alive past its launchd interval.

### D. Heartbeat schema additions

`/tmp/bridge-watcher-last.json` now includes:

| Field | Meaning |
|-------|---------|
| `ae_blocked` | true if the AE pre-flight tripped and the sweep was skipped |
| `close_dialogs_hit` | windows where both direct-close and fallback timed out (close dialog likely still attached) |
| `pids_killed` | child claude/node PIDs SIGTERM'd this run, summed across all closures |
| `windows_skipped_timeout` | windows where the per-window osascript timed out and we moved on |

Older fields (`windowsScanned`, `elicitationsFound`, `gcClosed`,
`gcAttempts`, `dryRun`, `fakechatEnabled`) keep their v1 semantics.

## Troubleshooting

| Symptom | Check |
|---------|-------|
| Heartbeat file missing | `tail /tmp/bridge-watcher.err.log` — usually a missing dep or PATH issue inside launchd's env |
| Heartbeat shows `windowsScanned:0` but Terminal is open | If `ae_blocked:true` is also set, macOS Automation permission is denied — grant Terminal → System Events automation in System Settings → Privacy & Security → Automation, then `launchctl kickstart -k gui/$(id -u)/com.eclaw.bridge-watcher`. If `ae_blocked:false`, Terminal itself isn't running. |
| `gcAttempts` keeps climbing but `gcClosed` stays 0 | Pre-v2 symptom — Terminal close confirmation dialog was hanging osascript. v2 SIGTERMs the child PID first; if you still see this on v2, run a single foreground sweep (`DRY_RUN=0 bash ~/.claude/bin/bridge-watcher.sh`) and check `~/.claude/logs/bridge-watcher.log` for `gc[pid-kill]` and `gc[fail]` lines. |
| `ae[blocked]` repeating every run | TCC drift after a macOS update or fresh shell context. Grant Automation permission to Terminal, then `rm ~/.claude/state/ae_last_alert` to force a verification fakechat on the next run. |
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
