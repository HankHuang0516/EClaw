/**
 * Screen Control Auth — Regression Test
 *
 * Verifies that the screen-capture and control endpoints accept
 * deviceSecret (portal/owner auth) WITHOUT requiring botSecret.
 *
 * Bug: Web Portal was sending botSecret=deviceSecret which fails
 * because botSecret is checked against entity.botSecret (different value).
 * Fix: Portal now sends deviceSecret directly.
 *
 * Test Scenarios:
 *  1. POST /api/device/screen-capture with deviceSecret → should NOT return "Invalid botSecret"
 *  2. POST /api/device/control with deviceSecret → should NOT return "Invalid botSecret"
 *  3. Missing both botSecret and deviceSecret → 400
 *  4. Wrong deviceSecret → should NOT authenticate as owner (falls through to bot auth)
 *
 * Usage:
 *   node test-screen-control-auth.js
 *   node test-screen-control-auth.js --local
 *
 * Credentials from backend/.env:
 *   BROADCAST_TEST_DEVICE_ID, BROADCAST_TEST_DEVICE_SECRET
 */

const path = require('path');
const fs   = require('fs');

const args    = process.argv.slice(2);
const isLocal = args.includes('--local');
const API_BASE = isLocal ? 'http://localhost:3000' : 'https://eclawbot.com';

// ── Load .env ────────────────────────────────────────────────────────────────
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}

const DEVICE_ID     = process.env.BROADCAST_TEST_DEVICE_ID;
const DEVICE_SECRET = process.env.BROADCAST_TEST_DEVICE_SECRET;

if (!DEVICE_ID || !DEVICE_SECRET) {
    console.error('Missing BROADCAST_TEST_DEVICE_ID / BROADCAST_TEST_DEVICE_SECRET in .env');
    process.exit(1);
}

let passed = 0, failed = 0;

function ok(label) { passed++; console.log(`  ✅ ${label}`); }
function fail(label, detail) { failed++; console.error(`  ❌ ${label} — ${detail}`); }

async function post(endpoint, body) {
    const res = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const json = await res.json();
    return { status: res.status, json };
}

async function run() {
    console.log(`\n🖥️  Screen Control Auth Tests — ${API_BASE}\n`);

    // Test 1: screen-capture with deviceSecret should NOT get "Invalid botSecret"
    {
        const { status, json } = await post('/api/device/screen-capture', {
            deviceId: DEVICE_ID,
            entityId: 0,
            deviceSecret: DEVICE_SECRET,
        });
        if (json.error === 'Invalid botSecret') {
            fail('screen-capture deviceSecret auth', `Got "Invalid botSecret" — owner auth not working`);
        } else {
            // Acceptable responses: device_offline (503), remote_control_disabled (403), or success
            // The key thing is we did NOT get "Invalid botSecret"
            ok(`screen-capture deviceSecret auth (status=${status}, result=${json.error || 'success'})`);
        }
    }

    // Test 2: control with deviceSecret should NOT get "Invalid botSecret"
    {
        const { status, json } = await post('/api/device/control', {
            deviceId: DEVICE_ID,
            entityId: 0,
            deviceSecret: DEVICE_SECRET,
            command: 'back',
        });
        if (json.error === 'Invalid botSecret') {
            fail('control deviceSecret auth', `Got "Invalid botSecret" — owner auth not working`);
        } else {
            ok(`control deviceSecret auth (status=${status}, result=${json.error || 'success'})`);
        }
    }

    // Test 3: missing both secrets → 400
    {
        const { status } = await post('/api/device/screen-capture', {
            deviceId: DEVICE_ID,
            entityId: 0,
        });
        status === 400
            ? ok('screen-capture missing secrets → 400')
            : fail('screen-capture missing secrets', `expected 400, got ${status}`);
    }

    // Test 4: wrong deviceSecret should not authenticate as owner
    {
        const { status, json } = await post('/api/device/screen-capture', {
            deviceId: DEVICE_ID,
            entityId: 0,
            deviceSecret: 'wrong-secret-value',
        });
        // Should fall through to bot auth and fail (no botSecret provided)
        // or get "Entity not bound" / "Invalid botSecret" — either way, not 2xx
        if (status >= 200 && status < 300) {
            fail('wrong deviceSecret rejected', `expected auth failure, got ${status}`);
        } else {
            ok(`wrong deviceSecret rejected (status=${status})`);
        }
    }

    // Summary
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`  Results: ${passed} passed, ${failed} failed`);
    console.log('─'.repeat(50) + '\n');
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
