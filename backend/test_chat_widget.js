/**
 * Test Script: Chat Widget Flow
 *
 * Tests the complete flow:
 * 1. Device sends message via /api/client/speak
 * 2. Peek mode (no botSecret) - should see count but not content
 * 3. Wrong botSecret - should get 403
 * 4. Correct botSecret - should receive and consume messages
 */

const BASE_URL = 'https://eclawbot.com';

async function api(method, path, body = null) {
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(`${BASE_URL}${path}`, options);
    return res.json();
}

async function runTest() {
    console.log('='.repeat(60));
    console.log('🧪 Chat Widget Flow Test');
    console.log('='.repeat(60));
    console.log(`Target: ${BASE_URL}\n`);

    // Step 1: Check current entity status
    console.log('1️⃣ Checking entity 0 status...');
    const status = await api('GET', '/api/status?entityId=0');
    console.log(`   Entity 0: ${status.character} - ${status.state}`);
    console.log(`   isBound: ${status.isBound !== false ? 'Yes' : 'No'}`);

    if (!status.isBound && status.isBound !== undefined) {
        console.log('\n❌ Entity 0 is not bound. Please bind first.');
        return;
    }

    // Step 2: Get botSecret from debug endpoint (for testing only)
    console.log('\n2️⃣ Getting debug info...');
    const debug = await api('GET', '/api/debug/slots');
    const entity0 = debug.slots?.find(s => s.entityId === 0);
    console.log(`   Entity 0 bound: ${entity0?.isBound}`);
    console.log(`   Message queue length: ${entity0?.messageQueueLength || 'N/A'}`);

    // We need to manually provide botSecret for testing
    // In real scenario, bot stores this from /api/bind response
    const TEST_MESSAGE = `TEST_${Date.now()}`;

    // Step 3: Device sends message
    console.log('\n3️⃣ [DEVICE] Sending message...');
    const sendResult = await api('POST', '/api/client/speak', {
        text: TEST_MESSAGE,
        entityId: '0',
        source: 'test_script'
    });
    console.log(`   Result: ${sendResult.success ? '✅ SUCCESS' : '❌ FAILED'}`);
    console.log(`   Message: "${TEST_MESSAGE}"`);

    // Step 4: Peek mode (no botSecret)
    console.log('\n4️⃣ [BOT] Peek mode (no botSecret)...');
    const peekResult = await api('GET', '/api/client/pending?entityId=0');
    console.log(`   Count: ${peekResult.count}`);
    console.log(`   Messages array length: ${peekResult.messages?.length || 0}`);
    console.log(`   Note: ${peekResult.note || 'N/A'}`);

    if (peekResult.count > 0 && peekResult.messages?.length === 0) {
        console.log('   ✅ Peek mode working: count visible, content hidden');
    } else if (peekResult.count === 0) {
        console.log('   ⚠️  No messages in queue (might have been consumed)');
    } else {
        console.log('   ❌ Unexpected: messages should be hidden without botSecret');
    }

    // Step 5: Wrong botSecret
    console.log('\n5️⃣ [BOT] Wrong botSecret...');
    const wrongSecretResult = await fetch(`${BASE_URL}/api/client/pending?entityId=0&botSecret=wrong-secret`);
    console.log(`   HTTP Status: ${wrongSecretResult.status}`);
    if (wrongSecretResult.status === 403) {
        console.log('   ✅ Correctly rejected with 403');
    } else {
        const data = await wrongSecretResult.json();
        console.log(`   ❌ Unexpected response:`, data);
    }

    // Step 6: Check if message still exists after peek and wrong secret
    console.log('\n6️⃣ Verifying message not consumed...');
    const checkAgain = await api('GET', '/api/client/pending?entityId=0');
    console.log(`   Count still: ${checkAgain.count}`);
    if (checkAgain.count > 0) {
        console.log('   ✅ Message preserved (not consumed by peek/wrong secret)');
    } else {
        console.log('   ⚠️  Message might have been consumed by another process');
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('📊 Test Summary');
    console.log('='.repeat(60));
    console.log('To complete the test with correct botSecret:');
    console.log('1. Get your botSecret from when you bound the entity');
    console.log('2. Run:');
    console.log(`   curl "${BASE_URL}/api/client/pending?entityId=0&botSecret=YOUR_SECRET"`);
    console.log('\nExpected: Should return messages array with your test message');
}

// Additional test: Full flow with manual botSecret input
async function testWithBotSecret(botSecret) {
    console.log('\n🔐 Testing with provided botSecret...');

    // Send fresh message
    const testMsg = `AUTHENTICATED_TEST_${Date.now()}`;
    await api('POST', '/api/client/speak', {
        text: testMsg,
        entityId: '0',
        source: 'test_authenticated'
    });
    console.log(`   Sent: "${testMsg}"`);

    // Retrieve with botSecret
    const result = await api('GET', `/api/client/pending?entityId=0&botSecret=${botSecret}`);
    console.log(`   Count: ${result.count}`);
    console.log(`   Messages received: ${result.messages?.length || 0}`);

    if (result.messages?.length > 0) {
        console.log('   ✅ Successfully retrieved messages:');
        result.messages.forEach(m => {
            console.log(`      - "${m.text}" from ${m.from}`);
        });
    } else if (result.success === false) {
        console.log(`   ❌ Error: ${result.message}`);
    }
}

// Run test
runTest().catch(console.error);

// Export for manual testing
// Usage: node -e "require('./test_chat_widget.js').testWithBotSecret('your-secret')"
module.exports = { testWithBotSecret };
