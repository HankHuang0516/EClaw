#!/usr/bin/env node
/**
 * Card Holder Redesign regression test
 *
 * Tests new APIs: my-cards, recent, history-by-code, block/unblock, unified search.
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
        console.log(`  \u2713 ${msg}`);
    } else {
        failed++;
        console.error(`  \u2717 ${msg}`);
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
    console.log('Card Holder Redesign regression test');
    console.log(`Base: ${BASE}, Device: ${DEVICE_ID}\n`);

    // ── 1. GET /api/contacts/my-cards ──
    console.log('1. My Cards');
    const myCards = await api('GET', `/api/contacts/my-cards?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`);
    assert(myCards.status === 200, `GET /api/contacts/my-cards → ${myCards.status}`);
    assert(myCards.data.success === true, 'success: true');
    assert(Array.isArray(myCards.data.cards), 'cards is array');

    // Missing deviceId
    const myCardsBad = await api('GET', '/api/contacts/my-cards');
    assert(myCardsBad.status === 400, `GET /api/contacts/my-cards no deviceId → ${myCardsBad.status}`);

    // ── 2. GET /api/contacts/recent ──
    console.log('\n2. Recent Contacts');
    const recent = await api('GET', `/api/contacts/recent?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}&limit=10`);
    assert(recent.status === 200, `GET /api/contacts/recent → ${recent.status}`);
    assert(recent.data.success === true, 'success: true');
    assert(Array.isArray(recent.data.contacts), 'contacts is array');

    // Missing deviceId
    const recentBad = await api('GET', '/api/contacts/recent');
    assert(recentBad.status === 400, `GET /api/contacts/recent no deviceId → ${recentBad.status}`);

    // ── 3. GET /api/contacts/search (unified) ──
    console.log('\n3. Unified Search');
    const search = await api('GET', `/api/contacts/search?deviceId=${DEVICE_ID}&q=test`);
    assert(search.status === 200, `GET /api/contacts/search → ${search.status}`);
    assert(search.data.success === true, 'success: true');
    // Should have both saved and external in response
    assert('saved' in search.data || 'cards' in search.data, 'has saved or cards field');
    assert('external' in search.data, 'has external field');

    // Missing query
    const searchBad = await api('GET', `/api/contacts/search?deviceId=${DEVICE_ID}`);
    assert(searchBad.status === 400, `GET /api/contacts/search no query → ${searchBad.status}`);

    // ── 4. GET /api/chat/history-by-code ──
    console.log('\n4. Chat History by Code');
    const historyBad1 = await api('GET', '/api/chat/history-by-code');
    assert(historyBad1.status === 400, `GET /api/chat/history-by-code no params → ${historyBad1.status}`);

    const historyBad2 = await api('GET', `/api/chat/history-by-code?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`);
    assert(historyBad2.status === 400, `GET /api/chat/history-by-code no publicCode → ${historyBad2.status}`);

    const history = await api('GET', `/api/chat/history-by-code?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}&publicCode=nonexist&limit=10`);
    // Should return 200 with empty array or 404
    assert(history.status === 200 || history.status === 404, `GET /api/chat/history-by-code → ${history.status}`);
    if (history.status === 200) {
        assert(Array.isArray(history.data.messages), 'messages is array');
    }

    // ── 5. PATCH /api/contacts/:publicCode — blocked field ──
    console.log('\n5. Block/Unblock');
    // First get existing cards to test on
    const list = await api('GET', `/api/contacts?deviceId=${DEVICE_ID}`);
    const cards = list.data.contacts || [];
    if (cards.length > 0) {
        const testCode = cards[0].publicCode;

        // Block
        const blockRes = await api('PATCH', `/api/contacts/${testCode}`, {
            deviceId: DEVICE_ID,
            deviceSecret: DEVICE_SECRET,
            blocked: true,
        });
        assert(blockRes.status === 200, `PATCH blocked=true → ${blockRes.status}`);
        assert(blockRes.data.card?.blocked === true, 'card.blocked is true');

        // Verify blocked cards hidden from default list
        const listAfterBlock = await api('GET', `/api/contacts?deviceId=${DEVICE_ID}`);
        const blockedVisible = (listAfterBlock.data.contacts || []).find(c => c.publicCode === testCode);
        assert(!blockedVisible, 'blocked card not in default list');

        // Unblock
        const unblockRes = await api('PATCH', `/api/contacts/${testCode}`, {
            deviceId: DEVICE_ID,
            deviceSecret: DEVICE_SECRET,
            blocked: false,
        });
        assert(unblockRes.status === 200, `PATCH blocked=false → ${unblockRes.status}`);
        assert(unblockRes.data.card?.blocked === false, 'card.blocked is false');
    } else {
        console.log('  (no cards to test block/unblock)');
    }

    // ── 6. GET /api/contacts with includeBlocked ──
    console.log('\n6. Include Blocked');
    const listAll = await api('GET', `/api/contacts?deviceId=${DEVICE_ID}&includeBlocked=true`);
    assert(listAll.status === 200, `GET /api/contacts includeBlocked → ${listAll.status}`);

    // ── Summary ──
    console.log(`\n${'='.repeat(40)}`);
    console.log(`Passed: ${passed}  Failed: ${failed}`);
    process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
