/**
 * Regression Test: Entity Message Echo/Duplication Bug
 *
 * ROOT CAUSE:
 * When a bot responds, it calls multiple endpoints that each independently
 * save the same message to chat_messages DB:
 *   1. /api/entity/broadcast   -> saveChatMessage()
 *   2. /api/entity/speak-to    -> saveChatMessage()
 *   3. /api/bot/sync-message   -> saveChatMessage()
 *   4. /api/transform (message) -> saveChatMessage()
 *
 * When Chat UI queries /api/chat/history, ALL records are returned,
 * causing the same message to appear 2-3 times (echo).
 *
 * FIX: saveChatMessage() deduplicates bot messages — if an identical
 * (device_id, entity_id, text, is_from_bot) was saved within 10s, skip.
 *
 * This test verifies NO echo occurs in any combination.
 */

const API_BASE = process.env.API_BASE || 'https://eclaw.up.railway.app';

const TEST_DEVICE_ID = `echo-regression-${Date.now()}`;
const TEST_DEVICE_SECRET = `secret-${Date.now()}`;

let passed = 0;
let failed = 0;
let skipped = 0;
let boundEntities = []; // { entityId, botSecret }

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
            await sleep(150); // prevent rate limiting
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
        console.log(`  OK ${label}`);
        passed++;
    } else {
        console.log(`  FAIL ${label}${detail ? ': ' + JSON.stringify(detail) : ''}`);
        failed++;
    }
}

function skip(label, reason) {
    console.log(`  SKIP ${label} (${reason})`);
    skipped++;
}

/**
 * Query chat history and count how many times a specific text appears for an entity.
 */
async function countMessageOccurrences(text, entityId) {
    const history = await api('GET',
        `/api/chat/history?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}&limit=100`
    );
    if (!history.data.success || !history.data.messages) {
        return { count: -1, messages: [] }; // DB not available
    }
    const matching = history.data.messages.filter(m =>
        m.text === text && m.entity_id === entityId
    );
    return { count: matching.length, messages: matching };
}

// ==============================
// Setup
// ==============================

async function setup() {
    console.log('--- Setup: Create device with 2 bound entities ---\n');

    for (const entityId of [0, 1]) {
        const reg = await api('POST', '/api/device/register', {
            entityId, deviceId: TEST_DEVICE_ID, deviceSecret: TEST_DEVICE_SECRET, isTestDevice: true
        });
        assert(`Entity ${entityId} registered`, reg.data.success, reg.data);

        const bind = await api('POST', '/api/bind', { code: reg.data.bindingCode });
        assert(`Entity ${entityId} bound`, bind.data.success, bind.data);

        boundEntities.push({ entityId, botSecret: bind.data.botSecret });
        console.log(`  Entity ${entityId} botSecret: ${bind.data.botSecret?.substring(0, 8)}...`);
    }
}

// ==============================
// Test Cases
// ==============================

/**
 * Test 1: broadcast + sync-message must NOT produce duplicate
 */
async function testBroadcastPlusSyncNoEcho() {
    console.log('\n--- Test: broadcast + sync-message must NOT echo ---\n');

    const text = `no-echo-broadcast-${Date.now()}`;
    const entity = boundEntities[0];

    // Bot broadcasts to other entities
    const bcast = await api('POST', '/api/entity/broadcast', {
        deviceId: TEST_DEVICE_ID, fromEntityId: entity.entityId,
        botSecret: entity.botSecret, text
    });
    assert('broadcast succeeds', bcast.data.success, bcast.data);

    // Bot also calls sync-message with the SAME text (this caused the echo)
    const sync = await api('POST', '/api/bot/sync-message', {
        deviceId: TEST_DEVICE_ID, entityId: entity.entityId,
        botSecret: entity.botSecret, message: text
    });
    assert('sync-message succeeds', sync.data.success, sync.data);

    await sleep(500);

    const { count, messages } = await countMessageOccurrences(text, entity.entityId);
    if (count === -1) {
        skip('broadcast+sync dedup check', 'chat DB not available');
        return;
    }

    assert(
        `broadcast + sync-message: message appears exactly 1 time (got ${count})`,
        count === 1,
        { count, sources: messages.map(m => m.source) }
    );
}

/**
 * Test 2: speak-to + sync-message must NOT produce duplicate
 */
async function testSpeakToPlusSyncNoEcho() {
    console.log('\n--- Test: speak-to + sync-message must NOT echo ---\n');

    const text = `no-echo-speakto-${Date.now()}`;
    const sender = boundEntities[0];

    // Bot sends entity-to-entity message
    const speakTo = await api('POST', '/api/entity/speak-to', {
        deviceId: TEST_DEVICE_ID, fromEntityId: sender.entityId,
        toEntityId: 1, botSecret: sender.botSecret, text
    });
    assert('speak-to succeeds', speakTo.data.success, speakTo.data);

    // Bot also calls sync-message
    const sync = await api('POST', '/api/bot/sync-message', {
        deviceId: TEST_DEVICE_ID, entityId: sender.entityId,
        botSecret: sender.botSecret, message: text
    });
    assert('sync-message succeeds', sync.data.success, sync.data);

    await sleep(500);

    const { count, messages } = await countMessageOccurrences(text, sender.entityId);
    if (count === -1) {
        skip('speak-to+sync dedup check', 'chat DB not available');
        return;
    }

    assert(
        `speak-to + sync-message: message appears exactly 1 time (got ${count})`,
        count === 1,
        { count, sources: messages.map(m => m.source) }
    );
}

/**
 * Test 3: transform + sync-message must NOT produce duplicate
 */
async function testTransformPlusSyncNoEcho() {
    console.log('\n--- Test: transform + sync-message must NOT echo ---\n');

    const text = `no-echo-transform-${Date.now()}`;
    const entity = boundEntities[0];

    // Bot updates entity via transform (includes message)
    const transform = await api('POST', '/api/transform', {
        deviceId: TEST_DEVICE_ID, entityId: entity.entityId,
        botSecret: entity.botSecret, state: 'IDLE', message: text
    });
    assert('transform succeeds', transform.data.success !== false, transform.data);

    // Bot also calls sync-message
    const sync = await api('POST', '/api/bot/sync-message', {
        deviceId: TEST_DEVICE_ID, entityId: entity.entityId,
        botSecret: entity.botSecret, message: text
    });
    assert('sync-message succeeds', sync.data.success, sync.data);

    await sleep(500);

    const { count, messages } = await countMessageOccurrences(text, entity.entityId);
    if (count === -1) {
        skip('transform+sync dedup check', 'chat DB not available');
        return;
    }

    assert(
        `transform + sync-message: message appears exactly 1 time (got ${count})`,
        count === 1,
        { count, sources: messages.map(m => m.source) }
    );
}

/**
 * Test 4: Triple call (broadcast + transform + sync-message) must NOT produce triple echo
 */
async function testTripleCallNoEcho() {
    console.log('\n--- Test: broadcast + transform + sync-message must NOT echo ---\n');

    const text = `no-echo-triple-${Date.now()}`;
    const entity = boundEntities[0];

    // Bot calls all three endpoints with same text
    const bcast = await api('POST', '/api/entity/broadcast', {
        deviceId: TEST_DEVICE_ID, fromEntityId: entity.entityId,
        botSecret: entity.botSecret, text
    });
    assert('broadcast succeeds', bcast.data.success, bcast.data);

    const transform = await api('POST', '/api/transform', {
        deviceId: TEST_DEVICE_ID, entityId: entity.entityId,
        botSecret: entity.botSecret, state: 'IDLE', message: text
    });
    assert('transform succeeds', transform.data.success !== false, transform.data);

    const sync = await api('POST', '/api/bot/sync-message', {
        deviceId: TEST_DEVICE_ID, entityId: entity.entityId,
        botSecret: entity.botSecret, message: text
    });
    assert('sync-message succeeds', sync.data.success, sync.data);

    await sleep(500);

    const { count, messages } = await countMessageOccurrences(text, entity.entityId);
    if (count === -1) {
        skip('triple dedup check', 'chat DB not available');
        return;
    }

    assert(
        `triple call: message appears exactly 1 time (got ${count})`,
        count === 1,
        { count, sources: messages.map(m => m.source) }
    );
}

/**
 * Test 5: Different messages from same entity should still be saved individually
 * (dedup must NOT suppress legitimately different messages)
 */
async function testDifferentMessagesNotSuppressed() {
    console.log('\n--- Test: different messages must NOT be suppressed ---\n');

    const entity = boundEntities[0];
    const text1 = `different-msg-A-${Date.now()}`;
    const text2 = `different-msg-B-${Date.now()}`;

    await api('POST', '/api/bot/sync-message', {
        deviceId: TEST_DEVICE_ID, entityId: entity.entityId,
        botSecret: entity.botSecret, message: text1
    });

    await api('POST', '/api/bot/sync-message', {
        deviceId: TEST_DEVICE_ID, entityId: entity.entityId,
        botSecret: entity.botSecret, message: text2
    });

    await sleep(500);

    const result1 = await countMessageOccurrences(text1, entity.entityId);
    const result2 = await countMessageOccurrences(text2, entity.entityId);

    if (result1.count === -1) {
        skip('different messages check', 'chat DB not available');
        return;
    }

    assert(
        `message A saved exactly 1 time (got ${result1.count})`,
        result1.count === 1,
        { count: result1.count }
    );
    assert(
        `message B saved exactly 1 time (got ${result2.count})`,
        result2.count === 1,
        { count: result2.count }
    );
}

/**
 * Test 6: User messages (is_from_user=true) must NOT be affected by dedup
 */
async function testUserMessagesNotAffected() {
    console.log('\n--- Test: user messages must NOT be affected by dedup ---\n');

    const text = `user-msg-nodedup-${Date.now()}`;

    // Send same message from user twice (to same entity)
    await api('POST', '/api/client/speak', {
        deviceId: TEST_DEVICE_ID, entityId: 0, text, source: 'regression_test'
    });
    await api('POST', '/api/client/speak', {
        deviceId: TEST_DEVICE_ID, entityId: 0, text, source: 'regression_test'
    });

    await sleep(500);

    const history = await api('GET',
        `/api/chat/history?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}&limit=100`
    );

    if (!history.data.success) {
        skip('user message dedup-exempt check', 'chat DB not available');
        return;
    }

    const matching = (history.data.messages || []).filter(m =>
        m.text === text && m.entity_id === 0 && m.is_from_user
    );

    assert(
        `user messages NOT suppressed: both saved (got ${matching.length})`,
        matching.length === 2,
        { count: matching.length }
    );
}

/**
 * Test 7: Messages to different entities must NOT be deduped
 */
async function testDifferentEntitiesNotDeduped() {
    console.log('\n--- Test: same text to different entities must NOT be deduped ---\n');

    const text = `cross-entity-${Date.now()}`;
    const e0 = boundEntities[0];
    const e1 = boundEntities[1];

    await api('POST', '/api/bot/sync-message', {
        deviceId: TEST_DEVICE_ID, entityId: e0.entityId,
        botSecret: e0.botSecret, message: text
    });

    await api('POST', '/api/bot/sync-message', {
        deviceId: TEST_DEVICE_ID, entityId: e1.entityId,
        botSecret: e1.botSecret, message: text
    });

    await sleep(500);

    const r0 = await countMessageOccurrences(text, e0.entityId);
    const r1 = await countMessageOccurrences(text, e1.entityId);

    if (r0.count === -1) {
        skip('cross-entity dedup check', 'chat DB not available');
        return;
    }

    assert(
        `entity 0 has exactly 1 copy (got ${r0.count})`,
        r0.count === 1,
        { count: r0.count }
    );
    assert(
        `entity 1 has exactly 1 copy (got ${r1.count})`,
        r1.count === 1,
        { count: r1.count }
    );
}

// ==============================
// Runner
// ==============================

async function runAll() {
    console.log('='.repeat(60));
    console.log('Regression: Entity Message Echo/Duplication');
    console.log('='.repeat(60));
    console.log(`Target: ${API_BASE}`);
    console.log(`Device: ${TEST_DEVICE_ID}\n`);

    try {
        await setup();

        // Echo prevention tests (the bug)
        await testBroadcastPlusSyncNoEcho();
        await testSpeakToPlusSyncNoEcho();
        await testTransformPlusSyncNoEcho();
        await testTripleCallNoEcho();

        // Correctness: dedup must NOT suppress legitimate messages
        await testDifferentMessagesNotSuppressed();
        await testUserMessagesNotAffected();
        await testDifferentEntitiesNotDeduped();

        // Log / Telemetry API Verification
        console.log('\n--- Log / Telemetry API Verification ---\n');

        const telRes = await api('GET',
            `/api/device-telemetry?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}&type=api_req`
        );
        if (telRes.status === 200 && telRes.data.entries) {
            const actions = telRes.data.entries.map(e => e.action);
            assert('Telemetry captured API calls', telRes.data.entries.length > 0, { count: telRes.data.entries.length });
            assert('Telemetry logged POST /api/device/register', actions.some(a => a.includes('/api/device/register')));
            assert('Telemetry logged POST /api/entity/broadcast', actions.some(a => a.includes('/api/entity/broadcast')));
            assert('Telemetry logged POST /api/entity/speak-to', actions.some(a => a.includes('/api/entity/speak-to')));
            assert('Telemetry logged POST /api/transform', actions.some(a => a.includes('/api/transform')));
            assert('Telemetry logged POST /api/bot/sync-message', actions.some(a => a.includes('/api/bot/sync-message')));
            assert('Telemetry logged POST /api/client/speak', actions.some(a => a.includes('/api/client/speak')));
            assert('Telemetry logged GET /api/chat/history', actions.some(a => a.includes('/api/chat/history')));
            const withDuration = telRes.data.entries.filter(e => e.duration != null && e.duration > 0);
            assert('Telemetry entries include response duration', withDuration.length > 0, { withDuration: withDuration.length });
        } else {
            skip('Telemetry verification', 'API not available');
        }

        const logRes = await api('GET',
            `/api/logs?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}&limit=50`
        );
        assert('Server log API accessible', logRes.status === 200 && logRes.data.success, { status: logRes.status });

    } catch (e) {
        console.error('\nFATAL:', e.message);
        console.error(e.stack);
        process.exit(1);
    }

    // Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
    console.log('='.repeat(60));

    if (failed > 0) {
        console.log(`\n${failed} assertion(s) FAILED — echo bug may still exist`);
        process.exit(1);
    } else {
        console.log('\nAll echo regression tests passed');
        process.exit(0);
    }
}

runAll().catch(e => {
    console.error('FATAL:', e);
    process.exit(1);
});
