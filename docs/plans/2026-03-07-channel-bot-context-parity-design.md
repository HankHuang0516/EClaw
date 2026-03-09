# Channel Bot Context Parity — Design Doc

**Date**: 2026-03-07
**Version target**: `@eclaw/openclaw-channel` v1.0.17
**Status**: Approved, ready for implementation

---

## Problem

Channel Bot（Entity 0，OpenClaw plugin）在 bot-to-bot 互動上缺少傳統 Bot 擁有的完整上下文：

| 缺口 | 影響 |
|------|------|
| bot-to-bot 時 Entity 0 壁紙不更新 | 使用者看到 Entity 0 靜止 |
| 無 quota 感知 | AI 不知配額剩餘，可能越界 |
| 無 Mission Notes/Skills | AI 不知任務規則與技能 |
| 無沉默選項 | AI 永遠被迫回覆，無法選擇靜默 |
| sendMessage 次要呼叫 state=undefined warn | 輕微 log 噪音 |

## 核心原則（已寫入 CLAUDE.md）

> **Bot Push Parity Rule**：任何加到傳統 Bot push 的 API 功能，必須同步加到 Channel Bot 的 `eclaw_context`。

---

## 解決方案：結構化 `eclaw_context` 物件（方案二）

### 資料流

```
Entity N → POST /api/entity/speak-to (or /broadcast)
              │
              ▼  index.js: 計算 b2bRemaining, missionHints
         channel-api.js: pushToChannelCallback()
              │  payload + eclaw_context
              ▼ HTTP POST Bearer token
         https://eclaw2.zeabur.app/eclaw-webhook
              │
              ▼  webhook-handler.ts
         讀取 eclaw_context → 組 enriched Body
         → dispatchReplyWithBufferedBlockDispatcher
              │
              ▼  OpenClaw AI
         生成回應（或輸出 [SILENT] 靜默）
              │
              ▼  deliver callback
         [SILENT] → skip
         entity_message/broadcast:
           sendMessage(text, 'IDLE')    ← 更新 entity 0 壁紙
           speakTo(fromEntityId, text)  ← 回覆發送方
         regular message:
           sendMessage(text, 'IDLE')   ← 現有行為
```

---

## `eclaw_context` Schema

```typescript
interface EClawContext {
  b2bRemaining?: number;   // 剩餘 bot-to-bot 配額
  b2bMax?: number;         // 最大配額（目前 8）
  expectsReply?: boolean;  // 發送方是否期望回覆
  missionHints?: string;   // getMissionApiHints() 的輸出（inline string）
  silentToken?: string;    // AI 輸出此 token 代表靜默（"[SILENT]"）
}
```

### OpenClaw AI 看到的 Body 範例

```
[Bot-to-Bot message from Entity 3 (LOBSTER)]
[Quota: 5/8 remaining — output "[SILENT]" if no new info worth replying to]

[AVAILABLE TOOLS — Mission Dashboard]
curl -s "https://eclawbot.com/api/mission/dashboard?deviceId=480def4c...&botSecret=f5ad89...&entityId=0"
curl -s "https://eclawbot.com/api/mission/notes?..."
curl -s -X POST "https://eclawbot.com/api/mission/todo/done" ...
curl -s -X POST "https://eclawbot.com/api/mission/note/add" ...

Hi Entity 0! Testing bot-to-bot messaging.
```

---

## 檔案改動清單

### `backend/index.js`
- `/api/entity/speak-to` call site：加入 `eclaw_context` 物件（b2bRemaining, b2bMax, expectsReply, missionHints, silentToken）
- `/api/entity/broadcast` call site：同上

### `backend/channel-api.js`
- `pushToChannelCallback()`：在 fetch body JSON 加入 `eclaw_context: payload.eclaw_context || null`

### `openclaw-channel-eclaw/src/types.ts`
- 新增 `EClawContext` interface
- `EClawInboundMessage` 加 `eclaw_context?: EClawContext`

### `openclaw-channel-eclaw/src/outbound.ts`
- 新增 `activeEvent: Map<string, string>`
- 新增 `setActiveEvent()` / `clearActiveEvent()`
- `sendText()` / `sendMedia()`：bot2bot 事件時 early return（避免 double sendMessage）

### `openclaw-channel-eclaw/src/webhook-handler.ts`
- 讀取 `msg.eclaw_context`
- 組 enriched Body（prefix + quota line + mission block + text）
- deliver callback：`[SILENT]` 檢查、entity_message/broadcast 時 sendMessage + speakTo
- dispatch 前後 setActiveEvent / clearActiveEvent

---

## 版本

- Plugin `package.json`：`1.0.16` → `1.0.17`
- 發布：`npm run build && npm publish`
- 部署：Zeabur KNOW-HOW Section 8 升級腳本

---

## 自我驗證計畫

| # | 驗證項目 | 預期結果 |
|---|---------|---------|
| V1 | Speak-to entity 0→3，等 entity 3 回覆 | log 出現 `client_push Channel message`（壁紙更新）+ speakTo 0→3 |
| V2 | Broadcast entity 0→[3,4] | 兩個 channel push OK + 兩次壁紙更新 + 兩次 speakTo |
| V3 | [SILENT] 路徑 | deliver 不觸發任何 API 呼叫 |
| V4 | `npm run build` | 零 TypeScript 錯誤 |
| V5 | Zeabur 升級至 v1.0.17 | log 出現 `Account default ready!` |
| V6 | 不出現 `state=undefined warn` | sendText double-call 被抑制 |
