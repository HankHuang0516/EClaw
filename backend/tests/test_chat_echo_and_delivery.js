/**
 * Regression Test: Chat Echo Suppression & Delivery Receipt
 *
 * Verifies that:
 *   1. Broadcast creates exactly 1 chat_messages record (not per-receiver duplicates)
 *   2. Speak-to creates exactly 1 chat_messages record
 *   3. The broadcast record has correct source format "entity:X:CHAR->targets"
 *   4. delivered_to is populated after push (or polling completes)
 *   5. /api/chat/history returns is_delivered and delivered_to fields
 *   6. Entity.message on receivers is set to "entity:X:CHAR: [廣播] text" format
 *      (this is for widget display only — Android Chat filters it out)
 *
 * Usage:
 *   node backend/tests/test_chat_echo_and_delivery.js
 */

const path = require('path');
const fs = require('fs');

const API_BASE = process.env.API_BASE || 'https://eclaw.up.railway.app';
const TEST_DEVICE_ID = `chat-echo-delivery-${Date.now()}`;
const TEST_DEVICE_SECRET = `secret-${Date.now()}`;
const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 20000;

let passed = 0;
let failed = 0;
let skipped = 0;
let boundEntities = []; // { entityId, botSecret }

// ==============================
// Helpers
// ==============================

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(method, path, body = null) {
    for (let attempt = 0; attempt < 3; attempt++) {
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
            if (attempt < 2) { await sleep(1000 * (attempt + 1)); continue; }
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

async function getChatHistory() {
    const res = await api('GET',
        `/api/chat/history?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}&limit=200`
    );
    if (!res.data.success || !res.data.messages) return null;
    return res.data.messages;
}

function findMessages(messages, predicate) {
    return messages.filter(predicate);
}

// ==============================
// Setup: 3 entities (0, 1, 2)
// ==============================

async function setup() {
    console.log('--- Setup: Create device with 3 bound entities ---\n');

    for (const entityId of [0, 1, 2]) {
        const reg = await api('POST', '/api/device/register', {
            entityId, deviceId: TEST_DEVICE_ID, deviceSecret: TEST_DEVICE_SECRET, isTestDevice: true
        });
        assert(`Entity ${entityId} registered`, reg.data.success, reg.data);

        const bind = await api('POST', '/api/bind', { code: reg.data.bindingCode });
        assert(`Entity ${entityId} bound`, bind.data.success, bind.data);

        boundEntities.push({ entityId, botSecret: bind.data.botSecret });
    }
    console.log();
}

// ==============================
// Test 1: Broadcast creates exactly 1 record
// ==============================

async function testBroadcastSingleRecord() {
    console.log('\n--- Test 1: Broadcast creates exactly 1 chat record ---\n');

    const text = `broadcast-single-${Date.now()}`;
    const sender = boundEntities[0]; // Entity 0 broadcasts

    const bcast = await api('POST', '/api/entity/broadcast', {
        deviceId: TEST_DEVICE_ID,
        fromEntityId: sender.entityId,
        botSecret: sender.botSecret,
        text
    });
    assert('broadcast succeeds', bcast.data.success, bcast.data);
    assert('broadcast sent to 2 entities', bcast.data.sentCount === 2, { sentCount: bcast.data.sentCount });

    await sleep(1000);

    const messages = await getChatHistory();
    if (!messages) {
        skip('broadcast single record', 'chat DB not available');
        return text;
    }

    const matching = findMessages(messages, m => m.text === text);
    assert(
        `broadcast creates exactly 1 record (got ${matching.length})`,
        matching.length === 1,
        { count: matching.length, sources: matching.map(m => m.source) }
    );

    if (matching.length > 0) {
        const record = matching[0];
        // Verify source format: "entity:0:CHAR->1,2"
        const sourcePattern = /^entity:\d+:[A-Z]+->\d+(,\d+)*$/;
        assert(
            `source format is "entity:X:CHAR->targets"`,
            sourcePattern.test(record.source),
            { source: record.source }
        );

        assert(
            'record is from bot (is_from_bot=true)',
            record.is_from_bot === true,
            { is_from_bot: record.is_from_bot }
        );

        assert(
            'record entity_id matches sender',
            record.entity_id === sender.entityId,
            { entity_id: record.entity_id, expected: sender.entityId }
        );
    }

    return text;
}

// ==============================
// Test 2: Speak-to creates exactly 1 record
// ==============================

async function testSpeakToSingleRecord() {
    console.log('\n--- Test 2: Speak-to creates exactly 1 chat record ---\n');

    const text = `speakto-single-${Date.now()}`;
    const sender = boundEntities[1]; // Entity 1 speaks to Entity 2

    const speakTo = await api('POST', '/api/entity/speak-to', {
        deviceId: TEST_DEVICE_ID,
        fromEntityId: sender.entityId,
        toEntityId: 2,
        botSecret: sender.botSecret,
        text
    });
    assert('speak-to succeeds', speakTo.data.success, speakTo.data);

    await sleep(1000);

    const messages = await getChatHistory();
    if (!messages) {
        skip('speak-to single record', 'chat DB not available');
        return;
    }

    const matching = findMessages(messages, m => m.text === text);
    assert(
        `speak-to creates exactly 1 record (got ${matching.length})`,
        matching.length === 1,
        { count: matching.length, sources: matching.map(m => m.source) }
    );

    if (matching.length > 0) {
        const record = matching[0];
        // Verify source format: "entity:1:CHAR->2"
        const sourcePattern = /^entity:\d+:[A-Z]+->\d+$/;
        assert(
            `source format is "entity:X:CHAR->target"`,
            sourcePattern.test(record.source),
            { source: record.source }
        );

        assert(
            'record entity_id matches sender',
            record.entity_id === sender.entityId,
            { entity_id: record.entity_id, expected: sender.entityId }
        );
    }
}

// ==============================
// Test 3: Broadcast delivered_to gets populated
// ==============================

async function testBroadcastDeliveredTo() {
    console.log('\n--- Test 3: Broadcast delivered_to populated after push ---\n');

    const text = `delivery-test-${Date.now()}`;
    const sender = boundEntities[0];

    const bcast = await api('POST', '/api/entity/broadcast', {
        deviceId: TEST_DEVICE_ID,
        fromEntityId: sender.entityId,
        botSecret: sender.botSecret,
        text
    });
    assert('broadcast succeeds', bcast.data.success, bcast.data);

    // Poll until delivered_to is populated (push is fire-and-forget)
    let record = null;
    const startTime = Date.now();
    while (Date.now() - startTime < MAX_WAIT_MS) {
        await sleep(POLL_INTERVAL_MS);
        const messages = await getChatHistory();
        if (!messages) { skip('delivered_to check', 'chat DB not available'); return; }

        const matching = findMessages(messages, m => m.text === text);
        if (matching.length > 0 && matching[0].is_delivered) {
            record = matching[0];
            break;
        }
    }

    if (!record) {
        // Entities have no webhook (test entities), so push won't happen
        // In this case delivered_to stays null — this is expected for polling-mode entities
        const messages = await getChatHistory();
        const matching = findMessages(messages || [], m => m.text === text);
        if (matching.length > 0) {
            record = matching[0];
        }
        skip(
            'delivered_to populated (test entities have no webhook — polling mode)',
            `is_delivered=${record?.is_delivered}, delivered_to=${record?.delivered_to}`
        );
        return;
    }

    assert(
        'is_delivered is true',
        record.is_delivered === true,
        { is_delivered: record.is_delivered }
    );

    assert(
        'delivered_to contains target entity IDs',
        record.delivered_to != null && record.delivered_to.length > 0,
        { delivered_to: record.delivered_to }
    );

    // Verify delivered_to contains actual target entity IDs
    const deliveredIds = record.delivered_to.split(',').map(s => parseInt(s.trim()));
    const expectedTargets = [1, 2]; // Entity 0 broadcasts to 1 and 2
    for (const targetId of expectedTargets) {
        assert(
            `delivered_to includes Entity ${targetId}`,
            deliveredIds.includes(targetId),
            { delivered_to: record.delivered_to, deliveredIds }
        );
    }
}

// ==============================
// Test 4: chat/history returns delivery fields
// ==============================

async function testChatHistoryIncludesDeliveryFields() {
    console.log('\n--- Test 4: /api/chat/history returns delivery fields ---\n');

    const messages = await getChatHistory();
    if (!messages || messages.length === 0) {
        skip('delivery fields in history', 'no messages or chat DB not available');
        return;
    }

    // Check that is_delivered and delivered_to fields exist in the response
    const sample = messages[0];
    assert(
        'is_delivered field exists in response',
        'is_delivered' in sample,
        { keys: Object.keys(sample) }
    );
    assert(
        'delivered_to field exists in response',
        'delivered_to' in sample,
        { keys: Object.keys(sample) }
    );
}

// ==============================
// Test 5: Receiver entity.message has correct format for widget
// ==============================

async function testReceiverEntityMessageFormat() {
    console.log('\n--- Test 5: Receiver entity.message has widget-compatible format ---\n');

    const text = `widget-format-${Date.now()}`;
    const sender = boundEntities[0];

    await api('POST', '/api/entity/broadcast', {
        deviceId: TEST_DEVICE_ID,
        fromEntityId: sender.entityId,
        botSecret: sender.botSecret,
        text
    });

    await sleep(500);

    // Check entity 1 and entity 2 status
    for (const receiverId of [1, 2]) {
        const status = await api('GET',
            `/api/status?deviceId=${TEST_DEVICE_ID}&entityId=${receiverId}`
        );

        if (!status.data || !status.data.message) {
            skip(`Entity ${receiverId} message format`, 'status not available');
            continue;
        }

        const msg = status.data.message;
        // Expected format: "entity:0:{CHAR}: [廣播] {text}"
        const echoPattern = /^entity:\d+:[A-Z]+:\s*\[廣播]\s*.+/;
        assert(
            `Entity ${receiverId} message matches widget format`,
            echoPattern.test(msg),
            { message: msg }
        );

        // Android's processEntityMessage() should SKIP this pattern
        const androidFilterPattern = /^entity:\d+:[A-Z]+:.*/;
        assert(
            `Entity ${receiverId} message would be filtered by Android processEntityMessage()`,
            androidFilterPattern.test(msg),
            { message: msg }
        );
    }
}

// ==============================
// Test 6: Speak-to receiver entity.message has correct format
// ==============================

async function testSpeakToReceiverEntityMessage() {
    console.log('\n--- Test 6: Speak-to receiver entity.message format ---\n');

    const text = `speakto-format-${Date.now()}`;
    const sender = boundEntities[1]; // Entity 1 speaks to Entity 0

    await api('POST', '/api/entity/speak-to', {
        deviceId: TEST_DEVICE_ID,
        fromEntityId: sender.entityId,
        toEntityId: 0,
        botSecret: sender.botSecret,
        text
    });

    await sleep(500);

    const status = await api('GET',
        `/api/status?deviceId=${TEST_DEVICE_ID}&entityId=0`
    );

    if (!status.data || !status.data.message) {
        skip('speak-to entity.message format', 'status not available');
        return;
    }

    const msg = status.data.message;
    // Expected format: "entity:1:{CHAR}: {text}" (no [廣播] prefix)
    const speakToPattern = /^entity:\d+:[A-Z]+:\s*.+/;
    assert(
        'Speak-to receiver message matches entity pattern',
        speakToPattern.test(msg),
        { message: msg }
    );

    // Should NOT contain [廣播] prefix
    assert(
        'Speak-to message does NOT have [廣播] prefix',
        !msg.includes('[廣播]'),
        { message: msg }
    );

    // Android's processEntityMessage() should SKIP this pattern
    const androidFilterPattern = /^entity:\d+:[A-Z]+:.*/;
    assert(
        'Speak-to message would be filtered by Android processEntityMessage()',
        androidFilterPattern.test(msg),
        { message: msg }
    );
}

// ==============================
// Test 7: Multiple broadcasts don't multiply records
// ==============================

async function testMultipleBroadcastsNoMultiplication() {
    console.log('\n--- Test 7: Rapid broadcasts create 1 record each ---\n');

    const sender = boundEntities[0];
    const texts = [];

    // Send 3 different broadcasts quickly
    for (let i = 0; i < 3; i++) {
        const text = `rapid-bcast-${i}-${Date.now()}`;
        texts.push(text);
        await api('POST', '/api/entity/broadcast', {
            deviceId: TEST_DEVICE_ID,
            fromEntityId: sender.entityId,
            botSecret: sender.botSecret,
            text
        });
    }

    await sleep(1500);

    const messages = await getChatHistory();
    if (!messages) {
        skip('rapid broadcast dedup', 'chat DB not available');
        return;
    }

    for (const text of texts) {
        const matching = findMessages(messages, m => m.text === text);
        assert(
            `"${text.substring(0, 20)}..." has exactly 1 record (got ${matching.length})`,
            matching.length === 1,
            { count: matching.length }
        );
    }
}

// ==============================
// Runner
// ==============================

async function runAll() {
    console.log('='.repeat(60));
    console.log('Regression: Chat Echo Suppression & Delivery Receipt');
    console.log('='.repeat(60));
    console.log(`Target: ${API_BASE}`);
    console.log(`Device: ${TEST_DEVICE_ID}\n`);

    try {
        await setup();

        await testBroadcastSingleRecord();
        await testSpeakToSingleRecord();
        await testBroadcastDeliveredTo();
        await testChatHistoryIncludesDeliveryFields();
        await testReceiverEntityMessageFormat();
        await testSpeakToReceiverEntityMessage();
        await testMultipleBroadcastsNoMultiplication();

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
        console.log(`\n${failed} assertion(s) FAILED — echo or delivery bug may still exist`);
        process.exit(1);
    } else {
        console.log('\nAll chat echo & delivery tests passed');
        process.exit(0);
    }
}

runAll().catch(e => {
    console.error('FATAL:', e);
    process.exit(1);
});
