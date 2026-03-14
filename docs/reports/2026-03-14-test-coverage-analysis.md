# EClaw 測試覆蓋率分析報告

**日期**: 2026-03-14
**分析範圍**: Backend (200+ endpoints across 20+ modules) + Android App (16 Activities, 90+ API calls)

---

## 現狀摘要

| 類別 | 數量 | 說明 |
|------|------|------|
| Backend API Endpoints | 200+ | `index.js` (139) + module routers (mission.js, auth.js, oauth-server.js, channel-api.js, article-publisher.js, ai-support.js, subscription.js 等) |
| Backend Test Files | 56 | `backend/tests/` |
| Jest Unit Tests | 2 | 本地 mock，無需伺服器 |
| Live Integration Tests | ~50 | 需要 live server |
| Android Instrumented Tests | 8 | 需要模擬器/裝置 |
| Android Unit Tests | 3 | JVM 本地執行 |

### 覆蓋率估算

- **有直接測試的 endpoints**: ~85/200+ ≈ **42%**
- **完全無測試的 endpoints**: ~115/200+ ≈ **58%**
- **有 unit test（mock/local）的模組**: 3/20+ ≈ **15%**

---

## 一、未被測試的 API Endpoints（高風險）

### 1. Admin 管理端點 — 0% 覆蓋

以下 admin 端點完全沒有測試：

| Endpoint | 說明 |
|----------|------|
| `GET /api/admin/stats` | 平台統計數據 |
| `GET /api/admin/bindings` | 綁定列表查詢 |
| `GET /api/admin/users` | 使用者列表 |
| `GET /api/admin/bots` | Bot 列表 |
| `POST /api/admin/push-update` | 推送更新通知 |
| `POST /api/admin/bots/create` | 建立 Bot |
| `POST /api/admin/official-bot/register` | 官方 Bot 註冊 |
| `GET /api/admin/official-bots` | 官方 Bot 列表 |
| `PUT /api/admin/official-bot/:botId` | 更新官方 Bot |
| `DELETE /api/admin/official-bot/:botId` | 刪除官方 Bot |
| `POST /api/admin/transfer-device` | 裝置轉移 |
| `GET /api/admin/gatekeeper/debug` | Gatekeeper Debug |
| `GET /api/skill-templates/contributions` | 投稿審核列表 |
| `GET /api/soul-templates/contributions` | Soul 投稿審核 |
| `GET /api/rule-templates/contributions` | Rule 投稿審核 |

**風險**: Admin 端點控制關鍵管理功能，auth bypass 或 data leak 可能影響整個平台。

### 2. 通知系統 — 0% 覆蓋

| Endpoint | 說明 |
|----------|------|
| `GET /api/notifications` | 通知列表 |
| `GET /api/notifications/count` | 未讀計數 |
| `POST /api/notifications/read` | 標記已讀 |
| `POST /api/notifications/read-all` | 全部標記已讀 |
| `GET /api/notification-preferences` | 通知偏好設定 |
| `PUT /api/notification-preferences` | 更新通知偏好 |

### 3. 排程系統 — 0% 覆蓋（除了 cron update bug fix）

| Endpoint | 說明 |
|----------|------|
| `GET /api/schedules` | 排程列表 |
| `POST /api/schedules` | 建立排程 |
| `PUT /api/schedules/:id` | 更新排程 |
| `PATCH /api/schedules/:id/toggle` | 啟用/停用 |
| `DELETE /api/schedules/:id` | 刪除排程 |
| `GET /api/schedule-executions` | 執行紀錄 |
| `GET /api/schedule-executions/:executionId/context` | 執行上下文 |
| `GET /api/bot/schedules` | Bot 排程列表 |
| `POST /api/bot/schedules` | Bot 建立排程 |
| `DELETE /api/bot/schedules/:id` | Bot 刪除排程 |

**風險**: 排程是核心功能，cron 任務錯誤可能導致大量不必要的推送或漏發。

### 4. 檔案管理與媒體 — 0% 覆蓋

| Endpoint | 說明 |
|----------|------|
| `GET /api/device/files` | 裝置檔案列表 |
| `GET /api/media/:id` | 媒體檔案存取 |
| `GET /api/chat/file/:id` | 聊天檔案存取 |
| `POST /api/chat/upload-media` | 媒體上傳 |
| `PUT /api/bot/file` | Bot 檔案上傳 |
| `GET /api/bot/file` | Bot 檔案讀取 |
| `GET /api/bot/files` | Bot 檔案列表 |
| `DELETE /api/bot/file` | Bot 檔案刪除 |

### 5. Feedback 系統 — 部分覆蓋

已測試: 基本 feedback 提交
未測試:
| Endpoint | 說明 |
|----------|------|
| `GET /api/feedback/:id/ai-prompt` | AI 除錯 prompt |
| `POST /api/feedback/:id/create-issue` | 建立 GitHub Issue |
| `PATCH /api/feedback/:id` | 更新 feedback |
| `POST /api/feedback/:id/photos` | 上傳照片 |
| `GET /api/feedback/:id/photos` | 照片列表 |
| `GET /api/feedback/photo/:photoId` | 單張照片 |
| `GET /api/feedback/pending-debug` | 待除錯列表 |
| `POST /api/feedback/:id/debug-result` | 除錯結果 |

### 6. 其他未測試端點

| Endpoint | 說明 |
|----------|------|
| `GET /api/device-preferences` | 裝置偏好 |
| `PUT /api/device-preferences` | 更新裝置偏好 |
| `POST /api/device/screen-capture` | 螢幕截圖 |
| `POST /api/device/screen-result` | 螢幕截圖結果 |
| `POST /api/device/control` | 遠端控制 |
| `GET /api/link-preview` | 連結預覽 |
| `POST /api/bot/sync-message` | Bot 訊息同步 |
| `GET /api/bot/pending-messages` | Bot 待處理訊息 |
| `POST /api/message/:messageId/react` | 訊息反應 |
| `POST /api/chat/integrity-report` | 聊天完整性報告 |
| `GET /api/handshake-failures` | 握手失敗紀錄 |
| `POST /api/device-vars` | 裝置變數 |
| `GET /api/device-vars` | 裝置變數查詢 |
| `DELETE /api/device-vars` | 裝置變數刪除 |
| `GET /api/chat/history` | 聊天歷史 |
| `POST /api/device/fcm-token` | FCM Token 註冊 |
| `GET /api/push/vapid-public-key` | Web Push VAPID |
| `POST /api/push/subscribe` | Web Push 訂閱 |
| `DELETE /api/push/unsubscribe` | Web Push 取消 |
| `POST /api/skill-templates/contribute` | Skill 投稿 |
| `GET /api/skill-templates/status/:pendingId` | 投稿狀態 |
| `DELETE /api/skill-templates/:skillId` | 刪除 Skill |
| `POST /api/soul-templates/contribute` | Soul 投稿 |
| `DELETE /api/soul-templates/:soulId` | 刪除 Soul |
| `POST /api/rule-templates/contribute` | Rule 投稿 |
| `DELETE /api/rule-templates/:ruleId` | 刪除 Rule |
| `GET /api/free-bot-tos` | Free Bot ToS |
| `POST /api/free-bot-tos/agree` | 同意 ToS |
| `POST /api/gatekeeper/appeal` | Gatekeeper 申訴 |
| `PATCH /api/github/issues/:number` | GitHub Issue 更新 |
| `GET /api/platform-stats` | 平台統計 |
| `POST /api/official-borrow/bind-free` | 免費綁定 |
| `POST /api/official-borrow/bind-personal` | 個人綁定 |
| `POST /api/official-borrow/add-paid-slot` | 付費 slot |
| `POST /api/official-borrow/unbind` | 解除綁定 |
| `POST /api/official-borrow/verify-subscription` | 驗證訂閱 |
| `GET /api/official-borrow/status` | 借用狀態 |

### 7. 模組化 Router 端點 — 大量未覆蓋

以下模組的端點大部分或完全沒有測試：

#### Authentication (`auth.js`) — 部分覆蓋
已測試: OAuth providers, OIDC, RBAC auth rejection
未測試:
| Endpoint | 說明 |
|----------|------|
| `POST /api/auth/register` | 使用者註冊 |
| `POST /api/auth/login` | 登入 |
| `POST /api/auth/app-login` | App 裝置登入 |
| `POST /api/auth/device-login` | 裝置登入 |
| `POST /api/auth/logout` | 登出 |
| `GET /api/auth/me` | 取得使用者資訊 |
| `GET /api/auth/verify-email` | Email 驗證 |
| `POST /api/auth/forgot-password` | 忘記密碼 |
| `POST /api/auth/reset-password` | 重設密碼 |
| `POST /api/auth/bind-email` | 綁定 Email |
| `DELETE /api/auth/account` | 刪除帳號 |

#### Subscription (`subscription.js`) — 0% 覆蓋
| Endpoint | 說明 |
|----------|------|
| `GET /api/subscription/status` | 訂閱狀態 |
| `POST /api/subscription/tappay/pay` | TapPay 付款 |
| `POST /api/subscription/cancel` | 取消訂閱 |
| `POST /api/subscription/verify-google` | Google Play 驗證 |
| `POST /api/subscription/usage` | 用量報告 |

**風險**: 付款相關邏輯完全未測，可能導致計費錯誤或安全漏洞。

#### AI Support (`ai-support.js`) — 0% 覆蓋
| Endpoint | 說明 |
|----------|------|
| `POST /api/ai-support/binding` | 綁定問題診斷 |
| `POST /api/ai-support/chat` | AI 通用聊天 |
| `POST /api/ai-support/chat/submit` | 聊天提交（polling） |
| `GET /api/ai-support/chat/poll/:requestId` | 輪詢回應 |
| `POST /api/ai-support/create-issue` | 從聊天建立 Issue |
| `POST /api/ai-support/admin-chat` | Admin AI 聊天 |

#### Article Publisher (`article-publisher.js`) — 0% 覆蓋
| Endpoint | 說明 |
|----------|------|
| `GET /api/publisher/blogger/oauth/start` | Blogger OAuth |
| `POST /api/publisher/blogger/publish` | 發布到 Blogger |
| `POST /api/publisher/hashnode/publish` | 發布到 Hashnode |
| `POST /api/publisher/x/tweet` | 發布推文 |

#### Channel API (`channel-api.js`) — 部分覆蓋
已測試: Auth rejection, required fields（`test-channel-api.js`）
未測試:
| Endpoint | 說明 |
|----------|------|
| `POST /api/channel/provision` | Channel 配置 |
| `POST /api/channel/bind` | Channel 綁定 |
| `POST /api/channel/message` | Channel 訊息 |
| `POST /api/channel/provision-device` | 裝置配置 |

---

## 二、測試架構缺陷

### 1. 幾乎沒有 Unit Tests（最嚴重的問題）

**現狀**: 只有 2 個 Jest unit test（`health.test.js`, `validation.test.js`），覆蓋極小部分。

**問題**: 56 個測試中有 ~50 個需要 live server，這意味著：
- 無法在 CI/CD 中快速執行
- 測試結果依賴外部狀態（資料庫、網路、部署）
- 無法隔離測試特定業務邏輯
- 無法做到 TDD 開發

**需要 unit test 的核心邏輯**:
- Gatekeeper 過濾邏輯（目前只有 `test_gatekeeper.js` 做了部分）
- 訊息路由邏輯（client/speak → 單一 entity vs. array vs. "all"）
- Broadcast 投遞邏輯
- Cross-device settings merge 邏輯
- Entity reorder 邏輯
- Schedule cron 解析與執行
- 用量限制計算（15-message limit）
- Official borrow slot 管理

### 2. 沒有資料庫層測試

`backend/index.js` 超過 10,000 行，所有 DB 操作（`pool.query`）直接寫在路由中，沒有獨立的 data access layer，也沒有 DB 層測試。

**建議**:
- 抽出 repository/DAO 層
- 使用 test database 或 in-memory SQLite 做 DB integration tests
- 測試 SQL query 正確性、transaction 行為、concurrent access

### 3. 沒有錯誤處理 / 邊界條件測試

現有測試主要驗證 "happy path"，缺少：
- 並發操作測試（兩個裝置同時 reorder）
- 大量資料測試（數千筆 chat history）
- 無效輸入（SQL injection, XSS payload）
- Rate limiting 邊界測試
- Token 過期/失效場景
- 網路斷線恢復

### 4. Web Portal 零測試

`backend/public/` 下的 Web Portal 頁面完全沒有前端測試：
- 無 E2E 測試（Playwright/Cypress）
- 無 component 測試
- 無 accessibility 測試

**Web Portal 頁面清單**（推估）：
- 登入/註冊頁
- Entity 管理頁
- 聊天頁
- Mission Dashboard
- 設定頁
- 排程管理頁

---

## 三、Android 測試缺口

### 現有覆蓋

- **3 unit tests**: Echo suppression regex, message format — 只測了最基本的模型邏輯
- **8 instrumented tests**: 主要是 UI 存在性檢查（按鈕存在、可點擊）

### 缺失

| 類別 | 說明 | 優先級 |
|------|------|--------|
| ViewModel 測試 | MainViewModel, MissionViewModel 完全未測 | 高 |
| Repository 測試 | StateRepository, ChatRepository 未測 | 高 |
| API Service 測試 | ClawApiService 90+ endpoints 未 mock 測試 | 中 |
| Room DB 測試 | ChatDatabase 遷移、DAO 查詢未測 | 中 |
| SocketManager 測試 | 即時通訊邏輯未測 | 中 |
| BillingManager 測試 | 付款流程未測 | 高 |
| FCM Service 測試 | Push 通知處理未測 | 中 |
| 導航流程 E2E | 跨 Activity 流程未測 | 低 |

---

## 四、優先改善建議

### P0 — 立即需要（安全 & 穩定性）

1. **Admin 端點 auth 測試** — 驗證所有 admin 端點拒絕非 admin 存取
2. **Input validation 測試** — SQL injection, XSS payload 對所有接受使用者輸入的端點
3. **Gatekeeper unit tests 擴充** — 覆蓋所有繞過攻擊模式

### P1 — 短期需要（核心功能可靠性）

4. **排程系統完整測試** — CRUD + cron 觸發 + 邊界情況
5. **通知系統測試** — 確保通知正確投遞、不丟失
6. **Official Borrow 流程測試** — 付費功能必須穩定
7. **檔案上傳/下載測試** — 媒體處理、size limit、格式驗證

### P2 — 中期需要（開發效率）

8. **抽出業務邏輯為可測試模組** — 從 10K+ 行的 index.js 中分離
9. **建立 Jest mock 測試套件** — 覆蓋核心路由邏輯
10. **Android ViewModel/Repository unit tests**
11. **Web Portal E2E 測試**（Playwright）

### P3 — 長期需要（品質基線）

12. **CI/CD 整合** — 每次 push 自動跑 unit tests
13. **覆蓋率追蹤** — 設定最低覆蓋率門檻
14. **效能測試** — 並發存取、大量資料處理
15. **Android Room migration test**

---

## 五、建議的新增測試檔案

| 檔案名稱 | 測試目標 | 類型 | 優先級 |
|----------|---------|------|--------|
| `test-admin-auth.js` | Admin 端點 auth 保護 | Live | P0 |
| `test-input-validation.js` | SQL injection / XSS | Local | P0 |
| `jest/schedule.test.js` | 排程 CRUD + cron | Jest mock | P1 |
| `jest/notification.test.js` | 通知系統邏輯 | Jest mock | P1 |
| `jest/official-borrow.test.js` | 借用流程邏輯 | Jest mock | P1 |
| `test-file-upload.js` | 媒體上傳/下載 | Live | P1 |
| `jest/message-routing.test.js` | 訊息路由（speak/broadcast） | Jest mock | P2 |
| `jest/entity-reorder.test.js` | Entity reorder 邏輯 | Jest mock | P2 |
| `jest/gatekeeper.test.js` | Gatekeeper 完整規則 | Jest mock | P0 |
| `test-feedback-workflow.js` | Feedback 完整工作流 | Live | P2 |

---

*報告產出：Claude Code test coverage analysis session*
