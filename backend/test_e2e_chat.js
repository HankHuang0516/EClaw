/**
 * End-to-End Chat Test
 *
 * Simulates complete flow:
 * 1. Device registers entity → gets binding code
 * 2. Bot binds with code → gets botSecret
 * 3. Device sends message
 * 4. Bot receives message (with botSecret)
 * 5. Verify peek mode and wrong secret behavior
 */

const BASE_URL = 'https://eclawbot.com';

async function api(method, path, body = null) {
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(`${BASE_URL}${path}`, options);

    // Handle non-JSON responses
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

async function runE2ETest() {
    console.log('='.repeat(60));
    console.log('🔄 End-to-End Chat Test');
    console.log('='.repeat(60));
    console.log(`Target: ${BASE_URL}\n`);

    let botSecret = null;
    const entityId = 0;

    // ========================================
    // STEP 1: Device registers entity
    // ========================================
    console.log('📱 STEP 1: Device registers entity...');
    const deviceId = `test-device-${Date.now()}`;
    const deviceSecret = `secret-${Date.now()}`;

    const registerResult = await api('POST', '/api/device/register', {
        entityId: entityId,
        deviceId: deviceId,
        deviceSecret: deviceSecret,
        isTestDevice: true
    });

    if (registerResult.data.success) {
        console.log(`   ✅ Binding code: ${registerResult.data.bindingCode}`);
        console.log(`   Entity ID: ${registerResult.data.entityId}`);

        // ========================================
        // STEP 2: Bot binds with code
        // ========================================
        console.log('\n🤖 STEP 2: Bot binds with code...');
        const bindResult = await api('POST', '/api/bind', {
            code: registerResult.data.bindingCode
        });

        if (bindResult.data.success) {
            botSecret = bindResult.data.botSecret;
            console.log(`   ✅ Bound successfully!`);
            console.log(`   botSecret: ${botSecret.substring(0, 8)}...`);
            console.log(`   Entity ID: ${bindResult.data.entityId}`);
        } else {
            console.log(`   ❌ Bind failed: ${bindResult.data.message}`);
            return;
        }
    } else {
        console.log(`   ❌ Register failed: ${registerResult.data.message}`);
        return;
    }

    // ========================================
    // STEP 3: Device sends message
    // ========================================
    console.log('\n📱 STEP 3: Device sends message...');
    const testMessage = `Hello from test! Time: ${new Date().toISOString()}`;
    const speakResult = await api('POST', '/api/client/speak', {
        text: testMessage,
        entityId: String(entityId),
        source: 'e2e_test'
    });

    console.log(`   Message: "${testMessage}"`);
    console.log(`   Result: ${speakResult.data.success ? '✅ Sent' : '❌ Failed'}`);

    // ========================================
    // STEP 4: Peek mode (no botSecret)
    // ========================================
    console.log('\n👀 STEP 4: Peek mode (no botSecret)...');
    const peekResult = await api('GET', `/api/client/pending?entityId=${entityId}`);
    console.log(`   Count: ${peekResult.data.count}`);
    console.log(`   Messages visible: ${peekResult.data.messages?.length || 0}`);

    if (peekResult.data.count > 0 && (peekResult.data.messages?.length || 0) === 0) {
        console.log('   ✅ PASS: Count visible, content hidden');
    } else {
        console.log('   ⚠️  Check: count=' + peekResult.data.count);
    }

    // ========================================
    // STEP 5: Wrong botSecret
    // ========================================
    console.log('\n🔒 STEP 5: Wrong botSecret...');
    const wrongResult = await api('GET', `/api/client/pending?entityId=${entityId}&botSecret=wrong-secret-123`);
    console.log(`   HTTP Status: ${wrongResult.status}`);

    if (wrongResult.status === 403) {
        console.log('   ✅ PASS: Correctly rejected');
    } else {
        console.log('   ❌ FAIL: Should return 403');
    }

    // Verify message still exists
    const checkResult = await api('GET', `/api/client/pending?entityId=${entityId}`);
    console.log(`   Message still pending: ${checkResult.data.count > 0 ? 'Yes ✅' : 'No ❌'}`);

    // ========================================
    // STEP 6: Correct botSecret
    // ========================================
    console.log('\n🔓 STEP 6: Correct botSecret...');
    const correctResult = await api('GET', `/api/client/pending?entityId=${entityId}&botSecret=${botSecret}`);
    console.log(`   Count: ${correctResult.data.count}`);
    console.log(`   Messages received: ${correctResult.data.messages?.length || 0}`);

    if (correctResult.data.messages?.length > 0) {
        console.log('   ✅ PASS: Messages retrieved');
        correctResult.data.messages.forEach((m, i) => {
            console.log(`   [${i + 1}] "${m.text}" from ${m.from}`);
        });
    } else {
        console.log('   ❌ FAIL: No messages received');
    }

    // ========================================
    // STEP 7: Verify messages consumed
    // ========================================
    console.log('\n🗑️ STEP 7: Verify messages consumed...');
    const afterResult = await api('GET', `/api/client/pending?entityId=${entityId}&botSecret=${botSecret}`);
    console.log(`   Remaining count: ${afterResult.data.count}`);

    if (afterResult.data.count === 0) {
        console.log('   ✅ PASS: Messages consumed after retrieval');
    } else {
        console.log('   ⚠️  Still have messages in queue');
    }

    // ========================================
    // SUMMARY
    // ========================================
    console.log('\n' + '='.repeat(60));
    console.log('📊 Test Summary');
    console.log('='.repeat(60));
    console.log(`Entity ID: ${entityId}`);
    console.log(`botSecret: ${botSecret}`);
    console.log('\nYou can use this botSecret to test manually:');
    console.log(`curl "${BASE_URL}/api/client/pending?entityId=${entityId}&botSecret=${botSecret}"`);
}

runE2ETest().catch(console.error);
