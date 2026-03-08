# OpenClaw Channel Plugin — Know-How

> 本文件記錄開發 `@eclaw/openclaw-channel` 過程中踩過的坑與正確做法。

---

## 1. Plugin ID 命名規則

**問題**: 啟動時出現 `plugin id mismatch (manifest uses "eclaw", entry hints "openclaw-channel")`

**原因**: OpenClaw 的 `discovery.js` 從 npm package name 自動推導 `idHint`：
- package name: `@eclaw/openclaw-channel`
- 去除 scope (`@eclaw/`) 後 → `idHint = "openclaw-channel"`

**正確做法**:
- `openclaw.plugin.json` 的 `"id"` 必須與 npm package 推導出的 idHint **完全一致**
- `src/index.ts` 裡的 `plugin.id` 也必須相同
- Channel id（如 `"eclaw"`）是獨立的，與 plugin id 不同

```json
// openclaw.plugin.json — 正確
{ "id": "openclaw-channel", "channels": ["eclaw"], ... }
```

```typescript
// src/index.ts — 正確
const plugin = { id: 'openclaw-channel', ... };
```

---

## 2. dispatchReplyWithBufferedBlockDispatcher 呼叫方式

**問題**: `TypeError: Cannot destructure property 'typingCallbacks' of 'options' as it is undefined`

**原因**: 直接把 ctx 傳進去，但函數簽名需要一個 options 物件。

**錯誤寫法**:
```typescript
await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher(ctxPayload);
```

**正確寫法**:
```typescript
await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
  ctx: ctxPayload,
  cfg,           // 完整的 openclaw config（從 ctx.cfg 傳入）
  dispatcherOptions: {
    deliver: async (payload: any) => {
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (text) await client.sendMessage(text, 'IDLE');
    },
    onError: (err: unknown) => {
      console.error('[E-Claw] Reply delivery error:', err);
    },
  },
});
```

**關鍵**: `cfg` 是從 `startAccount(ctx)` 的 `ctx.cfg` 取得，必須一路傳到 `createWebhookHandler`。

---

## 3. Inbound Context 格式（PascalCase）

OpenClaw 使用 PascalCase 命名慣例（與 Telegram/LINE/WhatsApp channel 一致）。

**必填欄位**:
```typescript
const inboundCtx = {
  Surface: 'eclaw',
  Provider: 'eclaw',
  OriginatingChannel: 'eclaw',
  AccountId: accountId,
  From: msg.from,             // 發送者 ID
  To: conversationId,         // 對話 ID
  OriginatingTo: msg.from,
  SessionKey: conversationId, // Session 唯一鍵
  Body: msg.text || '',
  RawBody: msg.text || '',
  CommandBody: msg.text || '',
  ChatType: 'direct',
};
const ctxPayload = rt.channel.reply.finalizeInboundContext(inboundCtx);
```

**錯誤**（camelCase 不行）: `channelId`, `text`, `senderId`

---

## 4. Webhook 整合方式：使用 api.registerHttpRoute()

**不需要額外 port**，直接掛在 OpenClaw 主 gateway HTTP server 上：

```typescript
// src/index.ts
api.registerHttpRoute({
  path: '/eclaw-webhook',
  handler: async (req: any, res: any) => {
    await parseBody(req);
    await dispatchWebhook(req, res);
  },
});
```

**Token 路由**（`webhook-registry.ts`）：
- 每個 account 啟動時產生一個隨機 `callbackToken`（32 bytes hex）
- Token 作為 `Bearer` 傳給 E-Claw，E-Claw 推送時帶回
- Registry Map：`token → { accountId, handler }`
- 支援多 account 同時運作

---

## 5. In-Process Restart 的陷阱

**現象**: Container 重啟成功（顯示 `Account default ready!`），但 OpenClaw config 改變後觸發 SIGUSR1 in-process restart，新 process 驗證 config 時報 `channels.eclaw: unknown channel id: eclaw`

**原因**: In-process restart 的 config 驗證在插件載入**之前**執行，此時 `eclaw` channel 尚未被 plugin 提供。

**解法**：
1. 在 config 加入 `plugins.allow: ["openclaw-channel"]`（讓 OpenClaw 信任此插件）
2. 移除 stale 的 `plugins.installs.eclaw`（舊 id 殘留）
3. 移除 `plugins.entries.eclaw`（如存在）
4. 做**完整容器重啟**（不是 SIGUSR1），讓插件在 config 驗證前正確載入

---

## 6. Zeabur 終端的 Bash 陷阱

**現象**: 在 Zeabur 容器終端執行多行 bash 時，自動補全（tab/autocomplete）可能把 `openclaw configure` 文字插入 `node -e '...'` 命令中間，導致 SyntaxError。

**解法**: 不要直接 inline 執行，改用 temp 檔案：

```bash
cat > /tmp/fix-cfg.js << 'EOF'
var fs = require('fs');
var p = '/home/node/.openclaw/openclaw.json';
var cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
// ... 修改邏輯 ...
fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
console.log('Done!');
EOF

node /tmp/fix-cfg.js
```

---

## 7. Config 修復腳本（完整版）

當容器出現 `unknown channel id` 或 plugin id mismatch 時，執行以下修復：

```bash
cat > /tmp/fix-cfg.js << 'EOF'
var fs = require('fs');
var p = '/home/node/.openclaw/openclaw.json';
var cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
// 清除舊 id 殘留
if (cfg.plugins && cfg.plugins.installs) {
  delete cfg.plugins.installs.eclaw;
  delete cfg.plugins.installs['openclaw-channel'];
}
if (cfg.plugins && cfg.plugins.entries) {
  delete cfg.plugins.entries.eclaw;
}
// 加入信任白名單
cfg.plugins = cfg.plugins || {};
cfg.plugins.allow = cfg.plugins.allow || [];
if (!cfg.plugins.allow.includes('openclaw-channel')) {
  cfg.plugins.allow.push('openclaw-channel');
}
fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
console.log('Done!');
console.log(JSON.stringify(cfg.plugins, null, 2));
EOF

node /tmp/fix-cfg.js
```

執行後確認輸出無誤，再從 Zeabur Dashboard 做**完整服務重啟**。

---

## 8. 升級插件版本的完整流程（重要）

**問題**：直接執行 `openclaw plugins install @eclaw/openclaw-channel@X.Y.Z` 會出現以下任一錯誤：
- `plugin already exists: delete it first`（舊版本還在）
- `Config invalid: channels.eclaw unknown channel id`（刪了插件後 config 驗證失敗）

**根本原因**：OpenClaw 在安裝插件前會驗證 config，但 config 裡的 `channels.eclaw` 需要 plugin 提供，形成雞蛋問題。

**正確升級流程**（一個腳本搞定）：

```bash
cat > /tmp/full-setup.js << 'EOF'
var fs = require('fs');
var { execSync } = require('child_process');
var p = '/home/node/.openclaw/openclaw.json';
var cfg = JSON.parse(fs.readFileSync(p, 'utf8'));

// 1. 備份 eclaw channel 設定
var eclawChannelCfg = cfg.channels && cfg.channels.eclaw;
console.log('Saved eclaw channel config:', JSON.stringify(eclawChannelCfg));

// 2. 清除會讓驗證失敗的條目
if (cfg.channels) delete cfg.channels.eclaw;
if (cfg.plugins) {
  if (cfg.plugins.entries) delete cfg.plugins.entries['openclaw-channel'];
  if (cfg.plugins.allow) cfg.plugins.allow = cfg.plugins.allow.filter(x => x !== 'openclaw-channel');
  if (cfg.plugins.installs) delete cfg.plugins.installs['openclaw-channel'];
}
fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
console.log('Config cleaned');

// 3. 刪除舊插件
execSync('rm -rf /home/node/.openclaw/extensions/openclaw-channel');
console.log('Old plugin deleted');

// 4. 安裝新插件（版本號請更新）
console.log('Installing...');
try {
  var out = execSync('openclaw plugins install @eclaw/openclaw-channel@1.0.13 2>&1', { encoding: 'utf8' });
  console.log(out);
} catch(e) {
  console.log(e.stdout || e.message);
}

// 5. 還原 eclaw channel 設定
cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
if (eclawChannelCfg) {
  cfg.channels = cfg.channels || {};
  cfg.channels.eclaw = eclawChannelCfg;
}
cfg.plugins = cfg.plugins || {};
cfg.plugins.allow = cfg.plugins.allow || [];
if (!cfg.plugins.allow.includes('openclaw-channel')) cfg.plugins.allow.push('openclaw-channel');
fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
console.log('Done! channels.eclaw restored.');
console.log('Final plugins:', JSON.stringify(cfg.plugins, null, 2));
EOF

node /tmp/full-setup.js
```

執行完後確認輸出，再從 **Zeabur Dashboard 重啟服務**（完整容器重啟）。

---

## 9. 版本歷史對應問題

| 版本 | 變更 |
|------|------|
| v1.0.9 | 初始版本 |
| v1.0.10 | 改用 `api.registerHttpRoute()` 取代獨立 HTTP server |
| v1.0.11 | 修正 `dispatchReplyWithBufferedBlockDispatcher` 呼叫方式 + PascalCase ctx |
| v1.0.12 | 修正 plugin id：`"eclaw"` → `"openclaw-channel"` |
| v1.0.13 | 修正 entity 已綁定時不重複呼叫 `bindEntity`（避免 "Entity already bound" 錯誤） |
| v1.0.14 | 永遠呼叫 `bindEntity()`（/channel/bind 對同 account 是冪等的） |
| v1.0.15 | entityId 改為可選；後端自動選空位；全滿時回傳 entity list |
| v1.0.16 | Bot2bot + Broadcast 支援：新增 `speakTo()` + `broadcastToAll()`；webhook-handler 依 event 類型路由 deliver；修正 `?? 0` entityId fallback |
| v1.0.17 | Channel Bot Context Parity：inbound payload 加入 `eclaw_context`（expectsReply / silentToken / missionHints / b2bRemaining / b2bMax）；webhook-handler 讀取並注入 Bot2bot quota 資訊；gateway 加入 auto-reconnect with exponential backoff |
| v1.0.18 | README 大幅更新：補充 Inbound Message Structure、eclaw_context、System Events、Silent Mode 等章節 |

---

## 10. Bot2Bot / Broadcast 事件路由（v1.0.16）

**問題**：entity 收到 `entity_message`（bot-to-bot）或 `broadcast` 事件後，原本的 `deliver` 只呼叫 `sendMessage()`，只更新自身壁紙狀態，沒有回應發送方。

**正確流程（v1.0.16 後）**：

| 事件類型 | deliver 路由 | 效果 |
|----------|------------|------|
| `message` | `sendMessage()` → `/api/channel/message` | 回應人類用戶 |
| `entity_message` | `speakTo(fromEntityId)` → `/api/entity/speak-to` | 回應對方 entity |
| `broadcast` | `speakTo(fromEntityId)` → `/api/entity/speak-to` | 私信回應廣播者 |

**Body 前綴注入（讓 AI 知道上下文）**：
- entity_message：`[Bot-to-Bot message from Entity X (CHARACTER)]`
- broadcast：`[Broadcast from Entity X (CHARACTER)]`

**避免重複記錄**：bot2bot 和 broadcast 只呼叫 `speakTo()`，不額外呼叫 `sendMessage()`（避免 chat history 重複）。

---

---

## 11. eclaw_context — Channel Bot Context Parity（v1.0.17）

**背景**：傳統 webhook bot 每次 push 都帶有指令前綴（mission hints、quota 資訊等），但 channel bot 收到的 inbound payload 原本沒有這些。v1.0.17 後 server 會在每次 push 中注入 `eclaw_context`。

**Inbound payload 新增欄位**：
```typescript
interface EClawContext {
  expectsReply: boolean;   // false → bot 應輸出 silentToken 保持沉默
  silentToken: string;     // 通常是 "[SILENT]"，plugin 遇到此回覆時跳過所有 API 呼叫
  missionHints: string;    // 任務 API 參考（同 traditional bot 的 getMissionApiHints）
  b2bRemaining?: number;   // bot2bot 剩餘回覆配額（每次人類訊息後重置）
  b2bMax?: number;         // 最大配額（目前 8）
}
```

**plugin 如何使用**（`webhook-handler.ts`）：
1. 讀取 `msg.eclaw_context?.silentToken ?? '[SILENT]'`
2. Bot2bot / broadcast 時，把 quota 資訊注入 body 前綴讓 AI 知道是否該回
3. `deliver` 函數收到 AI 回覆後，若 `text === silentToken` 則完全跳過（不呼叫 sendMessage 也不呼叫 speakTo）

**`expectsReply: false` 的觸發情境**：
- System events：`ENTITY_MOVED`、`NAME_CHANGED`、排程訊息（如需靜默）
- Bot2bot quota 超限

---

## 12. Auto-Reconnect with Exponential Backoff（v1.0.17）

**問題**：Gateway WebSocket 斷線後，plugin 沒有重連機制，bot 就永遠下線。

**解法**（`gateway.ts`）：
```typescript
const delay = Math.min(1000 * Math.pow(2, attempt), 30000); // 1s, 2s, 4s, ..., 30s
setTimeout(() => connect(attempt + 1), delay);
```

- 第一次斷線：1 秒後重連
- 每次失敗指數倍增，最大上限 30 秒
- 成功連線後 attempt reset 為 0

**注意**：重連時需要重新呼叫 `startAccount()` 的整個流程（provision → register callback → bind），不能只重建 WS。

---

## 13. Bot Push Parity Rule（後端 index.js）

**這是後端的規則，但開發 channel 功能時必須了解**：

任何後端新增的「傳統 bot push」功能，都必須同步支援 channel bot（via `channelModule.pushToChannelCallback`）。

已知的 channel push 觸發點（v1.0.17 後全部驗證通過）：
- ✅ 一般訊息 / broadcast
- ✅ bot-to-bot speak-to
- ✅ 排程訊息（executeScheduledMessage）
- ✅ Entity Slot Reorder → `[SYSTEM:ENTITY_MOVED]`
- ✅ Entity 改名 → `[SYSTEM:NAME_CHANGED]`（立即推送，不走 pendingRename queue）
- ✅ Mission 通知（TODO / SKILL / RULE / SOUL）

**重要**：wiring `missionModule.setPushToChannelCallback(channelModule...)` 必須在 `channelModule` 宣告之後，否則 JavaScript TDZ（Temporal Dead Zone）ReferenceError 會讓 Railway rollback。

---

## 14. Community Plugin 提交流程

**官方不接受把 channel plugin 合入主 repo**（WeCom PR #13228、Infoflow PR #13095 都被關閉）。

**正確路徑**：
1. 維護獨立 repo（`https://github.com/HankHuang0516/openclaw-channel-eclaw`）
2. 發布到 npm（`@eclaw/openclaw-channel`）
3. 開 PR 到 `openclaw/openclaw`，只修改 `docs/plugins/community.md`，加入條目：
   ```markdown
   - **E-Claw** — short description
     npm: `@eclaw/openclaw-channel`
     repo: `https://github.com/HankHuang0516/openclaw-channel-eclaw`
     install: `openclaw plugins install @eclaw/openclaw-channel`
   ```
4. PR [#38842](https://github.com/openclaw/openclaw/pull/38842)（已開，待 maintainer 審核）

---

## 15. 偵錯時有用的指令

```bash
# 查看 openclaw config 現狀
cat /home/node/.openclaw/openclaw.json | python3 -m json.tool

# 查看已安裝插件
openclaw plugins list

# 查看 gateway 日誌（在 Zeabur 容器外）
# → 使用 Zeabur Dashboard > Logs

# 查看 E-Claw server logs
curl -s "https://eclawbot.com/api/logs?deviceId=DEVICE_ID&deviceSecret=DEVICE_SECRET&limit=50"
```
