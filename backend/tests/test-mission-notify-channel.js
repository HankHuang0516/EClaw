#!/usr/bin/env node
/**
 * Mission Notify → Channel Bot Verification Test
 *
 * Verifies that POST /api/mission/notify correctly pushes to channel-bound entities
 * (Bot Push Parity Rule — mission notify parity).
 *
 * Strategy:
 *  1. Provision a channel account, register callback → test-sink
 *  2. Bind entity 6 as channel bot
 *  3. Call POST /api/mission/notify targeting entity 6
 *  4. Poll test-sink → assert payload received with correct fields
 *  5. Cleanup
 *
 * Usage:
 *   node test-mission-notify-channel.js
 *   node test-mission-notify-channel.js --local
 */

const path = require('path');
const fs   = require('fs');

const args    = process.argv.slice(2);
const API_BASE = args.includes('--local') ? 'http://localhost:3000' : 'https://eclawbot.com';

// ENTITY_CH determined dynamically at runtime (avoids deleting pre-existing entities)
let ENTITY_CH;
const POLL_MS   = 1500;
const WAIT_MS   = 15000;

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

    const SINK    = `${API_BASE}/api/channel/test-sink`;
    const SLOT    = `mission-notify-${Date.now()}`;
    const TOKEN   = 'mn-token-' + Math.random().toString(36).slice(2);
    const CALLBACK = `${SINK}?slot=${SLOT}`;

    console.log(`\n🧪  Mission Notify → Channel Bot Test — ${API_BASE}`);
    console.log(`    Device: ${DEVICE_ID.slice(0, 8)}...\n`);

    let apiKey, apiSecret;

    // ── 1. Provision + register ───────────────────────────────────────────────
    console.log('── 1. Provision channel account + register test-sink callback ──');
    const prov = await post(`${API_BASE}/api/channel/provision-device`, { deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
    assert(prov.status === 200, 'Provision OK');
    apiKey    = prov.data?.channel_api_key;
    apiSecret = prov.data?.channel_api_secret;

    const reg = await post(`${API_BASE}/api/channel/register`, {
        channel_api_key: apiKey, channel_api_secret: apiSecret,
        callback_url: CALLBACK, callback_token: TOKEN
    });
    assert(reg.status === 200, 'Register callback to test-sink OK');

    // ── 2. Create a fresh entity slot + bind as channel ──────────────────────
    console.log('\n── 2. Create test entity slot + bind as channel ──');
    // SAFETY: Create a new entity slot instead of reusing/overwriting existing ones
    const addRes = await post(`${API_BASE}/api/device/add-entity`, { deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
    if (addRes.status === 200 && addRes.data?.entityId !== undefined) {
        ENTITY_CH = addRes.data.entityId;
        console.log(`    Created new entity slot: ${ENTITY_CH}`);
    } else {
        // Fallback: find first unbound slot
        const entRes = await get(`${API_BASE}/api/entities?deviceId=${DEVICE_ID}`);
        const allIds = entRes.data?.entityIds || [];
        const boundIds = new Set((entRes.data?.entities || []).filter(e => e.isBound || e.bound).map(e => e.entityId));
        ENTITY_CH = allIds.find(id => !boundIds.has(id));
        console.log(`    Using existing unbound slot: ${ENTITY_CH}`);
    }
    assert(ENTITY_CH !== undefined, `Got entity slot for test (slot=${ENTITY_CH})`);

    const bind = await post(`${API_BASE}/api/channel/bind`, {
        channel_api_key: apiKey, channel_api_secret: apiSecret,
        entityId: ENTITY_CH, name: 'MissionTestBot'
    });
    assert(bind.status === 200, `Bind entity ${ENTITY_CH} OK`, JSON.stringify(bind.data));
    assert(bind.data?.bindingType === 'channel', 'bindingType=channel');

    // ── 3. Clear sink + call mission notify ───────────────────────────────────
    console.log('\n── 3. POST /api/mission/notify → entity 6 ──');
    await del(`${SINK}?slot=${SLOT}&deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`);

    const notifyRes = await post(`${API_BASE}/api/mission/notify`, {
        deviceId:     DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        notifications: [
            {
                type:      'TODO',
                title:     '測試任務項目',
                priority:  2,
                entityIds: [String(ENTITY_CH)]
            }
        ]
    });
    assert(notifyRes.status === 200, `mission notify returns 200`, JSON.stringify(notifyRes.data));

    // ── 4. Poll test-sink for channel push payload ────────────────────────────
    console.log('\n── 4. Wait for channel push in test-sink ──');
    let payloads;
    try {
        payloads = await poll(async () => {
            const r = await get(`${SINK}?slot=${SLOT}&deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`);
            const ps = r.data?.payloads || [];
            return ps.length > 0 ? ps : null;
        }, `test-sink slot ${SLOT} receives mission notify`);
    } catch (err) {
        assert(false, `Channel push received within ${WAIT_MS}ms — ${err.message}`);
        payloads = [];
    }

    if (payloads.length > 0) {
        const p  = payloads[0];
        const pl = p.payload || {};

        console.log('\n  📦 Payload received:');
        console.log(`     event:   ${pl.event}`);
        console.log(`     from:    ${pl.from}`);
        console.log(`     text:    ${(pl.text || '').slice(0, 80)}...`);
        console.log(`     eclaw_context: ${JSON.stringify(pl.eclaw_context)}`);

        assert(pl.event === 'message',          'event=message (human-initiated notify)');
        assert(pl.from  === 'mission_control',  'from=mission_control');
        assert(pl.text && pl.text.includes('[Mission Control'),  'text contains [Mission Control]');
        assert(pl.text && pl.text.includes('測試任務項目'),       'text contains 測試任務項目');
        assert(pl.entityId === ENTITY_CH,       `entityId=${ENTITY_CH}`);

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
    // Permanently delete the test-created entity slot to restore device state
    await del(`${API_BASE}/api/device/entity/${ENTITY_CH}/permanent`, { deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
    await del(`${API_BASE}/api/channel/register`, { channel_api_key: apiKey, channel_api_secret: apiSecret });
    console.log(`  Entity ${ENTITY_CH} unbound + deleted, channel account unregistered`);

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(60));
    console.log(`  Mission Notify Channel: ${passed} passed, ${failed} failed`);
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
