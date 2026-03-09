# Channel Bot Context Parity v1.0.17 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 讓 Channel Bot（OpenClaw plugin）在 bot-to-bot 互動中獲得與傳統 Bot 同等的 API 上下文（quota 感知、Mission Notes、壁紙更新、[SILENT] 靜默選項），消除 state=undefined warn。

**Architecture:** Server 在 channel push payload 裡附加 `eclaw_context` 結構化物件；Plugin 讀取後組成 enriched Body 給 OpenClaw AI；deliver callback 依事件類型路由（entity_message/broadcast 同時呼叫 sendMessage 更新壁紙 + speakTo 回覆），並支援 [SILENT] token 靜默。

**Tech Stack:** Node.js（backend），TypeScript（plugin），`@eclaw/openclaw-channel` npm package，Zeabur 容器部署。

---

## Task 1：Plugin — 新增 `EClawContext` 型別

**Files:**
- Modify: `C:\Hank\Other\project\openclaw-channel-eclaw\src\types.ts:12-29`

**Step 1：在 `EClawInboundMessage` 之前插入新 interface**

在 `types.ts` 第 12 行（`/** Inbound message...` 之前）插入：

```typescript
/** Context block injected by E-Claw server for Channel Bot parity with Traditional Bot */
export interface EClawContext {
  b2bRemaining?: number;   // Remaining bot-to-bot quota for receiving entity
  b2bMax?: number;         // Max quota (currently 8)
  expectsReply?: boolean;  // Whether sender expects a reply
  missionHints?: string;   // Output of getMissionApiHints() for receiving entity
  silentToken?: string;    // AI outputs this exact string to stay silent (e.g. "[SILENT]")
}
```

**Step 2：在 `EClawInboundMessage` interface 末尾加一個欄位**

在 `fromPublicCode?: string;` 之後加：

```typescript
  eclaw_context?: EClawContext;
```

**Step 3：確認型別正確**

```bash
cd C:\Hank\Other\project\openclaw-channel-eclaw
npm run lint
```
Expected: 零錯誤

---

## Task 2：Plugin — `outbound.ts` 事件追蹤（抑制 double sendMessage）

**Files:**
- Modify: `C:\Hank\Other\project\openclaw-channel-eclaw\src\outbound.ts`

**Step 1：在 `clients` Map 下方加入 activeEvent Map 與 export 函式**

在 `const clients = new Map<string, EClawClient>();` 之後加：

```typescript
/** Track current inbound event type per account to suppress duplicate sendMessage calls */
const activeEvent = new Map<string, string>();

export function setActiveEvent(accountId: string, event: string): void {
  activeEvent.set(accountId, event);
}

export function clearActiveEvent(accountId: string): void {
  activeEvent.delete(accountId);
}
```

**Step 2：在 `sendText()` 函式開頭加 early return**

在 `const client = clients.get(accountId);` 之前加：

```typescript
  // Suppress duplicate delivery for bot-to-bot events — webhook-handler's deliver handles these
  const event = activeEvent.get(accountId) ?? 'message';
  if (event === 'entity_message' || event === 'broadcast') {
    return { channel: 'eclaw', messageId: '', chatId: '' };
  }
```

**Step 3：在 `sendMedia()` 函式開頭加同樣的 early return**

緊接 `const accountId: string = ctx.accountId ?? 'default';` 後加相同內容。

**Step 4：確認型別**

```bash
npm run lint
```
Expected: 零錯誤

---

## Task 3：Plugin — `webhook-handler.ts` 核心改動

**Files:**
- Modify: `C:\Hank\Other\project\openclaw-channel-eclaw\src\webhook-handler.ts`

**Step 1：在 import 區塊加入新 import**

在既有 import 末尾加：

```typescript
import { setActiveEvent, clearActiveEvent } from './outbound.js';
```

**Step 2：讀取 `eclaw_context` 並構建 enriched Body**

找到現有的 `// Capture event context` 區塊（約第 44 行），在它之後加：

```typescript
      // Read server-injected context block (Channel Bot parity)
      const eclawCtx = msg.eclaw_context;
      const silentToken = eclawCtx?.silentToken ?? '[SILENT]';
```

**Step 3：替換 Body 組建邏輯**

把現有的整段 `// Build body — enrich with event context...` 區塊替換為：

```typescript
      // Build body — enrich with event context for bot-to-bot and broadcast
      let body = msg.text || '';
      if ((event === 'entity_message' || event === 'broadcast') && fromEntityId !== undefined) {
        const senderLabel = fromCharacter
          ? `Entity ${fromEntityId} (${fromCharacter})`
          : `Entity ${fromEntityId}`;
        const eventPrefix = event === 'broadcast'
          ? `[Broadcast from ${senderLabel}]`
          : `[Bot-to-Bot message from ${senderLabel}]`;

        const quotaLine = eclawCtx?.b2bRemaining !== undefined
          ? `[Quota: ${eclawCtx.b2bRemaining}/${eclawCtx.b2bMax ?? 8} remaining — output "${silentToken}" if no new info worth replying to]`
          : '';

        const missionBlock = eclawCtx?.missionHints ?? '';

        body = [eventPrefix, quotaLine, missionBlock, msg.text || '']
          .filter(Boolean)
          .join('\n');
      }
```

**Step 4：在 `dispatchReplyWithBufferedBlockDispatcher` 前後加 setActiveEvent / clearActiveEvent**

```typescript
      // Track event type so outbound.sendText() can suppress duplicate delivery
      setActiveEvent(accountId, event);
      try {
        await rt.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg,
          dispatcherOptions: {
            // ... (deliver callback, onError — 見下一步)
          },
        });
      } finally {
        clearActiveEvent(accountId);
      }
```

**Step 5：替換 deliver callback**

```typescript
            deliver: async (payload: any) => {
              if (!client) return;
              const text = typeof payload.text === 'string' ? payload.text.trim() : '';

              // [SILENT] token or empty → skip all API calls
              if (!text || text === silentToken) return;

              if ((event === 'entity_message' || event === 'broadcast') && fromEntityId !== undefined) {
                // Bot-to-bot / broadcast: update own wallpaper AND reply to sender
                await client.sendMessage(text, 'IDLE');
                await client.speakTo(fromEntityId, text, false);
              } else {
                // Normal human message: reply via channel message
                if (text) {
                  await client.sendMessage(text, 'IDLE');
                } else if (payload.mediaUrl) {
                  const rawType = typeof payload.mediaType === 'string' ? payload.mediaType : '';
                  const mediaType = rawType === 'image' ? 'photo'
                    : rawType === 'audio' ? 'voice'
                    : rawType === 'video' ? 'video'
                    : 'file';
                  await client.sendMessage('', 'IDLE', mediaType, payload.mediaUrl);
                }
              }
            },
```

**Step 6：Build 確認**

```bash
cd C:\Hank\Other\project\openclaw-channel-eclaw
npm run build
```
Expected: 零 TypeScript 錯誤，`dist/` 更新

---

## Task 4：Backend — `channel-api.js` passthrough

**Files:**
- Modify: `C:\Hank\Other\project\realbot\backend\channel-api.js:591-607`

**Step 1：在 fetch body JSON 加入 `eclaw_context` 欄位**

找到 `fromPublicCode: payload.fromPublicCode` 這行，在它之後加：

```javascript
                    eclaw_context: payload.eclaw_context || null,
```

完整 JSON body 末尾結果：
```javascript
                body: JSON.stringify({
                    event: payload.event || 'message',
                    deviceId,
                    entityId,
                    conversationId: `${deviceId}:${entityId}`,
                    from: payload.from || 'client',
                    text: payload.text || '',
                    mediaType: payload.mediaType || null,
                    mediaUrl: payload.mediaUrl || null,
                    backupUrl: payload.backupUrl || null,
                    timestamp: Date.now(),
                    isBroadcast: payload.isBroadcast || false,
                    broadcastRecipients: payload.broadcastRecipients || null,
                    fromEntityId: payload.fromEntityId,
                    fromCharacter: payload.fromCharacter,
                    fromPublicCode: payload.fromPublicCode,
                    eclaw_context: payload.eclaw_context || null,   // ← 新增
                }),
```

---

## Task 5：Backend — `index.js` speak-to call site

**Files:**
- Modify: `C:\Hank\Other\project\realbot\backend\index.js:3169-3180`

**Step 1：在 channel push call site 的 payload 加入 `eclaw_context`**

找到現有的 channel push block（isChannelBound，約第 3171 行），把 payload 從：

```javascript
        channelModule.pushToChannelCallback(deviceId, toId, {
            event: 'entity_message',
            from: sourceLabel,
            text: speakToText,
            mediaType: mediaType || null,
            mediaUrl: mediaUrl || null,
            backupUrl: mediaType === 'photo' ? getBackupUrl(mediaUrl) : null,
            fromEntityId: fromId,
            fromCharacter: fromEntity.character
        }, toEntity.channelAccountId)
```

改為：

```javascript
        channelModule.pushToChannelCallback(deviceId, toId, {
            event: 'entity_message',
            from: sourceLabel,
            text: speakToText,
            mediaType: mediaType || null,
            mediaUrl: mediaUrl || null,
            backupUrl: mediaType === 'photo' ? getBackupUrl(mediaUrl) : null,
            fromEntityId: fromId,
            fromCharacter: fromEntity.character,
            eclaw_context: {
                b2bRemaining: getBotToBotRemaining(deviceId, toId),
                b2bMax: BOT2BOT_MAX_MESSAGES,
                expectsReply: expectsReply,
                missionHints: getMissionApiHints('https://eclawbot.com', deviceId, toId, toEntity.botSecret),
                silentToken: '[SILENT]'
            }
        }, toEntity.channelAccountId)
```

---

## Task 6：Backend — `index.js` broadcast call site

**Files:**
- Modify: `C:\Hank\Other\project\realbot\backend\index.js:3924-3935`

**Step 1：在 broadcast channel push 的 payload 加入 `eclaw_context`**

找到 broadcast 的 channel push block（isChannelBoundBcast，約第 3924 行），把 payload 從：

```javascript
            channelModule.pushToChannelCallback(deviceId, toId, {
                event: 'broadcast',
                from: sourceLabel,
                text: broadcastText,
                mediaType: mediaType || null,
                mediaUrl: mediaUrl || null,
                backupUrl: mediaType === 'photo' ? getBackupUrl(mediaUrl) : null,
                isBroadcast: true,
                broadcastRecipients: targetIds,
                fromEntityId: fromId,
                fromCharacter: fromEntity.character
            }, toEntity.channelAccountId)
```

改為：

```javascript
            channelModule.pushToChannelCallback(deviceId, toId, {
                event: 'broadcast',
                from: sourceLabel,
                text: broadcastText,
                mediaType: mediaType || null,
                mediaUrl: mediaUrl || null,
                backupUrl: mediaType === 'photo' ? getBackupUrl(mediaUrl) : null,
                isBroadcast: true,
                broadcastRecipients: targetIds,
                fromEntityId: fromId,
                fromCharacter: fromEntity.character,
                eclaw_context: {
                    b2bRemaining: getBotToBotRemaining(deviceId, toId),
                    b2bMax: BOT2BOT_MAX_MESSAGES,
                    expectsReply: expectsReplyBcast,
                    missionHints: getMissionApiHints('https://eclawbot.com', deviceId, toId, toEntity.botSecret),
                    silentToken: '[SILENT]'
                }
            }, toEntity.channelAccountId)
```

---

## Task 7：Commit backend 改動

```bash
cd C:\Hank\Other\project\realbot
git add backend/index.js backend/channel-api.js
git commit -m "feat(channel): inject eclaw_context into channel bot push payloads

- speak-to: adds b2bRemaining, missionHints, expectsReply, silentToken
- broadcast: same fields for each target channel entity
- channel-api.js: passthrough eclaw_context in pushToChannelCallback

Part of Channel Bot Context Parity (v1.0.17)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
git push
```

---

## Task 8：Plugin — Bump 版本、Build、Publish

**Files:**
- Modify: `C:\Hank\Other\project\openclaw-channel-eclaw\package.json`

**Step 1：版本從 1.0.16 → 1.0.17**

```bash
cd C:\Hank\Other\project\openclaw-channel-eclaw
npm version patch
```

**Step 2：Build**

```bash
npm run build
```
Expected: 零錯誤

**Step 3：Publish**

```bash
npm publish
```
Expected: `+ @eclaw/openclaw-channel@1.0.17`

---

## Task 9：升級 Zeabur 容器至 v1.0.17

在 Zeabur Terminal 執行：

```bash
cat > /tmp/full-setup.js << 'EOF'
var fs = require('fs');
var { execSync } = require('child_process');
var p = '/home/node/.openclaw/openclaw.json';
var cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
var eclawChannelCfg = cfg.channels && cfg.channels.eclaw;
console.log('Saved eclaw channel config:', JSON.stringify(eclawChannelCfg));
if (cfg.channels) delete cfg.channels.eclaw;
if (cfg.plugins) {
  if (cfg.plugins.entries) delete cfg.plugins.entries['openclaw-channel'];
  if (cfg.plugins.allow) cfg.plugins.allow = cfg.plugins.allow.filter(x => x !== 'openclaw-channel');
  if (cfg.plugins.installs) delete cfg.plugins.installs['openclaw-channel'];
}
fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
execSync('rm -rf /home/node/.openclaw/extensions/openclaw-channel');
console.log('Installing v1.0.17...');
try {
  var out = execSync('openclaw plugins install @eclaw/openclaw-channel@1.0.17 2>&1', { encoding: 'utf8' });
  console.log(out);
} catch(e) { console.log(e.stdout || e.message); }
cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
if (eclawChannelCfg) { cfg.channels = cfg.channels || {}; cfg.channels.eclaw = eclawChannelCfg; }
cfg.plugins = cfg.plugins || {};
cfg.plugins.allow = cfg.plugins.allow || [];
if (!cfg.plugins.allow.includes('openclaw-channel')) cfg.plugins.allow.push('openclaw-channel');
fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
console.log('Done!');
EOF
node /tmp/full-setup.js
```

再從 **Zeabur Dashboard 完整重啟服務**。

Expected log: `[E-Claw] Account default ready!`

---

## Task 10：自我驗證 V1–V6

### V1 — Speak-to 壁紙更新

```bash
node -e "
const https = require('https');
const d = JSON.stringify({
  deviceId:'480def4c-2183-4d8e-afd0-b131ae89adcc',
  fromEntityId:0, toEntityId:3,
  botSecret:'f5ad89b82675def1f0e3b222e793c2ac',
  text:'V1.0.17 test — bot-to-bot speak-to with context', expects_reply:true
});
const r = https.request({hostname:'eclawbot.com',path:'/api/entity/speak-to',method:'POST',
  headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(d)}},
  res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>console.log(JSON.parse(b)));});
r.write(d);r.end();
"
```

等 15 秒後查 log：

```bash
node -e "
const https = require('https');
let b='';
https.get('https://eclawbot.com/api/logs?deviceId=2a0ad04d-9107-4250-b8be-ecd565983fb2&deviceSecret=77c91d51-7677-4c1f-aece-fe26fd651d6d-cfff4f91-6883-4450-b17d-1ae1cf4085b4&filterDevice=480def4c-2183-4d8e-afd0-b131ae89adcc&limit=50',
r=>{r.on('data',d=>b+=d);r.on('end',()=>{
  JSON.parse(b).logs.filter(l=>l.category!=='entity_poll').forEach(l=>
    console.log(l.created_at.slice(11,19),l.level.toUpperCase(),'['+l.category+']','e'+l.entity_id,l.message.slice(0,100)));
});});
"
```

**預期新增 log（相較 v1.0.16）：**
- `INFO [client_push] e0 Channel message from Entity 0` ← 壁紙更新 ✅ **新增**
- 不再出現 `WARN [client_push] enull /channel/message missing required fields` ✅ **修正**

### V2 — Broadcast 壁紙更新 × 2

```bash
node -e "
const https = require('https');
const d = JSON.stringify({
  deviceId:'480def4c-2183-4d8e-afd0-b131ae89adcc',
  fromEntityId:0, botSecret:'f5ad89b82675def1f0e3b222e793c2ac',
  text:'V1.0.17 broadcast test — context parity', expects_reply:true
});
const r = https.request({hostname:'eclawbot.com',path:'/api/entity/broadcast',method:'POST',
  headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(d)}},
  res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>console.log(JSON.parse(b)));});
r.write(d);r.end();
"
```

等 15 秒後查 log。預期：entity 0 壁紙更新出現 2 次（entity 3 + entity 4 各回覆一次）。

### V3 — [SILENT] 路徑

人工驗證：從 entity 3 發一個 speak-to 給 entity 0，內容為一段讓 AI 覺得不需回覆的重複訊息，觀察 log 是否出現 entity 0 的 speakTo / channel message。

若無法控制 AI 輸出，可在驗證完 V1/V2 後接受此項為「設計正確，依 AI 判斷」。

### V4 — Build 乾淨

```bash
cd C:\Hank\Other\project\openclaw-channel-eclaw
npm run build
```
Expected: 零錯誤

### V5 — Zeabur 容器啟動正常

Zeabur Dashboard Logs 出現：
```
[E-Claw] Entity 0 reconnected (existing channel binding), publicCode: 36wmtj
[E-Claw] Account default ready!
```

### V6 — 無 state=undefined warn

查 V1 log 確認不出現：
```
WARN [client_push] enull [PUSH] /channel/message missing required fields
```
