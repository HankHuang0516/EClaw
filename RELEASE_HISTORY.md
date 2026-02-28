# Release History

Track git commits for each release to enable changelog generation via `git diff`.

---

## Latest
v1.0.32 | 8fcdacb | 2026-02-28

---

## History

| Version | Commit | Date | Notes |
|---------|--------|------|-------|
| v1.0.31 | d6bd1d3 | 2026-02-27 | Bot gateway disconnection detection, handshake failure recording, push health tracking, skill doc optimization |
| v1.0.30 | b6bfa93 | 2026-02-26 | Avatar sync, premium entity slots, schedule editing, bot push hints, feedback redesign |
| v1.0.29 | f10bddf | 2026-02-25 | Cross-device bot-to-bot, 8 entity slots, video chat, admin, security |
| v1.0.28 | a334636 | 2026-02-24 | XP/Level system, Info Hub, E-Claw vs Telegram, domain migration, CI fixes |
| v1.0.27 | 7deb7d6 | 2026-02-22 | Notification system, FCM, Socket.IO, Web Push, multi-language, file upload |
| v1.0.26 | 73bb00f | 2026-02-22 | Per-device entity limit, schedule history, Mission Control UI |
| v1.0.25 | d550fc2 | 2026-02-22 | Schedule UI chips/cron, timezone fix, entity chip improvements |
| v1.0.24 | 06016c1 | 2026-02-22 | Schedule sub-tab, Chinese translations, CI/CD improvements |
| v1.0.23 | b3e7802 | 2026-02-22 | Entity cards fix, feedback photo upload, file manager UX |
| v1.0.22 | 5a90ca3 | 2026-02-21 | File management, feedback photo upload, free bot stats |
| v1.0.21 | 60b9235 | 2026-02-21 | Feedback redesign, gatekeeper fix, entity card fix |
| v1.0.20 | bca84ac | 2026-02-21 | Feedback UI upgrade, telemetry call fixes |
| v1.0.19 | 19d4f57 | 2026-02-20 | Telemetry SDK, entity refresh/reorder, slash commands, feedback |
| v1.0.18 | 82803b3 | 2026-02-20 | Gatekeeper lock strengthening, gatekeeper tests |
| v1.0.17 | 10947c4 | 2026-02-20 | Free bot TOS agreement flow, gatekeeper module |
| v1.0.16 | 9241d5a | 2026-02-20 | Echo suppression tests, delivery receipts, Kotlin unit tests |
| v1.0.15 | 0aaad4d | 2026-02-19 | Chat echo dedup, LATEST_APP_VERSION sync, test fixes |
| v1.0.14 | b31edb3 | 2026-02-19 | Server logs, broadcast fix, entity echo dedup |
| v1.0.13 | 7048a5d | 2026-02-19 | Server logs, broadcast fix, entity echo dedup |
| v1.0.12 | c1252b1 | 2026-02-18 | Subscription sync, usage limit fix |
| v1.0.11 | 47e481f | 2026-02-18 | 3 new regression tests, isTestDevice flag |
| v1.0.10 | b490271 | 2026-02-17 | Fix chat duplication, promote mode |
| v1.0.9 | 07764ea | 2026-02-17 | Chat media, usage limit, Google Play auto-upload |
| v1.0.8 | 55a17a5 | 2026-02-17 | Push error UX, webhook test, skill doc |
| v1.0.7 | b78ee97 | 2026-02-17 | Fix duplicate chat, update Flickr SDK |
| v1.0.6 | 18f9131 | 2026-02-14 | App name fix (E-Claw) |
| v1.0.5 | ebf662c | 2026-02-13 | Privacy Policy, Crash fixes, UI improvements |
| v1.0.4 | b0d267b | 2026-02-08 | Battery level reporting, entity broadcast |
| v1.0.3 | 515327f | 2026-02-07 | Multi-entity architecture, regression tests |
| v1.0.2 | (unknown) | - | Previous release |

---

## How to Use

### Generate Changelog for New Release
```bash
# 1. Get previous release commit
PREV=$(grep -A1 "## Latest" RELEASE_HISTORY.md | tail -1 | cut -d'|' -f2 | tr -d ' ')

# 2. View changes since last release
git log --oneline $PREV..HEAD
git diff --stat $PREV..HEAD

# 3. After release, update this file with new commit hash
```

### After Release Checklist
1. Update "Latest" section with new version, commit, date
2. Move previous "Latest" to "History" table
3. Commit this file with the release
