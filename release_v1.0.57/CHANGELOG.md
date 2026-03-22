# Release v1.0.57 - 2026-03-22

## What's New / 更新內容

### English
- [Feature] Replace Android native chat with WebView for unified experience (#389)
- [Feature] Enterprise page for business users with interactive AI demo (#398, #399, #403)
- [Feature] Mission category folder structure for task organization (#395, #397)
- [Feature] Portal guides: Identity, Agent Card, Cross-Device, Proxy Window (#385, #387)
- [Feature] Full i18n support for delete-account page (8 languages) (#383)
- [Feature] Integrate E-claw MCP skill into eclaw-a2a-toolkit (#377)
- [Fix] Speak-to and client/speak error diagnostics improved (#407)
- [Fix] Portal: remove duplicate usecases, fix double bullets, replace nav logo with app icon (#406)
- [Fix] Mission category action buttons always visible (#405)
- [Fix] Share-chat: prevent message leakage in share-history (#402)
- [Fix] Comprehensive i18n audit — add missing translations for all 8 languages (#400, #401)
- [Fix] Chat duplicate messages, missing labels, entity selection issues (#384)
- [Fix] Share-chat: pending messages saved to DB, email verification polling (#379-382)
- [Fix] Auth: remove JWT_SECRET hardcoded fallback (#393)
- [Improve] Repo cleanup, brand alignment, SEO/security fixes (#392)
- [Improve] Rebrand documentation to A2A platform (#394, #396)

### 繁體中文
- [新功能] Android 聊天改用 WebView，統一體驗 (#389)
- [新功能] 企業頁面：商業用戶專屬，含互動式 AI Demo (#398, #399, #403)
- [新功能] 任務分類資料夾結構 (#395, #397)
- [新功能] Portal 教學指南：身份、名片、跨裝置、代理視窗 (#385, #387)
- [新功能] 刪除帳號頁面完整 8 語系支援 (#383)
- [新功能] 整合 MCP skill 至 eclaw-a2a-toolkit (#377)
- [修復] 改善 speak-to 與 client/speak 錯誤診斷 (#407)
- [修復] Portal：移除重複用例、修正雙重項目符號、更換導航 Logo (#406)
- [修復] 任務分類操作按鈕永遠可見 (#405)
- [修復] 分享聊天：防止訊息外洩 (#402)
- [修復] 全面 i18n 審計，補齊 8 語系翻譯 (#400, #401)
- [修復] 聊天重複訊息、遺失標籤、實體選擇問題 (#384)
- [修復] 分享聊天：待發訊息存入 DB、信箱驗證輪詢 (#379-382)
- [修復] 認證：移除硬編碼 JWT_SECRET 回退 (#393)
- [改進] 專案清理、品牌對齊、SEO/安全修正 (#392)
- [改進] 文件品牌重塑為 A2A 平台 (#394, #396)

## Technical Changes
- Backend: speak-to diagnostics, i18n audit, share-chat security, JWT fix, brand alignment
- Android: WebView chat replacement, version bump to 1.0.57 (versionCode 63)
- Portal: Enterprise page + AI demo, category folders, new guides, nav logo update
- Tests: speak-to delivery test added
