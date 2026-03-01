# Release v1.0.33 - 2026-03-01

## What's New / 更新內容

### English

- [Feature] **Social Login**: Google and Facebook OAuth sign-in for both Android app and web portal
- [Feature] **AI Chat System**: Floating AI assistant (draggable FAB) on all main pages with background processing, image upload support, concurrency queue, and auto-retry
- [Feature] **AI Feedback to GitHub**: AI chat automatically creates GitHub issues for user feedback and bug reports
- [Feature] **AI Server Log Access**: AI assistant can query server logs directly for faster troubleshooting
- [Feature] **Cross-Device Contacts**: Chat system for messaging between entities on different devices with unified target bar
- [Feature] **Bot Communication**: Added `expects_reply` field to bot-to-bot speak-to and broadcast APIs
- [Feature] **Free Bot Enhancements**: Public code assigned to free bot bindings; limit hints and sold-out rental demand flow
- [Feature] **Account Status Card**: New account overview card on settings page
- [Fix] **Chat Dedup**: Fixed user messages being incorrectly deduplicated (only bot messages are deduped now)
- [Fix] **Entity Rendering**: Enabled EYE_LID/EYE_ANGLE rendering for richer expressions
- [Fix] **Chat Filters**: Broadcast/speak-to messages now correctly appear for recipient entities
- [Fix] **Schedule History**: Improved display, matching accuracy, and pagination
- [Fix] **Bot Behavior**: Bots now update mood/emoji only without narrating messages
- [Fix] **Entity Reorder**: Syncs all associated data atomically during reorder
- [Improve] **AI Chat Stability**: Fixed "thinking" stuck state, timeout issues, and JSON sanitization
- [Improve] **Cross-Device Display**: Correct chat labels and bubble counts for remote targets
- [Improve] **Test Suite**: Increased stress test timeout and added telemetry flush delay for reliability

### 繁體中文

- [新功能] **社交登入**：支援 Google 和 Facebook OAuth 登入（Android 和網頁版）
- [新功能] **AI 聊天系統**：所有主頁面新增浮動 AI 助手（可拖曳 FAB），支援背景處理、圖片上傳、併發佇列與自動重試
- [新功能] **AI 回饋至 GitHub**：AI 聊天自動為使用者反饋和錯誤報告建立 GitHub Issue
- [新功能] **AI 伺服器日誌查詢**：AI 助手可直接查詢伺服器日誌，加速問題排查
- [新功能] **跨裝置聯絡人**：跨裝置實體聊天系統，含統一目標列
- [新功能] **機器人通訊**：bot-to-bot speak-to 和 broadcast API 新增 `expects_reply` 欄位
- [新功能] **免費機器人強化**：免費綁定自動分配 public_code；新增額度提示與租賃需求流程
- [新功能] **帳號狀態卡片**：設定頁面新增帳號總覽卡片
- [修復] **聊天去重**：修正使用者訊息被錯誤去重的問題（現只對機器人訊息去重）
- [修復] **實體渲染**：啟用 EYE_LID/EYE_ANGLE 渲染，表情更豐富
- [修復] **聊天篩選**：廣播/speak-to 訊息現正確顯示於接收方實體
- [修復] **排程歷史**：改善顯示、匹配準確度與分頁
- [修復] **機器人行為**：機器人現只更新情緒/表情符號，不再旁白敘述
- [修復] **實體排序**：排序時原子性同步所有關聯資料
- [改進] **AI 聊天穩定性**：修正「思考中」卡住、逾時問題與 JSON 清理
- [改進] **跨裝置顯示**：修正遠端目標的聊天標籤與泡泡計數
- [改進] **測試套件**：增加壓力測試逾時並加入遙測排清延遲，提升可靠性

## Technical Changes

- Backend: Social login OAuth endpoints (Google/Facebook), AI chat proxy with Anthropic API, cross-device contacts, expects_reply field, server error logging, broadcast dedup fix, entity reorder atomic sync
- Android: Google/Facebook login SDKs, draggable AI FAB, cross-device contacts Activity, EYE_LID/EYE_ANGLE rendering, account status card
- Web Portal: Social login buttons, AI chat widget on all portal pages, background chat processing, image upload in AI chat, GitHub issue creation
- Tests: Increased suite timeout (300s→600s), telemetry flush delay fix, user message dedup test fix
- Infrastructure: claude-cli-proxy improvements (git installation, Nixpacks compatibility, permissions)
