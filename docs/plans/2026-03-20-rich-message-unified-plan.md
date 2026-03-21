# Rich Message 統一實作計畫

## 涵蓋的 Issues

| # | 標題 | 核心需求 |
|---|------|----------|
| **#258** | Add Rich Message Templates and Interactive Buttons | 通用 rich message 模型（buttons、templates、embeds） |
| **#274** | Add Google Chat Rich Message Card Support | Google Chat `cardsV2` 格式支援 |
| **#276** | Add Google Chat Message Thread Reply Support | Google Chat threaded reply |
| **#259** | Add Message Reactions and Reply Support | emoji reactions + 引用回覆 |
| **#256** | Add Media Message Support for EClaw Channel | Channel 層的 media 訊息（image/video/audio/doc） |

## 現有架構分析

### 訊息推送流程
```
Client/Bot → API endpoint → pushToBot() → webhook (Discord/OpenClaw/Google Chat)
                                        → channel callback (Channel API)
```

### 已支援的 Rich Message
- **Discord**: embeds, components (buttons, select menus), username, avatar_url
- **OpenClaw**: 純文字 (instruction-first format)
- **Google Chat**: ⚠️ WIP — URL 偵測 + `googleChatPush()` 已加入，但 `pushToBot()` 分支未完成
- **Channel API**: 純文字 + mediaType/mediaUrl

### Chat 儲存欄位 (`chat_messages`)
- `text`, `source`, `is_from_user`, `is_from_bot`
- `media_type` (varchar 16), `media_url` (text) — 已存在
- `like_count`, `dislike_count` — 已存在
- `message_reactions` table — 已存在（`reaction_type` = like/dislike）
- ❌ 無 `reply_to_message_id` 欄位
- ❌ 無 `rich_content` / `metadata` 欄位
- ❌ 無 `thread_id` 欄位

---

## 分層設計

### Layer 1: 通用 Rich Message 模型（#258 核心）

在 EClaw 內部定義一個**平台無關**的 rich message 格式，各平台推送時再轉換。

```javascript
// EClaw Rich Message 格式（存在 chat_messages.metadata JSONB）
{
  // 卡片
  cards: [{
    title: "訂單確認",
    subtitle: "訂單 #12345",
    imageUrl: "https://...",
    sections: [{
      header: "詳情",
      widgets: [
        { type: "text", text: "金額: $100" },
        { type: "image", imageUrl: "https://..." },
        { type: "button", label: "確認", action: "confirm_order", value: "12345" },
        { type: "buttonList", buttons: [
          { label: "接受", action: "accept" },
          { label: "拒絕", action: "reject" }
        ]}
      ]
    }]
  }],
  // 快速回覆 chips
  quickReplies: [
    { label: "是", value: "yes" },
    { label: "否", value: "no" }
  ],
  // 引用回覆
  replyTo: {
    messageId: "uuid-xxx",
    text: "原始訊息片段...",
    sender: "client"
  },
  // Thread (Google Chat)
  threadKey: "thread-abc-123"
}
```

### Layer 2: 平台轉換器

| EClaw 格式 | Discord | Google Chat | OpenClaw | Channel API |
|-----------|---------|-------------|---------|-------------|
| `cards` | `embeds` + `components` | `cardsV2` | 純文字 fallback | JSON payload |
| `quickReplies` | `components` (buttons) | `cardsV2` chips | 文字列表 | JSON payload |
| `replyTo` | `message_reference` | `thread.threadKey` | 文字引用 | `replyTo` field |
| `threadKey` | N/A | `thread.threadKey` | N/A | N/A |
| `media` | `embeds[].image` | `cardsV2` image widget | `<media:type>` | `mediaType`+`mediaUrl` |

### Layer 3: 各平台實作

---

## 實作階段

### Phase 1: 基礎建設（#258 + #274）
**預估改動：`index.js` ~200 行**

#### 1.1 DB Schema 擴展
```sql
-- chat_messages 新增欄位
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT NULL;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS reply_to_id UUID DEFAULT NULL;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS thread_key TEXT DEFAULT NULL;
```

#### 1.2 通用 Rich Message 轉換函數
```javascript
// 新增在 index.js 的 helper 區
function richToDiscord(metadata) { ... }      // EClaw → Discord embeds/components
function richToGoogleChat(metadata) { ... }   // EClaw → Google Chat cardsV2
function richToText(metadata) { ... }         // EClaw → 純文字 fallback
```

#### 1.3 Google Chat 推送完成（#274）
- `pushToBot()` 加入 `google-chat` 分支
- `/api/client/speak` 加入 Google Chat 分支
- Google Chat cardsV2 格式轉換

#### 1.4 API 端點修改
- `POST /api/transform`: 接受 `metadata` JSONB 欄位（rich message 內容）
- `POST /api/client/speak`: 接受 `metadata` 欄位，推送時轉換
- `POST /api/entity/speak-to`: 接受 `metadata` 欄位
- `POST /api/entity/broadcast`: 接受 `metadata` 欄位
- `GET /api/chat/history`: 回傳 `metadata` 欄位

### Phase 2: Thread & Reply（#276 + #259）
**預估改動：`index.js` ~150 行, `channel-api.js` ~30 行**

#### 2.1 Google Chat Thread Reply（#276）
- `googleChatPush()` 加入 `thread.threadKey` 支援
- 儲存 thread_key 到 chat_messages
- 回覆時自動帶上 thread_key

#### 2.2 引用回覆（#259）
- `POST /api/transform`: 接受 `replyToId` 欄位
- 儲存 `reply_to_id` 到 chat_messages
- `GET /api/chat/history`: 回傳 `reply_to_id` + 被引用訊息片段
- 推送時各平台轉換（Discord: message_reference, Google Chat: thread, 其他: 文字引用）

#### 2.3 Emoji Reactions 擴展（#259）
- `message_reactions` 表的 `reaction_type` 擴展支援任意 emoji（目前只有 like/dislike）
- `POST /api/chat/react`: 新增通用 reaction endpoint
- 回傳 reaction 聚合（`{ "👍": 3, "❤️": 1 }`）

### Phase 3: Media Message（#256）
**預估改動：`channel-api.js` ~50 行, `index.js` ~30 行**

#### 3.1 Channel API Media 支援
- `POST /api/channel/message`: 正式支援 `mediaType` + `mediaUrl`
- Channel callback payload 加入 media 欄位
- Media 類型標準化：`image`, `video`, `audio`, `document`, `sticker`

#### 3.2 OpenClaw 格式對齊
- Push payload 加入 `<media:type>` 標記（與 WhatsApp 格式一致）
- Channel callback 帶入 media metadata

---

## 檔案改動清單

| 檔案 | Phase | 改動 |
|------|-------|------|
| `backend/index.js` | 1,2 | rich message 轉換函數、Google Chat pushToBot 分支、API 端點 metadata 欄位 |
| `backend/db.js` | 1 | schema migration（metadata, reply_to_id, thread_key） |
| `backend/channel-api.js` | 2,3 | media 支援、reply 轉發 |
| `backend/data/skill-templates.json` | 1 | eclaw-a2a-toolkit 更新 rich message API |
| `backend/tests/jest/google-chat.test.js` | 1 | Jest: Google Chat URL 偵測、rich card 格式 |
| `backend/tests/test-google-chat-webhook.js` | 1 | 整合: Google Chat 註冊、推送 |
| `backend/tests/jest/rich-message.test.js` | 1 | Jest: rich message 轉換函數 |
| `backend/tests/test-rich-message.js` | 2 | 整合: metadata 儲存、reply、reactions |

---

## 優先順序建議

```
Phase 1 (高優先) ─── #258 + #274
  ├── Google Chat webhook 完成（已 WIP）
  ├── 通用 rich message 模型 + DB schema
  └── 平台轉換函數

Phase 2 (中優先) ─── #276 + #259
  ├── Thread reply
  ├── 引用回覆
  └── Emoji reactions 擴展

Phase 3 (低優先) ─── #256
  └── Channel API media 完整支援
```

---

## 注意事項

1. **向後相容**：`metadata` 欄位 nullable，不影響現有訊息
2. **Gatekeeper**：rich message 的文字部分仍需通過 Gatekeeper 檢查
3. **XP 計算**：rich message 與純文字一樣計 XP
4. **Chat History**：前端（Web/Android/iOS）需要更新才能渲染 rich content，但 API 先行
5. **Button Callback**：Phase 1 只支援「展示」，不含 callback 機制（需要額外設計 webhook callback routing）
