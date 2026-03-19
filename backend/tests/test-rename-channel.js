#!/usr/bin/env node
/**
 * Entity Name Change → Channel Bot Notification Test
 *
 * Verifies that renaming an entity immediately pushes [SYSTEM:NAME_CHANGED]
 * to channel-bound bots (Bot Push Parity Rule).
 *
 * Usage:
 *   node test-rename-channel.js
 *   node test-rename-channel.js --local
 */

const path = require('path');
const fs   = require('fs');

const args    = process.argv.slice(2);
const API_BASE = args.includes('--local') ? 'http://localhost:3000' : 'https://eclawbot.com';

let ENTITY_CH;  // resolved at runtime from actual device entities
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

async function run() {
    const env = loadEnv();
    const DEVICE_ID     = env.BROADCAST_TEST_DEVICE_ID;
    const DEVICE_SECRET = env.BROADCAST_TEST_DEVICE_SECRET;
    if (!DEVICE_ID) { console.error('Missing BROADCAST_TEST_DEVICE_ID in .env'); process.exit(1); }

    // SAFETY: Create a new entity slot instead of reusing existing ones
    const addRes = await post(`${API_BASE}/api/device/add-entity`, { deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
    if (addRes.status !== 200 || addRes.data?.entityId === undefined) {
        console.error('Failed to create test entity slot'); process.exit(1);
    }
    ENTITY_CH = addRes.data.entityId;

    const SINK     = `${API_BASE}/api/channel/test-sink`;
    const SLOT     = `rename-ch-${Date.now()}`;
    const TOKEN    = 'rename-token-' + Math.random().toString(36).slice(2);
    const CALLBACK = `${SINK}?slot=${SLOT}`;
    const OLD_NAME = 'OldBot';
    const NEW_NAME = 'NewBot' + Math.random().toString(36).slice(2, 8); // ≤12 chars

    console.log(`\n🧪  Entity Name Change → Channel Bot Notification Test — ${API_BASE}`);
    console.log(`    Device: ${DEVICE_ID.slice(0, 8)}...`);
    console.log(`    Entity ${ENTITY_CH} — rename "${OLD_NAME}" → "${NEW_NAME}"\n`);

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

    // ── 2. Bind entity as channel bot ─────────────────────────────────────────
    console.log(`\n── 2. Bind entity ${ENTITY_CH} as channel bot with initial name ──`);

    const bind = await post(`${API_BASE}/api/channel/bind`, {
        channel_api_key: apiKey, channel_api_secret: apiSecret,
        entityId: ENTITY_CH, name: OLD_NAME
    });
    assert(bind.status === 200, `Bind entity ${ENTITY_CH} OK`, JSON.stringify(bind.data));
    assert(bind.data?.bindingType === 'channel', 'bindingType=channel');

    // ── 3. Clear sink + rename entity ─────────────────────────────────────────
    console.log(`\n── 3. Clear sink + rename entity to "${NEW_NAME}" ──`);
    await del(`${SINK}?slot=${SLOT}&deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`);

    const renameRes = await put(`${API_BASE}/api/device/entity/name`, {
        deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET,
        entityId: ENTITY_CH, name: NEW_NAME
    });
    assert(renameRes.status === 200, `Rename returns 200`, JSON.stringify(renameRes.data));
    assert(renameRes.data?.name === NEW_NAME, `Returned name matches "${NEW_NAME}"`);

    // ── 4. Poll test-sink for NAME_CHANGED notification ───────────────────────
    console.log('\n── 4. Wait for NAME_CHANGED channel push in test-sink ──');
    let payloads;
    try {
        payloads = await poll(async () => {
            const r = await get(`${SINK}?slot=${SLOT}&deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`);
            const ps = r.data?.payloads || [];
            return ps.length > 0 ? ps : null;
        }, `test-sink receives rename notification`);
    } catch (err) {
        assert(false, `Rename notification received within ${WAIT_MS}ms — ${err.message}`);
        payloads = [];
    }

    if (payloads.length > 0) {
        const p  = payloads[0];
        const pl = p.payload || {};

        console.log('\n  📦 Payload received:');
        console.log(`     event:  ${pl.event}`);
        console.log(`     from:   ${pl.from}`);
        console.log(`     text:   ${(pl.text || '').slice(0, 200)}`);

        assert(pl.event === 'message',    'event=message');
        assert(pl.from  === 'system',     'from=system');
        assert(pl.text && pl.text.includes('NAME_CHANGED'),           'text includes NAME_CHANGED');
        assert(pl.text && pl.text.includes(OLD_NAME),                 `text mentions old name "${OLD_NAME}"`);
        assert(pl.text && pl.text.includes(NEW_NAME),                 `text mentions new name "${NEW_NAME}"`);

        const ctx = pl.eclaw_context;
        assert(ctx !== undefined && ctx !== null, 'eclaw_context present');
        if (ctx) {
            assert(ctx.expectsReply  === false,     'eclaw_context.expectsReply=false');
            assert(ctx.silentToken   === '[SILENT]', 'eclaw_context.silentToken=[SILENT]');
        }
    }

    // ── 5. Cleanup ─────────────────────────────────────────────────────────────
    console.log('\n── Cleanup ──');
    await del(`${API_BASE}/api/device/entity`, { deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, entityId: ENTITY_CH });
    await del(`${API_BASE}/api/device/entity/${ENTITY_CH}/permanent`, { deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
    await del(`${API_BASE}/api/channel/register`, { channel_api_key: apiKey, channel_api_secret: apiSecret });
    console.log(`  Entity ${ENTITY_CH} unbound + deleted, channel account unregistered`);

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(60));
    console.log(`  Entity Rename Channel: ${passed} passed, ${failed} failed`);
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
