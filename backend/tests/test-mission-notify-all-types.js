#!/usr/bin/env node
/**
 * Mission Notify All Types → Channel Bot Verification Test
 *
 * Verifies that POST /api/mission/notify correctly pushes all notification
 * types (TODO, SKILL, RULE, SOUL) to channel-bound entities.
 *
 * Usage:
 *   node test-mission-notify-all-types.js
 *   node test-mission-notify-all-types.js --local
 */

const path = require('path');
const fs   = require('fs');

const args    = process.argv.slice(2);
const API_BASE = args.includes('--local') ? 'http://localhost:3000' : 'https://eclawbot.com';

let ENTITY_CH;  // resolved at runtime from actual device entities
const POLL_MS   = 1500;
const WAIT_MS   = 20000;

function loadEnv() {
    const p = path.resolve(__dirname, '..', '.env');
    if (!fs.existsSync(p)) return {};
    const vars = {};
    fs.readFileSync(p, 'utf8').split('\n').forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        const idx = line.indexOf('=');
        if (idx > 0) vars[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    return vars;
}

async function req(method, url, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res  = await fetch(url, opts);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 300) }; }
    return { status: res.status, data };
}
const post = (url, body) => req('POST',   url, body);
const get  = (url)       => req('GET',    url);
const del  = (url, body) => req('DELETE', url, body);

let passed = 0, failed = 0;
const failures = [];

function assert(cond, msg, extra = '') {
    if (cond) { console.log(`  ✅ ${msg}`); passed++; }
    else       { console.error(`  ❌ ${msg}${extra ? ` → ${extra}` : ''}`); failed++; failures.push(msg); }
}

async function poll(fn, desc) {
    const deadline = Date.now() + WAIT_MS;
    while (Date.now() < deadline) {
        const r = await fn();
        if (r) return r;
        await new Promise(x => setTimeout(x, POLL_MS));
    }
    throw new Error(`Timeout: ${desc}`);
}

async function run() {
    const env = loadEnv();
    const DEVICE_ID     = env.BROADCAST_TEST_DEVICE_ID;
    const DEVICE_SECRET = env.BROADCAST_TEST_DEVICE_SECRET;
    if (!DEVICE_ID) { console.error('Missing BROADCAST_TEST_DEVICE_ID in .env'); process.exit(1); }

    // Query actual entity slot IDs from device (may be unbound)
    const entitiesRes = await get(`${API_BASE}/api/entities?deviceId=${DEVICE_ID}`);
    const availableIds = entitiesRes.data?.entityIds || [];
    if (availableIds.length < 1) { console.error(`Need at least 1 entity slot, found: ${availableIds}`); process.exit(1); }
    ENTITY_CH = availableIds[0];

    const SINK     = `${API_BASE}/api/channel/test-sink`;
    const SLOT     = `mn-all-types-${Date.now()}`;
    const TOKEN    = 'mn-token-' + Math.random().toString(36).slice(2);
    const CALLBACK = `${SINK}?slot=${SLOT}`;

    console.log(`\n🧪  Mission Notify All Types → Channel Bot Test — ${API_BASE}`);
    console.log(`    Device: ${DEVICE_ID.slice(0, 8)}...`);
    console.log(`    Entity ${ENTITY_CH} will be channel-bound\n`);

    let apiKey, apiSecret;

    // ── 1. Provision + register ───────────────────────────────────────────────
    console.log('── 1. Provision channel account + register test-sink ──');
    const prov = await post(`${API_BASE}/api/channel/provision-device`, { deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
    assert(prov.status === 200, 'Provision OK');
    apiKey    = prov.data?.channel_api_key;
    apiSecret = prov.data?.channel_api_secret;

    const reg = await post(`${API_BASE}/api/channel/register`, {
        channel_api_key: apiKey, channel_api_secret: apiSecret,
        callback_url: CALLBACK, callback_token: TOKEN
    });
    assert(reg.status === 200, 'Register callback to test-sink OK');

    // ── 2. Bind entity ────────────────────────────────────────────────────────
    console.log(`\n── 2. Bind entity ${ENTITY_CH} as channel ──`);
    await del(`${API_BASE}/api/device/entity`, { deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, entityId: ENTITY_CH });
    await new Promise(x => setTimeout(x, 500));

    const bind = await post(`${API_BASE}/api/channel/bind`, {
        channel_api_key: apiKey, channel_api_secret: apiSecret,
        entityId: ENTITY_CH, name: 'AllTypesTestBot'
    });
    assert(bind.status === 200, `Bind entity ${ENTITY_CH} OK`);
    assert(bind.data?.bindingType === 'channel', 'bindingType=channel');

    // ── 3. Send all 4 notification types at once ──────────────────────────────
    console.log('\n── 3. POST /api/mission/notify with TODO + SKILL + RULE + SOUL ──');
    await del(`${SINK}?slot=${SLOT}&deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`);

    const notifyRes = await post(`${API_BASE}/api/mission/notify`, {
        deviceId:     DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        notifications: [
            { type: 'TODO',  title: '測試TODO任務',  priority: 2, entityIds: [String(ENTITY_CH)] },
            { type: 'SKILL', title: '測試SKILL技能',               entityIds: [String(ENTITY_CH)] },
            { type: 'RULE',  title: '測試RULE規則',                entityIds: [String(ENTITY_CH)] },
            { type: 'SOUL',  title: '測試SOUL靈魂',                entityIds: [String(ENTITY_CH)] }
        ]
    });
    assert(notifyRes.status === 200, `mission notify returns 200`, JSON.stringify(notifyRes.data));

    // ── 4. Poll test-sink ─────────────────────────────────────────────────────
    console.log('\n── 4. Wait for channel push in test-sink ──');
    let payloads;
    try {
        payloads = await poll(async () => {
            const r = await get(`${SINK}?slot=${SLOT}&deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`);
            const ps = r.data?.payloads || [];
            return ps.length > 0 ? ps : null;
        }, `test-sink receives mission notify (all types)`);
    } catch (err) {
        assert(false, `Channel push received within ${WAIT_MS}ms — ${err.message}`);
        payloads = [];
    }

    if (payloads.length > 0) {
        const p  = payloads[0];
        const pl = p.payload || {};

        console.log('\n  📦 Payload received:');
        console.log(`     event:  ${pl.event}`);
        console.log(`     from:   ${pl.from}`);
        console.log(`     text (first 200): ${(pl.text || '').slice(0, 200)}`);

        assert(pl.event === 'message',         'event=message');
        assert(pl.from  === 'mission_control', 'from=mission_control');
        assert(pl.entityId === ENTITY_CH,      `entityId=${ENTITY_CH}`);

        // All 4 type tags should appear in the combined message
        assert(pl.text && pl.text.includes('[TODO'),  'text includes [TODO tag]');
        assert(pl.text && pl.text.includes('[SKILL'), 'text includes [SKILL tag]');
        assert(pl.text && pl.text.includes('[RULE'),  'text includes [RULE tag]');
        assert(pl.text && pl.text.includes('[SOUL'),  'text includes [SOUL tag]');

        // All 4 titles should appear
        assert(pl.text && pl.text.includes('測試TODO任務'),  'text includes TODO title');
        assert(pl.text && pl.text.includes('測試SKILL技能'), 'text includes SKILL title');
        assert(pl.text && pl.text.includes('測試RULE規則'),  'text includes RULE title');
        assert(pl.text && pl.text.includes('測試SOUL靈魂'),  'text includes SOUL title');

        const ctx = pl.eclaw_context;
        assert(ctx !== undefined && ctx !== null, 'eclaw_context present');
        if (ctx) {
            assert(ctx.expectsReply  === true,      'eclaw_context.expectsReply=true');
            assert(ctx.silentToken   === '[SILENT]', 'eclaw_context.silentToken=[SILENT]');
        }
    }

    // ── 5. Cleanup ─────────────────────────────────────────────────────────────
    console.log('\n── Cleanup ──');
    await del(`${API_BASE}/api/device/entity`, { deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, entityId: ENTITY_CH });
    await del(`${API_BASE}/api/channel/register`, { channel_api_key: apiKey, channel_api_secret: apiSecret });
    console.log(`  Entity ${ENTITY_CH} unbound, channel account unregistered`);

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(60));
    console.log(`  Mission Notify All Types: ${passed} passed, ${failed} failed`);
    if (failures.length) {
        console.log('\n  Failed:');
        failures.forEach(f => console.log(`    • ${f}`));
    }
    console.log('═'.repeat(60) + '\n');
    if (failed > 0) process.exit(1);
}

run().catch(err => {
    console.error('\nTest crashed:', err.message);
    process.exit(1);
});
