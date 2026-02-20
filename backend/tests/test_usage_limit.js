/**
 * Usage Limit Test
 *
 * Tests the daily message limit flow:
 * 1. Send 15 messages → should succeed (free tier limit)
 * 2. 16th message → should return 429 USAGE_LIMIT_EXCEEDED
 * 3. Simulate premium upgrade (via DB)
 * 4. Send 10 more messages → all should succeed (premium = no limit)
 *
 * Note: This test manipulates the usage_tracking table directly.
 *       It uses a unique test device to avoid interference.
 */

const API_BASE = process.env.API_BASE || 'https://eclaw.up.railway.app';

const TEST_DEVICE_ID = `test-usage-${Date.now()}`;
const TEST_DEVICE_SECRET = 'test-secret';
const DAILY_LIMIT = 15;

let passed = 0;
let failed = 0;
let boundEntity = null;

// ==============================
// Helpers
// ==============================

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, path, body = null, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const options = { method, headers: { 'Content-Type': 'application/json' } };
            if (body) options.body = JSON.stringify(body);
            const res = await fetch(`${API_BASE}${path}`, options);
            const text = await res.text();
            await sleep(150);
            try {
                return { status: res.status, data: JSON.parse(text) };
            } catch {
                return { status: res.status, data: text };
            }
        } catch (e) {
            if (attempt < retries) {
                await sleep(1000 * (attempt + 1));
                continue;
            }
            return { status: 0, data: { error: e.message } };
        }
    }
}

function assert(label, condition, detail) {
    if (condition) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.log(`  ❌ ${label}${detail ? ': ' + JSON.stringify(detail) : ''}`);
        failed++;
    }
}

async function sendMessage(text) {
    return api('POST', '/api/client/speak', {
        deviceId: TEST_DEVICE_ID,
        entityId: 0,
        text,
        source: 'test_usage_limit'
    });
}

// ==============================
// Setup
// ==============================

async function setup() {
    console.log('============================================================');
    console.log('USAGE LIMIT TEST');
    console.log('============================================================');
    console.log(`API Base: ${API_BASE}`);
    console.log(`Test Device: ${TEST_DEVICE_ID}`);
    console.log(`Daily Limit: ${DAILY_LIMIT}\n`);

    // Register and bind entity 0
    const { data: regData } = await api('POST', '/api/device/register', {
        deviceId: TEST_DEVICE_ID,
        deviceSecret: TEST_DEVICE_SECRET,
        entityId: 0,
        appVersion: '1.0.3',
        isTestDevice: true
    });

    const { data: bindData } = await api('POST', '/api/bind', {
        code: regData.bindingCode
    });

    boundEntity = { entityId: 0, botSecret: bindData.botSecret };
    console.log(`Setup: Entity 0 bound\n`);
}

// ==============================
// Tests
// ==============================

async function testFreeTierLimit() {
    console.log('--- Phase 1: Send 15 messages (free tier) ---');

    let successCount = 0;
    for (let i = 1; i <= DAILY_LIMIT; i++) {
        const { status, data } = await sendMessage(`usage-test-msg-${i}`);
        if (status === 200 && data.success) {
            successCount++;
        } else {
            console.log(`  ⚠️  Message ${i} failed unexpectedly: status=${status}`, data);
        }
    }
    assert(`${DAILY_LIMIT} messages sent successfully`, successCount === DAILY_LIMIT, { successCount });

    // 16th message should be rejected
    console.log('\n--- Phase 2: 16th message should be rejected ---');
    const { status, data } = await sendMessage('this-should-fail');

    assert('16th message returns 429', status === 429, { status });
    assert('error is USAGE_LIMIT_EXCEEDED', data.error === 'USAGE_LIMIT_EXCEEDED', data);
    assert('remaining is 0', data.remaining === 0, data);
    assert('limit matches daily limit', data.limit === DAILY_LIMIT, { limit: data.limit });

    // Send a few more to verify the limit persists
    const { status: s2 } = await sendMessage('still-blocked');
    assert('subsequent messages still blocked (429)', s2 === 429, { status: s2 });
}

async function testPremiumBypass() {
    console.log('\n--- Phase 3: Mark device as premium ---');

    // Use the debug endpoint to set premium (if available), or test via subscription status
    // The backend checks device.isPremium or user_accounts.subscription_status
    // For test devices, we use the /api/debug/set-premium endpoint if it exists,
    // otherwise we verify that the usage limit response format is correct.

    const { status: premStatus, data: premData } = await api('POST', '/api/debug/set-premium', {
        deviceId: TEST_DEVICE_ID,
        deviceSecret: TEST_DEVICE_SECRET,
        isPremium: true
    });

    if (premStatus === 200 && premData.success) {
        console.log('  Premium status set via debug endpoint');

        console.log('\n--- Phase 4: Send 10 more messages (premium, no limit) ---');
        let premiumSuccess = 0;
        for (let i = 1; i <= 10; i++) {
            const { status, data } = await sendMessage(`premium-test-msg-${i}`);
            if (status === 200 && data.success) {
                premiumSuccess++;
            } else {
                console.log(`  ⚠️  Premium message ${i} failed: status=${status}`, data);
            }
        }
        assert('10 premium messages sent successfully', premiumSuccess === 10, { premiumSuccess });

    } else if (premStatus === 404) {
        // Debug endpoint not available - skip premium test but verify limit format
        console.log('  ⏭️  /api/debug/set-premium not available (skipping premium bypass test)');
        console.log('  Verifying usage limit response format instead...');

        const { data } = await sendMessage('format-check');
        assert('usage limit response has error field', data.error === 'USAGE_LIMIT_EXCEEDED', data);
        assert('usage limit response has limit field', typeof data.limit === 'number', data);
        assert('usage limit response has remaining field', data.remaining === 0, data);
    } else {
        console.log(`  ⚠️  Unexpected response from set-premium: ${premStatus}`, premData);
        assert('premium endpoint accessible', false, { status: premStatus });
    }
}

async function testSubscriptionStatus() {
    console.log('\n--- Subscription status API ---');

    // Check subscription status endpoint exists (may require cookie auth)
    const { status } = await api('GET',
        `/api/subscription/status?deviceId=${TEST_DEVICE_ID}`
    );
    // Should return 200 or 401 (if auth required), not 404 or 500
    assert('subscription status endpoint exists (not 404/500)',
        status !== 404 && status !== 500, { status });
}

// ==============================
// Main
// ==============================

async function main() {
    try {
        await setup();
        await testFreeTierLimit();
        await testPremiumBypass();
        await testSubscriptionStatus();

        // Log / Telemetry API Verification
        console.log('\n--- Log / Telemetry API Verification ---');

        const telRes = await api('GET',
            `/api/device-telemetry?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}&type=api_req`
        );
        if (telRes.status === 200 && telRes.data.entries) {
            const actions = telRes.data.entries.map(e => e.action);
            assert('Telemetry captured API calls', telRes.data.entries.length > 0, { count: telRes.data.entries.length });
            assert('Telemetry logged POST /api/device/register', actions.some(a => a.includes('/api/device/register')));
            assert('Telemetry logged POST /api/client/speak', actions.some(a => a.includes('/api/client/speak')));
            const withDuration = telRes.data.entries.filter(e => e.duration != null && e.duration > 0);
            assert('Telemetry entries include response duration', withDuration.length > 0, { withDuration: withDuration.length });
        }

        const logRes = await api('GET',
            `/api/logs?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}&limit=50`
        );
        assert('Server log API accessible', logRes.status === 200 && logRes.data.success, { status: logRes.status });

        console.log('\n============================================================');
        console.log('USAGE LIMIT TEST SUMMARY');
        console.log('============================================================');
        console.log(`Results: ${passed} passed, ${failed} failed`);
        console.log('============================================================\n');

        if (failed > 0) {
            console.log('❌ Usage limit tests FAILED');
            process.exit(1);
        } else {
            console.log('✅ All usage limit tests passed');
            process.exit(0);
        }
    } catch (e) {
        console.error('Test crashed:', e);
        process.exit(1);
    }
}

main();
