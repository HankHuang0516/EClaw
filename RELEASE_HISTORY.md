# Release History

Track git commits for each release to enable changelog generation via `git diff`.

---

## Latest
v1.0.20 | bca84ac | 2026-02-21

---

## History

| Version | Commit | Date | Notes |
|---------|--------|------|-------|
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
