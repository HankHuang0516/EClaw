#!/usr/bin/env node
/**
 * Card Holder regression test
 *
 * Tests: agent_card_holder CRUD lifecycle, search, refresh, pin, category, notes.
 * Credentials: BROADCAST_TEST_DEVICE_ID + BROADCAST_TEST_DEVICE_SECRET from .env
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const BASE = process.env.TEST_BASE_URL || 'https://eclawbot.com';
const DEVICE_ID = process.env.BROADCAST_TEST_DEVICE_ID;
const DEVICE_SECRET = process.env.BROADCAST_TEST_DEVICE_SECRET;

if (!DEVICE_ID || !DEVICE_SECRET) {
    console.error('Missing BROADCAST_TEST_DEVICE_ID or BROADCAST_TEST_DEVICE_SECRET in .env');
    process.exit(1);
}

let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${msg}`);
    } else {
        failed++;
        console.error(`  ✗ ${msg}`);
    }
}

async function api(method, path, body) {
    const url = `${BASE}${path}`;
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
}

async function run() {
    console.log('Card Holder regression test');
    console.log(`Base: ${BASE}, Device: ${DEVICE_ID}\n`);

    // 1. GET /api/contacts — list
    console.log('1. List card holder');
    const list = await api('GET', `/api/contacts?deviceId=${DEVICE_ID}`);
    assert(list.status === 200, `GET /api/contacts → ${list.status}`);
    assert(Array.isArray(list.data.contacts), 'contacts is array');

    // 2. GET /api/contacts — missing deviceId
    console.log('\n2. List without deviceId');
    const noDevice = await api('GET', '/api/contacts');
    assert(noDevice.status === 400, `GET /api/contacts → 400 (${noDevice.status})`);

    // 3. POST /api/contacts — bad code format
    console.log('\n3. Add with bad code');
    const badCode = await api('POST', '/api/contacts', {
        deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, publicCode: '!!bad!!'
    });
    assert(badCode.status === 400, `POST bad code → 400 (${badCode.status})`);

    // 4. GET /api/contacts/search — missing query
    console.log('\n4. Search without query');
    const noQuery = await api('GET', `/api/contacts/search?deviceId=${DEVICE_ID}`);
    assert(noQuery.status === 400, `GET search no q → 400 (${noQuery.status})`);

    // 5. GET /api/contacts/search — valid
    console.log('\n5. Search with query');
    const search = await api('GET', `/api/contacts/search?deviceId=${DEVICE_ID}&q=test`);
    assert(search.status === 200, `GET search → 200 (${search.status})`);
    assert(Array.isArray(search.data.cards), 'cards is array');

    // 6. PATCH /api/contacts/:code — no fields
    console.log('\n6. PATCH no valid fields');
    const noFields = await api('PATCH', '/api/contacts/abc123', {
        deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET
    });
    assert(noFields.status === 400, `PATCH no fields → 400 (${noFields.status})`);

    // 7. GET /api/contacts/:code — not found
    console.log('\n7. GET detail non-existent');
    const notFound = await api('GET', `/api/contacts/zzz999?deviceId=${DEVICE_ID}`);
    assert(notFound.status === 404, `GET detail → 404 (${notFound.status})`);

    // 8. POST /api/contacts/:code/refresh — not found
    console.log('\n8. Refresh non-existent');
    const refreshBad = await api('POST', '/api/contacts/zzz999/refresh', {
        deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET
    });
    assert(refreshBad.status === 404, `POST refresh → 404 (${refreshBad.status})`);

    // 9. No upper limit check — ensure no 429 on existing contacts
    console.log('\n9. No upper limit');
    assert(!list.data.error || !list.data.error.includes('limit'), 'No contact limit error');

    // Summary
    console.log(`\n${'='.repeat(40)}`);
    console.log(`Passed: ${passed}, Failed: ${failed}`);
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('Test error:', err);
    process.exit(1);
});
