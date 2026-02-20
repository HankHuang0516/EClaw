# Release v1.0.17 - 2026-02-20

## What's New / 更新內容

### English
- [Feature] Free bot TOS agreement flow: users must accept Terms of Service before using free official bots (Web portal + Android app sync)
- [Feature] Gatekeeper module for free bot abuse prevention — rate limiting, usage tracking, and automated enforcement
- [Improve] Dashboard UI updated with TOS agreement status display

### 繁體中文
- [新功能] 免費 Bot 服務條款同意流程：使用者必須先同意服務條款才能使用免費官方 Bot（Web 入口 + Android App 同步）
- [新功能] Gatekeeper 模組防止免費 Bot 濫用 — 速率限制、使用量追蹤、自動化執行
- [改進] Dashboard UI 新增 TOS 同意狀態顯示

## Commits (since v1.0.16)
- 8aac3a0 Merge pull request #8
- 8fcb354 feat: add free bot TOS agreement flow (Web + App sync)
- 60681e5 feat: add gatekeeper module for free bot abuse prevention
- 182b365 chore: bump backend version comment to trigger Railway redeploy
- c43168d Release v1.0.16

## Technical Changes
- Backend: `gatekeeper.js` - new module (550 lines) for free bot abuse prevention
- Backend: `index.js` - TOS agreement endpoints, bind-free flow requires TOS, gatekeeper integration
- Backend: `public/portal/dashboard.html` - TOS agreement status UI
- Backend: `public/shared/i18n.js` - TOS-related i18n strings
- Android: `OfficialBorrowActivity.kt` - TOS agreement flow before free bot binding
- Android: `OfficialBorrowModels.kt` - TOS data models
- Android: `ClawApiService.kt` - TOS API endpoints
- Android: `strings.xml` / `strings.xml (zh-rTW)` - TOS UI strings
- Android: version bump 1.0.16 → 1.0.17 (versionCode 18 → 19)
