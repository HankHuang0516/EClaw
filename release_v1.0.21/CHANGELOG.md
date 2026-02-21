# Release v1.0.21 - 2026-02-21

## What's New / 更新內容

### English
- [Feature] Redesigned feedback UI with dark theme, color-coded categories, and feedback tracking links (Web + Android)
- [Feature] New dedicated Feedback Activity and Feedback History Activity on Android
- [Fix] Reduce gatekeeper false positives + show blocking reason on both platforms
- [Fix] Prevent entity cards from hiding in edit mode + fix price inconsistency (#16, #17)

### 繁體中文
- [新功能] 重新設計回饋 UI，深色主題、彩色分類標籤、回饋追蹤連結（Web + Android）
- [新功能] Android 新增專屬回饋頁面與回饋歷史頁面
- [修復] 減少 Gatekeeper 誤判 + 在雙平台顯示封鎖原因
- [修復] 防止實體卡片在編輯模式隱藏 + 修正價格不一致問題（#16, #17）

## Commits (since v1.0.20)
- cc0cf11 Merge pull request #22
- 6ef2386 feat: redesign feedback UI with dark theme, color-coded categories, and tracking links
- cd98cdf Merge pull request #21
- 3cf1e3a Merge pull request #20
- 27fb59c feat: redesign feedback UI with dark theme, highlighted categories, and feedback tracking
- 70c317d fix: reduce gatekeeper false positives + show blocking reason on both platforms (#18)
- 39cdad5 Merge pull request #19
- b6dfa4f fix: prevent entity cards from hiding in edit mode + fix price inconsistency (#16, #17)

## Technical Changes
- Android: `FeedbackActivity.kt` - New dedicated feedback page (318 lines)
- Android: `FeedbackHistoryActivity.kt` - New feedback history page (341 lines)
- Android: `FeedbackModels.kt` - Feedback data models
- Android: `SettingsActivity.kt` - Refactored feedback to separate activity
- Android: `MainActivity.kt` - Navigation to feedback
- Android: `ChatActivity.kt` - Feedback entry point
- Android: `activity_feedback.xml` + `activity_feedback_history.xml` - New layouts
- Android: `AndroidManifest.xml` - Register new activities
- Android: `themes.xml` - Dark theme additions
- Backend: `gatekeeper.js` - Reduced false positives
- Backend: `public/portal/feedback.html` - New 832-line feedback portal page
- Backend: `public/portal/settings.html` - Enhanced feedback section
- Backend: `public/portal/dashboard.html` - Minor fix
- Backend: `public/shared/i18n.js` - Feedback i18n strings
- Android: version bump 1.0.20 → 1.0.21 (versionCode 22 → 23)
