# Release v1.0.19 - 2026-02-20

## What's New / 更新內容

### English
- [Feature] Device telemetry debug buffer (~1MB/device) with auto-capture middleware for API calls
- [Feature] Telemetry SDK for Web portal + Android app with auto-capture
- [Feature] In-place entity refresh (rebind without unbinding)
- [Feature] Edit mode with drag-to-reorder entity cards
- [Feature] Slash command autocomplete in Chat input
- [Feature] Device feedback with log snapshot capture + AI diagnostic prompt
- [Improve] Bot API test reduced from 20 to 10 cases to fit 300s runner timeout
- [Test] Entity management tests for refresh, reorder, and log verification
- [Test] Log/telemetry API verification added to all 14 integration tests
- [Test] Device telemetry test suite + feedback test suite

### 繁體中文
- [新功能] 設備遙測除錯緩衝區（~1MB/裝置），自動擷取 API 呼叫的中介層
- [新功能] Web 入口 + Android App 的遙測 SDK，自動擷取功能
- [新功能] 就地重新整理實體（重新綁定無需解綁）
- [新功能] 編輯模式支援拖曳排序實體卡片
- [新功能] 聊天輸入支援斜線命令自動完成
- [新功能] 設備回饋功能，含日誌快照擷取 + AI 診斷提示
- [改進] Bot API 測試從 20 縮減至 10 個案例以適應 300 秒執行限制
- [測試] 實體管理測試（刷新、排序、日誌驗證）
- [測試] 所有 14 個整合測試新增日誌/遙測 API 驗證
- [測試] 設備遙測測試套件 + 回饋測試套件

## Commits (since v1.0.18)
- 0fc22df Merge pull request #12
- 5f2b3e3 feat: enhance feedback with log snapshot capture + AI diagnostic prompt
- 6caf5c6 feat: add slash command autocomplete in Chat input
- eab7e94 Merge pull request #11
- c09db3b test: add log/telemetry API verification to all 14 integration tests
- 3ad93ee Merge pull request #10
- 42163b5 test: add entity management tests for refresh, reorder, and log verification
- fdda0de feat: add edit mode with drag-to-reorder entity cards
- 098a755 feat: add in-place entity refresh (rebind without unbinding)
- 30406fd feat: add telemetry SDK for Web + Android with auto-capture
- 15d9a3a feat: add device telemetry debug buffer (~1MB/device) with auto-capture
- 4049f0c fix: reduce bot API test from 20 to 10 cases to fit 300s runner timeout

## Technical Changes
- Backend: `device-telemetry.js` - New 428-line module for device telemetry with auto-capture middleware
- Backend: `device-feedback.js` - New 561-line module for device feedback with log snapshot + AI prompt
- Backend: `index.js` - Telemetry middleware, entity refresh/reorder endpoints, feedback endpoints (+584 lines)
- Backend: `public/shared/telemetry.js` - Web telemetry SDK (200 lines)
- Backend: `public/portal/settings.html` - Feedback UI with log snapshot
- Android: `TelemetryHelper.kt` + `TelemetryInterceptor.kt` - Android telemetry SDK
- Android: `EntityCardAdapter.kt` - Edit mode with drag-to-reorder
- Android: `SlashCommand.kt` + `SlashCommandAdapter.kt` - Slash command autocomplete
- Android: `MainActivity.kt` - Entity refresh, reorder, telemetry integration
- Android: `ChatActivity.kt` - Slash command autocomplete UI
- Android: version bump 1.0.18 → 1.0.19 (versionCode 20 → 21)
- Tests: 4 new test files, telemetry verification added to all 14 existing tests
