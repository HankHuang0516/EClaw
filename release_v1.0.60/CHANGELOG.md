# Release v1.0.60 - 2026-03-24

## What's New / 更新內容

### English
- [Feature] Paste image from clipboard in desktop chat (Ctrl+V / Cmd+V)
- [Feature] URL bar with copy button on public note pages
- [Feature] Note Page public/private UX — badge in list + toggle in viewer
- [Feature] Order flow with TapPay integration (B2) in chat
- [Feature] Rich Message Protocol — product cards, carousel, action buttons in chat
- [Feature] Markdown rendering for bot messages via marked.js
- [Feature] Interactive forms for Note Pages (P6)
- [Feature] Visitor analytics + custom domain APIs for Note Pages
- [Feature] Markdown rendering support for Note Pages
- [Feature] Drawing scroll sync + bot-readable PNG snapshot
- [Feature] Page navigation bar for public note pages
- [Feature] Entity public home page (GET /p/:publicCode)
- [Feature] Auto-detect eclaw://note/ and /p/ links → iframe preview in messages
- [Feature] E-commerce demo GIF on enterprise page and GitHub README
- [Feature] Live e-commerce AI customer service demo section on enterprise page
- [Feature] Public note pages route (GET /p/:code/:noteId)
- [Fix] Avatar HTML appearing as raw text in schedule display
- [Fix] Security hardening — DNS rebinding protection, timing-safe comparisons, landing.html i18n
- [Fix] Security audit P0/P1 fixes, Discord integration, Android UX improvements
- [Fix] AI widget coverage, draft auto-save, long-press copy
- [Fix] Android Card Holder manual refresh button
- [Fix] Chat page auto-refresh on Android WebView foreground
- [Fix] i18n missing keys, mission scroll, scheduler 502 retry
- [Fix] Allow same-origin iframe embedding for /c/ and /p/ routes
- [Fix] Filter chip toggle button positioning fix
- [Improve] Scheduled audit — security fixes, i18n, SEO, mission skill/rule dedup, Discord integration

### 繁體中文
- [新功能] 桌面版聊天支援從剪貼簿貼上圖片（Ctrl+V / Cmd+V）
- [新功能] 公開筆記頁面新增網址列與複製按鈕
- [新功能] 筆記頁面公開/私有 UX — 列表顯示徽章 + 檢視器中可切換
- [新功能] 聊天中整合 TapPay 訂單流程（B2）
- [新功能] 豐富訊息協議 — 產品卡片、輪播、動作按鈕
- [新功能] Bot 訊息支援 Markdown 渲染（marked.js）
- [新功能] 筆記頁面支援互動表單（P6）
- [新功能] 筆記頁面新增訪客分析 + 自訂網域 API
- [新功能] 筆記頁面支援 Markdown 渲染
- [新功能] 畫布繪圖同步捲動 + Bot 可讀 PNG 快照
- [新功能] 公開筆記頁面新增導航列
- [新功能] 實體公開主頁（GET /p/:publicCode）
- [新功能] 自動偵測 eclaw://note/ 和 /p/ 連結，訊息中嵌入 iframe 預覽
- [新功能] 企業頁面新增電商展示 GIF
- [新功能] 企業頁面新增即時電商 AI 客服展示區
- [新功能] 公開筆記頁面路由（GET /p/:code/:noteId）
- [修復] 排程顯示中 Avatar HTML 顯示為原始文字
- [修復] 安全強化 — DNS 重綁定防護、時序安全比對、landing.html 國際化
- [修復] 安全稽核 P0/P1 修復、Discord 整合、Android UX 改進
- [修復] AI 小工具覆蓋率、草稿自動儲存、長按複製
- [修復] Android 名片夾手動重新整理按鈕
- [修復] Android WebView 前景自動重新整理聊天頁面
- [修復] i18n 缺失翻譯鍵、任務捲動、排程器 502 重試
- [修復] 允許同源 iframe 嵌入 /c/ 和 /p/ 路由
- [修復] 篩選晶片切換按鈕位置修復
- [改進] 定期稽核 — 安全修復、i18n、SEO、任務技能/規則去重、Discord 整合

## Technical Changes
- Backend: semantic-release v1.145.4 → v1.161.1 (16 releases)
- Backend: Security hardening (DNS rebinding, timing-safe), Rich Message Protocol, TapPay order flow
- Android: versionCode 65 → 66, versionName 1.0.59 → 1.0.60
- Android: Card Holder refresh, WebView auto-refresh, AI draft persistence
- Tests: Jest 53 suites / 885 tests passed
