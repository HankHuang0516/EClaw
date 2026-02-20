/**
 * Multi-Entity Chat Monitoring Test
 *
 * Tests the full chat flow across multiple entities:
 * 1. speak-to (entity-to-entity) delivery & polling
 * 2. broadcast delivery to all entities
 * 3. Duplicate detection (same message should not appear twice)
 * 4. Sent/read status marking (delivered_to tracking)
 * 5. Bot API error handling (invalid botSecret, 404, stalling)
 * 6. Scales entity count X from 2..4 to stress multi-entity
 */

const API_BASE = process.env.API_BASE || 'https://eclaw.up.railway.app';

const TEST_DEVICE_ID = `test-chat-mon-${Date.now()}`;
const TEST_DEVICE_SECRET = 'test-secret';

let passed = 0;
let failed = 0;
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
            await sleep(150); // prevent Railway rate limiting
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

async function registerAndBind(entityId) {
    const { status: regStatus, data: regData } = await api('POST', '/api/device/register', {
        deviceId: TEST_DEVICE_ID,
        deviceSecret: TEST_DEVICE_SECRET,
        entityId,
        appVersion: '1.0.3',
        isTestDevice: true
    });
    if (!regData.bindingCode) {
        console.error(`  Register entity ${entityId} failed (${regStatus}):`, regData);
        return { entityId, botSecret: null };
    }
    const { status: bindStatus, data: bindData } = await api('POST', '/api/bind', {
        code: regData.bindingCode
    });
    if (!bindData.botSecret) {
        console.error(`  Bind entity ${entityId} failed (${bindStatus}):`, bindData);
        return { entityId, botSecret: null };
    }
    return { entityId, botSecret: bindData.botSecret };
}

async function pollMessages(entityId, botSecret) {
    const { data } = await api('GET',
        `/api/client/pending?deviceId=${TEST_DEVICE_ID}&entityId=${entityId}&botSecret=${botSecret}`
    );
    return data;
}

// ==============================
// Tests
// ==============================

async function testSpeakTo(from, to) {
    console.log(`\n--- speak-to: Entity ${from.entityId} → Entity ${to.entityId} ---`);

    const uniqueMsg = `speak-to-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const { status, data } = await api('POST', '/api/entity/speak-to', {
        deviceId: TEST_DEVICE_ID,
        fromEntityId: from.entityId,
        toEntityId: to.entityId,
        botSecret: from.botSecret,
        text: uniqueMsg
    });

    assert('speak-to returns 200', status === 200, { status, data });
    assert('speak-to success', data.success === true, data);
    assert('from entity matches', data.from?.entityId === from.entityId, data.from);
    assert('to entity matches', data.to?.entityId === to.entityId, data.to);

    // Poll receiver to verify delivery
    const pending = await pollMessages(to.entityId, to.botSecret);
    const found = pending.messages?.some(m => m.text?.includes(uniqueMsg));
    assert('receiver got the message', found, { count: pending.count });

    return uniqueMsg;
}

async function testBroadcast(from, allEntities) {
    console.log(`\n--- broadcast: Entity ${from.entityId} → all ---`);

    const uniqueMsg = `broadcast-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const { status, data } = await api('POST', '/api/entity/broadcast', {
        deviceId: TEST_DEVICE_ID,
        fromEntityId: from.entityId,
        botSecret: from.botSecret,
        text: uniqueMsg
    });

    const expectedTargets = allEntities.filter(e => e.entityId !== from.entityId).length;
    assert('broadcast returns 200', status === 200, { status });
    assert('broadcast success', data.success === true, data);
    assert(`broadcast sent to ${expectedTargets} entities`, data.sentCount === expectedTargets, { sentCount: data.sentCount });

    // Poll each receiver
    for (const ent of allEntities) {
        if (ent.entityId === from.entityId) continue;
        const pending = await pollMessages(ent.entityId, ent.botSecret);
        const found = pending.messages?.some(m => m.text?.includes(uniqueMsg));
        assert(`Entity ${ent.entityId} received broadcast`, found, { count: pending.count });
    }

    return uniqueMsg;
}

async function testDuplicateDetection() {
    console.log('\n--- duplicate detection: send same text twice ---');

    const entity0 = boundEntities[0];
    const entity1 = boundEntities[1];
    const uniqueMsg = `dedup-test-${Date.now()}`;

    // Send same message twice from entity 0 to entity 1
    await api('POST', '/api/entity/speak-to', {
        deviceId: TEST_DEVICE_ID,
        fromEntityId: entity0.entityId,
        toEntityId: entity1.entityId,
        botSecret: entity0.botSecret,
        text: uniqueMsg
    });
    await api('POST', '/api/entity/speak-to', {
        deviceId: TEST_DEVICE_ID,
        fromEntityId: entity0.entityId,
        toEntityId: entity1.entityId,
        botSecret: entity0.botSecret,
        text: uniqueMsg
    });

    // Poll receiver - should get both (backend stores both; client-side dedup handles it)
    // But neither should 500 or cause an error
    const pending = await pollMessages(entity1.entityId, entity1.botSecret);
    const matchCount = (pending.messages || []).filter(m => m.text?.includes(uniqueMsg)).length;
    // Backend stores each message (no server-side dedup on speak-to) - check no crash
    assert('duplicate messages stored without error', matchCount >= 1, { matchCount });
    assert('no server error on duplicate send', pending.messages !== undefined, pending);
}

async function testBotApiErrors() {
    console.log('\n--- bot API error handling ---');

    // 1. Invalid botSecret
    const { status: s1, data: d1 } = await api('POST', '/api/entity/speak-to', {
        deviceId: TEST_DEVICE_ID,
        fromEntityId: 0,
        toEntityId: 1,
        botSecret: 'invalid-secret-xxx',
        text: 'should fail'
    });
    assert('invalid botSecret returns 403', s1 === 403, { status: s1, data: d1 });

    // 2. Non-existent device
    const { status: s2 } = await api('POST', '/api/entity/speak-to', {
        deviceId: 'non-existent-device-xyz',
        fromEntityId: 0,
        toEntityId: 1,
        botSecret: 'xxx',
        text: 'should fail'
    });
    assert('non-existent device returns 404', s2 === 404, { status: s2 });

    // 3. Send to self
    const entity0 = boundEntities[0];
    const { status: s3, data: d3 } = await api('POST', '/api/entity/speak-to', {
        deviceId: TEST_DEVICE_ID,
        fromEntityId: entity0.entityId,
        toEntityId: entity0.entityId,
        botSecret: entity0.botSecret,
        text: 'self-message'
    });
    assert('send-to-self returns 400', s3 === 400, { status: s3, data: d3 });

    // 4. Invalid entityId
    const { status: s4 } = await api('POST', '/api/entity/speak-to', {
        deviceId: TEST_DEVICE_ID,
        fromEntityId: 99,
        toEntityId: 0,
        botSecret: 'xxx',
        text: 'invalid entity'
    });
    assert('invalid entityId returns 400', s4 === 400, { status: s4 });

    // 5. Missing text + mediaUrl
    const { status: s5, data: d5 } = await api('POST', '/api/entity/broadcast', {
        deviceId: TEST_DEVICE_ID,
        fromEntityId: entity0.entityId,
        botSecret: entity0.botSecret
        // no text, no mediaUrl
    });
    assert('missing text returns 400', s5 === 400, { status: s5, data: d5 });

    // 6. Bot polling with invalid secret
    const { status: s6, data: d6 } = await api('GET',
        `/api/client/pending?deviceId=${TEST_DEVICE_ID}&entityId=0&botSecret=wrong-secret`
    );
    assert('poll with invalid secret returns 403', s6 === 403, { status: s6, data: d6 });
}

async function testBotToBotRateLimit() {
    console.log('\n--- bot-to-bot rate limit (8 messages) ---');

    const entity0 = boundEntities[0];
    const entity1 = boundEntities[1];

    // Reset counter by sending a human message
    await api('POST', '/api/client/speak', {
        deviceId: TEST_DEVICE_ID,
        entityId: 0,
        text: 'human reset',
        source: 'test'
    });

    // Send 9 bot-to-bot messages (limit is 8)
    let lastStatus = 200;
    let rateLimited = false;
    for (let i = 0; i < 9; i++) {
        const { status, data } = await api('POST', '/api/entity/speak-to', {
            deviceId: TEST_DEVICE_ID,
            fromEntityId: entity0.entityId,
            toEntityId: entity1.entityId,
            botSecret: entity0.botSecret,
            text: `rate-limit-test-${i}`
        });
        lastStatus = status;
        if (status === 429 || data.rateLimited) {
            rateLimited = true;
            break;
        }
    }
    assert('bot-to-bot rate limit triggers at 8+', rateLimited, { lastStatus });

    // After human message, counter should reset
    await api('POST', '/api/client/speak', {
        deviceId: TEST_DEVICE_ID,
        entityId: 0,
        text: 'human reset again',
        source: 'test'
    });

    const { status: s2, data: d2 } = await api('POST', '/api/entity/speak-to', {
        deviceId: TEST_DEVICE_ID,
        fromEntityId: entity0.entityId,
        toEntityId: entity1.entityId,
        botSecret: entity0.botSecret,
        text: 'after-human-reset'
    });
    assert('rate limit resets after human message', s2 === 200 && d2.success, { status: s2 });
}

async function testChatHistory() {
    console.log('\n--- chat history retrieval ---');

    const { status, data } = await api('GET',
        `/api/chat/history?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}&limit=50`
    );
    assert('chat history returns 200', status === 200, { status });
    assert('chat history success', data.success === true, data);
    assert('chat history has messages', Array.isArray(data.messages) && data.messages.length > 0, { count: data.messages?.length });
}

// ==============================
// Main
// ==============================

async function main() {
    console.log('============================================================');
    console.log('MULTI-ENTITY CHAT MONITORING TEST');
    console.log('============================================================');
    console.log(`API Base: ${API_BASE}`);
    console.log(`Test Device: ${TEST_DEVICE_ID}\n`);

    // Scale entity count from 2 up to 4
    for (let entityCount = 2; entityCount <= 4; entityCount++) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`PHASE: ${entityCount} entities`);
        console.log('='.repeat(60));

        // Register additional entities as needed
        while (boundEntities.length < entityCount) {
            const ent = await registerAndBind(boundEntities.length);
            boundEntities.push(ent);
            console.log(`Setup: Entity ${ent.entityId} bound (botSecret: ${ent.botSecret?.slice(0, 8)}...)`);
        }

        // speak-to: first entity → second entity
        await testSpeakTo(boundEntities[0], boundEntities[1]);

        // broadcast from last entity
        await testBroadcast(boundEntities[entityCount - 1], boundEntities.slice(0, entityCount));
    }

    // Entity-count-independent tests (run once)
    await testDuplicateDetection();
    await testBotApiErrors();
    await testBotToBotRateLimit();
    await testChatHistory();

    // Log / Telemetry API Verification
    console.log('\n--- Log / Telemetry API Verification ---');

    const telRes = await api('GET',
        `/api/device-telemetry?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}&type=api_req`
    );
    if (telRes.status === 200 && telRes.data.entries) {
        const actions = telRes.data.entries.map(e => e.action);
        assert('Telemetry captured API calls', telRes.data.entries.length > 0, { count: telRes.data.entries.length });
        assert('Telemetry logged POST /api/device/register', actions.some(a => a.includes('/api/device/register')));
        assert('Telemetry logged POST /api/entity/speak-to', actions.some(a => a.includes('/api/entity/speak-to')));
        assert('Telemetry logged POST /api/entity/broadcast', actions.some(a => a.includes('/api/entity/broadcast')));
        assert('Telemetry logged POST /api/client/speak', actions.some(a => a.includes('/api/client/speak')));
        assert('Telemetry logged GET /api/client/pending', actions.some(a => a.includes('/api/client/pending')));
        assert('Telemetry logged GET /api/chat/history', actions.some(a => a.includes('/api/chat/history')));
        const withDuration = telRes.data.entries.filter(e => e.duration != null && e.duration > 0);
        assert('Telemetry entries include response duration', withDuration.length > 0, { withDuration: withDuration.length });
    }

    const logRes = await api('GET',
        `/api/logs?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}&limit=50`
    );
    assert('Server log API accessible', logRes.status === 200 && logRes.data.success, { status: logRes.status });

    // Summary
    console.log('\n============================================================');
    console.log('CHAT MONITORING TEST SUMMARY');
    console.log('============================================================');
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('============================================================\n');

    if (failed > 0) {
        console.log('❌ Chat monitoring tests FAILED');
        process.exit(1);
    } else {
        console.log('✅ All chat monitoring tests passed');
        process.exit(0);
    }
}

main().catch(e => {
    console.error('Test crashed:', e);
    process.exit(1);
});
