# Release v1.0.40 - 2026-03-06

## What's New / 更新內容

### English
- [Feature] Chat Image Preview — image URLs now display as inline previews in the chat window
- [Feature] Remote Control Improvements — screen elements limit increased 150→300, smarter keyboard input (ime_action fallback), getWindows() fallback added
- [Fix] **Critical** Entity Crash Fix — Gson crash when a bot sends non-numeric data to the wallpaper parts field (caused all entity slots to go blank; reinstall didn't help)
- [Fix] Chat Stability — ChatIntegrity false-positive detections and LinkPreviewHelper NPE resolved
- [Fix] AI Image Processing — exclude current message from history to fix double-send issue
- [Fix] Screenshot Reliability — 5 MB body limit, improved error propagation, canTakeScreenshot guard, backend timeout shortened
- [Fix] Claude CLI Proxy — Docker startup fixed (PORT variable expansion, missing import sys, Python logging to stdout), warmup interval optimized 5min→30min
- [Fix] OpenClaw Channel binding guide added to User Guide tab in portal

### 繁體中文
- [新功能] 聊天圖片預覽 — 圖片 URL 現在會在聊天視窗內直接顯示為內嵌預覽
- [新功能] 遠端控制改進 — 螢幕元素上限提升至 300，鍵盤輸入處理更智慧，新增 getWindows() 備援
- [修復] **重大** 實體崩潰修復 — Bot 傳送非數值資料至桌布 parts 欄位時導致所有實體槽變空白（重裝也無效），已修復
- [修復] 聊天穩定性 — 修復 ChatIntegrity 誤判和 LinkPreviewHelper NPE 崩潰
- [修復] AI 圖片處理 — 排除當前訊息以修正 AI 圖片分析重複問題
- [修復] 截圖可靠性 — 上傳限制 5 MB、改進錯誤傳遞、canTakeScreenshot 防護、後端逾時縮短
- [修復] Claude CLI Proxy — Docker 啟動修復（PORT 變數展開、缺少 import sys、Python 日誌輸出），預熱間隔優化 5min→30min
- [修復] 使用者指南新增 OpenClaw Channel 綁定教學

## Technical Changes
- Backend: backend/index.js — parts 欄位寫入時過濾非數值；LATEST_APP_VERSION → 1.0.40
- Android: EntityStatus/AgentStatus.parts 型別 Map<String,Double> → Map<String,Any>；ClawRenderer 安全轉型；versionCode 42→43，versionName 1.0.40
- Web Portal: info.html 新增 v1.0.40 release entry；i18n.js 8 語言完整翻譯 (rn_1040_1~6)
- Claude CLI Proxy: Docker startup 修復多個問題

## Bug Fix Reference
- Issue #144: [Bug] NumberFormatException parsing URL as integer → FIXED & CLOSED
