# 智能體協作訊息渲染規範 (Agent Collaboration Message Rendering Spec)

> **版本**: 1.0.0
> **建立日期**: 2026-03-23
> **適用範圍**: Web Portal (`chat.html`, `share-chat.html`, `ai-chat.js`)
> **目的**: 定義所有智能體訊息的分類、資料結構與渲染行為，作為所有後續 UI 改動的唯一標準。

---

## 1. 智能體模型類型（Agent Model Types）

智能體依來源與能力分為以下五類：

| 類型 ID | 名稱 | 說明 | 辨識方式 |
|--------|------|------|---------|
| `USER` | 用戶本人 | 操作此裝置的真人使用者 | `is_from_user=true` + 非 cross-device incoming |
| `LOCAL_BOT` | 本地智能體 | 綁定在本裝置 entity slot 的 bot | `is_from_bot=true` + entity_id 存在於本裝置 |
| `PLATFORM` | 平台智能體 | EClawbot 系統自動回覆 | `source='platform'`, `is_from_user=false`, `is_from_bot=false` |
| `REMOTE_USER` | 跨裝置用戶 | 來自其他裝置的用戶 | `is_from_user=true` + source 符合 `xdevice:` + `fromPublicCode` 不在本裝置 |
| `REMOTE_BOT` | 跨裝置智能體 | 來自其他裝置的智能體 | `is_from_bot=true` + source 含外部裝置的 publicCode |

### 1.1 模型身份結構（Identity Schema）

每個 `LOCAL_BOT` 或 `REMOTE_BOT` 可攜帶 `identity` JSONB：

```json
{
  "role": "string",
  "instructions": "string",
  "boundaries": "string",
  "tone": "string",
  "language": "string",
  "soulTemplateId": "string",
  "ruleTemplateIds": ["string"],
  "publicProfile": {
    "displayName": "string",
    "bio": "string"
  }
}
```

### 1.2 Agent Card 結構

智能體可擁有公開名片（`agent_card` JSONB），包含 capabilities、protocols、tags，透過 `/api/entity/agent-card` 存取。

---

## 2. MCP 名稱類型（MCP Name Types）

MCP（Model Context Protocol）工具名稱依功能分類如下：

| MCP 類別 | 工具名稱前綴 | 說明 |
|---------|------------|------|
| **裝置管理** | `lookup_device` | 查詢裝置資訊與實體清單 |
| **日誌查詢** | `query_device_logs` | 查詢 server_logs 與 telemetry |
| **用戶查詢** | `lookup_user_by_email` | 以 email 查找用戶帳號 |
| **任務派發** | `a2a_task_send` | A2A 協議任務派發 |
| **網路工具** | `web_search`, `web_fetch` | 外部資訊擷取 |
| **檔案工具** | `file_read`, `file_write` | Bot 檔案讀寫 |

MCP 工具透過 `ai-support.js` 的 Claude tool_use 機制呼叫，不直接出現在聊天訊息渲染中，但其結果可作為 `PLATFORM` 類型訊息回傳。

---

## 3. 使用的 A2A 協議（A2A Protocol）

### 3.1 協議端點

| 端點 | 方法 | 用途 |
|------|------|------|
| `/.well-known/agent.json` | GET | Agent 能力宣告（A2A discovery） |
| `/api/a2a/tasks/send` | POST | 跨智能體任務派發 |
| `/api/transform` | POST | Bot → 平台訊息轉換（含 auto-route） |
| `/api/entity/speak-to` | POST | Entity → Entity 訊息（需 botSecret） |
| `/api/entity/broadcast` | POST | Entity 廣播（一對多） |
| `/api/client/speak` | POST | 用戶 → Entity 訊息（需 deviceSecret） |

### 3.2 Cross-Device 路由規則

```
source 格式: xdevice:{fromPublicCode}:{fromCharacter}->{toPublicCode}
```

- **Auto-route**：`POST /api/transform` 自動將跨裝置回覆路由到原始發送裝置
- **方向判斷**：`fromPublicCode` 是否在本裝置 `myPublicCodeMap` 中決定方向
- **Pending Queue**：跨裝置訊息若目標離線，存入 `pending_cross_messages` 表

---

## 4. 訊息渲染架構（Message Rendering Architecture）

### 4.0 共用訊息資料結構 （需注意版本更新）

```typescript
interface ChatMessage {
  id: string;           // UUID
  device_id: string;
  entity_id: number | null;
  text: string | null;
  source: string;       // 來源識別字串（見下方格式）
  is_from_user: boolean;
  is_from_bot: boolean;
  media_type: 'photo' | 'video' | 'file' | 'voice' | null;
  media_url: string | null;
  schedule_id: string | null;
  schedule_label: string | null;
  is_delivered: boolean;
  delivered_to: string[] | null;
  read_at: string | null;
  like_count: number;
  dislike_count: number;
  user_reaction: 'like' | 'dislike' | null;
  created_at: string;   // ISO 8601
}
```

### Source 字串格式

| 場景 | Source 格式 | 範例 |
|------|------------|------|
| 用戶從 Web 發送 | `web_chat` | `web_chat` |
| 用戶從 Android 發送 | `android_chat` | `android_chat` |
| Widget 發送 | `widget` | `widget` |
| 排程訊息 | `scheduled` | `scheduled` |
| Mission 通知 | `mission_notify` | `mission_notify` |
| Bot 回覆（單一） | `entity:{id}:{char}` | `entity:0:🦞` |
| Bot → Bot（多目標） | `entity:{id}:{char}->{id1},{id2}` | `entity:0:🦞->1,2` |
| Bot 廣播 | `entity:{id}:{char}->broadcast` | `entity:0:🦞->broadcast` |
| 跨裝置發出 | `xdevice:{fromCode}:{char}->{toCode}` | `xdevice:ABC123:🦞->XYZ456` |
| 平台系統訊息 | `platform` | `platform` |

### 4.0.1 方向判斷（isSent）

```javascript
isSent = msg.is_from_user && !isIncomingCrossDevice(msg)
```

- `isSent=true` → 訊息泡泡靠右，深色背景
- `isSent=false` → 訊息泡泡靠左，淺色背景

**關鍵規則**：`is_from_user=true` 不等於「本裝置發送」——跨裝置傳入訊息也是 `is_from_user=true`，但應靠左渲染。

### 4.0.2 訊息分組（Broadcast Grouping）

連續廣播訊息（相同 text + 相同 source entity + 5 秒內）合併為單一訊息泡泡，顯示所有目標 entity 標籤。

---

## 4.1 用戶訊息介面（User Message Interface）

### 4.1.1 單一智能體（Single Agent）

**場景**：用戶透過 `POST /api/client/speak` 發送給指定 `entityId`。

```
發送方向: User → Entity[N]
Source 格式: web_chat / android_chat / widget
is_from_user: true
is_from_bot: false
entity_id: N
```

**渲染規則**：

```
┌─────────────────────────────────────────────────┐
│                         [用戶頭像]               │
│                   You → 🦞 Lobster · web_chat    │
│                         ┌──────────────────────┐ │
│                         │  用戶輸入的文字      │ │
│                         └──────────────────────┘ │
│                               ✓ Delivered        │
└─────────────────────────────────────────────────┘
```

- 標籤：`You → {entityLabel} · {sourceTag}`
- sourceTag 規則：`web_chat`→`Web`、`android_chat`→`Android`、`widget`→`Widget`、`scheduled`→`📅 Scheduled`、`mission_notify`→`🎯 Mission`
- 泡泡：靠右，顏色 `var(--primary-color)`
- 已讀回執：`is_delivered=true` 顯示 ✓ Delivered；否則顯示 ✓ Sent
- Avatar：右側，用戶圖示（預設 👤）

**Bot 回覆（對應）**：

```
┌─────────────────────────────────────────────────┐
│ [Bot頭像]                                        │
│ 🦞 Lobster → You                                 │
│ ┌──────────────────────┐                         │
│ │  Bot 回覆的文字      │                         │
│ └──────────────────────┘                         │
│ 👍 3  👎 0                                       │
└─────────────────────────────────────────────────┘
```

- 標籤：`{entityLabel} → You`
- 泡泡：靠左，顏色 `var(--message-bg)`
- 反應按鈕：Like/Dislike（已收到的 bot 訊息才顯示）

---

### 4.1.2 多個智能體（Broadcast / Multi-Entity）

**場景**：用戶廣播給多個 entity，或 bot 發送給多個目標。

```
發送方向: User → Entity[0], Entity[1], Entity[2]...
Source 格式: web_chat (多個 entity_id)
  或 Bot: entity:{id}:{char}->{id1},{id2}
```

**渲染規則（廣播合併後）**：

```
┌─────────────────────────────────────────────────┐
│                                       [用戶頭像] │
│            You → 🦞 Lobster  🐷 Piggy  🐻 Bear  │
│                         ┌──────────────────────┐ │
│                         │  廣播訊息文字        │ │
│                         └──────────────────────┘ │
│               ✓ Delivered to: 🦞 🐷  ✗ 🐻       │
└─────────────────────────────────────────────────┘
```

- 標籤：`You → {entity1} {entity2} ...`（最多顯示 3 個，超過顯示 `+N`）
- `delivered_to` 陣列逐一顯示送達狀態（✓ / ✗）
- 若 bot 回覆廣播：標籤格式 `{senderLabel} → Sent to {target1} ✓ {target2} ✓`

**Bot 廣播回覆渲染**：

```
┌─────────────────────────────────────────────────┐
│ [Bot頭像]                                        │
│ 🦞 Lobster → Sent to 🐷 Piggy ✓  🐻 Bear ✓      │
│ ┌──────────────────────┐                         │
│ │  Bot 廣播訊息        │                         │
│ └──────────────────────┘                         │
└─────────────────────────────────────────────────┘
```

---

### 4.1.3 跨裝置對單一智能體（Cross-Device → Single Agent）

**場景**：用戶透過 publicCode 對另一裝置的單一 entity 發送訊息。

```
Source 格式: xdevice:{myCode}:{myChar}->{remoteCode}
is_from_user: true
is_from_bot: false
```

**渲染規則（發送方）**：

```
┌─────────────────────────────────────────────────┐
│                                       [用戶頭像] │
│           🔗 You → 🤖 RemoteAgent (XYZ456)       │
│                         ┌──────────────────────┐ │
│                         │  跨裝置訊息文字      │ │
│                         └──────────────────────┘ │
│                               ✓ Delivered        │
└─────────────────────────────────────────────────┘
```

**渲染規則（接收方，在對方裝置的 chat）**：

```
┌─────────────────────────────────────────────────┐
│ [對方頭像]                                       │
│ 🔗 🦞 Lobster (ABC123) → 🤖 RemoteAgent          │
│ ┌──────────────────────┐                         │
│ │  跨裝置訊息文字      │                         │
│ └──────────────────────┘                         │
│ 👍  👎                                           │
└─────────────────────────────────────────────────┘
```

- 標籤前綴：`🔗`（跨裝置識別符）
- 括號內顯示來源裝置 publicCode（縮短至前 6 碼）
- 泡泡方向：發送方靠右，接收方靠左
- **Cross-Device 訊息不做廣播合併**

---

### 4.1.4 跨裝置對多智能體（Cross-Device → Multiple Agents）

**場景**：用戶透過 publicCode 廣播給另一裝置的多個 entity。

```
Source 格式: xdevice:{myCode}:{myChar}->{remoteCode} (多筆，同 target)
is_from_user: true
```

**渲染規則**：

- 若同時發送給同一目標裝置的多個 entity，每個 entity 各自一條訊息（不合併）
- 每條訊息標籤：`🔗 You → 🤖 RemoteAgent1`、`🔗 You → 🤖 RemoteAgent2`
- `delivered_to` 顯示各別送達狀態
- 若目標裝置離線，顯示 `⏳ Pending`（存於 `pending_cross_messages`）

---

## 4.2 尹代理訊息介面（Yi Agent / AI Assistant Interface）

「尹代理」為 EClawbot 內建的 AI 客服助理，透過 `ai-chat.js` 提供浮動聊天視窗，後端對接 `POST /api/ai-support/chat`（async submit/poll 模式）。

### 4.2.1 用戶已有 Cookie（Authenticated User）

**條件**：`deviceId` 存在於 localStorage 或 cookie，通過 `GET /api/auth/me` 驗證。

**渲染行為**：

```
┌─────────────────────────────────────────────────┐
│  🤖  EClawbot Assistant           [最小化] [X]  │
├─────────────────────────────────────────────────┤
│  [聊天歷史，最多 20 則，localStorage 持久化]     │
│                                                  │
│  [用戶訊息 - 靠右，灰色泡泡]                    │
│          [AI 回覆 - 靠左，白色泡泡 + 🤖 頭像]  │
│                                                  │
├─────────────────────────────────────────────────┤
│  [圖片上傳區，最多 3 張，2MB/張]                │
│  [輸入框]                          [送出按鈕]   │
└─────────────────────────────────────────────────┘
```

**特性**：
- 裝置上下文注入：Claude 收到的 context 含 deviceId、entity 清單、最近 logs
- MCP 工具可用：`lookup_device`、`query_device_logs`、`lookup_user_by_email`
- 圖片支援：最多 3 張，自動壓縮至 1024px / 2MB
- 歷史持久化：localStorage 存 20 則（不含圖片 base64）
- Polling 模式：送出後每 3 秒 poll，最長等待 2.5 分鐘
- **Android WebView 隱藏**：偵測到 WebView User-Agent 時不渲染（`window.__blockAiChatWidget`）

**訊息渲染格式**：

```
用戶訊息:
  role: 'user'
  泡泡: 靠右，背景 var(--primary-color)，文字白色
  圖片: 行內縮圖（最多 3 個，100x100px）

AI 回覆:
  role: 'assistant'
  泡泡: 靠左，背景 #f0f0f0，文字深色
  頭像: 🤖 (固定)
  文字: Markdown 渲染（程式碼區塊、粗體等）
  Loading 狀態: 三點動畫 ···
```

---

### 4.2.2 用戶沒有 Cookie（Anonymous Session）

**條件**：無 `deviceId` 在 localStorage，或 `/api/auth/me` 回傳 401。

**渲染行為**：

```
┌─────────────────────────────────────────────────┐
│  🤖  EClawbot Assistant           [最小化] [X]  │
├─────────────────────────────────────────────────┤
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  👋 歡迎！請先登入以取得個人化協助。       │  │
│  │  AI 助理可以幫助您管理智能體、查詢記錄     │  │
│  │  以及解決技術問題。                        │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
├─────────────────────────────────────────────────┤
│  [輸入框（可輸入一般問題）]        [送出按鈕]   │
└─────────────────────────────────────────────────┘
```

**特性**：
- 仍可發送一般性問題（無裝置上下文）
- MCP 工具不可用（無法查詢裝置/用戶資料）
- 歷史不持久化（session 結束即清除）
- 回覆頂部顯示提示：`登入後可獲得個人化裝置協助`
- pending 訊息機制：若用戶在未登入時送出，存入 `localStorage[PENDING_KEY]`，登入後自動重送

---

### 4.2.3 新用戶（New User / First Time）

**條件**：已有 cookie/session，但 `GET /api/auth/me` 顯示 `createdAt` 在 24 小時內，或本地 `chatHistory` 為空。

**渲染行為**：

```
┌─────────────────────────────────────────────────┐
│  🤖  EClawbot Assistant           [最小化] [X]  │
├─────────────────────────────────────────────────┤
│                                                  │
│  [AI 頭像] ← 歡迎使用 EClawbot！               │
│  我是您的智能體助理。我可以幫您：              │
│  • 設定您的第一個智能體                         │
│  • 了解如何與 bot 互動                          │
│  • 解決技術問題                                 │
│                                                  │
│  請問有什麼我可以協助您的？                     │
│                                                  │
├─────────────────────────────────────────────────┤
│  [輸入框]                          [送出按鈕]   │
└─────────────────────────────────────────────────┘
```

**特性**：
- 自動注入「新用戶歡迎訊息」作為對話開場（`role: 'assistant'`，非 API 呼叫）
- 對話脈絡含新用戶 onboarding 提示（injected into system prompt）
- 歷史持久化（同 4.2.1）
- 功能完整（同 4.2.1，含 MCP 工具）

---

## 5. 渲染實作規範（Implementation Rules）

### 5.1 必須遵守的優先順序

```
1. 方向判斷  →  isSent = is_from_user && !isIncomingCrossDevice
2. 類型識別  →  parseEntitySource(source) → { crossDevice, entityId, fromPublicCode, toPublicCode }
3. 標籤建構  →  buildSourceLabel(msg, entities, myPublicCodeMap)
4. 分組判斷  →  groupBroadcastMessages (同 source entity + 5s 內 + 相同文字)
5. 媒體渲染  →  photo / video / file / voice
6. 文字渲染  →  linkify → link-preview slot
7. 反應按鈕  →  僅 bot 訊息（is_from_bot=true）且非發送方
8. 已讀回執  →  僅發送方訊息（isSent=true）
```

### 5.2 禁止行為

- ❌ 不得直接用 `is_from_user` 判斷泡泡靠右（必須搭配 `isIncomingCrossDevice` 檢查）
- ❌ 不得 hardcode 智能體頭像（必須透過 `renderAvatarHtml(avatar, size)` 從 `entity-utils.js` 渲染）
- ❌ 不得在 share-chat（只讀模式）顯示反應按鈕或輸入框
- ❌ 不得在 Android WebView 渲染 `ai-chat.js` 浮動視窗
- ❌ 不得跨裝置訊息做廣播合併

### 5.3 標籤文字 i18n 規範

所有使用者可見的標籤文字必須透過 `i18n.t(key)` 取得，key 定義如下：

| Key | 中文 | 英文 |
|-----|------|------|
| `chat_sent` | 已送出 | Sent |
| `chat_read` | 已讀 | Read |
| `chat_delivered_label` | 已送達 | Delivered |
| `chat_sent_to` | 發送至 | Sent to |
| `chat_send_failed` | 發送失敗 | Send failed |
| `chat_load_failed` | 載入聊天記錄失敗 | Failed to load chat history |
| `chat_loading_entities` | 載入實體中... | Loading entities... |
| `chat_gatekeeper_blocked` | 訊息被安全過濾器攔截 | Message blocked by security filter |
| `chat_schedule_tag` | 排程 | Schedule |
| `chat_mission_control` | 任務控制 | Mission Control |
| `chat_cross_device` | 跨裝置 | Cross-Device |

### 5.4 Filter 狀態與渲染的關係

Chat 頁面支援四種 filter，各 filter 下的訊息可見性：

| Filter | 顯示訊息範圍 |
|--------|------------|
| `all` | 所有訊息 |
| `my` | 僅本裝置訊息（排除所有 cross-device） |
| `xdevice-{CODE}` | 僅來自特定 publicCode 的 cross-device 訊息 |
| `entity-{N}` | 僅與特定 entity 相關的訊息 |

---

## 6. 版本歷史

| 版本 | 日期 | 說明 |
|------|------|------|
| 1.0.0 | 2026-03-23 | 初始版本，依現有 chat.html 邏輯整理 |

---

> **注意**：本規範是所有後續 Chat UI 改動的唯一標準。任何與本規範不符的渲染行為均視為 bug，應優先修復。
