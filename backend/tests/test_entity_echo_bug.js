/**
 * Test: Entity Message Echo/Duplication Bug
 *
 * ROOT CAUSE ANALYSIS:
 * When a bot responds to a message, the same text gets saved to chat_messages
 * multiple times through different endpoints:
 *
 * 1. /api/entity/broadcast  -> saveChatMessage(deviceId, fromId, text, "entity:X:CHAR->targets", false, true)
 *    OR /api/entity/speak-to -> saveChatMessage(deviceId, fromId, text, "entity:X:CHAR->Y", false, true)
 *
 * 2. /api/bot/sync-message  -> saveChatMessage(deviceId, entityId, text, "bot", false, true)
 *
 * 3. /api/transform (if message is set) -> saveChatMessage(deviceId, entityId, text, entityName, false, true)
 *
 * All three insert into chat_messages with the same entity_id and similar text.
 * When the Chat UI loads /api/chat/history, it gets ALL records, causing duplicates.
 *
 * REPRODUCTION:
 * 1. Setup device with 2 bound entities
 * 2. Entity 0 broadcasts a message (saves to chat_messages once)
 * 3. Entity 0 also calls sync-message with the same text (saves AGAIN)
 * 4. Query chat/history -> same message appears TWICE
 */

const BASE_URL = process.env.TEST_URL || 'https://eclaw.up.railway.app';

async function api(method, path, body = null) {
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(`${BASE_URL}${path}`, options);
    const text = await res.text();
    try {
        return { status: res.status, data: JSON.parse(text) };
    } catch {
        return { status: res.status, data: text };
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runEchoBugTest() {
    console.log('='.repeat(60));
    console.log('Entity Message Echo/Duplication Bug Test');
    console.log('='.repeat(60));
    console.log(`Target: ${BASE_URL}\n`);

    let passed = 0, failed = 0;

    // ============================================
    // Setup: Create device with 2 bound entities
    // ============================================
    console.log('--- Setup: Create device with 2 entities ---\n');

    const deviceId = `echo-test-${Date.now()}`;
    const deviceSecret = `secret-${Date.now()}`;

    // Register and bind Entity 0
    const reg0 = await api('POST', '/api/device/register', {
        entityId: 0, deviceId, deviceSecret, isTestDevice: true
    });
    const bind0 = await api('POST', '/api/bind', { code: reg0.data.bindingCode });
    const botSecret0 = bind0.data.botSecret;
    console.log(`Entity 0 bound, botSecret: ${botSecret0.substring(0, 8)}...`);

    // Register and bind Entity 1
    const reg1 = await api('POST', '/api/device/register', {
        entityId: 1, deviceId, deviceSecret, isTestDevice: true
    });
    const bind1 = await api('POST', '/api/bind', { code: reg1.data.bindingCode });
    const botSecret1 = bind1.data.botSecret;
    console.log(`Entity 1 bound, botSecret: ${botSecret1.substring(0, 8)}...`);

    // ============================================
    // Test 1: Broadcast + sync-message = DUPLICATE
    // ============================================
    console.log('\n--- Test 1: Broadcast + sync-message causes duplicate ---\n');

    const broadcastText = `Echo test broadcast ${Date.now()}`;

    // Step 1: Entity 0 broadcasts (this is what a bot does when it talks to other entities)
    console.log('1a. Entity 0 broadcasts message...');
    const bcast = await api('POST', '/api/entity/broadcast', {
        deviceId, fromEntityId: 0, botSecret: botSecret0, text: broadcastText
    });
    console.log(`    Broadcast result: ${bcast.data.success ? 'OK' : 'FAILED'}`);

    // Step 2: Entity 0 also calls sync-message (bot syncs its response to chat)
    console.log('1b. Entity 0 calls sync-message with SAME text...');
    const sync = await api('POST', '/api/bot/sync-message', {
        deviceId, entityId: 0, botSecret: botSecret0, message: broadcastText
    });
    console.log(`    Sync result: ${sync.data.success ? 'OK' : 'FAILED'}`);

    // Step 3: Check chat history for duplicates
    await sleep(500); // Wait for DB writes
    console.log('1c. Checking chat history for duplicates...');
    const history1 = await api('GET',
        `/api/chat/history?deviceId=${deviceId}&deviceSecret=${deviceSecret}&limit=50`
    );

    const matchingMsgs1 = (history1.data.messages || []).filter(m =>
        m.text === broadcastText && m.entity_id === 0
    );

    console.log(`    Messages with same text under entity 0: ${matchingMsgs1.length}`);
    matchingMsgs1.forEach((m, i) => {
        console.log(`      [${i}] source="${m.source}", is_from_bot=${m.is_from_bot}, id=${m.id}`);
    });

    if (matchingMsgs1.length > 1) {
        console.log('    BUG CONFIRMED: Same message saved multiple times!');
        console.log('    -> broadcast saved: source="entity:0:LOBSTER->1"');
        console.log('    -> sync-message saved: source="bot"');
        failed++;
    } else if (matchingMsgs1.length === 1) {
        console.log('    PASS: Message appears only once (dedup working)');
        passed++;
    } else {
        console.log('    SKIP: No messages found (chat DB may not be available)');
    }

    // ============================================
    // Test 2: speak-to + sync-message = DUPLICATE
    // ============================================
    console.log('\n--- Test 2: speak-to + sync-message causes duplicate ---\n');

    const speakToText = `Echo test speak-to ${Date.now()}`;

    // Step 1: Entity 0 speaks to Entity 1
    console.log('2a. Entity 0 speaks to Entity 1...');
    const speakTo = await api('POST', '/api/entity/speak-to', {
        deviceId, fromEntityId: 0, toEntityId: 1, botSecret: botSecret0, text: speakToText
    });
    console.log(`    Speak-to result: ${speakTo.data.success ? 'OK' : 'FAILED'}`);

    // Step 2: Entity 0 also syncs same message
    console.log('2b. Entity 0 calls sync-message with SAME text...');
    const sync2 = await api('POST', '/api/bot/sync-message', {
        deviceId, entityId: 0, botSecret: botSecret0, message: speakToText
    });
    console.log(`    Sync result: ${sync2.data.success ? 'OK' : 'FAILED'}`);

    // Step 3: Check for duplicates
    await sleep(500);
    console.log('2c. Checking chat history for duplicates...');
    const history2 = await api('GET',
        `/api/chat/history?deviceId=${deviceId}&deviceSecret=${deviceSecret}&limit=50`
    );

    const matchingMsgs2 = (history2.data.messages || []).filter(m =>
        m.text === speakToText && m.entity_id === 0
    );

    console.log(`    Messages with same text under entity 0: ${matchingMsgs2.length}`);
    matchingMsgs2.forEach((m, i) => {
        console.log(`      [${i}] source="${m.source}", is_from_bot=${m.is_from_bot}, id=${m.id}`);
    });

    if (matchingMsgs2.length > 1) {
        console.log('    BUG CONFIRMED: speak-to + sync-message = duplicate!');
        failed++;
    } else if (matchingMsgs2.length === 1) {
        console.log('    PASS: Message appears only once');
        passed++;
    }

    // ============================================
    // Test 3: transform + sync-message = DUPLICATE
    // ============================================
    console.log('\n--- Test 3: transform (with message) + sync-message causes duplicate ---\n');

    const transformText = `Echo test transform ${Date.now()}`;

    // Step 1: Entity 0 updates via transform with a message
    console.log('3a. Entity 0 calls transform with message...');
    const transform = await api('POST', '/api/transform', {
        deviceId, entityId: 0, botSecret: botSecret0,
        state: 'IDLE', message: transformText
    });
    console.log(`    Transform result: ${transform.data.success ? 'OK' : 'FAILED'}`);

    // Step 2: Entity 0 also syncs same message
    console.log('3b. Entity 0 calls sync-message with SAME text...');
    const sync3 = await api('POST', '/api/bot/sync-message', {
        deviceId, entityId: 0, botSecret: botSecret0, message: transformText
    });
    console.log(`    Sync result: ${sync3.data.success ? 'OK' : 'FAILED'}`);

    // Step 3: Check for duplicates
    await sleep(500);
    console.log('3c. Checking chat history for duplicates...');
    const history3 = await api('GET',
        `/api/chat/history?deviceId=${deviceId}&deviceSecret=${deviceSecret}&limit=50`
    );

    const matchingMsgs3 = (history3.data.messages || []).filter(m =>
        m.text === transformText && m.entity_id === 0
    );

    console.log(`    Messages with same text under entity 0: ${matchingMsgs3.length}`);
    matchingMsgs3.forEach((m, i) => {
        console.log(`      [${i}] source="${m.source}", is_from_bot=${m.is_from_bot}, id=${m.id}`);
    });

    if (matchingMsgs3.length > 1) {
        console.log('    BUG CONFIRMED: transform + sync-message = duplicate!');
        failed++;
    } else if (matchingMsgs3.length === 1) {
        console.log('    PASS: Message appears only once');
        passed++;
    }

    // ============================================
    // Test 4: Triple duplicate (broadcast + transform + sync-message)
    // ============================================
    console.log('\n--- Test 4: Triple duplicate (broadcast + transform + sync-message) ---\n');

    const tripleText = `Echo test triple ${Date.now()}`;

    console.log('4a. Entity 0 broadcasts...');
    await api('POST', '/api/entity/broadcast', {
        deviceId, fromEntityId: 0, botSecret: botSecret0, text: tripleText
    });

    console.log('4b. Entity 0 calls transform...');
    await api('POST', '/api/transform', {
        deviceId, entityId: 0, botSecret: botSecret0,
        state: 'IDLE', message: tripleText
    });

    console.log('4c. Entity 0 calls sync-message...');
    await api('POST', '/api/bot/sync-message', {
        deviceId, entityId: 0, botSecret: botSecret0, message: tripleText
    });

    await sleep(500);
    console.log('4d. Checking chat history...');
    const history4 = await api('GET',
        `/api/chat/history?deviceId=${deviceId}&deviceSecret=${deviceSecret}&limit=50`
    );

    const matchingMsgs4 = (history4.data.messages || []).filter(m =>
        m.text === tripleText && m.entity_id === 0
    );

    console.log(`    Messages with same text under entity 0: ${matchingMsgs4.length}`);
    matchingMsgs4.forEach((m, i) => {
        console.log(`      [${i}] source="${m.source}", is_from_bot=${m.is_from_bot}, id=${m.id}`);
    });

    if (matchingMsgs4.length >= 3) {
        console.log('    BUG CONFIRMED: TRIPLE duplicate! broadcast + transform + sync-message all saved independently.');
        failed++;
    } else if (matchingMsgs4.length > 1) {
        console.log(`    BUG CONFIRMED: ${matchingMsgs4.length}x duplicate`);
        failed++;
    } else if (matchingMsgs4.length === 1) {
        console.log('    PASS: Message appears only once');
        passed++;
    }

    // ============================================
    // Summary
    // ============================================
    console.log(`\n${'='.repeat(60)}`);
    console.log('ROOT CAUSE SUMMARY');
    console.log('='.repeat(60));
    console.log(`
The echo bug occurs because the bot calls MULTIPLE endpoints
that each independently save the same message to chat_messages DB:

  1. /api/entity/broadcast   -> saveChatMessage() [line 1896]
  2. /api/entity/speak-to    -> saveChatMessage() [line 1754]
  3. /api/bot/sync-message   -> saveChatMessage() [line 3884]
  4. /api/transform (message) -> saveChatMessage() [line 1240]

When the Chat UI queries /api/chat/history, ALL records are returned,
causing the same message to appear 2-3 times.

FIX: Add deduplication in sync-message and transform endpoints -
skip saving to chat_messages if a recent identical message
(same entity_id, same text, is_from_bot=true) was already saved
within the last few seconds.
`);

    console.log(`Result: ${passed}/${passed + failed} tests passed`);
    if (failed > 0) {
        console.log(`${failed} duplication bug(s) confirmed`);
    }
    console.log('='.repeat(60));
}

runEchoBugTest().catch(console.error);
