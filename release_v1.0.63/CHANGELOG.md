# Release v1.0.63 - 2026-04-03

## What's New / 更新內容

### English
- [Feature] **Kanban Board Enhancements** — Timeline projected executions with 24h forecast, entity workload indicators (density, token cost, share %), reviewer assignment with auto-notify on transform, inline automation card creation with schedule
- [Feature] **Kanban Card Entity Requirement** — Cards now require at least one assigned entity on create/update/move
- [Feature] **Card Movement Animation** — Slower, more polished FLIP animation (0.7s) with enhanced enter/exit effects
- [Feature] **Channel mediaUrl** — Include mediaUrl in channel push text field for rich media support
- [Feature] **Mission Notes** — DELETE /note/:id endpoint, category clear/delete with undo UX
- [Feature] **Note Page Security** — Consent-gated script execution for public note pages, require script description from bots
- [Feature] **Kanban Board (Mission Center v2)** — FLIP card animation, automation timeline view, sub-tabs on sibling pages
- [Feature] **Community Hub** — Real API integration with comments replacing mock data
- [Feature] **Workspace Mission Panel** — Mission page added to workspace split-view panels
- [Feature] **Privacy Policy** — Full i18n privacy policy page linked from registration
- [Fix] **Chat Grouping** — Strict broadcast grouping by entity_id, prevent speak-to visual grouping with plain replies
- [Fix] **Auto-Review** — Correct auto-review trigger logic (non-BUSY transform, reviewer entity support, marks done correctly)
- [Fix] **Security** — SSRF protection on channel callbacks, broadcast NaN fix, kanban validation hardening
- [Fix] **WebView** — UTF-8-safe base64 decoding, synthetic DOMContentLoaded for blocked scripts, WebView encoding hardening
- [Fix] **Mission Control** — Note auto-save retry on version conflict, sub-tabs overflow fix, WebView heading cleanup
- [Improve] **i18n** — Complete French (fr) and German (de) translations; expanded Arabic (ar), Hindi (hi), Malay (ms) coverage
- [Improve] **Legacy Cleanup** — Removed legacy schedule APIs, todo routes, and related tests; mission.html restored as full page

### 繁體中文
- [新功能] **看板增強** — 時間軸預測執行（24 小時預測）、實體工作量指標（密度、Token 成本、佔比 %）、審查者指派與 transform 時自動通知、內嵌自動化卡片建立含排程
- [新功能] **看板卡片實體必填** — 建立/更新/移動卡片時必須指派至少一個實體
- [新功能] **卡片移動動畫** — 更慢更流暢的 FLIP 動畫（0.7 秒），增強進場/退場效果
- [新功能] **頻道 mediaUrl** — 頻道推送訊息包含 mediaUrl 欄位以支援富媒體
- [新功能] **任務筆記** — DELETE /note/:id 端點、分類清除/刪除含復原 UX
- [新功能] **筆記頁安全** — 公開筆記頁 script 執行需使用者同意、要求 bot 提供 script 說明
- [新功能] **看板（任務中心 v2）** — FLIP 卡片動畫、自動化時間軸視圖、同級頁面子分頁
- [新功能] **社群中心** — 替換 Mock 資料為真實 API 並啟用留言功能
- [新功能] **工作區任務面板** — Mission 頁面加入工作區分割檢視
- [新功能] **隱私政策** — 完整 i18n 隱私政策頁面，從註冊條款連結
- [修復] **聊天分組** — 依 entity_id 嚴格分組廣播，防止 speak-to 訊息與一般回覆混合分組
- [修復] **自動審查** — 修正自動審查觸發邏輯（非 BUSY 狀態 transform、支援審查者實體、正確標記完成）
- [修復] **安全性** — 頻道回呼 SSRF 防護、廣播 NaN 修復、看板驗證強化
- [修復] **WebView** — UTF-8 安全 base64 解碼、blocked scripts 的 DOMContentLoaded 觸發、WebView 編碼強化
- [修復] **任務控制** — 筆記自動儲存版本衝突重試、子分頁溢出修復、WebView 標題清理
- [改進] **i18n** — 完成法語(fr)和德語(de)翻譯；擴展阿拉伯語(ar)、印地語(hi)、馬來語(ms)覆蓋率
- [改進] **舊版清理** — 移除舊版排程 API、待辦路由及相關測試；mission.html 恢復為完整頁面

## Technical Changes
- Backend: Kanban timeline projections API, reviewerEntityId, inline automation, entity requirement validation, SSRF protection
- Android: WebView host for Mission Center (Phase 2+3), native Mission replaced
- Web Portal: FLIP animation (0.7s), workspace Mission panel, mission embed mode, community real API
- i18n: French (fr), German (de) complete; Arabic, Hindi, Malay expanded
- Tests: 6 new kanban-card Jest tests, 875 total tests
