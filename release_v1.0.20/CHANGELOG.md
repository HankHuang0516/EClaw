# Release v1.0.20 - 2026-02-21

## What's New / 更新內容

### English
- [Feature] Upgraded Android feedback UI to match web portal — category picker + "mark bug moment" button
- [Fix] Replace system edit icon with custom Material icon for visual consistency
- [Fix] Fix TelemetryHelper call signatures in SettingsActivity (trackError/trackAction)

### 繁體中文
- [新功能] Android 回饋 UI 升級與 Web 入口一致 — 類別選擇器 + 「標記Bug時刻」按鈕
- [修復] 以自訂 Material 圖示取代系統編輯圖示，視覺一致性
- [修復] 修正 SettingsActivity 中 TelemetryHelper 呼叫簽名（trackError/trackAction）

## Commits (since v1.0.19)
- 0385acd Merge pull request #15
- f908b04 fix: replace system edit icon with custom Material icon for visual consistency
- a674d01 feat: upgrade Android feedback UI to match web portal (category + mark bug moment)

## Technical Changes
- Android: `SettingsActivity.kt` - Feedback UI with category picker, mark bug moment, fixed telemetry calls
- Android: `ClawApiService.kt` - Feedback API endpoints (sendFeedback, markFeedback)
- Android: `activity_settings.xml` - Feedback section UI layout
- Android: `ic_edit.xml` - New custom Material edit icon drawable
- Android: `MainActivity.kt` - Minor layout reference fix
- Android: `strings.xml` / `strings.xml (zh-rTW)` - Feedback UI strings
- Android: version bump 1.0.19 → 1.0.20 (versionCode 21 → 22)
