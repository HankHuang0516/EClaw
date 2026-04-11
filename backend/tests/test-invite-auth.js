/**
 * Regression test: Issue #1676 — /api/invite/my-code returns 500
 *
 * Root cause: invite.js JWT-auth router was mounted before index.js device-auth
 * routes, intercepting device-auth requests and returning 401/500.
 *
 * Fix: removed invite.js router mount; index.js routes now support both
 * device-auth (query params) and JWT cookie auth.
 *
 * Run: node backend/tests/test-invite-auth.js
 * Credentials: BROADCAST_TEST_DEVICE_ID + BROADCAST_TEST_DEVICE_SECRET
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const BASE = process.env.TEST_BASE_URL || 'https://eclawbot.com';
const DEVICE_ID = process.env.BROADCAST_TEST_DEVICE_ID;
const DEVICE_SECRET = process.env.BROADCAST_TEST_DEVICE_SECRET;

if (!DEVICE_ID || !DEVICE_SECRET) {
    console.error('Missing BROADCAST_TEST_DEVICE_ID or BROADCAST_TEST_DEVICE_SECRET');
    process.exit(1);
}

let passed = 0, failed = 0;

function assert(condition, label) {
    if (condition) { console.log(`  ✅ ${label}`); passed++; }
    else { console.error(`  ❌ ${label}`); failed++; }
}

async function run() {
    console.log('=== Issue #1676: Invite Auth Regression Test ===\n');

    // Test 1: GET /api/invite/my-code with device auth (settings.html pattern)
    console.log('Test 1: GET /api/invite/my-code with device auth');
    {
        const url = `${BASE}/api/invite/my-code?deviceId=${encodeURIComponent(DEVICE_ID)}&deviceSecret=${encodeURIComponent(DEVICE_SECRET)}`;
        const res = await fetch(url);
        const data = await res.json();
        assert(res.status === 200, `status 200 (got ${res.status})`);
        assert(data.success === true, 'success: true');
        assert(typeof data.code === 'string' && data.code.length >= 4, `code is string (got: ${data.code})`);
        assert(typeof data.bonus_messages === 'number' || data.bonus_messages !== undefined, 'bonus_messages present');
        assert(typeof data.total_invited === 'number' || data.total_invited !== undefined, 'total_invited present');
    }

    // Test 2: GET /api/invite/my-code without any auth → should return 401 not 500
    console.log('\nTest 2: GET /api/invite/my-code without auth');
    {
        const res = await fetch(`${BASE}/api/invite/my-code`);
        assert(res.status === 401, `status 401 (got ${res.status})`);
        assert(res.status !== 500, 'NOT 500 (was the original bug)');
    }

    // Test 3: GET /api/invite/my-code with wrong secret → 403
    console.log('\nTest 3: GET /api/invite/my-code with wrong secret');
    {
        const url = `${BASE}/api/invite/my-code?deviceId=${encodeURIComponent(DEVICE_ID)}&deviceSecret=wrong_secret`;
        const res = await fetch(url);
        assert(res.status === 403, `status 403 (got ${res.status})`);
    }

    // Test 4: GET /api/invite/stats with device auth
    console.log('\nTest 4: GET /api/invite/stats with device auth');
    {
        const url = `${BASE}/api/invite/stats?deviceId=${encodeURIComponent(DEVICE_ID)}&deviceSecret=${encodeURIComponent(DEVICE_SECRET)}`;
        const res = await fetch(url);
        const data = await res.json();
        assert(res.status === 200, `status 200 (got ${res.status})`);
        assert(data.success === true, 'success: true');
    }

    // Test 5: POST /api/invite/redeem with no code → 400
    console.log('\nTest 5: POST /api/invite/redeem with no code');
    {
        const res = await fetch(`${BASE}/api/invite/redeem`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET }),
        });
        assert(res.status === 400, `status 400 (got ${res.status})`);
    }

    // Test 6: POST /api/invite/redeem with invalid code → 404
    console.log('\nTest 6: POST /api/invite/redeem with invalid code');
    {
        const res = await fetch(`${BASE}/api/invite/redeem`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, code: 'ZZZZZZZZ' }),
        });
        const data = await res.json();
        assert(res.status === 404 || res.status === 400, `status 404/400 (got ${res.status})`);
    }

    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Test runner error:', err); process.exit(1); });
