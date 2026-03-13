# Release v1.0.45 - 2026-03-12

## What's New / 更新內容

### English
- [Feature] Skill template gallery: search bar with live filtering by name/author
- [Feature] Browse button and gallery title now display template count (e.g. "142")
- [Fix] Skill template gallery no longer shows empty when opened before API loads (retry-on-empty logic)
- [Fix] Installation steps now correctly populated when selecting a template
- [Feature] Web portal: "瀏覽官方模板" button shows template count, matching Android
- [Feature] 5 enterprise security features: IP allowlist, geo-blocking, rate limiting, audit logging, RBAC
- [Fix] Cron schedule update no longer violates NOT NULL constraint on scheduled_at
- [Fix] HTTPS redirect skipped for /api/health path (health check stability)

### 繁體中文
- [新功能] 技能模板選擇器：新增即時搜尋列（可按名稱/作者過濾）
- [新功能] 「瀏覽官方模板」按鈕與彈窗標題現在顯示模板數量（如 "142"）
- [修復] 修復在 API 載入前開啟模板選擇器時顯示空白的問題（加入重試機制）
- [修復] 從模板套用時，安裝步驟欄位現在能正確填入內容
- [新功能] Web 入口網站：「瀏覽官方模板」按鈕同步顯示模板數量
- [新功能] 5 項企業安全功能：IP 白名單、地區封鎖、速率限制、稽核日誌、RBAC
- [修復] 修復 cron 排程更新時 scheduled_at 違反 NOT NULL 限制的問題
- [修復] 修復 /api/health 路徑被 HTTPS 重新導向的問題

## Technical Changes
- Android: `MissionControlActivity.kt` — retry-on-empty gallery, search bar, template count badge
- Android: `MissionControlActivity.kt` — fix `TelemetryHelper.trackAction` extra context arg
- Portal: `mission.html` — template count on browse button and gallery dialog title
- Backend: enterprise security features (IP allowlist, geo-blocking, rate limiting, audit logging, RBAC)
- Backend: cron scheduled_at NOT NULL fix
- Backend: /api/health HTTPS redirect bypass
- Tests: `test-skill-templates.js` — 12 regression cases for template API health and Android code structure
- Tests: enterprise feature regression tests added
