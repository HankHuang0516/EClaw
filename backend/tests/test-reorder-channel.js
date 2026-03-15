#!/usr/bin/env node
/**
 * Entity Reorder → Channel Bot Notification Test
 *
 * Verifies that reordering entities correctly notifies channel-bound bots
 * of their new slot via pushToChannelCallback (Bot Push Parity Rule).
 *
 * Strategy:
 *  1. Provision channel account, register callback → test-sink
 *  2. Bind entity 6 as channel bot (slot 6)
 *  3. Reorder: swap slot 6 ↔ slot 7
 *  4. Poll test-sink → assert ENTITY_MOVED payload received
 *  5. Cleanup
 *
 * Usage:
 *   node test-reorder-channel.js
 *   node test-reorder-channel.js --local
 */

const path = require('path');
const fs   = require('fs');

const args    = process.argv.slice(2);
const API_BASE = args.includes('--local') ? 'http://localhost:3000' : 'https://eclawbot.com';

let ENTITY_CH;  // resolved at runtime from actual device entities
let SWAP_WITH;  // resolved at runtime from actual device entities
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
const put  = (url, body) => req('PUT',    url, body);

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

// Build reorder array by swapping two entity IDs within the full ID list
function buildSwappedOrder(allIds, idA, idB) {
    return allIds.map(id => {
        if (id === idA) return idB;
        if (id === idB) return idA;
        return id;
    });
}

async function run() {
    const env = loadEnv();
    const DEVICE_ID     = env.BROADCAST_TEST_DEVICE_ID;
    const DEVICE_SECRET = env.BROADCAST_TEST_DEVICE_SECRET;
    if (!DEVICE_ID) { console.error('Missing BROADCAST_TEST_DEVICE_ID in .env'); process.exit(1); }

    // Query actual entity slot IDs from device (may be unbound)
    const entitiesRes = await get(`${API_BASE}/api/entities?deviceId=${DEVICE_ID}`);
    const availableIds = entitiesRes.data?.entityIds || [];
    if (availableIds.length < 2) { console.error(`Need at least 2 entity slots, found: ${availableIds}`); process.exit(1); }
    ENTITY_CH = availableIds[0];
    SWAP_WITH = availableIds[1];

    const SINK     = `${API_BASE}/api/channel/test-sink`;
    const SLOT     = `reorder-ch-${Date.now()}`;
    const TOKEN    = 'reorder-token-' + Math.random().toString(36).slice(2);
    const CALLBACK = `${SINK}?slot=${SLOT}`;

    console.log(`\n🧪  Entity Reorder → Channel Bot Notification Test — ${API_BASE}`);
    console.log(`    Device: ${DEVICE_ID.slice(0, 8)}...`);
    console.log(`    Entity ${ENTITY_CH} will be channel-bound, then swapped to slot ${SWAP_WITH}\n`);

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

    // ── 2. Bind entity 6 as channel bot ──────────────────────────────────────
    console.log(`\n── 2. Bind entity ${ENTITY_CH} as channel, also clear slot ${SWAP_WITH} ──`);
    // Clear both slots first
    await del(`${API_BASE}/api/device/entity`, { deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, entityId: ENTITY_CH });
    await del(`${API_BASE}/api/device/entity`, { deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, entityId: SWAP_WITH });
    await new Promise(x => setTimeout(x, 500));

    const bind = await post(`${API_BASE}/api/channel/bind`, {
        channel_api_key: apiKey, channel_api_secret: apiSecret,
        entityId: ENTITY_CH, name: 'ReorderTestBot'
    });
    assert(bind.status === 200, `Bind entity ${ENTITY_CH} OK`, JSON.stringify(bind.data));
    assert(bind.data?.bindingType === 'channel', 'bindingType=channel');

    // ── 3. Clear sink + reorder (swap slot 6 ↔ slot 7) ──────────────────────
    console.log(`\n── 3. Reorder: swap slot ${ENTITY_CH} ↔ slot ${SWAP_WITH} ──`);
    await del(`${SINK}?slot=${SLOT}&deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`);

    // Get current entity IDs for reorder permutation
    const entData = await get(`${API_BASE}/api/entities?deviceId=${DEVICE_ID}`);
    const allEntityIds = entData.data?.entityIds || [];

    const order = buildSwappedOrder(allEntityIds, ENTITY_CH, SWAP_WITH);
    console.log(`    Entity IDs: [${allEntityIds.join(',')}] → Swapped order: [${order.join(',')}]`);

    const reorderRes = await post(`${API_BASE}/api/device/reorder-entities`, {
        deviceId:     DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        order
    });
    assert(reorderRes.status === 200, `Reorder returns 200`, JSON.stringify(reorderRes.data));

    // ── 4. Poll test-sink for ENTITY_MOVED notification ───────────────────────
    console.log('\n── 4. Wait for ENTITY_MOVED channel push in test-sink ──');
    let payloads;
    try {
        payloads = await poll(async () => {
            const r = await get(`${SINK}?slot=${SLOT}&deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`);
            const ps = r.data?.payloads || [];
            return ps.length > 0 ? ps : null;
        }, `test-sink receives reorder notification`);
    } catch (err) {
        assert(false, `Reorder notification received within ${WAIT_MS}ms — ${err.message}`);
        payloads = [];
    }

    if (payloads.length > 0) {
        const p  = payloads[0];
        const pl = p.payload || {};

        console.log('\n  📦 Payload received:');
        console.log(`     event:  ${pl.event}`);
        console.log(`     from:   ${pl.from}`);
        console.log(`     text (first 200): ${(pl.text || '').slice(0, 200)}`);

        assert(pl.event === 'message',   'event=message');
        assert(pl.from  === 'system',    'from=system');
        assert(pl.text && pl.text.includes('ENTITY_MOVED'),          'text includes ENTITY_MOVED');
        assert(pl.text && pl.text.includes(`from #${ENTITY_CH} to #${SWAP_WITH}`), `text mentions slot change ${ENTITY_CH} → ${SWAP_WITH}`);
        assert(pl.text && pl.text.includes(`entityId: ${SWAP_WITH}`), `text shows new entityId=${SWAP_WITH}`);

        const ctx = pl.eclaw_context;
        assert(ctx !== undefined && ctx !== null, 'eclaw_context present');
        if (ctx) {
            assert(ctx.expectsReply  === false,     'eclaw_context.expectsReply=false');
            assert(ctx.silentToken   === '[SILENT]', 'eclaw_context.silentToken=[SILENT]');
        }
    }

    // ── 5. Cleanup (restore order first, then unbind) ─────────────────────────
    console.log('\n── Cleanup ──');
    // Restore original order (the original allEntityIds is the un-swapped order)
    await post(`${API_BASE}/api/device/reorder-entities`, { deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, order: allEntityIds });
    await new Promise(x => setTimeout(x, 300));
    // Now entity is back at slot ENTITY_CH — unbind it
    await del(`${API_BASE}/api/device/entity`, { deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, entityId: ENTITY_CH });
    await del(`${API_BASE}/api/channel/register`, { channel_api_key: apiKey, channel_api_secret: apiSecret });
    console.log(`  Order restored, entity ${ENTITY_CH} unbound, channel account unregistered`);

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(60));
    console.log(`  Entity Reorder Channel: ${passed} passed, ${failed} failed`);
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
