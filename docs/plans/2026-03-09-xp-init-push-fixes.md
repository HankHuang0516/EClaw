# XP Preservation & Channel Init Push — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** (A) 驗證 XP/level 保留修復（Fix 1）；(B) 實作 channel bot 重綁後初始化推送（Fix 2）並驗證。

**Architecture:**
- Fix 1 驗證：新增 `POST /api/debug/set-entity-xp`（`isTestDevice` 保護）+ 擴充 `test_entity_name_preservation.js` 加入 XP scenario
- Fix 2 實作：在 `channel-api.js` 的 `POST /api/channel/bind` 成功後，對新綁定（非 idempotent reconnect）呼叫 `pushToChannelCallback` 推送 `ECLAW_READY` 初始化訊息
- Fix 2 驗證：使用既有 `/api/channel/test-sink` 機制，在 `test-channel-api.js` 加入 bind → sink 接收驗證

**Tech Stack:** Node.js / Express, `backend/index.js`, `backend/channel-api.js`, `backend/tests/`

---

## Task A: 新增 Debug Set-XP 端點（Fix 1 驗證前置）

**Files:**
- Modify: `backend/index.js` (debug endpoints 區塊, ~line 4749)

**Step A-1: 加入 `POST /api/debug/set-entity-xp` endpoint**

緊接在 `POST /api/debug/reset` 之後（~line 4771）加入：

```javascript
/**
 * POST /api/debug/set-entity-xp
 * Directly set XP/level on an entity (test devices only).
 * Body: { deviceId, deviceSecret, entityId, xp }
 */
app.post('/api/debug/set-entity-xp', (req, res) => {
    const { deviceId, deviceSecret, entityId, xp } = req.body || {};
    if (!deviceId || !deviceSecret || entityId === undefined || xp === undefined) {
        return res.status(400).json({ success: false, error: 'deviceId, deviceSecret, entityId, xp required' });
    }
    const device = devices[deviceId];
    if (!device || device.deviceSecret !== deviceSecret) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    if (!device.isTestDevice) {
        return res.status(403).json({ success: false, error: 'Test devices only' });
    }
    const eId = parseInt(entityId);
    const entity = device.entities[eId];
    if (!entity) {
        return res.status(404).json({ success: false, error: `Entity ${eId} not found` });
    }
    const xpVal = Math.max(0, parseInt(xp) || 0);
    entity.xp = xpVal;
    entity.level = calculateLevel(xpVal);
    saveData();
    res.json({ success: true, entityId: eId, xp: entity.xp, level: entity.level });
});
```

> 注意：`calculateLevel` 已在 index.js 中定義（`function calculateLevel(xp)`），直接呼叫即可。

**Step A-2: 手動測試 endpoint 是否工作**

先 deploy（push），再確認：
```bash
curl -s -X POST "https://eclawbot.com/api/debug/set-entity-xp" \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"2a0ad04d-9107-4250-b8be-ecd565983fb2","deviceSecret":"77c91d51-7677-4c1f-aece-fe26fd651d6d-cfff4f91-6883-4450-b17d-1ae1cf4085b4","entityId":0,"xp":0}'
```
預期：`{"success":false,"error":"Entity 0 not found"}` 或 `{"success":false,"error":"Test devices only"}`（正常，因為 BROADCAST_TEST_DEVICE 不是 isTestDevice）

**Step A-3: Commit**

```bash
git add backend/index.js
git commit -m "feat(debug): add POST /api/debug/set-entity-xp for test devices"
```

---

## Task B: Fix 1 驗證 — XP Preservation Test Script

**Files:**
- Create: `backend/tests/test_entity_xp_preservation.js`

**Step B-1: 建立測試檔案**

```javascript
/**
 * Entity XP/Level Preservation Test
 *
 * 驗證修復：Fix #156 — 實體 XP/level 在 unbind/rebind 操作中不會被重設為 0/1。
 *
 * 依賴：
 *   - POST /api/debug/set-entity-xp (isTestDevice 保護)
 *   - GET /api/entities (回傳 xp, level)
 *   - POST /api/device/register + POST /api/bind (標準綁定流程)
 *   - DELETE /api/entity, DELETE /api/device/entity (解綁流程)
 *
 * Run: node backend/tests/test_entity_xp_preservation.js
 * Run (local): node backend/tests/test_entity_xp_preservation.js --local
 */

'use strict';

const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const isLocal = args.includes('--local');
const API_BASE = isLocal ? 'http://localhost:3000' : 'https://eclawbot.com';

// ── .env loader ──────────────────────────────────────────────
function loadEnv() {
    const envPath = path.resolve(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return {};
    const vars = {};
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        const idx = line.indexOf('=');
        if (idx > 0) vars[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    return vars;
}

// ── HTTP helpers ─────────────────────────────────────────────
async function api(method, urlPath, body = null) {
    const url = `${API_BASE}${urlPath}`;
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    return { status: res.status, data: await res.json().catch(() => ({})) };
}

// ── Assertion helpers ────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;
function assert(cond, label, detail = '') {
    if (cond) { console.log(`  ✅ ${label}`); passed++; }
    else       { console.log(`  ❌ ${label}${detail ? ' — ' + detail : ''}`); failed++; }
}
function skip(label, reason) { console.log(`  ⏭️  ${label} — ${reason}`); skipped++; }

// ── Setup helpers ────────────────────────────────────────────
async function registerAndBind(deviceId, deviceSecret, entityId) {
    const reg = await api('POST', '/api/device/register', { deviceId, deviceSecret, entityId, isTestDevice: true });
    if (!reg.data.success) throw new Error(`register failed: ${JSON.stringify(reg.data)}`);
    const bind = await api('POST', '/api/bind', { code: reg.data.bindingCode });
    if (!bind.data.success) throw new Error(`bind failed: ${JSON.stringify(bind.data)}`);
    return bind.data.botSecret;
}

async function setXP(deviceId, deviceSecret, entityId, xp) {
    const r = await api('POST', '/api/debug/set-entity-xp', { deviceId, deviceSecret, entityId, xp });
    if (!r.data.success) throw new Error(`set-xp failed: ${JSON.stringify(r.data)}`);
    return r.data;
}

async function getXP(deviceId, deviceSecret, entityId) {
    // GET /api/entities requires deviceSecret
    const r = await api('GET', `/api/entities?deviceId=${deviceId}&deviceSecret=${deviceSecret}`, null);
    if (!r.data.success) throw new Error(`get-entities failed: ${JSON.stringify(r.data)}`);
    const entity = (r.data.entities || []).find(e => e.entityId === entityId);
    return entity ? { xp: entity.xp, level: entity.level, isBound: entity.isBound } : null;
}

// ── Tests ────────────────────────────────────────────────────
async function runTests() {
    console.log('='.repeat(60));
    console.log('ENTITY XP / LEVEL PRESERVATION TEST');
    console.log('='.repeat(60));
    console.log(`Target: ${API_BASE}`);
    console.log(`Date:   ${new Date().toISOString()}\n`);

    const ts = Date.now();
    const deviceId = `test-xp-preserve-${ts}`;
    const deviceSecret = `secret-xp-${ts}`;

    // ── Scenario 0: Baseline — verify debug endpoint works ──
    console.log('--- Scenario 0: Debug endpoint baseline ---\n');
    {
        const botSecret = await registerAndBind(deviceId, deviceSecret, 0);

        const setResult = await setXP(deviceId, deviceSecret, 0, 250);
        assert(setResult.xp === 250, 'set-xp accepted xp=250', `got ${setResult.xp}`);
        assert(setResult.level >= 2, 'level recalculated (>=2 for xp=250)', `got ${setResult.level}`);

        const before = await getXP(deviceId, deviceSecret, 0);
        assert(before?.xp === 250, 'GET /api/entities returns xp=250', `got ${before?.xp}`);
        assert(before?.isBound === true, 'entity is bound');

        console.log(`  ℹ️  xp=250 → level=${before?.level}`);
    }
    console.log('');

    // ── Scenario 1: DELETE /api/device/entity — device-side unbind ──
    console.log('--- Scenario 1: DELETE /api/device/entity preserves XP ---\n');
    {
        const before = await getXP(deviceId, deviceSecret, 0);
        const xpBefore = before?.xp || 0;

        await api('DELETE', '/api/device/entity', { deviceId, deviceSecret, entityId: 0 });

        const after = await getXP(deviceId, deviceSecret, 0);
        assert(after?.isBound === false, 'entity is unbound after device-side delete');
        assert(after?.xp === xpBefore, `XP preserved after device-side delete (${xpBefore})`, `got ${after?.xp}`);
        assert(after?.level === before?.level, `level preserved after device-side delete (${before?.level})`, `got ${after?.level}`);
    }
    console.log('');

    // ── Scenario 2: Rebind after unbind ——————————————————————
    console.log('--- Scenario 2: Rebind after unbind preserves XP ---\n');
    {
        const xpBefore = (await getXP(deviceId, deviceSecret, 0))?.xp || 0;

        await registerAndBind(deviceId, deviceSecret, 0);

        const after = await getXP(deviceId, deviceSecret, 0);
        assert(after?.isBound === true, 'entity is bound after rebind');
        assert(after?.xp === xpBefore, `XP preserved across rebind (${xpBefore})`, `got ${after?.xp}`);
    }
    console.log('');

    // ── Scenario 3: DELETE /api/entity — bot-side unbind ─────
    console.log('--- Scenario 3: DELETE /api/entity (bot-side) preserves XP ---\n');
    {
        const botSecret = (await api('POST', '/api/device/register', { deviceId, deviceSecret, entityId: 0, isTestDevice: true })).data;
        // entity 0 is already bound; we need botSecret
        // get it from the entity state indirectly — rebind first
        await api('DELETE', '/api/device/entity', { deviceId, deviceSecret, entityId: 0 });
        const bs = await registerAndBind(deviceId, deviceSecret, 0);
        await setXP(deviceId, deviceSecret, 0, 400);

        const before = await getXP(deviceId, deviceSecret, 0);
        assert(before?.xp === 400, 'XP set to 400 before bot-side delete');

        await api('DELETE', '/api/entity', { deviceId, entityId: 0, botSecret: bs });

        const after = await getXP(deviceId, deviceSecret, 0);
        assert(after?.isBound === false, 'entity unbound after bot-side delete');
        assert(after?.xp === 400, 'XP=400 preserved after bot-side delete', `got ${after?.xp}`);
    }
    console.log('');

    // ── Scenario 4: Multiple unbind/rebind cycles ─────────────
    console.log('--- Scenario 4: Multiple cycles preserve XP cumulatively ---\n');
    {
        const CYCLES = 3;
        let currentXP = 0;

        for (let i = 0; i < CYCLES; i++) {
            // Bind fresh
            await api('DELETE', '/api/device/entity', { deviceId, deviceSecret, entityId: 0 }).catch(() => {});
            await registerAndBind(deviceId, deviceSecret, 0);

            // Award increasing XP each cycle
            currentXP += (i + 1) * 100;
            await setXP(deviceId, deviceSecret, 0, currentXP);

            // Unbind
            await api('DELETE', '/api/device/entity', { deviceId, deviceSecret, entityId: 0 });

            const after = await getXP(deviceId, deviceSecret, 0);
            assert(after?.xp === currentXP, `Cycle ${i+1}: XP=${currentXP} preserved after unbind`, `got ${after?.xp}`);
        }
    }
    console.log('');

    // ── Scenario 5: Multi-entity isolation ───────────────────
    console.log('--- Scenario 5: Unbinding entity 0 does not affect entity 1 XP ---\n');
    {
        await api('DELETE', '/api/device/entity', { deviceId, deviceSecret, entityId: 0 }).catch(() => {});
        const bs0 = await registerAndBind(deviceId, deviceSecret, 0);
        const bs1 = await registerAndBind(deviceId, deviceSecret, 1);

        await setXP(deviceId, deviceSecret, 0, 100);
        await setXP(deviceId, deviceSecret, 1, 999);

        await api('DELETE', '/api/device/entity', { deviceId, deviceSecret, entityId: 0 });

        const xp1 = await getXP(deviceId, deviceSecret, 1);
        assert(xp1?.xp === 999, 'Entity 1 XP=999 unaffected by entity 0 unbind', `got ${xp1?.xp}`);
        assert(xp1?.isBound === true, 'Entity 1 still bound');
    }
    console.log('');

    // ── Summary ───────────────────────────────────────────────
    console.log('='.repeat(60));
    console.log('TEST SUMMARY');
    console.log('='.repeat(60));
    console.log(`  Passed:  ${passed}`);
    console.log(`  Failed:  ${failed}`);
    console.log(`  Skipped: ${skipped}`);
    if (failed === 0) console.log('\n✅ All XP preservation tests passed!');
    else              console.log(`\n❌ ${failed} test(s) failed`);
    console.log('='.repeat(60));
    return { passed, failed, skipped };
}

runTests().catch(err => {
    console.error('\n❌ Test runner error:', err.message);
    process.exit(1);
});
```

**Step B-2: 跑測試（預期所有通過，因為 Fix 1 已部署）**

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 node backend/tests/test_entity_xp_preservation.js
```

預期：所有 assert ✅ 通過

**Step B-3: Commit**

```bash
git add backend/tests/test_entity_xp_preservation.js
git commit -m "test(entity): add XP/level preservation regression test (Fix #156 verification)"
```

---

## Task C: Fix 2 實作 — Channel Bot Init Push

**Files:**
- Modify: `backend/index.js` (channelModule 初始化, ~line 7406)
- Modify: `backend/channel-api.js` (module factory 簽章 + bind endpoint, ~line 21 + ~line 452)

**Step C-1: 在 channel-api.js module factory 加入 `apiBase` 參數**

修改 [channel-api.js:21](backend/channel-api.js#L21)：

```javascript
// Before:
module.exports = function (devices, { authMiddleware, serverLog, generateBotSecret, generatePublicCode, publicCodeIndex, saveChatMessage, io, saveData }) {

// After:
module.exports = function (devices, { authMiddleware, serverLog, generateBotSecret, generatePublicCode, publicCodeIndex, saveChatMessage, io, saveData, apiBase }) {
```

**Step C-2: 修改 index.js — 傳入 apiBase**

修改 [index.js:7406](backend/index.js#L7406)：

```javascript
// Before:
const channelModule = require('./channel-api')(devices, {
    authMiddleware: authModule.authMiddleware,
    serverLog,
    generateBotSecret,
    generatePublicCode,
    publicCodeIndex,
    saveChatMessage,
    io,
    saveData
});

// After:
const channelModule = require('./channel-api')(devices, {
    authMiddleware: authModule.authMiddleware,
    serverLog,
    generateBotSecret,
    generatePublicCode,
    publicCodeIndex,
    saveChatMessage,
    io,
    saveData,
    apiBase: process.env.API_BASE || 'https://eclawbot.com'
});
```

**Step C-3: 在 bind endpoint 加入 init push（僅 full bind，非 idempotent reconnect）**

找到 [channel-api.js](backend/channel-api.js) 中 full bind 成功後的 `res.json(...)` 呼叫（~line 472），在 `saveData()` 之後、`res.json(...)` 之前加入：

```javascript
            saveData();
            serverLog('info', 'bind', `Entity ${eId} bound via channel plugin`, { deviceId, entityId: eId });
            if (process.env.DEBUG === 'true') serverLog('info', 'bind', `[BIND] entity ${eId} bound OK, publicCode=${publicCode}`, { deviceId, entityId: eId });

            // Send ECLAW_READY init push so bot gets credentials immediately
            // (fire-and-forget; don't block response if push fails)
            const initText = [
                `[SYSTEM:ECLAW_READY] E-Claw channel binding established.`,
                `deviceId: ${deviceId} | entityId: ${eId} | botSecret: ${botSecret}`,
                ``,
                `[AVAILABLE TOOLS — Mission Dashboard]`,
                `Read tasks/notes/rules/skills: exec: curl -s "${apiBase}/api/mission/dashboard?deviceId=${deviceId}&botSecret=${botSecret}&entityId=${eId}"`,
                `Read notes: exec: curl -s "${apiBase}/api/mission/notes?deviceId=${deviceId}&botSecret=${botSecret}&entityId=${eId}"`,
                `Mark TODO done: exec: curl -s -X POST "${apiBase}/api/mission/todo/done" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${eId},"botSecret":"${botSecret}","title":"TASK_TITLE"}'`,
                `Add note: exec: curl -s -X POST "${apiBase}/api/mission/note/add" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${eId},"botSecret":"${botSecret}","title":"TITLE","content":"CONTENT"}'`,
                `Update wallpaper: exec: curl -s -X POST "${apiBase}/api/transform" -H "Content-Type: application/json" -d '{"deviceId":"${deviceId}","entityId":${eId},"botSecret":"${botSecret}","state":"IDLE","message":"hello"}'`
            ].join('\n');

            pushToChannelCallback(deviceId, eId, {
                event: 'message',
                from: 'system',
                text: initText
            }, account.id).catch(err => {
                if (process.env.DEBUG === 'true') serverLog('warn', 'bind', `[BIND] ECLAW_READY push failed: ${err.message}`, { deviceId, entityId: eId });
            });

            res.json({
                success: true,
                deviceId,
                entityId: eId,
                botSecret,
                publicCode,
                bindingType: 'channel'
            });
```

> 注意：`pushToChannelCallback` 是在同一個模組 closure 內定義的，可以直接呼叫。`apiBase` 從 module factory 參數傳入。

**Step C-4: Verify syntax**

```bash
node --check backend/channel-api.js
node --check backend/index.js
```

預期：無輸出（syntax OK）

**Step C-5: Commit**

```bash
git add backend/channel-api.js backend/index.js
git commit -m "feat(channel): send ECLAW_READY init push to bot after full bind"
```

---

## Task D: Fix 2 驗證 — Channel Bind Init Push Test

**Files:**
- Modify: `backend/tests/test-channel-api.js` (在現有測試末尾加入新 section)

**Step D-1: 查看 test-channel-api.js 的尾端**

讀取 `backend/tests/test-channel-api.js` 最後 50 行，確認在哪裡加入新 test section。

**Step D-2: 加入 test-sink + bind init push 驗證 scenario**

在測試檔案的 `runTests()` 函式末尾（在 Summary 之前）加入：

```javascript
  // ── Test Sink + Bind Init Push ──
  console.log('--- Init Push Verification (test-sink) ---\n');
  {
    const ts = Date.now();
    const sinkDeviceId = `test-init-push-${ts}`;
    const sinkDeviceSecret = `secret-sink-${ts}`;
    const sinkSlot = `init-push-${ts}`;
    const sinkToken = `tok-${ts}`;

    // 1. Register device (isTestDevice so we can have a channel account)
    const reg = await postJSON(`${API_BASE}/api/device/register`, {
      deviceId: sinkDeviceId, deviceSecret: sinkDeviceSecret, entityId: 0, isTestDevice: true
    });
    assert(reg.data.success, 'Sink device registered');

    // 2. Provision channel account via provision-device (no JWT needed)
    const prov = await postJSON(`${API_BASE}/api/channel/provision-device`, {
      deviceId: sinkDeviceId, deviceSecret: sinkDeviceSecret
    });
    if (!prov.data.success || !prov.data.channel_api_key) {
      console.log('  ⏭️  Init push test — provision-device failed, skipping');
      console.log(`     (${prov.data.message || prov.data.error || 'unknown'})`);
    } else {
      const { channel_api_key, channel_api_secret } = prov.data;

      // 3. Register callback to test-sink
      const sinkUrl = `${API_BASE}/api/channel/test-sink?slot=${sinkSlot}&token=${sinkToken}`;
      const regCb = await postJSON(`${API_BASE}/api/channel/register`, {
        channel_api_key, channel_api_secret, callback_url: sinkUrl
      });
      assert(regCb.data.success, 'Callback registered to test-sink');

      // 4. Clear sink
      await fetch(`${API_BASE}/api/channel/test-sink?slot=${sinkSlot}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: sinkDeviceId, deviceSecret: sinkDeviceSecret })
      });

      // 5. Bind entity → should trigger ECLAW_READY push
      const bindR = await postJSON(`${API_BASE}/api/channel/bind`, {
        channel_api_key, channel_api_secret, entityId: 0, name: 'TestInitBot'
      });
      assert(bindR.data.success, 'Bind succeeded for init push test');

      // 6. Wait briefly for async push
      await new Promise(r => setTimeout(r, 800));

      // 7. Check test-sink received the push
      const sinkRes = await fetch(
        `${API_BASE}/api/channel/test-sink?slot=${sinkSlot}&deviceId=${sinkDeviceId}&deviceSecret=${sinkDeviceSecret}`
      );
      const sinkData = await sinkRes.json();
      const payloads = sinkData.payloads || [];

      const initMsg = payloads.find(p => p.payload?.text?.includes('ECLAW_READY'));
      assert(!!initMsg, 'ECLAW_READY init push received in test-sink');
      if (initMsg) {
        const txt = initMsg.payload.text;
        assert(txt.includes(sinkDeviceId), 'Init push contains deviceId');
        assert(txt.includes(bindR.data.botSecret), 'Init push contains botSecret');
        assert(txt.includes('mission/dashboard'), 'Init push contains mission dashboard URL');
        assert(initMsg.payload.event === 'message', 'Init push event is "message"');
        assert(initMsg.payload.entityId === 0, 'Init push entityId is 0');
      }

      // 8. Verify idempotent reconnect does NOT send another init push
      await fetch(`${API_BASE}/api/channel/test-sink?slot=${sinkSlot}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: sinkDeviceId, deviceSecret: sinkDeviceSecret })
      });

      // Re-bind (idempotent — same channel account, same entity)
      await postJSON(`${API_BASE}/api/channel/bind`, {
        channel_api_key, channel_api_secret, entityId: 0
      });
      await new Promise(r => setTimeout(r, 800));

      const sinkRes2 = await fetch(
        `${API_BASE}/api/channel/test-sink?slot=${sinkSlot}&deviceId=${sinkDeviceId}&deviceSecret=${sinkDeviceSecret}`
      );
      const sinkData2 = await sinkRes2.json();
      const initMsg2 = (sinkData2.payloads || []).find(p => p.payload?.text?.includes('ECLAW_READY'));
      assert(!initMsg2, 'Idempotent reconnect does NOT re-send ECLAW_READY');

      // 9. Cleanup — unbind
      await fetch(`${API_BASE}/api/device/entity`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: sinkDeviceId, deviceSecret: sinkDeviceSecret, entityId: 0 })
      });
    }
  }
  console.log('');
```

**Step D-3: 跑完整 test-channel-api.js 並確認新測試通過**

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 node backend/tests/test-channel-api.js
```

預期：新的 init push 測試全部通過

**Step D-4: Commit**

```bash
git add backend/tests/test-channel-api.js
git commit -m "test(channel): add ECLAW_READY init push + idempotent reconnect verification"
```

---

## Task E: Push 到 Remote，等待 Railway 部署

**Step E-1: Push**

```bash
git push
```

**Step E-2: 等待 Railway 部署完成（約 1-2 分鐘）**

觀察 Railway Dashboard 或等 health check 回應。

**Step E-3: 對 production 重跑所有驗證測試**

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 node backend/tests/test_entity_xp_preservation.js
NODE_TLS_REJECT_UNAUTHORIZED=0 node backend/tests/test-channel-api.js
```

兩個測試都應全部通過（或只有需要官方 bot 的 scenario 跳過）。

---

## 測試覆蓋範圍總表

| 測試 | 涵蓋路徑 | 主要驗證點 |
|------|---------|-----------|
| `test_entity_xp_preservation.js` | DELETE /api/device/entity → rebind | Fix 1: XP/level 跨 unbind/rebind 保留 |
| `test_entity_xp_preservation.js` | DELETE /api/entity (bot-side) | Fix 1: XP/level 跨 bot-side unbind 保留 |
| `test_entity_xp_preservation.js` | 多循環 unbind/rebind | Fix 1: 累積 XP 每次都保留 |
| `test_entity_xp_preservation.js` | 多實體隔離 | Fix 1: unbind 一個不影響其他 entity 的 XP |
| `test-channel-api.js` (新增) | POST /api/channel/bind (full bind) | Fix 2: 新綁定後收到 ECLAW_READY push |
| `test-channel-api.js` (新增) | POST /api/channel/bind (idempotent) | Fix 2: 重連後不重複送 init push |

> Fix 1 的其他 5 條路徑（scheduler cleanup、bind-free、bind-personal、borrow unbind、auto-unbind helper）需要官方 bot 環境，在現有測試環境中以 `skip` 處理，生產環境可透過 server logs 確認。
