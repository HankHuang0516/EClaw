/**
 * Test Broadcast and Entity-to-Entity Messaging
 */

const BASE_URL = 'https://eclaw.up.railway.app';

async function api(method, path, body = null) {
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(`${BASE_URL}${path}`, options);
    return { status: res.status, data: await res.json() };
}

async function runTest() {
    console.log('='.repeat(60));
    console.log('Broadcast & Entity-to-Entity Messaging Test');
    console.log('='.repeat(60));
    console.log(`Target: ${BASE_URL}\n`);

    let passed = 0, failed = 0;

    // ============================================
    // Setup: Create device with 2 bound entities
    // ============================================
    console.log('--- Setup: Create device with 2 entities ---\n');

    const deviceId = `test-device-${Date.now()}`;
    const deviceSecret = `secret-${Date.now()}`;

    // Register and bind Entity 0
    console.log('1. Register Entity 0...');
    const reg0 = await api('POST', '/api/device/register', {
        entityId: 0,
        deviceId: deviceId,
        deviceSecret: deviceSecret,
        isTestDevice: true
    });
    console.log(`   Binding code: ${reg0.data.bindingCode}`);

    const bind0 = await api('POST', '/api/bind', { code: reg0.data.bindingCode });
    const botSecret0 = bind0.data.botSecret;
    console.log(`   Entity 0 bound, botSecret: ${botSecret0.substring(0, 8)}...`);

    // Register and bind Entity 1
    console.log('\n2. Register Entity 1...');
    const reg1 = await api('POST', '/api/device/register', {
        entityId: 1,
        deviceId: deviceId,
        deviceSecret: deviceSecret,
        isTestDevice: true
    });
    console.log(`   Binding code: ${reg1.data.bindingCode}`);

    const bind1 = await api('POST', '/api/bind', { code: reg1.data.bindingCode });
    const botSecret1 = bind1.data.botSecret;
    console.log(`   Entity 1 bound, botSecret: ${botSecret1.substring(0, 8)}...`);

    // ============================================
    // Test 1: Single Entity Message
    // ============================================
    console.log('\n--- Test 1: Single Entity Message ---\n');

    console.log('3. Send message to Entity 0 only...');
    const single = await api('POST', '/api/client/speak', {
        deviceId: deviceId,
        entityId: 0,
        text: 'Hello Entity 0!',
        source: 'test_single'
    });
    console.log(`   Response: ${JSON.stringify(single.data)}`);

    if (single.data.success && single.data.targets?.length === 1) {
        console.log('   ??Single message sent successfully');
        passed++;
    } else {
        console.log('   ??Single message failed');
        failed++;
    }

    // ============================================
    // Test 2: Broadcast to Array of Entities
    // ============================================
    console.log('\n--- Test 2: Broadcast to Array ---\n');

    console.log('4. Broadcast to [0, 1]...');
    const broadcast = await api('POST', '/api/client/speak', {
        deviceId: deviceId,
        entityId: [0, 1],
        text: 'Hello everyone!',
        source: 'test_broadcast'
    });
    console.log(`   Response: ${JSON.stringify(broadcast.data)}`);

    if (broadcast.data.success && broadcast.data.targets?.length === 2 && broadcast.data.broadcast) {
        console.log('   ??Broadcast to array worked');
        passed++;
    } else {
        console.log('   ??Broadcast to array failed');
        failed++;
    }

    // ============================================
    // Test 3: Broadcast to "all"
    // ============================================
    console.log('\n--- Test 3: Broadcast to "all" ---\n');

    console.log('5. Broadcast to "all" bound entities...');
    const broadcastAll = await api('POST', '/api/client/speak', {
        deviceId: deviceId,
        entityId: "all",
        text: 'Message to all!',
        source: 'test_all'
    });
    console.log(`   Response: ${JSON.stringify(broadcastAll.data)}`);

    if (broadcastAll.data.success && broadcastAll.data.targets?.length >= 2) {
        console.log(`   ??Broadcast to "all" sent to ${broadcastAll.data.targets.length} entities`);
        passed++;
    } else {
        console.log('   ??Broadcast to "all" failed');
        failed++;
    }

    // ============================================
    // Test 4: Entity-to-Entity Messaging
    // ============================================
    console.log('\n--- Test 4: Entity-to-Entity Messaging ---\n');

    console.log('6. Entity 0 sends message to Entity 1...');
    const e2e = await api('POST', '/api/entity/speak-to', {
        deviceId: deviceId,
        fromEntityId: 0,
        toEntityId: 1,
        botSecret: botSecret0,
        text: 'Hey Entity 1, this is Entity 0!'
    });
    console.log(`   Response: ${JSON.stringify(e2e.data)}`);

    if (e2e.data.success && e2e.data.from?.entityId === 0 && e2e.data.to?.entityId === 1) {
        console.log('   ??Entity 0 ??Entity 1 message sent');
        passed++;
    } else {
        console.log('   ??Entity-to-entity message failed');
        failed++;
    }

    // ============================================
    // Test 5: Entity 1 checks pending messages
    // ============================================
    console.log('\n--- Test 5: Entity 1 Receives Message ---\n');

    console.log('7. Entity 1 checks pending messages...');
    const pending = await api('GET', `/api/client/pending?deviceId=${deviceId}&entityId=1&botSecret=${botSecret1}`);
    console.log(`   Message count: ${pending.data.messages?.length || 0}`);

    const e2eMsg = pending.data.messages?.find(m => m.from === 'entity:0:LOBSTER');
    if (e2eMsg) {
        console.log(`   Found entity message: "${e2eMsg.text}" from ${e2eMsg.from}`);
        console.log('   ??Entity-to-entity message received correctly');
        passed++;
    } else {
        console.log('   ??Entity-to-entity message not found');
        console.log(`   Messages: ${JSON.stringify(pending.data.messages)}`);
        failed++;
    }

    // ============================================
    // Test 6: Wrong botSecret should fail
    // ============================================
    console.log('\n--- Test 6: Wrong botSecret Rejection ---\n');

    console.log('8. Try entity-to-entity with wrong botSecret...');
    const wrongSecret = await api('POST', '/api/entity/speak-to', {
        deviceId: deviceId,
        fromEntityId: 0,
        toEntityId: 1,
        botSecret: 'wrong-secret',
        text: 'Should fail'
    });
    console.log(`   Status: ${wrongSecret.status}`);

    if (wrongSecret.status === 403) {
        console.log('   ??Correctly rejected wrong botSecret');
        passed++;
    } else {
        console.log('   ??Should have rejected wrong botSecret');
        failed++;
    }

    // ============================================
    // Test 7: Self-message should fail
    // ============================================
    console.log('\n--- Test 7: Self-Message Rejection ---\n');

    console.log('9. Try entity sending to self...');
    const selfMsg = await api('POST', '/api/entity/speak-to', {
        deviceId: deviceId,
        fromEntityId: 0,
        toEntityId: 0,
        botSecret: botSecret0,
        text: 'Talking to myself'
    });
    console.log(`   Status: ${selfMsg.status}`);

    if (selfMsg.status === 400 && selfMsg.data.message.includes('self')) {
        console.log('   ??Correctly rejected self-message');
        passed++;
    } else {
        console.log('   ??Should have rejected self-message');
        failed++;
    }

    // ============================================
    // Log / Telemetry API Verification
    // ============================================
    console.log('\n--- Log / Telemetry API Verification ---\n');

    const telRes = await api('GET', `/api/device-telemetry?deviceId=${deviceId}&deviceSecret=${encodeURIComponent(deviceSecret)}&type=api_req`);
    if (telRes.status === 200 && telRes.data.entries) {
        const actions = telRes.data.entries.map(e => e.action);
        if (actions.some(a => a.includes('/api/device/register'))) { console.log('   ✅ Telemetry logged POST /api/device/register'); passed++; }
        else { console.log('   ❌ Missing POST /api/device/register in telemetry'); failed++; }
        if (actions.some(a => a.includes('/api/client/speak'))) { console.log('   ✅ Telemetry logged POST /api/client/speak'); passed++; }
        else { console.log('   ❌ Missing POST /api/client/speak in telemetry'); failed++; }
        if (actions.some(a => a.includes('/api/entity/speak-to'))) { console.log('   ✅ Telemetry logged POST /api/entity/speak-to'); passed++; }
        else { console.log('   ❌ Missing POST /api/entity/speak-to in telemetry'); failed++; }
        if (actions.some(a => a.includes('/api/client/pending'))) { console.log('   ✅ Telemetry logged GET /api/client/pending'); passed++; }
        else { console.log('   ❌ Missing GET /api/client/pending in telemetry'); failed++; }
        const withDuration = telRes.data.entries.filter(e => e.duration != null && e.duration > 0);
        if (withDuration.length > 0) { console.log(`   ✅ Telemetry entries include duration (${withDuration.length}/${telRes.data.entries.length})`); passed++; }
        else { console.log('   ❌ No telemetry entries have duration'); failed++; }
    } else {
        console.log('   ⚠️ Telemetry API not available');
    }

    const logRes = await api('GET', `/api/logs?deviceId=${deviceId}&deviceSecret=${encodeURIComponent(deviceSecret)}&limit=50`);
    if (logRes.status === 200 && logRes.data.success) { console.log(`   ✅ Server log API accessible (${logRes.data.count} entries)`); passed++; }
    else { console.log('   ❌ Server log API not accessible'); failed++; }

    // ============================================
    // Summary
    // ============================================
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Result: ${passed}/${passed + failed} tests passed`);
    console.log('='.repeat(60));

    if (failed === 0) {
        console.log('\n??All messaging tests passed!');
        console.log('\nFeatures working:');
        console.log('  - Single entity message');
        console.log('  - Broadcast to array [0, 1, 2]');
        console.log('  - Broadcast to "all" bound entities');
        console.log('  - Entity-to-entity messaging with source label');
        console.log('  - botSecret authentication');
        console.log('  - Self-message rejection');
    } else {
        console.log(`\n??${failed} test(s) failed`);
    }
}

runTest().catch(console.error);
