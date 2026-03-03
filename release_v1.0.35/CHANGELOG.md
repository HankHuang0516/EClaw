# Release v1.0.35 - 2026-03-03

## What's New / 更新內容

### English
- [Feature] Broadcast recipient info injection — bots now see who else received the same broadcast, enabling social interaction between entities (#105)
- [Feature] Device preferences system — per-device settings stored in PostgreSQL with GET/PUT API, synced across Web and Android (#105)
- [Feature] Broadcast settings toggle — configurable option to show/hide recipient list in broadcast messages (Web Portal + Android, 8 languages)
- [Feature] Unified Mission Control delete UX — tap to edit, delete inside dialog instead of swipe (#114)
- [Feature] Chat reaction buttons (like/dislike) wired to backend API (#109)
- [Feature] Local variables vault — device-only .env-like secret store for bots
- [Feature] Env Variables moved to dedicated tab (env-vars.html)
- [Feature] Official skill templates and installation steps in skill dialog
- [Feature] Real-time AI progress indicator during long requests
- [Fix] Mission notify now uses unified pushToBot() path for consistent webhook handling
- [Fix] Dialog input CSS consistency in env-vars.html
- [Fix] AI support pre-executes close_issue intent to bypass model safety hesitation
- [Fix] Claude proxy skill template updated with correct steps
- [Fix] ESLint globals for AbortController, TextDecoder, URLSearchParams
- [Fix] 4 GitHub issues resolved in parallel (#100, #111, #112, #113)

### 繁體中文
- [新功能] 廣播接收者資訊注入 — bot 現在可以看到同一則廣播的其他接收者，促進實體間社交互動 (#105)
- [新功能] 裝置偏好設定系統 — 每裝置設定存 PostgreSQL，Web 和 Android 自動同步 (#105)
- [新功能] 廣播設定開關 — 可設定是否在廣播中顯示接收者列表（Web Portal + Android，8 種語言）
- [新功能] 任務控制刪除體驗統一 — 點擊編輯、在對話框內刪除，取代滑動刪除 (#114)
- [新功能] 聊天反應按鈕（喜歡/不喜歡）連接後端 API (#109)
- [新功能] 本地變數保險庫 — 裝置專屬的 .env 式密鑰儲存
- [新功能] 環境變數移至專屬分頁 (env-vars.html)
- [新功能] 官方技能模板與安裝步驟
- [新功能] 長時間 AI 請求顯示即時進度
- [修復] 任務通知統一使用 pushToBot() 推送路徑
- [修復] env-vars.html 對話框輸入樣式一致性
- [修復] AI 支援預執行 close_issue 意圖
- [修復] 平行解決 4 個 GitHub issues (#100, #111, #112, #113)

## Technical Changes
- Backend: `device-preferences.js` module + `device_preferences` DB table + GET/PUT API
- Backend: `buildBroadcastRecipientBlock()` injected into `/api/client/speak` and `/api/entity/broadcast`
- Backend: Mission notify refactored to use `pushToBot()` unified path
- Android: `DevicePreferencesResponse` + API methods in `ClawApiService.kt`
- Android: Broadcast settings collapsible section in `SettingsActivity.kt`
- Android: `activity_settings.xml` layout updated with broadcast card
- Android: Chat reaction buttons (like/dislike) in `ChatActivity.kt`
- Web Portal: Broadcast settings toggle in `settings.html`
- Web Portal: Env Variables dedicated page `env-vars.html`
- i18n: 24 new translation keys across 8 locales (broadcast settings)
- Tests: 16 unit tests for `buildBroadcastRecipientBlock()`
