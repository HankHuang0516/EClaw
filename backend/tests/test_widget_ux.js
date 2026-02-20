/**
 * Widget UI/UX Validation Tests
 * Tests the chat widget flow: entity selection, single/broadcast messaging
 */

const API_BASE = process.env.API_BASE || 'https://eclaw.up.railway.app';

const TEST_DEVICE_ID = `test-widget-${Date.now()}`;
const TEST_DEVICE_SECRET = 'test-secret';

let boundEntities = [];

async function setup() {
    console.log('============================================================');
    console.log('WIDGET UI/UX VALIDATION TESTS');
    console.log('============================================================');
    console.log(`API Base: ${API_BASE}`);
    console.log(`Test Device: ${TEST_DEVICE_ID}\n`);

    // Bind entities 0 and 1 for testing
    for (let entityId = 0; entityId < 2; entityId++) {
        // Register
        const registerRes = await fetch(`${API_BASE}/api/device/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                deviceId: TEST_DEVICE_ID,
                deviceSecret: TEST_DEVICE_SECRET,
                entityId: entityId,
                appVersion: '1.0.3',
                isTestDevice: true
            })
        });
        const registerData = await registerRes.json();

        // Bind
        const bindRes = await fetch(`${API_BASE}/api/bind`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: registerData.bindingCode })
        });
        const bindData = await bindRes.json();

        boundEntities.push({
            entityId,
            botSecret: bindData.botSecret
        });

        console.log(`Setup: Entity ${entityId} bound`);
    }
    console.log('');
}

async function runTests() {
    let passed = 0;
    let failed = 0;

    // Test 1: Send to single entity (entityId as number)
    console.log('--- Test 1: Single entity message (entityId as Int) ---');
    try {
        const res = await fetch(`${API_BASE}/api/client/speak`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                deviceId: TEST_DEVICE_ID,
                entityId: 0,  // Int, not String
                text: 'Hello from widget',
                source: 'android_widget'
            })
        });
        const data = await res.json();

        if (data.success && data.targets?.length === 1 && data.targets[0].entityId === 0) {
            console.log('??Single entity message works with Int entityId');
            passed++;
        } else {
            console.log('??Single entity message failed:', data);
            failed++;
        }
    } catch (e) {
        console.log('??Exception:', e.message);
        failed++;
    }

    // Test 2: Send to single entity (entityId as string - legacy support)
    console.log('\n--- Test 2: Single entity message (entityId as String) ---');
    try {
        const res = await fetch(`${API_BASE}/api/client/speak`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                deviceId: TEST_DEVICE_ID,
                entityId: "1",  // String for legacy support
                text: 'Hello with string entityId',
                source: 'android_widget'
            })
        });
        const data = await res.json();

        if (data.success && data.targets?.length === 1) {
            console.log('??Single entity message works with String entityId (legacy)');
            passed++;
        } else {
            console.log('??String entityId failed:', data);
            failed++;
        }
    } catch (e) {
        console.log('??Exception:', e.message);
        failed++;
    }

    // Test 3: Broadcast to array (multi-select in widget)
    console.log('\n--- Test 3: Broadcast to array [0, 1] ---');
    try {
        const res = await fetch(`${API_BASE}/api/client/speak`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                deviceId: TEST_DEVICE_ID,
                entityId: [0, 1],  // Array for broadcast
                text: 'Broadcast message!',
                source: 'android_widget'
            })
        });
        const data = await res.json();

        if (data.success && data.targets?.length === 2 && data.broadcast === true) {
            console.log('??Broadcast to array works');
            console.log(`   Sent to ${data.targets.length} entities`);
            passed++;
        } else {
            console.log('??Broadcast failed:', data);
            failed++;
        }
    } catch (e) {
        console.log('??Exception:', e.message);
        failed++;
    }

    // Test 4: Broadcast to "all"
    console.log('\n--- Test 4: Broadcast to "all" ---');
    try {
        const res = await fetch(`${API_BASE}/api/client/speak`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                deviceId: TEST_DEVICE_ID,
                entityId: "all",
                text: 'Broadcast to all!',
                source: 'android_widget'
            })
        });
        const data = await res.json();

        if (data.success && data.targets?.length >= 2 && data.broadcast === true) {
            console.log('??Broadcast to "all" works');
            console.log(`   Sent to ${data.targets.length} bound entities`);
            passed++;
        } else {
            console.log('??Broadcast to "all" failed:', data);
            failed++;
        }
    } catch (e) {
        console.log('??Exception:', e.message);
        failed++;
    }

    // Test 5: Invalid device returns error (not 500)
    console.log('\n--- Test 5: Invalid device returns proper error ---');
    try {
        const res = await fetch(`${API_BASE}/api/client/speak`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                deviceId: 'non-existent-device',
                entityId: 0,
                text: 'Test',
                source: 'android_widget'
            })
        });

        if (res.status === 404) {
            console.log('??Invalid device returns 404 (not 500)');
            passed++;
        } else {
            console.log(`??Expected 404, got ${res.status}`);
            failed++;
        }
    } catch (e) {
        console.log('??Exception:', e.message);
        failed++;
    }

    // Test 6: Missing deviceId returns 400
    console.log('\n--- Test 6: Missing deviceId returns 400 ---');
    try {
        const res = await fetch(`${API_BASE}/api/client/speak`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                entityId: 0,
                text: 'Test',
                source: 'android_widget'
            })
        });

        if (res.status === 400) {
            console.log('??Missing deviceId returns 400');
            passed++;
        } else {
            console.log(`??Expected 400, got ${res.status}`);
            failed++;
        }
    } catch (e) {
        console.log('??Exception:', e.message);
        failed++;
    }

    // Test 7: Verify messages received by bot
    console.log('\n--- Test 7: Bot receives messages via polling ---');
    try {
        const res = await fetch(
            `${API_BASE}/api/client/pending?deviceId=${TEST_DEVICE_ID}&entityId=0&botSecret=${boundEntities[0].botSecret}`
        );
        const data = await res.json();

        if (data.count > 0 && data.messages?.length > 0) {
            console.log(`??Bot received ${data.count} messages`);
            console.log(`   Latest: "${data.messages[data.messages.length - 1].text}"`);
            passed++;
        } else {
            console.log('??No messages in queue:', data);
            failed++;
        }
    } catch (e) {
        console.log('??Exception:', e.message);
        failed++;
    }

    // Test 8: Response includes versionInfo
    console.log('\n--- Test 8: Response includes versionInfo ---');
    try {
        const res = await fetch(
            `${API_BASE}/api/client/pending?deviceId=${TEST_DEVICE_ID}&entityId=0&botSecret=${boundEntities[0].botSecret}`
        );
        const data = await res.json();

        if (data.versionInfo && data.versionInfo.latestVersion) {
            console.log('??Response includes versionInfo');
            console.log(`   Latest version: ${data.versionInfo.latestVersion}`);
            passed++;
        } else {
            console.log('??Missing versionInfo:', data);
            failed++;
        }
    } catch (e) {
        console.log('??Exception:', e.message);
        failed++;
    }

    // Log / Telemetry API Verification
    console.log('\n--- Log / Telemetry API Verification ---');
    try {
        const telRes = await fetch(
            `${API_BASE}/api/device-telemetry?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}&type=api_req`
        );
        const telData = await telRes.json();
        if (telData.success && telData.entries && telData.entries.length > 0) {
            const actions = telData.entries.map(e => e.action);
            if (actions.some(a => a.includes('/api/device/register'))) { console.log('✅ Telemetry logged POST /api/device/register'); passed++; }
            else { console.log('❌ Missing POST /api/device/register in telemetry'); failed++; }
            if (actions.some(a => a.includes('/api/client/speak'))) { console.log('✅ Telemetry logged POST /api/client/speak'); passed++; }
            else { console.log('❌ Missing POST /api/client/speak in telemetry'); failed++; }
            if (actions.some(a => a.includes('/api/client/pending'))) { console.log('✅ Telemetry logged GET /api/client/pending'); passed++; }
            else { console.log('❌ Missing GET /api/client/pending in telemetry'); failed++; }
            const withDuration = telData.entries.filter(e => e.duration != null && e.duration > 0);
            if (withDuration.length > 0) { console.log(`✅ Telemetry entries include duration (${withDuration.length}/${telData.entries.length})`); passed++; }
            else { console.log('❌ No telemetry entries have duration'); failed++; }
        } else {
            console.log('⚠️ Telemetry API returned no entries');
        }

        const logRes = await fetch(
            `${API_BASE}/api/logs?deviceId=${TEST_DEVICE_ID}&deviceSecret=${TEST_DEVICE_SECRET}&limit=50`
        );
        const logData = await logRes.json();
        if (logData.success) { console.log(`✅ Server log API accessible (${logData.count} entries)`); passed++; }
        else { console.log('❌ Server log API not accessible'); failed++; }
    } catch (err) {
        console.log(`⚠️ Telemetry verification error: ${err.message}`);
    }

    return { passed, failed };
}

async function main() {
    try {
        await setup();
        const { passed, failed } = await runTests();

        console.log('\n============================================================');
        console.log('WIDGET UX TEST SUMMARY');
        console.log('============================================================');
        console.log(`Results: ${passed} passed, ${failed} failed`);
        console.log('============================================================\n');

        if (failed > 0) {
            console.log('??Widget UX tests FAILED');
            process.exit(1);
        } else {
            console.log('??All widget UX tests PASSED');
            process.exit(0);
        }
    } catch (e) {
        console.error('Test setup failed:', e.message);
        process.exit(1);
    }
}

main();
