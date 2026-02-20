/**
 * Device Isolation Test (v5 Matrix Architecture)
 *
 * Tests that two devices with the same entityId are completely isolated.
 * Device A's Entity 0 should NOT interfere with Device B's Entity 0.
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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTest() {
    console.log('='.repeat(60));
    console.log('Device Isolation Test (v5 Matrix Architecture)');
    console.log('='.repeat(60));
    console.log(`Target: ${BASE_URL}\n`);

    let passed = 0, failed = 0;

    // ============================================
    // Setup Device A + Bot A on Entity 0
    // ============================================
    console.log('--- Setup Device A + Bot A (Entity 0) ---\n');

    const deviceIdA = `device-A-${Date.now()}`;
    const deviceSecretA = `secret-A-${Date.now()}`;

    console.log('1. Device A registers Entity 0...');
    const regA = await api('POST', '/api/device/register', {
        entityId: 0,
        deviceId: deviceIdA,
        deviceSecret: deviceSecretA,
        isTestDevice: true
    });
    console.log(`   Device: ${deviceIdA}`);
    console.log(`   Binding code: ${regA.data.bindingCode}`);

    console.log('\n2. Bot A binds...');
    const bindA = await api('POST', '/api/bind', { code: regA.data.bindingCode });
    const botSecretA = bindA.data.botSecret;
    console.log(`   Bot A botSecret: ${botSecretA.substring(0, 8)}...`);

    // ============================================
    // Setup Device B + Bot B on Entity 0
    // ============================================
    console.log('\n--- Setup Device B + Bot B (Entity 0) ---\n');

    const deviceIdB = `device-B-${Date.now()}`;
    const deviceSecretB = `secret-B-${Date.now()}`;

    console.log('3. Device B registers Entity 0...');
    const regB = await api('POST', '/api/device/register', {
        entityId: 0,
        deviceId: deviceIdB,
        deviceSecret: deviceSecretB,
        isTestDevice: true
    });
    console.log(`   Device: ${deviceIdB}`);
    console.log(`   Binding code: ${regB.data.bindingCode}`);

    console.log('\n4. Bot B binds...');
    const bindB = await api('POST', '/api/bind', { code: regB.data.bindingCode });
    const botSecretB = bindB.data.botSecret;
    console.log(`   Bot B botSecret: ${botSecretB.substring(0, 8)}...`);

    // ============================================
    // Test 1: Both bots can control their own Entity 0
    // ============================================
    console.log('\n--- Test 1: Both bots can control their Entity 0 ---\n');

    console.log('5. Bot A transforms Device A Entity 0...');
    const transformA = await api('POST', '/api/transform', {
        deviceId: deviceIdA,
        entityId: 0,
        botSecret: botSecretA,
        message: 'Hello from Bot A!'
    });
    if (transformA.data.success) {
        console.log(`   ✅ Success: "${transformA.data.currentState.message}"`);
        passed++;
    } else {
        console.log(`   ❌ Failed: ${transformA.data.message}`);
        failed++;
    }

    console.log('\n6. Bot B transforms Device B Entity 0...');
    const transformB = await api('POST', '/api/transform', {
        deviceId: deviceIdB,
        entityId: 0,
        botSecret: botSecretB,
        message: 'Hello from Bot B!'
    });
    if (transformB.data.success) {
        console.log(`   ✅ Success: "${transformB.data.currentState.message}"`);
        passed++;
    } else {
        console.log(`   ❌ Failed: ${transformB.data.message}`);
        failed++;
    }

    // ============================================
    // Test 2: Verify messages are isolated
    // ============================================
    console.log('\n--- Test 2: Verify messages are isolated ---\n');

    const statusA = await api('GET', `/api/status?deviceId=${deviceIdA}&entityId=0`);
    const statusB = await api('GET', `/api/status?deviceId=${deviceIdB}&entityId=0`);

    console.log('7. Check Device A Entity 0 message...');
    if (statusA.data.message === 'Hello from Bot A!') {
        console.log(`   ✅ Correct: "${statusA.data.message}"`);
        passed++;
    } else {
        console.log(`   ❌ Wrong: "${statusA.data.message}"`);
        failed++;
    }

    console.log('\n8. Check Device B Entity 0 message...');
    if (statusB.data.message === 'Hello from Bot B!') {
        console.log(`   ✅ Correct: "${statusB.data.message}"`);
        passed++;
    } else {
        console.log(`   ❌ Wrong: "${statusB.data.message}"`);
        failed++;
    }

    // ============================================
    // Test 3: Bot A cannot control Device B's Entity
    // ============================================
    console.log('\n--- Test 3: Cross-device access should fail ---\n');

    console.log('9. Bot A tries to control Device B Entity 0...');
    const crossAccess = await api('POST', '/api/transform', {
        deviceId: deviceIdB,  // Wrong device!
        entityId: 0,
        botSecret: botSecretA,  // Bot A's secret
        message: 'Hacked!'
    });
    if (crossAccess.status === 403) {
        console.log(`   ✅ Correctly rejected (403): ${crossAccess.data.message}`);
        passed++;
    } else if (crossAccess.data.success) {
        console.log(`   ❌ SECURITY ISSUE: Cross-device access succeeded!`);
        failed++;
    } else {
        console.log(`   ⚠️ Unexpected: ${crossAccess.status} - ${crossAccess.data.message}`);
        failed++;
    }

    // ============================================
    // Test 4: Client messages are isolated
    // ============================================
    console.log('\n--- Test 4: Client messages are isolated ---\n');

    console.log('10. Client A sends message to Device A Entity 0...');
    await api('POST', '/api/client/speak', {
        deviceId: deviceIdA,
        entityId: 0,
        text: 'Message for Bot A'
    });

    console.log('11. Client B sends message to Device B Entity 0...');
    await api('POST', '/api/client/speak', {
        deviceId: deviceIdB,
        entityId: 0,
        text: 'Message for Bot B'
    });

    console.log('\n12. Bot A checks pending messages...');
    const pendingA = await api('GET', `/api/client/pending?deviceId=${deviceIdA}&entityId=0&botSecret=${botSecretA}`);
    const msgA = pendingA.data.messages.find(m => m.text === 'Message for Bot A');
    const wrongMsgA = pendingA.data.messages.find(m => m.text === 'Message for Bot B');

    if (msgA && !wrongMsgA) {
        console.log(`   ✅ Bot A only sees its own message: "${msgA.text}"`);
        passed++;
    } else {
        console.log(`   ❌ Message isolation failed!`);
        console.log(`      Messages: ${JSON.stringify(pendingA.data.messages)}`);
        failed++;
    }

    console.log('\n13. Bot B checks pending messages...');
    const pendingB = await api('GET', `/api/client/pending?deviceId=${deviceIdB}&entityId=0&botSecret=${botSecretB}`);
    const msgB = pendingB.data.messages.find(m => m.text === 'Message for Bot B');
    const wrongMsgB = pendingB.data.messages.find(m => m.text === 'Message for Bot A');

    if (msgB && !wrongMsgB) {
        console.log(`   ✅ Bot B only sees its own message: "${msgB.text}"`);
        passed++;
    } else {
        console.log(`   ❌ Message isolation failed!`);
        console.log(`      Messages: ${JSON.stringify(pendingB.data.messages)}`);
        failed++;
    }

    // ============================================
    // Log / Telemetry API Verification
    // ============================================
    console.log('\n--- Log / Telemetry API Verification ---\n');

    // Verify Device A telemetry
    const telA = await api('GET', `/api/device-telemetry?deviceId=${deviceIdA}&deviceSecret=${encodeURIComponent(deviceSecretA)}&type=api_req`);
    if (telA.status === 200 && telA.data.entries) {
        const actionsA = telA.data.entries.map(e => e.action);
        if (actionsA.some(a => a.includes('/api/device/register'))) { console.log('   ✅ Device A: Telemetry logged POST /api/device/register'); passed++; }
        else { console.log('   ❌ Device A: Missing POST /api/device/register in telemetry'); failed++; }
        if (actionsA.some(a => a.includes('/api/transform'))) { console.log('   ✅ Device A: Telemetry logged POST /api/transform'); passed++; }
        else { console.log('   ❌ Device A: Missing POST /api/transform in telemetry'); failed++; }
        if (actionsA.some(a => a.includes('/api/status'))) { console.log('   ✅ Device A: Telemetry logged GET /api/status'); passed++; }
        else { console.log('   ❌ Device A: Missing GET /api/status in telemetry'); failed++; }
        if (actionsA.some(a => a.includes('/api/client/speak'))) { console.log('   ✅ Device A: Telemetry logged POST /api/client/speak'); passed++; }
        else { console.log('   ❌ Device A: Missing POST /api/client/speak in telemetry'); failed++; }
        if (actionsA.some(a => a.includes('/api/client/pending'))) { console.log('   ✅ Device A: Telemetry logged GET /api/client/pending'); passed++; }
        else { console.log('   ❌ Device A: Missing GET /api/client/pending in telemetry'); failed++; }
        const withDur = telA.data.entries.filter(e => e.duration != null && e.duration > 0);
        if (withDur.length > 0) { console.log(`   ✅ Device A: Telemetry entries include duration (${withDur.length}/${telA.data.entries.length})`); passed++; }
        else { console.log('   ❌ Device A: No telemetry entries have duration'); failed++; }
    } else {
        console.log('   ⚠️ Device A telemetry not available');
    }

    // Verify Device B telemetry
    const telB = await api('GET', `/api/device-telemetry?deviceId=${deviceIdB}&deviceSecret=${encodeURIComponent(deviceSecretB)}&type=api_req`);
    if (telB.status === 200 && telB.data.entries) {
        const actionsB = telB.data.entries.map(e => e.action);
        if (actionsB.some(a => a.includes('/api/device/register'))) { console.log('   ✅ Device B: Telemetry logged POST /api/device/register'); passed++; }
        else { console.log('   ❌ Device B: Missing POST /api/device/register in telemetry'); failed++; }
        if (actionsB.some(a => a.includes('/api/transform'))) { console.log('   ✅ Device B: Telemetry logged POST /api/transform'); passed++; }
        else { console.log('   ❌ Device B: Missing POST /api/transform in telemetry'); failed++; }
    } else {
        console.log('   ⚠️ Device B telemetry not available');
    }

    // Server logs
    const logA = await api('GET', `/api/logs?deviceId=${deviceIdA}&deviceSecret=${encodeURIComponent(deviceSecretA)}&limit=50`);
    if (logA.status === 200 && logA.data.success) { console.log(`   ✅ Server log API accessible (${logA.data.count} entries)`); passed++; }
    else { console.log('   ❌ Server log API not accessible'); failed++; }

    // ============================================
    // Summary
    // ============================================
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Result: ${passed}/${passed + failed} tests passed`);
    console.log('='.repeat(60));

    if (failed === 0) {
        console.log('\n✅ All isolation tests passed!');
        console.log('\nMatrix Architecture Working:');
        console.log(`  - Device A (${deviceIdA.substring(0, 20)}...) Entity 0 ← Bot A`);
        console.log(`  - Device B (${deviceIdB.substring(0, 20)}...) Entity 0 ← Bot B`);
        console.log('  - Both use Entity 0, but completely isolated!');
    } else {
        console.log(`\n❌ ${failed} test(s) failed - check isolation logic`);
    }
}

runTest().catch(console.error);
