#!/usr/bin/env node
/**
 * Schedule → Channel Bot Verification Test
 *
 * Verifies that the scheduler correctly pushes to channel-bound entities
 * (Bot Push Parity Rule — schedule parity).
 *
 * Strategy:
 *  1. Provision a channel account, register callback → test-sink
 *  2. Bind entity 6 as channel bot
 *  3. Create a one-time schedule firing in 5 seconds
 *  4. Poll test-sink → assert payload received with correct fields
 *  5. Cleanup
 *
 * Usage:
 *   node test-schedule-channel.js
 *   node test-schedule-channel.js --local
 */

const path = require('path');
const fs   = require('fs');

const args    = process.argv.slice(2);
const API_BASE = args.includes('--local') ? 'http://localhost:3000' : 'https://eclawbot.com';

const ENTITY_CH = 1;   // must be within free device limit (0-3); entity 6 is premium-only
const POLL_MS   = 1500;
const WAIT_MS   = 90000; // scheduler runs every minute; wait up to 90s for the next cron tick

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

    const SINK     = `${API_BASE}/api/channel/test-sink`;
    const SLOT     = `schedule-ch-${Date.now()}`;
    const TOKEN    = 'sched-token-' + Math.random().toString(36).slice(2);
    const CALLBACK = `${SINK}?slot=${SLOT}`;
    const SCHED_MSG = `Hello Channel Bot! Scheduled at ${new Date().toISOString()}`;

    console.log(`\n🧪  Schedule → Channel Bot Test — ${API_BASE}`);
    console.log(`    Device: ${DEVICE_ID.slice(0, 8)}...`);
    console.log(`    Entity ${ENTITY_CH} will be channel-bound\n`);

    let apiKey, apiSecret, scheduleId;

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

    // ── 2. Bind entity ────────────────────────────────────────────────────────
    console.log('\n── 2. Bind entity 6 as channel ──');
    await del(`${API_BASE}/api/device/entity`, { deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, entityId: ENTITY_CH });
    await new Promise(x => setTimeout(x, 500));

    const bind = await post(`${API_BASE}/api/channel/bind`, {
        channel_api_key: apiKey, channel_api_secret: apiSecret,
        entityId: ENTITY_CH, name: 'ScheduleTestBot'
    });
    assert(bind.status === 200, `Bind entity ${ENTITY_CH} OK`, JSON.stringify(bind.data));
    assert(bind.data?.bindingType === 'channel', 'bindingType=channel');

    // ── 3. Clear sink + create schedule (fires in 5s) ─────────────────────────
    // Scheduler runs every minute (cron * * * * *). Set scheduledAt to NOW so the
    // next cron tick (within 60s) will always execute it (scheduledAt <= now).
    console.log('\n── 3. Create one-time schedule (already overdue — next cron tick will fire it) ──');
    await del(`${SINK}?slot=${SLOT}&deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`);

    const fireAt = new Date(Date.now()).toISOString();
    const schedRes = await post(`${API_BASE}/api/schedules`, {
        deviceId:     DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entityId:     ENTITY_CH,
        message:      SCHED_MSG,
        scheduledAt:  fireAt,
        repeatType:   'once',
        label:        'channel-parity-test'
    });
    assert(schedRes.status === 200 || schedRes.status === 201, `Create schedule OK (${schedRes.status})`, JSON.stringify(schedRes.data));
    scheduleId = schedRes.data?.schedule?.id || schedRes.data?.id;
    assert(scheduleId !== undefined, `Got schedule id: ${scheduleId}`);
    console.log(`    Schedule #${scheduleId} fires at ${fireAt}`);

    // ── 4. Poll test-sink ─────────────────────────────────────────────────────
    console.log('\n── 4. Wait for channel push in test-sink ──');
    let payloads;
    try {
        payloads = await poll(async () => {
            const r = await get(`${SINK}?slot=${SLOT}&deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`);
            const ps = r.data?.payloads || [];
            return ps.length > 0 ? ps : null;
        }, `test-sink slot ${SLOT} receives scheduled push`);
    } catch (err) {
        assert(false, `Channel push received within ${WAIT_MS}ms — ${err.message}`);
        payloads = [];
    }

    if (payloads.length > 0) {
        const p  = payloads[0];
        const pl = p.payload || {};

        console.log('\n  📦 Payload received:');
        console.log(`     event:        ${pl.event}`);
        console.log(`     from:         ${pl.from}`);
        console.log(`     text:         ${(pl.text || '').slice(0, 80)}`);
        console.log(`     eclaw_context: ${JSON.stringify(pl.eclaw_context)}`);

        assert(pl.event === 'message',   'event=message');
        assert(pl.from  === 'scheduled', 'from=scheduled');
        assert(pl.text  && pl.text.startsWith(SCHED_MSG), `text matches scheduled message`);
        assert(pl.entityId === ENTITY_CH, `entityId=${ENTITY_CH}`);

        const ctx = pl.eclaw_context;
        assert(ctx !== undefined && ctx !== null, 'eclaw_context present');
        if (ctx) {
            assert(ctx.expectsReply  === true,      'eclaw_context.expectsReply=true');
            assert(ctx.silentToken   === '[SILENT]', 'eclaw_context.silentToken=[SILENT]');
            assert(ctx.missionHints !== undefined,  'eclaw_context.missionHints present');
        }
    }

    // ── 5. Cleanup ─────────────────────────────────────────────────────────────
    console.log('\n── Cleanup ──');
    if (scheduleId) {
        await del(`${API_BASE}/api/schedules/${scheduleId}?deviceId=${encodeURIComponent(DEVICE_ID)}&deviceSecret=${encodeURIComponent(DEVICE_SECRET)}`);
    }
    await del(`${API_BASE}/api/device/entity`, { deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, entityId: ENTITY_CH });
    await del(`${API_BASE}/api/channel/register`, { channel_api_key: apiKey, channel_api_secret: apiSecret });
    console.log('  Schedule deleted, entity 6 unbound, channel account unregistered');

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(60));
    console.log(`  Schedule Channel: ${passed} passed, ${failed} failed`);
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
