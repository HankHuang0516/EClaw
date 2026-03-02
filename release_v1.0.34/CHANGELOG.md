# Release v1.0.34 - 2026-03-02

## What's New / 更新內容

### English
- [Feature] In-app update dialog — check for updates on launch with optional/force update support
- [Feature] FCM push notification for app updates — admin can push update alerts to all devices
- [Feature] Admin app update panel — push update notifications from admin dashboard (all 8 languages)
- [Feature] AI can close GitHub issues via action system
- [Feature] Claude CLI proxy connects to Postgres for direct DB queries
- [Feature] AI support session monitoring via proxy-sessions endpoint
- [Improve] Entity selection UX unified — bot rental reuses Add Entity slot selector
- [Improve] AI chat max-turns increased to 15 with intermediate feedback
- [Fix] Resolve 7 GitHub issues in parallel agent batch fix
- [Fix] Persist DATABASE_URL to file for Claude CLI child processes
- [Fix] Cache-Control no-cache for i18n.js to prevent stale translations
- [Fix] Stream-json output format requires --verbose flag
- [Fix] Sanitize raw CLI JSON in async path for AI support proxy
- [Fix] Remove AD_ID permission from Android app
- [Fix] Skip 401 redirect on public info.html page

### 繁體中文
- [新功能] 應用內更新對話框 — 啟動時檢查更新，支援選擇性/強制更新
- [新功能] FCM 推播通知更新 — 管理員可向所有裝置推送更新提醒
- [新功能] 管理員更新推播面板 — 從管理後台推送更新通知（支援 8 種語言）
- [新功能] AI 可透過動作系統關閉 GitHub Issues
- [新功能] Claude CLI 代理連接 PostgreSQL 直接查詢資料庫
- [新功能] AI 支援系統新增 session 監控端點
- [改進] 統一實體選擇 UX — 機器人租用復用新增實體的插槽選擇器
- [改進] AI 聊天最大回合數提升至 15，增加中間回饋
- [修復] 平行 Agent 批次修復 7 個 GitHub Issues
- [修復] 持久化 DATABASE_URL 供 Claude CLI 子程序使用
- [修復] i18n.js 加入 Cache-Control no-cache 防止翻譯過期
- [修復] stream-json 輸出格式需搭配 --verbose 旗標
- [修復] AI 支援代理非同步路徑清理原始 CLI JSON
- [修復] 移除 Android 應用的 AD_ID 權限
- [修復] 公開頁面 info.html 跳過 401 重導向

## Technical Changes
- Backend: AI support proxy improvements (session monitoring, DB queries, max-turns 15)
- Backend: Admin app update push notification endpoint
- Android: In-app update check dialog + FCM app_update category handling
- Web Portal: Admin update notification UI (8 languages), info.html 401 fix
