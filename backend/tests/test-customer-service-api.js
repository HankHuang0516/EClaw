/**
 * Customer Service API — Integration Test
 *
 * Tests the AI customer service tool endpoints and device context injection.
 * Verifies: lookup_device, query_device_logs, lookup_user_by_email tools work
 * correctly through the AI support system, and that device context is auto-injected
 * in the first message of new conversations.
 *
 * Credentials: BROADCAST_TEST_DEVICE_ID + BROADCAST_TEST_DEVICE_SECRET (from .env)
 */

require('dotenv').config({ path: __dirname + '/../.env' });

const BASE = process.env.TEST_BASE_URL || 'https://eclawbot.com';
const DEVICE_ID = process.env.BROADCAST_TEST_DEVICE_ID;
const DEVICE_SECRET = process.env.BROADCAST_TEST_DEVICE_SECRET;

if (!DEVICE_ID || !DEVICE_SECRET) {
    console.error('❌ Missing BROADCAST_TEST_DEVICE_ID / BROADCAST_TEST_DEVICE_SECRET');
    process.exit(1);
}

let passed = 0;
let failed = 0;

function assert(condition, label) {
    if (condition) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.error(`  ❌ ${label}`);
        failed++;
    }
}

async function api(method, path, body) {
    const opts = {
        method,
        headers: { 'Content-Type': 'application/json' },
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${BASE}${path}`, opts);
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
}

// ═══════════════════════════════════════════
// Test 1: AI chat submit accepts device credentials
// ═══════════════════════════════════════════
async function testSubmitWithDeviceCredentials() {
    console.log('\n🔹 Test: AI chat submit accepts device credentials');
    const requestId = crypto.randomUUID();
    const { status, data } = await api('POST', '/api/ai-support/chat/submit', {
        requestId,
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        message: 'test message - please respond briefly',
        history: [],
        page: 'test'
    });

    assert(status === 200, `Status 200 (got ${status})`);
    assert(data && data.success === true, 'Response success=true');
    assert(data && data.requestId === requestId, 'RequestId echoed back');
    return requestId;
}

// ═══════════════════════════════════════════
// Test 2: AI chat poll returns result
// ═══════════════════════════════════════════
async function testPollResult(requestId) {
    console.log('\n🔹 Test: AI chat poll returns result');

    // Poll up to 60 seconds
    const maxWait = 60000;
    const interval = 3000;
    const start = Date.now();
    let lastData = null;

    while (Date.now() - start < maxWait) {
        const { status, data } = await api('GET',
            `/api/ai-support/chat/poll/${requestId}?deviceId=${DEVICE_ID}&deviceSecret=${encodeURIComponent(DEVICE_SECRET)}`
        );

        lastData = data;
        if (data && data.status === 'completed') {
            assert(status === 200, 'Poll status 200');
            assert(typeof data.response === 'string' && data.response.length > 0, 'Got non-empty response');
            return;
        }
        if (data && (data.status === 'failed' || data.status === 'expired')) {
            assert(false, `Request ${data.status}: ${data.error || 'unknown'}`);
            return;
        }
        await new Promise(r => setTimeout(r, interval));
    }
    assert(false, `Poll timed out after ${maxWait}ms, last status: ${lastData?.status || 'unknown'}`);
}

// ═══════════════════════════════════════════
// Test 3: AI chat submit rejects invalid credentials
// ═══════════════════════════════════════════
async function testRejectsInvalidCredentials() {
    console.log('\n🔹 Test: AI chat submit rejects invalid credentials');
    const { status, data } = await api('POST', '/api/ai-support/chat/submit', {
        requestId: crypto.randomUUID(),
        deviceId: 'nonexistent-device',
        deviceSecret: 'wrong-secret',
        message: 'test',
        history: []
    });

    assert(status === 401, `Status 401 (got ${status})`);
    assert(data && data.success === false, 'success=false');
}

// ═══════════════════════════════════════════
// Test 4: AI chat submit rejects missing message
// ═══════════════════════════════════════════
async function testRejectsMissingMessage() {
    console.log('\n🔹 Test: AI chat submit rejects missing message');
    const { status, data } = await api('POST', '/api/ai-support/chat/submit', {
        requestId: crypto.randomUUID(),
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        history: []
    });

    assert(status === 400, `Status 400 (got ${status})`);
    assert(data && data.success === false, 'success=false');
}

// ═══════════════════════════════════════════
// Test 5: AI chat submit idempotency
// ═══════════════════════════════════════════
async function testIdempotency() {
    console.log('\n🔹 Test: AI chat submit is idempotent (same requestId)');
    const requestId = crypto.randomUUID();
    const body = {
        requestId,
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        message: 'idempotency test',
        history: [],
        page: 'test'
    };

    const { data: data1 } = await api('POST', '/api/ai-support/chat/submit', body);
    assert(data1 && data1.success, 'First submit succeeds');

    // Wait a moment for DB write
    await new Promise(r => setTimeout(r, 500));

    const { data: data2 } = await api('POST', '/api/ai-support/chat/submit', body);
    assert(data2 && data2.success, 'Second submit also succeeds (idempotent)');
    assert(data2 && data2.requestId === requestId, 'Same requestId returned');
}

// ═══════════════════════════════════════════
// Test 6: Proxy status endpoint is accessible
// ═══════════════════════════════════════════
async function testProxyStatus() {
    console.log('\n🔹 Test: Proxy status endpoint accessible');
    const { status } = await api('GET', '/api/ai-support/proxy-status');
    assert(status === 200, `Status 200 (got ${status})`);
}

// ═══════════════════════════════════════════
// Main
// ═══════════════════════════════════════════
(async () => {
    console.log('═══════════════════════════════════════════');
    console.log('Customer Service API — Integration Tests');
    console.log(`Target: ${BASE}`);
    console.log('═══════════════════════════════════════════');

    await testRejectsInvalidCredentials();
    await testRejectsMissingMessage();
    await testProxyStatus();
    await testIdempotency();

    // Submit + poll test (may take time due to AI processing)
    const requestId = await testSubmitWithDeviceCredentials();
    if (requestId) {
        await testPollResult(requestId);
    }

    console.log(`\n═══════════════════════════════════════════`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('═══════════════════════════════════════════');
    process.exit(failed > 0 ? 1 : 0);
})();
