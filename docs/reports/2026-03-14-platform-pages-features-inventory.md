# EClaw 三平台頁面與功能渲染邏輯整理

> 建立日期：2026-03-14
> 涵蓋範圍：Web Portal、Android App、iOS/React Native App

---

## 目錄

1. [總覽](#1-總覽)
2. [跨平台功能對照表](#2-跨平台功能對照表)
3. [Web Portal 頁面清單](#3-web-portal-頁面清單)
4. [Android App 頁面清單](#4-android-app-頁面清單)
5. [iOS App 頁面清單](#5-ios-app-頁面清單)
6. [共用元件與服務](#6-共用元件與服務)
7. [可清除項目](#7-可清除項目)
8. [跨平台缺口分析](#8-跨平台缺口分析)

---

## 1. 總覽

| 平台 | 頁面/畫面數 | 主要技術 | 狀態 |
|------|-----------|---------|------|
| Web Portal | 16 HTML（含 3 個 redirect stub） | 原生 HTML/JS/CSS、Socket.IO | 生產中 |
| Android App | 16 Activities（3 個未使用） | Kotlin、Retrofit、Socket.IO、Room DB | 生產中 |
| iOS App | 11 Screens | React Native (Expo)、Zustand、Axios、Socket.IO | 生產中 |

---

## 2. 跨平台功能對照表

| 功能 | Web | Android | iOS | 備註 |
|------|:---:|:-------:|:---:|------|
| **登入/註冊** | ✅ `index.html` | ✅ 首次啟動自動建立 | ✅ 自動建立 | Web 支援 Email/OAuth；App 以 deviceId 為主 |
| **Entity 卡片首頁** | ✅ `dashboard.html` | ✅ `MainActivity` | ✅ Home tab | 核心頁面 |
| **Entity 管理 (CRUD)** | ✅ dashboard 內 | ✅ MainActivity 內（~~EntityManagerActivity~~ 已廢棄） | ✅ `entity-manager` | |
| **即時聊天** | ✅ `chat.html` | ✅ `ChatActivity` | ✅ Chat tab → `chat/[id]` | |
| **AI 客服聊天** | ✅ 浮動 widget (`ai-chat.js`) | ✅ `AiChatActivity` | ✅ `ai-chat` | |
| **Mission Dashboard** | ✅ `mission.html` | ✅ `MissionControlActivity` | ✅ Mission tab | TODO/Notes/Rules |
| **Skill/Soul/Rule 模板** | ✅ mission 內 | ✅ mission 內 | ✅ mission 內 | |
| **排程管理** | ✅ `schedule.html` | ✅ `ScheduleActivity` | ✅ `schedule` | |
| **環境變數** | ✅ `env-vars.html` | ✅ mission 內整合 | ⚠️ API 存在但無 UI | iOS 缺口 |
| **檔案管理** | ✅ `files.html` | ✅ `FileManagerActivity` | ✅ `file-manager` | |
| **設定** | ✅ `settings.html` | ✅ `SettingsActivity` | ✅ Settings tab | |
| **訂閱/計費** | ✅ settings 內 | ✅ settings 內 (Google Play) | ⚠️ 僅 Free tier UI | iOS 缺口 |
| **通知偏好** | ✅ settings 內 | ✅ settings 內 | ⚠️ Toggle 存在但未接 API | iOS 缺口 |
| **Official Bot 借用** | ✅ dashboard 內 | ✅ `OfficialBorrowActivity` | ✅ `official-borrow` | |
| **Feedback 提交** | ✅ `feedback.html` | ✅ `FeedbackActivity` | ✅ `feedback` | |
| **Feedback 歷史** | ✅ settings 內 | ✅ `FeedbackHistoryActivity` | ❌ 無 | iOS 缺口 |
| **跨裝置聯絡人** | ✅ chat 內 | ✅ chat 內 | ❌ API 存在但無 UI | iOS 缺口 |
| **遠端螢幕控制** | ✅ `screen-control.html` | ✅ `ScreenControlService` | ❌ 無 | iOS 無需（設計如此） |
| **Agent Card CRUD** | ✅ dashboard 內 | ✅ entity manager 內 | ✅ entity-manager 內 | |
| **Cross-device Settings** | ✅ dashboard 內 | ✅ main 內 | ❌ 無 UI | iOS 缺口 |
| **Admin 後台** | ✅ `admin.html` | ❌ 無 | ❌ 無 | Web-only（設計如此） |
| **Info Hub (FAQ/Guide)** | ✅ `info.html` | ❌ 無（連結到 Web） | ❌ 無 | Web-only |
| **隱私政策** | ✅ settings modal | ✅ `PrivacyPolicyActivity` | ⚠️ 按鈕存在但無實作 | iOS 缺口 |
| **刪除帳號** | ✅ `delete-account.html` | ❌ 透過 Web | ❌ 透過 Web | Web-only |
| **Live Wallpaper** | ❌ N/A | ✅ `ClawWallpaperService` | ❌ N/A | Android-only |
| **Layout 編輯器** | ❌ N/A | ✅ `DebugRenderActivity` | ❌ N/A | Android-only |
| **Crash Log Viewer** | ❌ N/A | ✅ `CrashLogViewerActivity` | ❌ N/A | Android-only |
| **Home Widget** | ❌ N/A | ✅ `ChatWidgetProvider` | ❌ N/A | Android-only |
| **Quick Message** | ❌ N/A | ✅ `MessageActivity` | ❌ N/A | Android-only |
| **Channel 整合** | ✅ settings 內 | ❌ 無 | ❌ 無 | Web-only |

---

## 3. Web Portal 頁面清單

### 3.1 公開頁面（無需登入）

#### `index.html` — 登入/註冊
- **渲染邏輯**：3 個認證 Tab（Login / Register / Device Login）+ 忘記密碼 + 社群 OAuth
- **API**：`POST /api/auth/login`, `/register`, `/device-login`, `/forgot-password`, `/reset-password`, `/oauth/google`, `/oauth/facebook`
- **特殊**：已登入自動跳轉 dashboard；支援 8 語系切換

#### `info.html` — 資訊中心 (FAQ / Guide / Release Notes / Compare)
- **渲染邏輯**：4 個 Tab 內容區塊，靜態內容為主
- **API**：僅 `GET /api/auth/me`（判斷是否顯示登入 CTA）
- **特殊**：整合了原本獨立的 faq / release-notes / compare 頁面

#### ~~`faq.html`~~ — 🗑️ Redirect Stub
- **渲染邏輯**：`<meta http-equiv="refresh">` 轉向 `info.html#faq`
- **狀態**：可清除（12 行，純重導向）

#### ~~`release-notes.html`~~ — 🗑️ Redirect Stub
- **渲染邏輯**：`<meta http-equiv="refresh">` 轉向 `info.html#release-notes`
- **狀態**：可清除（12 行，純重導向）

#### ~~`compare-channels.html`~~ — 🗑️ Redirect Stub
- **渲染邏輯**：`<meta http-equiv="refresh">` 轉向 `info.html#compare`
- **狀態**：可清除（12 行，純重導向）

### 3.2 認證頁面（需登入）

#### `dashboard.html` — 裝置首頁（3,092 行）
- **渲染邏輯**：
  - Entity 卡片網格（auto-fill, 300px min）：avatar、名稱、徽章、狀態
  - 卡片操作：改名、換頭像、刪除、Agent Card、Cross-device Settings
  - 新增 Entity 按鈕
  - Official Bot 借用系統（Free/Paid）
  - 訂閱資訊卡片
  - Entity 拖曳排序
  - Channel 推廣卡片
- **API**（24 端點）：entities CRUD、agent-card CRUD、cross-device-settings CRUD、official-borrow、subscription、feedback
- **Socket.IO**：entity:update、notification

#### `chat.html` — 即時聊天（2,713 行）
- **渲染邏輯**：
  - Entity 選擇器下拉
  - 用量徽章（警告/危險狀態）
  - 訊息過濾 chips（All/Received/Sent/System）
  - 訊息列表：文字、連結、媒體、link preview cards
  - 文字輸入 + 檔案上傳
  - 跨 Entity 廣播對話框
  - 跨裝置聯絡人管理
  - Entity 公開碼查詢
- **API**（9 端點）：client/speak、cross-speak、contacts、entity/lookup、message upload
- **Socket.IO**：chat:message

#### `mission.html` — Mission Control（2,142 行）
- **渲染邏輯**：
  - 3 子 Tab：Mission（TODO/DONE）、Notes、Rules
  - TODO 列表：優先級（HIGH/MEDIUM/LOW）、完成狀態、行內編輯
  - Notes：富文本編輯
  - Rules：優先級、action 顯示
  - Skill/Soul/Rule 模板畫廊 + 社群貢獻
  - TODO 拖曳排序
- **API**（7 端點）：mission/dashboard、skill/soul/rule-templates
- **Sub-tab 導航**：Schedule、Env Variables、Remote Control

#### `schedule.html` — 排程管理（1,171 行）
- **渲染邏輯**：排程列表（cron 表達式）、CRUD 表單、狀態徽章、最後執行時間
- **API**（5 端點）：schedules CRUD

#### `env-vars.html` — 環境變數（539 行）
- **渲染邏輯**：Key-Value 編輯器（device / bot / merged 三區）、驗證、儲存
- **API**（1 端點）：`POST /api/device-vars`

#### `files.html` — 檔案管理（897 行）
- **渲染邏輯**：檔案列表（縮圖、大小、日期）、類型指示器、下載/刪除、分頁
- **API**：`GET /api/entities`

#### `screen-control.html` — 遠端螢幕控制（437 行）
- **渲染邏輯**：即時螢幕預覽、截圖/刷新/指令按鈕、延遲指示器
- **API**（2 端點）：device/screen-capture、device/control

#### `settings.html` — 設定（1,769 行）
- **渲染邏輯**：
  - Device Info（ID/Secret 複製）
  - 訂閱狀態卡（方案、用量、到期、價格）
  - 通知偏好 toggles
  - Web Push 訂閱
  - 語系選擇
  - OpenClaw Channel 整合
  - Feedback 歷史
  - 隱私政策 modal
  - 刪除帳號連結
- **API**（18 端點）：subscription、notification-preferences、device-preferences、push、feedback、channel

#### `feedback.html` — 回報問題（1,188 行）
- **渲染邏輯**：提交表單（標題、描述、分類、Email）、檔案附件、歷史列表、GitHub issue 連結
- **API**（2 端點）：feedback submit/history

#### `admin.html` — 管理後台（1,694 行）
- **渲染邏輯**：
  - 統計卡片（users/devices/entities/bots）
  - 使用者管理列表
  - Bot 註冊管理
  - Skill/Soul/Rule 貢獻審核佇列
  - AI 管理員聊天
  - Gatekeeper 管理（strikes/appeals/reset）
  - 推播廣播
  - 稽核日誌
- **API**（13 端點）：admin stats/users/bots、contributions 審核、ai-support
- **存取控制**：需 admin RBAC 角色

#### `delete-account.html` — 刪除帳號（213 行）
- **渲染邏輯**：確認對話框、OAuth 重驗、危險警告、確認按鈕
- **API**（3 端點）：auth/me、oauth/config、auth/account DELETE

### 3.3 共用模組

| 檔案 | 用途 |
|------|------|
| `shared/api.js` | `apiCall()` Fetch wrapper + `showToast()` |
| `shared/auth.js` | `checkAuth()` 登入驗證 + `currentUser` 物件 |
| `shared/nav.js` | 主導航列（6 連結 + admin 動態注入） |
| `shared/public-nav.js` | 公開頁導航（login 按鈕） |
| `shared/socket.js` | Socket.IO 初始化 + 事件處理 |
| `shared/entity-utils.js` | Avatar/Name 解析 + 預設 emoji 對應 |
| `shared/ai-chat.js` | 浮動 AI 聊天 widget |
| `shared/footer.js` | 頁尾連結 |
| `../shared/i18n.js` | 8 語系國際化系統 |
| `../shared/telemetry.js` | 客戶端遙測 SDK |

---

## 4. Android App 頁面清單

### 4.1 底部導航（5 主要 Tab）

| Tab | Activity | 圖示 | 說明 |
|-----|----------|------|------|
| Home | `MainActivity` | 🏠 | Entity 卡片網格、新增/刪除/排序、avatar 選擇、cross-device settings、agent card |
| Mission | `MissionControlActivity` | 🎯 | TODO/MISSION/DONE、Notes、Skills/Souls/Rules 模板畫廊 |
| Chat | `ChatActivity` | 💬 | 即時聊天、語音錄製、檔案上傳、slash command、跨裝置聯絡人 |
| Files | `FileManagerActivity` | 📁 | 媒體畫廊（照片/語音）、類型/時間篩選、Grid/List 切換 |
| Settings | `SettingsActivity` | ⚙️ | 訂閱、帳號綁定、語系、通知、廣播、桌布、crash log |

### 4.2 子頁面

#### `EntityManagerActivity` — Entity 管理面板
- **進入方式**：MainActivity → Entity 管理按鈕
- **渲染邏輯**：Entity 卡片列表（狀態徽章、public code、Agent Card 對話框）、新增/移除/永久刪除
- **API**：entities、agent-card CRUD、add-entity、delete permanent

#### `ScheduleActivity` — 排程管理
- **進入方式**：MissionControlActivity → 排程 Tab
- **渲染邏輯**：排程列表 + 執行歷史、建立/編輯對話框、執行環境檢視
- **API**：schedules CRUD、schedule-executions

#### `AiChatActivity` — AI 客服
- **進入方式**：Settings → AI Chat / FAB 按鈕（Mission、Schedule、Files 頁面）
- **渲染邏輯**：聊天 RecyclerView、圖片附件（max 3）、非同步輪詢
- **API**：ai-support/chat、chat/submit、chat/poll

#### `OfficialBorrowActivity` — Official Bot 借用
- **進入方式**：MainActivity → Official Bot 按鈕
- **渲染邏輯**：Free/Paid tier 卡片、TOS 顯示、綁定/解綁按鈕
- **API**：official-borrow status/bind/unbind

#### `FeedbackActivity` — 問題回報
- **進入方式**：Settings → Feedback
- **渲染邏輯**：分類選擇（Bug/Feature/Question）、訊息輸入、照片上傳（max 5）
- **API**：feedback submit/photos

#### `FeedbackHistoryActivity` — Feedback 歷史
- **進入方式**：Settings → Feedback History / FeedbackActivity 完成後
- **渲染邏輯**：已提交列表、狀態徽章、GitHub issue 連結
- **API**：`GET /api/feedback`

#### `MessageActivity` — 快速發話
- **進入方式**：Home Widget / 通知快速回覆
- **渲染邏輯**：透明 overlay dialog、Entity 選擇 chips、訊息輸入
- **API**：`POST /api/client/speak`
- **特殊**：`singleTop`、`excludeFromRecents`

### 4.3 Android-Only 功能

#### `WallpaperPreviewActivity` — 桌布預覽
- **渲染邏輯**：Live wallpaper 預覽、自訂背景圖、設定桌布按鈕
- **儲存**：`LayoutPreferences` SharedPreferences

#### `DebugRenderActivity` — Layout 編輯器
- **渲染邏輯**：可拖曳 Entity 定位、自訂 layout 開關、重置按鈕
- **儲存**：`LayoutPreferences` SharedPreferences

#### `PrivacyPolicyActivity` — 隱私政策
- **渲染邏輯**：唯讀 HTML 文字 from `strings.xml`

#### `CrashLogViewerActivity` — Crash Log
- **渲染邏輯**：Crash log 列表、單筆/全部刪除
- **儲存**：`CrashLogManager` app cache

### 4.4 Android 服務與元件

| 元件 | 類型 | 說明 |
|------|------|------|
| `ClawWallpaperService` | Live Wallpaper Service | Entity 動畫 + Socket.IO 更新 |
| `ScreenControlService` | Accessibility Service | 遠端螢幕截取/控制 |
| `ClawFcmService` | FCM Service | Push 通知接收 + 路由 |
| `ChatWidgetProvider` | AppWidget | 首頁 widget 顯示最新訊息 |
| `BottomNavHelper` | Helper | 底部導航統一管理 |
| `AiChatFabHelper` | Helper | AI Chat FAB 注入（Mission/Schedule/Files） |
| `TelemetryInterceptor` | OkHttp Interceptor | 自動追蹤所有 API 請求 |

---

## 5. iOS App 頁面清單

### 5.1 底部導航（4 主要 Tab）

| Tab | 路由 | 圖示 | 說明 |
|-----|------|------|------|
| Home | `(tabs)/index` | 🏠 | Entity 卡片列表、binding code、廣播 |
| Chat | `(tabs)/chat` | 💬 | Entity 聊天列表 → 點擊進入個別聊天 |
| Mission | `(tabs)/mission` | 🎯 | 8 個水平 Tab（Todo/Missions/Done/Notes/Skills/Souls/Rules/Variables） |
| Settings | `(tabs)/settings` | ⚙️ | 帳號、訂閱、語系、通知、Entity 管理、Feedback |

### 5.2 Modal 頁面

#### `chat/[entityId]` — 個別聊天
- **渲染邏輯**：聊天氣泡（左=bot/右=user）、時間戳記、媒體指示器、拍照/選圖、無限滾動分頁
- **API**：chatApi.getHistory、speak、uploadMedia
- **Socket.IO**：chat:message 即時更新

#### `entity-manager` — Entity 管理
- **渲染邏輯**：Entity 卡片列表（avatar、名稱、slot 編號）、改名/換頭像/解綁/永久刪除、Agent Card 對話框
- **API**：rename、updateAvatar、remove、add、deletePermanent、agentCard CRUD

#### `ai-chat` — AI 客服
- **渲染邏輯**：聊天列表、圖片附件（max 3）、thinking indicator、清除歷史
- **API**：aiSupportApi.chat（同步）

#### `schedule` — 排程管理
- **渲染邏輯**：排程卡片列表（頻率/狀態 chip）、啟用 toggle、建立對話框（8 種頻率選項）
- **API**：scheduleApi list/create/toggle/delete

#### `file-manager` — 檔案管理
- **渲染邏輯**：3 欄 Grid（照片縮圖/音訊圖示）、類型/時間篩選、長按分享
- **API**：fileApi.list + Expo FileSystem + Sharing

#### `feedback` — 問題回報
- **渲染邏輯**：類型 chips（bug/feature/question）、描述輸入、截圖（max 5）、提交後自動返回
- **API**：feedbackApi.submit、uploadPhotos

#### `official-borrow` — Official Bot 借用
- **渲染邏輯**：Slot 總覽卡、TOS checkbox、Entity 卡片（綁定/解綁按鈕）
- **API**：officialBorrowApi status/bindFree/unbind

### 5.3 iOS 狀態管理 (Zustand)

| Store | 狀態 | 說明 |
|-------|------|------|
| `AuthStore` | deviceId, deviceSecret, language | SecureStore 持久化 |
| `EntityStore` | entities[], bindingCodes, isLoading | Entity 列表 + binding code |
| `ChatStore` | messagesByEntity, unreadCounts | 每 Entity 訊息 + 未讀數 |

### 5.4 iOS 服務

| 服務 | 說明 |
|------|------|
| `services/api.ts` | Axios HTTP client（25+ 端點）、auto deviceId/Secret 注入 |
| `services/socketService.ts` | Socket.IO 連線（entity:update、chat:message、notification） |
| `services/notificationService.ts` | Expo Notifications（APNs token 上傳、badge 管理） |

---

## 6. 共用元件與服務

### 6.1 國際化支援

| 語系 | Web | Android | iOS |
|------|:---:|:-------:|:---:|
| English | ✅ | ✅ | ✅ |
| 繁體中文 | ✅ | ✅ | ✅ |
| 簡體中文 | ✅ | ✅ | ✅ |
| 日本語 | ✅ | ✅ | ✅ |
| 한국어 | ✅ | ✅ | ✅ |
| ไทย | ✅ | ✅ | ✅ |
| Tiếng Việt | ✅ | ✅ | ✅ |
| Indonesia | ✅ | ✅ | ✅ |

### 6.2 即時通訊 (Socket.IO)

三平台皆使用相同的 Socket.IO 事件：

| 事件 | 方向 | 說明 | Web | Android | iOS |
|------|------|------|:---:|:-------:|:---:|
| `entity:update` | Server→Client | Entity 狀態變更 | ✅ | ✅ | ✅ |
| `chat:message` | Server→Client | 新聊天訊息 | ✅ | ✅ | ✅ |
| `notification` | Server→Client | 通用通知 | ✅ | ✅ | ✅ |
| `vars:approval-request` | Server→Client | JIT 變數審核 | ❌ | ❌ | ✅ |
| `vars:approval-response` | Client→Server | 審核回覆 | ❌ | ❌ | ✅ |

### 6.3 遙測追蹤

| 平台 | 實作 | 自動追蹤 |
|------|------|---------|
| Web | `shared/telemetry.js` | Page view + `apiCall()` 包裝 |
| Android | `TelemetryInterceptor` + `TelemetryHelper` | OkHttp 攔截器自動追蹤所有 API |
| iOS | 無 | ❌ 尚未實作 |

---

## 7. 可清除項目

### 7.1 Web Portal — 確認可清除

| 檔案 | 行數 | 原因 | 影響評估 |
|------|------|------|---------|
| `portal/faq.html` | 12 | 純 redirect 到 `info.html#faq`，已無獨立內容 | 低風險（可能有舊書籤） |
| `portal/release-notes.html` | 12 | 純 redirect 到 `info.html#release-notes` | 低風險 |
| `portal/compare-channels.html` | 12 | 純 redirect 到 `info.html#compare` | 低風險 |

> **建議**：這三個檔案總共僅 36 行，功能已完全由 `info.html` 取代。可以保留作為向後相容 redirect（零維護成本），或直接刪除。

### 7.2 iOS App — 未實作功能（可考慮移除 UI 殼或補齊實作）

| 功能 | 現狀 | 建議 |
|------|------|------|
| Email 帳號綁定 | 按鈕存在但 handler 未實作 | 補齊實作 或 暫時隱藏 |
| 訂閱升級 | 顯示 Free tier + 升級按鈕（no-op） | 補齊 Apple IAP 或 隱藏按鈕 |
| 通知偏好 toggle | Toggle 存在但未接後端 API | 接上 `notification-preferences` API |
| 隱私政策連結 | 按鈕存在但 handler 為空 | 加入 WebView 或連結到 info.html |
| 付費 Bot 借用 | 顯示 "IAP coming soon" | 補齊或暫時隱藏 |

### 7.3 Android App — 未使用的 Activity（3 個）

| Activity | 檔案 | 原因 | 影響評估 |
|----------|------|------|---------|
| `EntityManagerActivity` | `EntityManagerActivity.kt` + `activity_entity_manager.xml` | Manifest 中宣告，但無任何 production Intent 啟動它。功能已由 `MainActivity` 的 Entity 卡片操作取代 | 可安全移除（測試檔案需同步清理） |
| `AiChatActivity` | `AiChatActivity.kt` + `activity_ai_chat.xml` | 已被 `AiChatBottomSheet` fragment 取代，無 production Intent | 可安全移除 |
| `DebugRenderActivity` | `DebugRenderActivity.kt` + `activity_layout_editor.xml` | 僅測試檔案啟動，production 無入口。Layout 編輯功能已整合到 `WallpaperPreviewActivity` | 可安全移除或未來開放入口 |

### 7.4 Android App — 未使用的 Drawable 資源（12 個）

| 檔案 | 原因 |
|------|------|
| `badge_busy.xml` | 舊版 Entity 狀態徽章，已不使用 |
| `badge_eating.xml` | 同上 |
| `badge_excited.xml` | 同上 |
| `badge_idle.xml` | 同上 |
| `badge_sleeping.xml` | 同上 |
| `bg_entity_badge.xml` | 舊版 Entity badge 背景 |
| `bg_recording_indicator.xml` | 舊版錄音指示器 |
| `chat_bubble_lobster.xml` | 舊版聊天主題 bubble |
| `chat_bubble_pig.xml` | 同上 |
| `ic_drag.xml` | 未使用的拖曳圖示 |
| `ic_thumb_down_filled.xml` | 未使用的按讚圖示 |
| `ic_thumb_up_filled.xml` | 同上 |

### 7.5 Web Portal — 無其他可清除頁面

Web Portal 扣除 3 個 redirect stub 後，13 個頁面全部活躍。

---

## 8. 跨平台缺口分析

### iOS 缺少的功能（相對於 Web + Android）

| 缺口 | 優先級 | 說明 |
|------|--------|------|
| 環境變數管理 UI | 中 | API 存在（`/api/device-vars`），缺少前端頁面 |
| 跨裝置聯絡人 | 中 | API 存在（`/api/contacts`），Chat 頁面無聯絡人功能 |
| Cross-device Settings | 低 | API 存在，Entity Manager 未整合 |
| Feedback 歷史 | 低 | 提交後無法查看歷史記錄 |
| 遙測追蹤 | 中 | 完全未實作，無法用 telemetry 調試 |
| 語音訊息 | 中 | Android Chat 支援語音錄製，iOS 僅文字+圖片 |
| Slash Command | 低 | Android Chat 有 slash command 自動完成，iOS 無 |

### Android 缺少的功能（相對於 Web）

| 缺口 | 優先級 | 說明 |
|------|--------|------|
| Channel 整合 | 低 | Web settings 可建立 OpenClaw channel，Android 無 |
| 刪除帳號 | 低 | 透過 Web 處理即可 |
| Admin 後台 | N/A | 設計上 Web-only |

### Web 缺少的功能（相對於 Android）

| 缺口 | 優先級 | 說明 |
|------|--------|------|
| Live Wallpaper | N/A | 平台特有功能 |
| Home Widget | N/A | 平台特有功能 |
| 語音錄製 | 低 | Web Chat 無語音錄製（可考慮 MediaRecorder API） |
| 快速發話 overlay | N/A | Mobile-only UX pattern |

---

*此文件由 Claude Code 自動產生，基於 2026-03-14 的 codebase 狀態。*
