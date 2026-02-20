/**
 * Webhook Registration Test
 *
 * Tests the Push mode webhook registration and message pushing.
 * Since we can't actually receive webhooks in this test, we verify:
 * 1. Webhook registration works
 * 2. Debug slots show webhook status
 * 3. Client speak returns push status
 * 4. Webhook unregistration works
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
    console.log('Webhook Registration Test');
    console.log('='.repeat(60));
    console.log(`Target: ${BASE_URL}\n`);

    let passed = 0, failed = 0;
    let botSecret = null;
    const entityId = 0;

    // Step 1: Setup - Register and bind
    console.log('1. Setting up entity...');
    const deviceId = `webhook-test-${Date.now()}`;
    const deviceSecret = `secret-${Date.now()}`;

    const registerRes = await api('POST', '/api/device/register', {
        entityId,
        deviceId,
        deviceSecret,
        isTestDevice: true
    });

    if (!registerRes.data.success) {
        console.log(`   Register failed: ${registerRes.data.message}`);
        return;
    }

    const bindRes = await api('POST', '/api/bind', {
        code: registerRes.data.bindingCode
    });

    if (!bindRes.data.success) {
        console.log(`   Bind failed: ${bindRes.data.message}`);
        return;
    }

    botSecret = bindRes.data.botSecret;
    console.log(`   Entity ${entityId} ready, botSecret: ${botSecret.substring(0, 8)}...\n`);

    // Step 2: Check initial mode (should be polling) - v5: use /api/debug/devices
    console.log('2. Checking initial mode (should be polling)...');
    const devicesRes1 = await api('GET', '/api/debug/devices');
    const device1 = devicesRes1.data.devices?.find(d => d.deviceId === deviceId);
    const slot1 = device1?.entities?.find(e => e.entityId === entityId);
    if (slot1 && slot1.mode === 'polling' && !slot1.webhookRegistered) {
        console.log(`   Mode: ${slot1.mode}, webhookRegistered: ${slot1.webhookRegistered}`);
        passed++;
    } else {
        console.log(`   Unexpected initial state: ${JSON.stringify(slot1)}`);
        failed++;
    }

    // Step 3: Register webhook - v5: include deviceId
    console.log('\n3. Registering webhook...');
    const webhookRes = await api('POST', '/api/bot/register', {
        deviceId,
        entityId,
        botSecret,
        webhook_url: 'https://example-bot.com',
        token: 'test-token-12345',
        session_key: 'agent:main:main'
    });

    if (webhookRes.data.success && webhookRes.data.mode === 'push') {
        console.log(`   Result: ${webhookRes.data.message}`);
        console.log(`   Mode: ${webhookRes.data.mode}`);
        passed++;
    } else {
        console.log(`   Failed: ${JSON.stringify(webhookRes.data)}`);
        failed++;
    }

    // Step 4: Verify webhook in debug devices - v5
    console.log('\n4. Verifying webhook status in debug devices...');
    const devicesRes2 = await api('GET', '/api/debug/devices');
    const device2 = devicesRes2.data.devices?.find(d => d.deviceId === deviceId);
    const slot2 = device2?.entities?.find(e => e.entityId === entityId);
    if (slot2 && slot2.mode === 'push' && slot2.webhookRegistered) {
        console.log(`   Mode: ${slot2.mode}, webhookRegistered: ${slot2.webhookRegistered}`);
        passed++;
    } else {
        console.log(`   Unexpected state: ${JSON.stringify(slot2)}`);
        failed++;
    }

    // Step 5: Send message - should attempt push (will fail since example.com won't accept) - v5: include deviceId
    console.log('\n5. Testing client speak with webhook...');
    const speakRes = await api('POST', '/api/client/speak', {
        deviceId,
        entityId,
        text: 'Test message for webhook'
    });

    // v5: Response now has targets array instead of direct mode
    if (speakRes.data.success && speakRes.data.targets) {
        const target = speakRes.data.targets.find(t => t.entityId === entityId);
        if (target && target.mode === 'push') {
            console.log(`   Result: ${speakRes.data.message}`);
            console.log(`   Mode: ${target.mode}, pushed: ${target.pushed}`);
            passed++;
        } else {
            console.log(`   Target not in push mode: ${JSON.stringify(target)}`);
            failed++;
        }
    } else {
        console.log(`   Unexpected response: ${JSON.stringify(speakRes.data)}`);
        failed++;
    }

    // Step 6: Test webhook registration without botSecret (should fail) - v5
    console.log('\n6. Testing webhook registration without botSecret...');
    const badWebhookRes = await api('POST', '/api/bot/register', {
        deviceId,
        entityId,
        webhook_url: 'https://attacker.com',
        token: 'stolen-token',
        session_key: 'hacked'
    });

    if (badWebhookRes.status === 403) {
        console.log(`   Status: ${badWebhookRes.status} (correctly rejected)`);
        passed++;
    } else {
        console.log(`   Unexpected: ${badWebhookRes.status}`);
        failed++;
    }

    // Step 7: Unregister webhook - v5: include deviceId
    console.log('\n7. Unregistering webhook...');
    const unregRes = await api('DELETE', `/api/bot/register?deviceId=${deviceId}&entityId=${entityId}&botSecret=${botSecret}`);

    if (unregRes.data.success && unregRes.data.mode === 'polling') {
        console.log(`   Result: ${unregRes.data.message}`);
        console.log(`   Mode: ${unregRes.data.mode}`);
        passed++;
    } else {
        console.log(`   Failed: ${JSON.stringify(unregRes.data)}`);
        failed++;
    }

    // Step 8: Verify back to polling mode - v5
    console.log('\n8. Verifying back to polling mode...');
    const devicesRes3 = await api('GET', '/api/debug/devices');
    const device3 = devicesRes3.data.devices?.find(d => d.deviceId === deviceId);
    const slot3 = device3?.entities?.find(e => e.entityId === entityId);
    if (slot3 && slot3.mode === 'polling' && !slot3.webhookRegistered) {
        console.log(`   Mode: ${slot3.mode}, webhookRegistered: ${slot3.webhookRegistered}`);
        passed++;
    } else {
        console.log(`   Unexpected state: ${JSON.stringify(slot3)}`);
        failed++;
    }

    // Log / Telemetry API Verification
    console.log('\n--- Log / Telemetry API Verification ---\n');

    const telRes = await api('GET', `/api/device-telemetry?deviceId=${deviceId}&deviceSecret=${encodeURIComponent(deviceSecret)}&type=api_req`);
    if (telRes.status === 200 && telRes.data.entries) {
        const actions = telRes.data.entries.map(e => e.action);
        if (actions.some(a => a.includes('/api/device/register'))) { console.log('   ✅ Telemetry logged POST /api/device/register'); passed++; }
        else { console.log('   ❌ Missing POST /api/device/register in telemetry'); failed++; }
        if (actions.some(a => a.includes('/api/client/speak'))) { console.log('   ✅ Telemetry logged POST /api/client/speak'); passed++; }
        else { console.log('   ❌ Missing POST /api/client/speak in telemetry'); failed++; }
        if (actions.some(a => a.includes('/api/bot/register'))) { console.log('   ✅ Telemetry logged POST /api/bot/register'); passed++; }
        else { console.log('   ❌ Missing POST /api/bot/register in telemetry'); failed++; }
        const withDuration = telRes.data.entries.filter(e => e.duration != null && e.duration > 0);
        if (withDuration.length > 0) { console.log(`   ✅ Telemetry entries include duration (${withDuration.length}/${telRes.data.entries.length})`); passed++; }
        else { console.log('   ❌ No telemetry entries have duration'); failed++; }
    } else {
        console.log('   ⚠️ Telemetry API not available');
    }

    const logRes = await api('GET', `/api/logs?deviceId=${deviceId}&deviceSecret=${encodeURIComponent(deviceSecret)}&limit=50`);
    if (logRes.status === 200 && logRes.data.success) { console.log(`   ✅ Server log API accessible (${logRes.data.count} entries)`); passed++; }
    else { console.log('   ❌ Server log API not accessible'); failed++; }

    // Summary
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Result: ${passed}/${passed + failed} tests passed`);
    if (failed === 0) {
        console.log('All webhook registration tests passed!');
    } else {
        console.log(`${failed} test(s) failed`);
    }
}

runTest().catch(console.error);
