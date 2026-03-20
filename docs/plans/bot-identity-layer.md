# Bot Identity Layer — Implementation Plan

## Overview

將現有 `agentCard` JSONB 擴展為完整的 `identity` JSONB 欄位，統一管理 bot 的內部行為指令（role, instructions, boundaries, tone）和外部展示資訊（原 agent card 的 description, capabilities, protocols, tags）。Identity 設定後會注入到每次 push 訊息中，讓 bot 每次收到訊息時都知道自己的角色定位。

### 設計決定（已確認）
1. **Storage**: `identity` JSONB on `entities` table（取代 `agent_card`）
2. **修改權限**: Owner 和 Bot 都可以修改，無鎖定機制
3. **Push 注入**: 只在 bot **有** identity 時才注入 `[IDENTITY]` 區塊到 push 訊息
4. **Onboarding**: Bind 時 push `IDENTITY_SETUP_REQUIRED` 事件 + 可用資源列表（soul templates, rule templates, schedules, notes），bot 自行決定要設定什麼
5. **UI**: Dashboard Entity Card 展開區域顯示 identity 設定
6. **Agent Card = identity.public**: Agent card 的 CRUD 改為讀寫 `identity.public` 子物件

---

## Step 1: Database Migration — `agent_card` → `identity`

**File**: `backend/db.js`

- Add new column: `ALTER TABLE entities ADD COLUMN IF NOT EXISTS identity JSONB`
- Data migration: 把現有 `agent_card` 資料搬到 `identity.public`
  ```sql
  UPDATE entities SET identity = jsonb_build_object('public', agent_card)
  WHERE agent_card IS NOT NULL AND identity IS NULL;
  ```
- Keep `agent_card` column temporarily for backward compat (可在下個版本移除)
- Update `saveDeviceData()` — persist `identity` field
- Update `loadAllDevices()` — reconstruct `identity` from DB

**In-memory model change**:
```js
// createDefaultEntity()
identity: null,  // add this
// agentCard: null  — keep but derive from identity.public
```

---

## Step 2: Identity JSONB Schema & Validation

**File**: `backend/index.js`

新增 `validateIdentity(identity)` function:

```jsonc
{
  // — 內部行為（owner/bot 設定，不對外公開）—
  "role": "string (max 100)",           // 一句話角色
  "description": "string (max 500)",     // 詳細職責描述
  "instructions": ["string (max 200)"],  // 行為指令（max 20 條）
  "boundaries": ["string (max 200)"],    // 行為邊界（max 20 條）
  "tone": "string (max 50)",            // 語氣風格
  "language": "string (max 10)",         // 預設語言 e.g. "zh-TW"

  // — 綁定的 templates（參考用）—
  "soulTemplateId": "string",
  "ruleTemplateIds": ["string"],

  // — 外部展示（= 原 agent card，對外公開）—
  "public": {
    "description": "string (max 500, required if public set)",
    "capabilities": [{ "id", "name", "description" }],  // max 10
    "protocols": ["string"],   // max 10
    "tags": ["string"],        // max 20
    "version": "string",
    "website": "string",
    "contactEmail": "string"
  }
}
```

---

## Step 3: API Endpoints

**File**: `backend/index.js`

### 3a. New Identity CRUD

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `PUT /api/entity/identity` | deviceSecret OR botSecret | 建立/更新 identity（partial merge） |
| `GET /api/entity/identity` | deviceSecret OR botSecret | 讀取完整 identity |
| `DELETE /api/entity/identity` | deviceSecret OR botSecret | 清除 identity |

PUT 支援 **partial merge** — bot 可以只更新 `role` 而不影響其他欄位。

### 3b. Agent Card 向下相容

保留現有 3 個 agent card endpoints，但改為讀寫 `identity.public`：
- `PUT /api/entity/agent-card` → 寫入 `entity.identity.public`
- `GET /api/entity/agent-card` → 讀取 `entity.identity.public`
- `DELETE /api/entity/agent-card` → 清除 `entity.identity.public`

`GET /api/entity/lookup` 也改為從 `identity.public` 回傳 `agentCard`。

---

## Step 4: Push Message — `IDENTITY_SETUP_REQUIRED` Injection

**File**: `backend/index.js`

**核心邏輯**：OpenClaw bot 內建 identity 認知，不需要每次 push 都提醒。**唯一注入條件是 bot 尚未設定 identity**。

- **Bot 有 identity** → 不注入任何東西
- **Bot 沒有 identity** → 注入 `[IDENTITY_SETUP_REQUIRED]` 提示

### 4a. OpenClaw push（instruction-first）

在 `getMissionApiHints()` 呼叫**之後**，如果 `entity.identity` 為 null，附加：

```
[IDENTITY_SETUP_REQUIRED]
You have no identity configured yet. Set your identity (role, instructions, boundaries) via:
exec: curl -s -X PUT "https://eclawbot.com/api/entity/identity" ...
Available resources to review:
- Soul templates: exec: curl -s "https://eclawbot.com/api/soul-templates"
- Rule templates: exec: curl -s "https://eclawbot.com/api/rule-templates"
- Your dashboard: exec: curl -s "https://eclawbot.com/api/mission/dashboard?..."
[/IDENTITY_SETUP_REQUIRED]
```

新增 helper function `buildIdentitySetupHint(entity, apiBase, deviceId, entityId, botSecret)` — 只在 `entity.identity` 為 null 時回傳提示，否則回傳空字串。

### 4b. Channel push（structured JSON）

在 `eclaw_context` 中新增 `identitySetupRequired` boolean：
```json
{
  "eclaw_context": {
    "identitySetupRequired": true,
    ...existing fields...
  }
}
```

### 4c. 所有 push 路徑都要注入

搜索所有 `getMissionApiHints` 呼叫位置（~10 處），在每處後面加上 identity setup hint：
- `POST /api/client/speak` (line 4590)
- `POST /api/entity/speak-to` (lines 4836, 4879)
- Cross-device speak (line 5218)
- Broadcast (line 5898)
- Schedule push (lines 6125, 6173)
- Mission notify (lines 9935, 9958)

---

## Step 5: Bind Response — Identity Hint

**File**: `backend/index.js`

在 `POST /api/bind` 回應中新增資源列表，讓 bot 知道可以設定 identity：
```json
{
  ...existing response...,
  "identitySetupRequired": true,
  "availableResources": {
    "soulTemplates": "GET /api/soul-templates",
    "ruleTemplates": "GET /api/rule-templates",
    "schedules": "GET /api/schedules?deviceId=X&botSecret=X&entityId=Y",
    "missionDashboard": "GET /api/mission/dashboard?deviceId=X&botSecret=X&entityId=Y",
    "setIdentity": "PUT /api/entity/identity"
  }
}
```

Push 中的 `[IDENTITY_SETUP_REQUIRED]` 提示已在 Step 4 處理（每次 push 都檢查，不限於第一次）。

---

## Step 6: Socket.IO Events

**File**: `backend/index.js`

- Identity 更新時 emit `entity:identity-updated`：
  ```js
  io.to(deviceId).emit('entity:identity-updated', {
    entityId,
    identity: entity.identity
  });
  ```
- 同時 push webhook 通知給 bot（如果是 owner 改的）：
  ```json
  { "event": "IDENTITY_UPDATED", "identity": { ... } }
  ```

---

## Step 7: Web Portal UI — Dashboard Entity Card

**File**: `backend/public/portal/dashboard.html`

在現有 entity card 展開區域中，取代獨立的 "Agent Card" 按鈕，改為 **Identity 設定面板**：

```
┌─────────────────────────────────────┐
│ 🦞 Entity #0 — BotName        IDLE │
│ Avatar  Message...                  │
├─────────────────────────────────────┤
│ ▼ Identity                          │
│ ┌─────────────────────────────────┐ │
│ │ Role: [___________]             │ │
│ │ Description: [________________] │ │
│ │ Instructions: [+ Add]          │ │
│ │  • instruction 1          [×]  │ │
│ │  • instruction 2          [×]  │ │
│ │ Boundaries: [+ Add]           │ │
│ │  • boundary 1             [×]  │ │
│ │ Tone: [dropdown ▼]             │ │
│ │ Language: [dropdown ▼]         │ │
│ ├─────────────────────────────────┤ │
│ │ ▼ Public Profile (Agent Card)  │ │
│ │ Description: [________________] │ │
│ │ Capabilities: [+ Add]         │ │
│ │ Tags: [tag1] [tag2] [+ Add]   │ │
│ │ Protocols: [+ Add]            │ │
│ ├─────────────────────────────────┤ │
│ │ [Save Identity]  [Clear]       │ │
│ └─────────────────────────────────┘ │
│ [Chat] [Settings] [Unbind]          │
└─────────────────────────────────────┘
```

**實作細節**：
- 現有的 `openAgentCardDialog()` → 改為 `openIdentityPanel()`
- 不再用 modal dialog，直接在 card body 中展開（可折疊）
- 移除獨立的 Agent Card 按鈕
- Save 呼叫 `PUT /api/entity/identity`
- 監聽 `entity:identity-updated` Socket.IO 事件即時更新

---

## Step 8: Android App

**File**: `app/src/main/java/com/hank/clawlive/`

- 更新 `EntityModel.kt` — 新增 `identity` 欄位
- 更新 entity card UI — 顯示 identity 資訊（role badge, description）
- 更新 agent card 相關的 API calls 使用新 `/api/entity/identity` 端點
- 保持向下相容（server 會同時支援 agent-card endpoints）

---

## Step 9: iOS App

**File**: `ios-app/`

- 更新 entity model — 新增 `identity` 欄位
- 更新 entity card 顯示
- 向下相容同 Android

---

## Step 10: `createDefaultEntity()` & Unbind Cleanup

**File**: `backend/index.js`

- `createDefaultEntity()`: 新增 `identity: null`
- Unbind 時自動清除 identity（同現有 agentCard 行為）
- Entity trash: 保留 identity 到 trash table

---

## Step 11: Skill Template Sync

**File**: `backend/data/skill-templates.json`

在 `eclaw-a2a-toolkit` 的 `steps` 中新增 Identity API 文件：
```
PUT /api/entity/identity — Set bot identity (role, instructions, boundaries, public profile)
GET /api/entity/identity — Read identity
DELETE /api/entity/identity — Clear identity
```

---

## Step 12: Tests

### Jest unit test
- `backend/tests/jest/identity.test.js` — validation, CRUD, partial merge, backward compat

### Integration test
- `backend/tests/test-identity-layer.js` — E2E: set identity → verify push injection → update → verify notification

---

## Step 13: Card Holder & Lookup Compatibility

- `GET /api/entity/lookup` — 從 `identity.public` 回傳 `agentCard` field（保持回應格式不變）
- `autoCollectCard()` — 從 `identity.public` 取 card snapshot
- Card Holder pages — 無需改動（它們讀的是 snapshot）

---

## Migration Safety

1. **DB**: `identity` 是新欄位，不影響現有 `agent_card`
2. **API**: Agent card endpoints 改為讀寫 `identity.public`，回應格式不變
3. **Push**: Identity block 只在有 identity 時注入，不影響無 identity 的 bot
4. **Client**: 舊版 Android/iOS app 繼續用 agent-card API，照常運作

---

## Execution Order

1. DB migration (Step 1)
2. Validation + CRUD API (Steps 2-3)
3. Push injection (Step 4)
4. Bind onboarding (Step 5)
5. Socket.IO events (Step 6)
6. Web Portal UI (Step 7)
7. Backward compat (Step 13)
8. Tests (Step 12)
9. Skill template sync (Step 11)
10. `createDefaultEntity` + cleanup (Step 10)
11. Android/iOS (Steps 8-9) — 可在後續 PR
