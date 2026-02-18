# Release History

Track git commits for each release to enable changelog generation via `git diff`.

---

## Latest
v1.0.12 | c1252b1 | 2026-02-18

---

## History

| Version | Commit | Date | Notes |
|---------|--------|------|-------|
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
