# Release v1.0.18 - 2026-02-20

## What's New / 更新內容

### English
- [Fix] Strengthen gatekeeper both locks to catch real-world attacks — Chinese regex patterns now use flexible matching, token detection adds entropy check for mixed alphanumeric tokens
- [Test] Add gatekeeper regression test suite (196 lines)

### 繁體中文
- [修復] 強化 Gatekeeper 雙鎖防護以攔截真實攻擊 — 中文正則表達式改用彈性匹配，Token 偵測新增混合英數字元的熵值檢查
- [測試] 新增 Gatekeeper 回歸測試套件（196 行）

## Commits (since v1.0.17)
- 6e3c808 Merge pull request #9
- 64a88aa fix: strengthen gatekeeper both locks to catch real-world attacks

## Technical Changes
- Backend: `gatekeeper.js` - Chinese regex patterns changed from `\s*` to `.{0,30}` flexible matching; added gateway-specific pattern; token detection adds `looksLikeToken()` entropy check + broad `[A-Za-z0-9]{20,48}` pattern requiring upper+lower+digit mix
- Backend: `tests/test_gatekeeper.js` - New 196-line test suite for gatekeeper module
- Android: version bump 1.0.17 → 1.0.18 (versionCode 19 → 20)
