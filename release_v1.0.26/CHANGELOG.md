# Release v1.0.26 - 2026-02-22

## What's New / 更新內容

### English
- [Feature] Per-device entity limit: free users get 4 slots, premium users get 8 slots
- [Feature] Schedule execution history: recurring schedules now show execution logs in the history tab
- [Feature] Dynamic entity chips with debug 4/8 toggle in Mission Control
- [Improve] Mission Control UI: Schedule moved to content card ("Go to Schedule"), top bar simplified with Save button
- [Improve] Entity chip UI: removed close icons, added avatars, dark theme colors
- [Fix] Device timezone now correctly used for cron schedule execution
- [Fix] Schedule add button no longer shows double "+" icon

### 繁體中文
- [新功能] 每裝置實體數限制：免費用戶 4 個位置，付費用戶 8 個位置
- [新功能] 排程執行歷史：重複排程現在會在歷史分頁顯示執行紀錄
- [新功能] 動態實體晶片，Mission Control 中可切換 4/8 個除錯模式
- [改進] Mission Control UI：排程移至內容卡片（「進入排程」），頂部列簡化為儲存按鈕
- [改進] 實體晶片 UI：移除關閉圖示、新增頭像、深色主題配色
- [修復] 裝置時區現在正確用於 cron 排程執行
- [修復] 排程新增按鈕不再顯示雙重「+」圖示

## Technical Changes
- Backend: Added `schedule_executions` table and `GET /api/schedule-executions` endpoint
- Backend: Per-device entity limit with `MAX_ENTITIES_PER_DEVICE` config (free: 4, premium: 8)
- Backend: Fixed timezone pass-through in `POST /api/schedules`
- Backend: Synced `LATEST_APP_VERSION` to 1.0.26
- Android: New schedule execution history API integration
- Android: Mission Control layout restructured (Schedule as navigation card)
- Android: Dynamic entity chips with avatar icons
- Web: Schedule history now uses dedicated executions endpoint
