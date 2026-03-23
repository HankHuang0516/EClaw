# Release v1.0.58 - 2026-03-23

## What's New / 更新內容

### English
- [Feature] Cross-device message labels with 🔗 icon in chat (#408)
- [Feature] Android Mission Control: category folder structure (#412)
- [Feature] Android File Manager: folder structure support (#417)
- [Feature] Web Portal File Manager: folder structure (#424)
- [Feature] Web Portal Chat: collapsible filter chip group (#427)
- [Feature] Mission notes webview static pages + Android alignment (#414)
- [Feature] Unified circular ic_launcher_round icons across all pages (#413)
- [Fix] AI chat widget duplicate prevention in Android WebView (#410, #411, #419-#423)
- [Fix] Canvas drawing stroke size issue — added pointer capture (#430)
- [Fix] Comprehensive audit: security, i18n, SEO, chat integrity (#430)
- [Fix] Missing files_btn_delete i18n key for all 8 languages (#425)
- [Fix] Android compilation errors in note page viewer (#416)
- [Fix] HTML caching fix for WebView, debug banner removal (#421)
- [Fix] targetDeviceId added to curl templates for cross-device routing (#426)
- [Test] AI chat WebView guard regression test (#423)

### 繁體中文
- [新功能] 聊天中跨裝置訊息顯示 🔗 圖示 (#408)
- [新功能] Android 任務控制：分類資料夾結構 (#412)
- [新功能] Android 檔案管理器：資料夾結構 (#417)
- [新功能] Web Portal 檔案管理器：資料夾結構 (#424)
- [新功能] Web Portal 聊天：可收合篩選標籤群組 (#427)
- [新功能] 任務筆記 WebView 靜態頁面 + Android 對齊 (#414)
- [新功能] 統一所有頁面使用圓形 App 圖示 (#413)
- [修復] Android WebView 中 AI 聊天重複問題 (#410-#423)
- [修復] 畫布繪圖筆劃過小 — 加入指標捕獲 (#430)
- [修復] 全面審計：安全、i18n、SEO、聊天完整性 (#430)
- [修復] 補齊 files_btn_delete 8 語系翻譯 (#425)
- [修復] 筆記頁面 Android 編譯錯誤 (#416)
- [修復] WebView HTML 快取修正、除錯橫幅移除 (#421)
- [修復] curl 模板加入 targetDeviceId 跨裝置路由 (#426)
- [測試] AI 聊天 WebView 防護回歸測試 (#423)

## Technical Changes
- Android: Mission Control categories, File Manager folders, Note page viewer, WebView AI widget guard
- Backend: Note pages API, filter chips, security/i18n/SEO audit, cross-device routing
- Portal: File manager folders, chat filters, unified icons, drawing canvas fix
- Tests: AI chat WebView guard, note pages, cross-speak chat rendering
