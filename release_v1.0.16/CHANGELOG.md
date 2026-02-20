# Release v1.0.16 - 2026-02-20

## What's New / 更新內容

### English
- [Fix] Suppress broadcast echo in Chat — prevent duplicate messages when syncing from backend
- [Fix] Suppress speak-to echo in processEntityMessage() — same dedup logic for entity-to-entity messages
- [Fix] Update delivery receipts on re-sync to reflect actual delivery status
- [Feature] Add UnitTestSuite to run all pure-Kotlin unit tests
- [Test] New regression test: entity echo suppression and delivery receipts (backend)
- [Test] New regression test: echo regex validation (backend)
- [Test] New Android unit test: ChatEchoSuppressionTest (Kotlin)
- [Improve] Track release workflow (.agent/workflows/release.md) in git

### 繁體中文
- [修復] 抑制聊天中的廣播回音 — 從後端同步時防止訊息重複
- [修復] 在 processEntityMessage() 中抑制 speak-to 回音 — 實體對實體訊息使用相同去重複邏輯
- [修復] 重新同步時更新送達回條以反映實際送達狀態
- [新功能] 新增 UnitTestSuite 以執行所有純 Kotlin 單元測試
- [測試] 新增回歸測試：實體回音抑制與送達回條（後端）
- [測試] 新增回歸測試：回音正則驗證（後端）
- [測試] 新增 Android 單元測試：ChatEchoSuppressionTest（Kotlin）
- [改進] 將發布工作流程 (.agent/workflows/release.md) 納入版控

## Commits (since v1.0.15)
- a21be20 Merge pull request #7
- 854f595 test: add UnitTestSuite to run all pure-Kotlin unit tests
- a50b494 Merge remote-tracking branch 'origin/main' into claude/fix-subscription-usage-limit-ZOAU7
- 1f3b616 chore: track .agent/workflows/release.md in git
- 710fd99 test: add regression tests for entity echo suppression and delivery receipts
- 4409e60 fix: also suppress speak-to echo in processEntityMessage()
- bdb57d1 fix: suppress broadcast echo in Chat and update delivery receipts on re-sync
- f9b6202 Release v1.0.15

## Technical Changes
- Android: `ChatRepository.kt` - suppress broadcast/speak-to echo in syncFromBackend(), update delivery receipts
- Android: `ChatMessageDao.kt` - new queries for echo dedup and delivery status update
- Android: `ChatEchoSuppressionTest.kt` - pure-Kotlin unit test for echo suppression regex patterns
- Android: `UnitTestSuite.kt` - test suite runner for all Kotlin unit tests
- Backend: `tests/test_chat_echo_and_delivery.js` - new regression test (echo suppression + delivery receipts)
- Backend: `tests/test_echo_regex_validation.js` - new regex validation test
- Android: version bump 1.0.15 → 1.0.16 (versionCode 17 → 18)
