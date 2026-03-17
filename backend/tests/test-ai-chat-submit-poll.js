/**
 * AI Chat Submit/Poll — Regression Test
 *
 * Verifies the async submit/poll pattern that AiChatViewModel uses:
 *   1. POST /api/ai-support/chat/submit — validation + requestId return
 *   2. GET  /api/ai-support/chat/poll/:requestId — status polling
 *   3. Edge cases: invalid UUID, missing fields, wrong credentials, idempotency
 *
 * Issue: #248 (AiChatBottomSheet ViewModel refactor)
 *
 * Usage:
 *   node backend/tests/test-ai-chat-submit-poll.js
 */

'use strict';

const path = require('path');
const fs   = require('fs');
const { randomUUID } = require('crypto');

const API_BASE = 'https://eclawbot.com';

// ── Load .env ────────────────────────────────────────────────────────────────

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

const env = loadEnv();
let DEVICE_ID, DEVICE_SECRET;
if (env.BROADCAST_TEST_DEVICE_ID && env.BROADCAST_TEST_DEVICE_SECRET) {
    DEVICE_ID     = env.BROADCAST_TEST_DEVICE_ID;
    DEVICE_SECRET = env.BROADCAST_TEST_DEVICE_SECRET;
} else if (env.TEST_DEVICE_ID && env.TEST_DEVICE_SECRET) {
    DEVICE_ID     = env.TEST_DEVICE_ID;
    DEVICE_SECRET = env.TEST_DEVICE_SECRET;
} else {
    console.error('ERROR: Set BROADCAST_TEST_DEVICE_ID+BROADCAST_TEST_DEVICE_SECRET in backend/.env');
    process.exit(1);
}

// ── Test Helpers ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function ok(condition, label) {
    if (condition) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.log(`  ❌ ${label}`);
        failed++;
    }
}

async function post(url, body) {
    const resp = await fetch(`${API_BASE}${url}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return { status: resp.status, data: await resp.json() };
}

async function get(url) {
    const resp = await fetch(`${API_BASE}${url}`);
    return { status: resp.status, data: await resp.json() };
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function testSubmitValidation() {
    console.log('\n[1] Submit — validation');

    // Missing requestId
    const r1 = await post('/api/ai-support/chat/submit', {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        message: 'Hello'
    });
    ok(r1.status === 400, 'Missing requestId → 400');

    // Invalid requestId (not UUID)
    const r2 = await post('/api/ai-support/chat/submit', {
        requestId: 'not-a-uuid',
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        message: 'Hello'
    });
    ok(r2.status === 400, 'Invalid requestId → 400');

    // Missing message
    const r3 = await post('/api/ai-support/chat/submit', {
        requestId: randomUUID(),
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET
    });
    ok(r3.status === 400, 'Missing message → 400');

    // Empty message
    const r4 = await post('/api/ai-support/chat/submit', {
        requestId: randomUUID(),
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        message: '   '
    });
    ok(r4.status === 400, 'Empty message → 400');
}

async function testSubmitAuth() {
    console.log('\n[2] Submit — authentication');

    // No credentials
    const r1 = await post('/api/ai-support/chat/submit', {
        requestId: randomUUID(),
        message: 'Hello'
    });
    ok(r1.status === 401, 'No credentials → 401');

    // Wrong credentials
    const r2 = await post('/api/ai-support/chat/submit', {
        requestId: randomUUID(),
        deviceId: DEVICE_ID,
        deviceSecret: 'wrong-secret-123',
        message: 'Hello'
    });
    ok(r2.status === 401, 'Wrong secret → 401');
}

async function testSubmitSuccess() {
    console.log('\n[3] Submit — success');

    const requestId = randomUUID();
    const r = await post('/api/ai-support/chat/submit', {
        requestId,
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        message: 'Say exactly: PONG',
        history: [],
        page: 'test'
    });
    ok(r.status === 200, `Submit returns 200 (status=${r.status})`);
    ok(r.data.success === true, 'success: true');
    ok(r.data.requestId === requestId, 'requestId matches');

    return requestId;
}

async function testSubmitIdempotency(requestId) {
    console.log('\n[4] Submit — idempotency');

    // Re-submit same requestId should return existing status
    const r = await post('/api/ai-support/chat/submit', {
        requestId,
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        message: 'Duplicate'
    });
    ok(r.status === 200, 'Duplicate requestId → 200');
    ok(r.data.success === true, 'success: true');
    ok(r.data.requestId === requestId, 'Same requestId returned');
}

async function testPollAuth() {
    console.log('\n[5] Poll — authentication');

    const fakeId = randomUUID();

    // No credentials
    const r1 = await get(`/api/ai-support/chat/poll/${fakeId}`);
    ok(r1.status === 401, 'Poll no credentials → 401');

    // Wrong credentials
    const r2 = await get(`/api/ai-support/chat/poll/${fakeId}?deviceId=${DEVICE_ID}&deviceSecret=wrong`);
    ok(r2.status === 401, 'Poll wrong secret → 401');
}

async function testPollNonExistent() {
    console.log('\n[6] Poll — non-existent request');

    const fakeId = randomUUID();
    const r = await get(`/api/ai-support/chat/poll/${fakeId}?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`);
    ok(r.status === 404 || (r.status === 200 && r.data.status === 'not_found'),
        `Non-existent requestId → 404 or not_found (got ${r.status}, status=${r.data.status})`);
}

async function testPollCompletion(requestId) {
    console.log('\n[7] Poll — wait for completion');

    const POLL_INTERVAL = 3000;
    const MAX_ATTEMPTS = 50;

    let finalStatus = null;
    for (let i = 1; i <= MAX_ATTEMPTS; i++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
        const r = await get(`/api/ai-support/chat/poll/${requestId}?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`);
        if (r.data.status === 'completed' || r.data.status === 'failed' || r.data.status === 'expired') {
            finalStatus = r.data;
            console.log(`    (Completed after ${i} polls, ${i * POLL_INTERVAL / 1000}s)`);
            break;
        }
        if (i % 5 === 0) {
            console.log(`    (Still polling... attempt ${i}, status=${r.data.status})`);
        }
    }

    ok(finalStatus !== null, 'Poll terminates within 150s');
    if (finalStatus) {
        ok(finalStatus.status === 'completed', `Final status: ${finalStatus.status}`);
        if (finalStatus.status === 'completed') {
            ok(typeof finalStatus.response === 'string' && finalStatus.response.length > 0, 'Response is non-empty string');
            ok(!finalStatus.busy, 'Not busy');
        }
    }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('=== AI Chat Submit/Poll Regression Test ===');
    console.log(`Server: ${API_BASE}`);
    console.log(`Device: ${DEVICE_ID}`);

    await testSubmitValidation();
    await testSubmitAuth();
    const requestId = await testSubmitSuccess();
    await testSubmitIdempotency(requestId);
    await testPollAuth();
    await testPollNonExistent();
    await testPollCompletion(requestId);

    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Test runner error:', err);
    process.exit(1);
});
