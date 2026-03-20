/**
 * Channel XP Accumulation — Regression Test (Issue #345)
 *
 * Validates that channel-bound entities accumulate XP when they send
 * messages via POST /api/channel/message, the same way entities using
 * POST /api/transform do.
 *
 * Strategy:
 *  - Provision a channel account (device-secret auth)
 *  - Register callback pointing at test-sink
 *  - Bind an entity via channel
 *  - Record initial XP
 *  - Send message via /api/channel/message
 *  - Verify XP increased by BOT_REPLY amount (+10)
 *  - Verify 30-second cooldown (rapid second message does NOT add XP)
 *  - Cleanup: unbind entity, delete channel account
 *
 * Usage:
 *   node test-channel-xp.js
 *   node test-channel-xp.js --local    # target localhost:3000
 *
 * Credentials auto-loaded from backend/.env:
 *   BROADCAST_TEST_DEVICE_ID, BROADCAST_TEST_DEVICE_SECRET
 */

const path = require('path');
const fs   = require('fs');

// ── Config ─────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const isLocal = args.includes('--local');
const API_BASE = isLocal ? 'http://localhost:3000' : 'https://eclawbot.com';

// ── .env loader ─────────────────────────────────────────────────────────────
function loadEnvFile() {
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

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function req(method, url, body) {
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
    if (body) opts.body = JSON.stringify(body);

    const res  = await fetch(url, opts);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 300) }; }
    return { status: res.status, data };
}

const postJSON   = (url, body) => req('POST',   url, body);
const getJSON    = (url)       => req('GET',    url);
const deleteJSON = (url, body) => req('DELETE', url, body);
const patchJSON  = (url, body) => req('PATCH',  url, body);

// ── Test runner ──────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message, extra = '') {
    if (condition) {
        console.log(`  ✓ ${message}`);
        passed++;
    } else {
        console.error(`  ✗ ${message}${extra ? ` (${extra})` : ''}`);
        failed++;
        failures.push(message);
    }
}

function section(title) {
    console.log(`\n── ${title} ──`);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function runTests() {
    const env = loadEnvFile();
    const DEVICE_ID     = env.BROADCAST_TEST_DEVICE_ID;
    const DEVICE_SECRET = env.BROADCAST_TEST_DEVICE_SECRET;

    if (!DEVICE_ID || !DEVICE_SECRET) {
        console.error('ERROR: BROADCAST_TEST_DEVICE_ID and BROADCAST_TEST_DEVICE_SECRET required in backend/.env');
        process.exit(1);
    }

    const SINK_BASE = `${API_BASE}/api/channel/test-sink`;
    const SLOT      = `test-xp-${Date.now()}`;
    const TOKEN     = 'token-' + Math.random().toString(36).slice(2);
    const CALLBACK  = `${SINK_BASE}?slot=${SLOT}`;

    console.log(`\n🔬 Channel XP Accumulation Test (Issue #345) — ${API_BASE}`);
    console.log(`   Device: ${DEVICE_ID.substring(0, 8)}...`);

    let apiKey, apiSecret, accountId;
    let botSecret;
    let entityId;

    try {
        // ──────────────────────────────────────────────────────────────────
        section('1. Provision channel account');

        const prov = await postJSON(`${API_BASE}/api/channel/provision-device`, {
            deviceId:     DEVICE_ID,
            deviceSecret: DEVICE_SECRET
        });
        assert(prov.status === 200 && prov.data?.success, 'Channel account provisioned');
        apiKey    = prov.data?.channel_api_key;
        apiSecret = prov.data?.channel_api_secret;
        accountId = prov.data?.id;

        // ──────────────────────────────────────────────────────────────────
        section('2. Register callback + bind entity');

        const reg = await postJSON(`${API_BASE}/api/channel/register`, {
            channel_api_key:    apiKey,
            channel_api_secret: apiSecret,
            callback_url:       CALLBACK,
            auth_token:         TOKEN
        });
        assert(reg.status === 200 && reg.data?.success, 'Callback registered');

        // Add a new entity for testing
        const addEntity = await postJSON(`${API_BASE}/api/device/add-entity`, {
            deviceId:     DEVICE_ID,
            deviceSecret: DEVICE_SECRET
        });
        assert(addEntity.status === 200 && addEntity.data?.success, 'Entity added');
        entityId = addEntity.data?.entityId;

        const bind = await postJSON(`${API_BASE}/api/channel/bind`, {
            channel_api_key:    apiKey,
            channel_api_secret: apiSecret,
            deviceId:           DEVICE_ID,
            entityId:           entityId,
            botName:            'XP-Test-Bot'
        });
        assert(bind.status === 200 && bind.data?.success, 'Entity bound via channel');
        botSecret = bind.data?.botSecret;

        // ──────────────────────────────────────────────────────────────────
        section('3. Record initial XP');

        const before = await getJSON(`${API_BASE}/api/entities?deviceId=${DEVICE_ID}`);
        const entityBefore = (before.data?.entities || []).find(e => e.entityId === entityId);
        const initialXP = entityBefore?.xp || 0;
        console.log(`  Initial XP: ${initialXP}`);

        // ──────────────────────────────────────────────────────────────────
        section('4. Send channel message → XP should increase');

        const msg1 = await postJSON(`${API_BASE}/api/channel/message`, {
            channel_api_key: apiKey,
            deviceId:        DEVICE_ID,
            entityId:        entityId,
            botSecret:       botSecret,
            message:         'Hello from channel bot!',
            state:           'IDLE'
        });
        assert(msg1.status === 200, 'Channel message sent (1st)');

        // Check XP in response
        const xpAfter1 = msg1.data?.currentState?.xp;
        assert(xpAfter1 === initialXP + 10, `XP increased by 10 (expected ${initialXP + 10}, got ${xpAfter1})`);

        // Also verify via entities endpoint
        const after1 = await getJSON(`${API_BASE}/api/entities?deviceId=${DEVICE_ID}`);
        const entityAfter1 = (after1.data?.entities || []).find(e => e.entityId === entityId);
        assert(entityAfter1?.xp === initialXP + 10, `Entities endpoint confirms XP=${initialXP + 10}`);

        // ──────────────────────────────────────────────────────────────────
        section('5. Rapid second message → XP should NOT increase (30s cooldown)');

        const msg2 = await postJSON(`${API_BASE}/api/channel/message`, {
            channel_api_key: apiKey,
            deviceId:        DEVICE_ID,
            entityId:        entityId,
            botSecret:       botSecret,
            message:         'Rapid follow-up message',
            state:           'IDLE'
        });
        assert(msg2.status === 200, 'Channel message sent (2nd, rapid)');

        const xpAfter2 = msg2.data?.currentState?.xp;
        assert(xpAfter2 === initialXP + 10, `XP unchanged due to cooldown (expected ${initialXP + 10}, got ${xpAfter2})`);

        // ──────────────────────────────────────────────────────────────────
        section('6. Level calculation');

        const levelAfter = msg1.data?.currentState?.level;
        assert(typeof levelAfter === 'number' && levelAfter >= 1, `Level is valid (got ${levelAfter})`);

    } finally {
        // ──────────────────────────────────────────────────────────────────
        section('Cleanup');

        // Unbind & delete entity
        if (entityId !== undefined) {
            await deleteJSON(`${API_BASE}/api/device/entity/${entityId}/permanent`, {
                deviceId:     DEVICE_ID,
                deviceSecret: DEVICE_SECRET
            });
            console.log(`  Entity ${entityId} deleted`);
        }

        // Revoke channel account
        if (accountId) {
            await deleteJSON(`${API_BASE}/api/channel/provision-device`, {
                deviceId:     DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                accountId:    accountId
            });
            console.log(`  Channel account ${accountId} revoked`);
        }
    }

    // ── Summary ──────────────────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failures.length) {
        console.log('Failures:');
        failures.forEach(f => console.log(`  - ${f}`));
    }
    console.log(`${'═'.repeat(50)}\n`);

    process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
    console.error('Unexpected error:', err);
    process.exit(1);
});
