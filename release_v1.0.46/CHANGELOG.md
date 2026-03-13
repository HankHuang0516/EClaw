# Release v1.0.46 - 2026-03-12

## What's New / 更新內容

### English
- [Feature] X (Twitter) publisher: new OAuth 1.0a endpoints for posting articles/threads
- [Feature] X publisher: diagnostic error headers for easier debugging
- [Feature] Mission dashboard: auto-save on every edit + split save/notify workflow
- [Fix] Webhook entity push silently skipped in multi-entity broadcast (#181)
- [Fix] publicCode no longer lost during entity reorder

### 繁體中文
- [新功能] X（Twitter）發布功能：支援 OAuth 1.0a，可發布文章/串文
- [新功能] X 發布器：新增診斷錯誤標頭，方便除錯
- [新功能] 任務面板：每次編輯自動儲存，儲存與通知流程分離
- [修復] 修復多實體廣播中 Webhook 實體推送被靜默跳過的問題（#181）
- [修復] 修復實體重新排序後 publicCode 遺失的問題

## Technical Changes
- Backend: `x-publisher.js` — X (Twitter) OAuth 1.0a post/thread endpoints
- Backend: `x-publisher.js` — diagnostic `X-Error-*` headers on failure responses
- Backend: `index.js` — auto-save dashboard on edit; split save vs. notify
- Backend: `index.js` — fix #181 webhook push skipped in multi-entity broadcast
- Backend: `index.js` — fix publicCode preservation across entity reorder
- Tests: regression test lookup/unbind endpoint corrections
