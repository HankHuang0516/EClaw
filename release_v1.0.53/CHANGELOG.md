# Release v1.0.53 - 2026-03-20

## What's New / 更新內容

### English
- [Feature] Web image search bot tool for article illustrations
- [Feature] Debug log viewer for admin/developer users
- [Feature] Webhook URL in push logs and debug/webhooks endpoint
- [Feature] Entity trash & consolidated delete (merge remove + permanent delete)
- [Feature] Full entity slot compaction (renumber slots to 0,1,2,...)
- [Feature] Avatar photo upload via Flickr with improved UX
- [Feature] Complete agent card rendering across all platforms
- [Feature] Rewritten Card Holder web portal matching Android 3-section layout
- [Feature] Chip-based agent card editing UX on Android
- [Feature] Expanded eclaw-a2a-toolkit with all 93 API endpoints
- [Feature] 10 new Jest test suites
- [Fix] Back button added to FileManagerActivity, Files button style aligned
- [Fix] Bottom nav layout_gravity set to BOTTOM in CardHolderActivity
- [Fix] Admin panel bot ID display, active bindings logic, contribution pagination
- [Fix] Channel API key state sync between web and app
- [Fix] Image avatars rendering in chat bubble labels
- [Fix] Admin nav link race condition in checkAuth()
- [Fix] CDN cache mismatch prevention for entity loading on web portal
- [Fix] Scroll position preserved when switching bottom nav tabs
- [Fix] openclaw-channel-eclaw synced to v1.2.1

### 繁體中文
- [新功能] 網頁圖片搜尋機器人工具，用於文章插圖
- [新功能] 管理員/開發者除錯日誌檢視器
- [新功能] Webhook URL 加入推送日誌和除錯端點
- [新功能] 實體垃圾桶 & 合併刪除操作
- [新功能] 完整實體插槽壓縮（重新編號為 0,1,2,...）
- [新功能] 透過 Flickr 上傳頭像照片，改善 UX
- [新功能] 所有平台完整 Agent 卡片渲染
- [新功能] 重寫名片夾 Web Portal，對齊 Android 三段式佈局
- [新功能] Android 上 chip 式 Agent 卡片編輯 UX
- [新功能] 擴展 eclaw-a2a-toolkit 至全部 93 個 API 端點
- [修復] FileManagerActivity 新增返回按鈕
- [修復] CardHolderActivity 底部導覽列定位修正
- [修復] 管理面板機器人 ID 顯示、綁定邏輯、貢獻分頁修正
- [修復] Web 與 App 之間 Channel API 金鑰狀態同步
- [修復] 聊天氣泡標籤中的圖片頭像渲染
- [修復] CDN 快取不一致導致的實體載入問題
- [修復] 切換底部導覽列時保留捲動位置

## Technical Changes
- Backend: v1.114.0 → v1.119.1 (6 minor releases)
- Android: versionCode 56 → 59
- Tests: 10 new test suites added
- openclaw-channel-eclaw: synced to v1.2.1
