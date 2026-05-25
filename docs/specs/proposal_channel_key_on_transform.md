# 方案 A：channel key 共存於 `/api/transform`（含 per-entity ACL）

> 提案狀態：**已實作**（Phase 1–4 完成，2026-05-12）
> 目標 repo：EClaw backend
> 相關前置：PR #2287 / #2289（senderHint）、#2290~#2294（misleading-arrow 修復系列）
> 收斂文件：`docs/specs/channel-routing-paths.md`（從本提案提煉的正式規格）

---

## 1. 動機

目前 `/api/transform` 只接受 `botSecret`（entity 範圍認證）。橋（claude-code / codex / hermes）若想用到 transform 的：

- `@`-mention auto-routing
- entity state 表演
- A2A queue / messageQueue 副作用

就必須各自儲存對應 entity 的 `botSecret`。這帶來：

1. 機密管理分散（每橋都存 N 份 botSecret）
2. 橋無法用「單一通行證」代多隻 entity 講話
3. 橋本身常常**就是**某隻 entity 的 LLM runtime（claude-code = #1/#3 的腦），但走 `/api/channel/message` 拿不到 transform 的副作用

方案 A 讓橋用既有的 `ECLAW_API_KEY` + 顯式 `entityId` claim 呼叫 transform，並用註冊時定好的 ACL 限制可扮演對象與可執行動作。

---

## 2. 名詞

| 名詞 | 說明 |
|---|---|
| **botSecret** | entity 自己的身份證；證明「我就是 entity N」 |
| **channel key** (`ECLAW_API_KEY`) | 橋的通行證；證明「我是合法的外部橋」 |
| **channel registration** | server 端對每個 channel 預先設定的紀錄（key、ACL、metadata） |
| **ACL** | per-(channel, entity) 的權限表：能否講話、改 state、觸發 A2A queue |
| **act-as** | 橋呼叫 transform 時聲明「我這次扮演哪隻 entity」 |

---

## 3. 認證模型

`/api/transform` 接受兩種互斥的認證路徑：

### 3.1 既有路徑（不變）
```
deviceId + entityId + botSecret
```
副作用全開：self-save、state 變更、A2A queue、`@`-mention auto-route。
chatSource 寫 `entity:N:CHAR`。

### 3.2 新路徑：channel key + act-as
```
Header:  X-Channel-Key: <ECLAW_API_KEY>
Body:    { "deviceId": "...", "entityId": <N>, "actAs": "channel", "message": "...", ... }
```
Server 驗證：
1. channel key 對應某筆 channel registration
2. registration 的 device 必須 = body.deviceId
3. registration 的 ACL 必須允許「扮演 entityId=N」
4. 該動作需要的權限（state / A2A queue 等）必須在 ACL 內

通過後行為**等同 botSecret 路徑**，差異只有 chatSource 加註：
```
entity:N:CHAR via:<channelName>
```

兩種認證**不能同時提供**（同時帶 botSecret + channel key → 400）。

---

## 4. Channel Registration / ACL 結構

新增 backend 資料表 `channel_registrations`（或 file-based 設定）：

```jsonc
{
  "channelName": "claude-code-eclaw-channel",
  "deviceId": "...",
  "keyHash": "<argon2 of ECLAW_API_KEY>",
  "allowedEntities": [
    {
      "entityId": 1,
      "permissions": ["speak", "state", "a2a"]   // 這橋是 #1 的腦，全開
    },
    {
      "entityId": 2,
      "permissions": ["speak"]                    // 只替 #2 轉訊息
    },
    {
      "entityId": 3,
      "permissions": ["speak", "state", "a2a"]
    }
  ],
  "createdAt": "...",
  "lastSeenAt": "..."
}
```

### 權限細項

| 權限 | 涵蓋的副作用 |
|---|---|
| `speak` | 寫入 chat history、`@`-mention auto-route、senderHint resolve、broadcast |
| `state` | `state` 參數允許帶入並更新該 entity 的 state |
| `a2a` | 寫入 messageQueue、觸發 pendingA2A，使該 entity 後續 transform 能延續對話 |

請求動作對應的權限在 server 預檢；缺權限 → 403 並回傳缺哪一項。

---

## 5. API 變更

### 5.1 `POST /api/transform`

新增可選欄位：
```jsonc
{
  "actAs": "channel",     // 必填，固定值，未來保留擴充
  // botSecret 不再必填，但若帶了則優先走 botSecret 路徑
}
```

新增 Header：
```
X-Channel-Key: <ECLAW_API_KEY>
```

Response 新增欄位：
```jsonc
{
  "auth": {
    "via": "botSecret" | "channelKey",
    "channelName": "claude-code-eclaw-channel",   // 僅 channelKey 路徑
    "grantedPermissions": ["speak", "state"]      // 實際使用的權限子集
  }
}
```

### 5.2 Channel registration 管理端點（device 範圍）

```
POST   /api/channel/register      # device owner 註冊新 channel + 取得 key
GET    /api/channel/registrations # 列出該 device 的 channel
PATCH  /api/channel/registrations/:name  # 修改 ACL
DELETE /api/channel/registrations/:name  # 撤銷 channel key
POST   /api/channel/registrations/:name/rotate-key  # 換 key
```

均要求 `deviceSecret`（device owner 範圍）。

---

## 6. 行為差異表

| 情境 | botSecret 路徑 | channelKey 路徑 |
|---|---|---|
| 寫 chat history | `entity:N:CHAR` | `entity:N:CHAR via:<channelName>` |
| `@`-mention auto-route | ✓ | ✓ |
| `state` 參數 | 接受 | ACL 有 `state` 才接受，否則 400 |
| A2A queue 副作用 | ✓ | ACL 有 `a2a` 才執行 |
| self-save chatSource | 不變（PR #2294 邏輯） | 同左，但加 `via:` 標記 |
| 速率限制軸 | per-entity | per-channel + per-entity |

---

## 7. 安全考量

1. **channel key 範圍永遠 ≤ device 範圍**：channel key 不能跨 device 扮演 entity，即使 ACL 寫了。
2. **白名單嚴格**：未在 `allowedEntities` 出現的 entity → 403，不退回 botSecret 流程。
3. **權限不可繼承**：`speak` 不自動帶 `state`，每項權限獨立。
4. **撤銷即時生效**：channel key rotate / delete 後，舊 key 立刻失效（不快取）。
5. **chatSource 標記不可省略**：channel key 路徑寫進 chat history 一律帶 `via:<channelName>`，事後 audit 看得出來。
6. **不擴展 prohibited entity**：botSecret 能做的破壞性動作（如 entity 自殺、改 publicCode）**不**透過 channelKey 路徑開放。

---

## 8. 遷移路徑

1. **Phase 1（後端）**：新增 channel_registrations 表 + 端點 + transform 雙認證分支。既有 botSecret 流程零變更。
2. **Phase 2（橋）**：claude-code / codex / hermes 開選項：preferTransformViaChannelKey。預設仍走 `/api/channel/message`。
3. **Phase 3（觀察）**：監看 chatSource `via:` 標記、ACL 拒絕事件、雙認證錯用率。
4. **Phase 4（收斂）**：橋預設改走 channelKey + transform；保留 `/api/channel/message` 給未註冊橋的 fallback。

---

## 9. 開放問題

1. **`@all` broadcast 是否需要獨立權限？**
   廣播範圍大，建議拆 `broadcast` 權限位，預設關閉。
2. **state 衝突解決**
   多橋 + bot 自己的 LLM 同時改 state → last-writer-wins？加版本號？建議先 last-writer-wins + 在 chat history 留 state-change 軌跡。
3. **channel key 在 client 端的儲存**
   橋若部署在使用者機器，key 落地形式（檔案 / keychain / env）需要 README 規範。
4. **`/api/channel/message` 何去何從**
   若 channelKey + transform 全面取代，channel/message 可降級為 thin wrapper 或廢棄。需評估外部整合者影響。
5. **跨 device 場景**
   現階段 channelKey 鎖在 deviceId；未來若有 SaaS 多 device 部署，需要設計 device-spanning channel registration。

---

## 10. 不在範圍

- 不改 botSecret 既有語意
- 不改 PR #2290~#2294 已修的 chatSource 規則
- 不引入 OAuth / JWT；channel key 維持靜態 secret + rotate 端點
- 不處理 `/api/chat/history?entityId=N` 忽略 entityId 的問題（另案）
