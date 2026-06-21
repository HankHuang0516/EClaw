/**
 * Entity Isolation Test
 *
 * Tests whether two device/bot pairs on the same entityId interfere.
 * Current architecture: Entity slots are shared - last binder wins!
 */

const BASE_URL = 'https://eclawbot.com';

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
    console.log('Entity Isolation Test');
    console.log('='.repeat(60));
    console.log(`\nScenario: Two device/bot pairs trying to use Entity 0\n`);

    // ============================================
    // Setup A1 + B1 on Entity 0
    // ============================================
    console.log('--- Setup Pair 1 (A1 + B1) on Entity 0 ---\n');

    const deviceA1 = `device-A1-${Date.now()}`;
    const secretA1 = `secret-A1-${Date.now()}`;

    console.log('1. A1 registers Entity 0...');
    const regA1 = await api('POST', '/api/device/register', {
        entityId: 0,
        deviceId: deviceA1,
        deviceSecret: secretA1,
        isTestDevice: true
    });
    console.log(`   Binding code: ${regA1.data.bindingCode}`);

    console.log('2. B1 binds to Entity 0...');
    const bindB1 = await api('POST', '/api/bind', { code: regA1.data.bindingCode });
    const botSecretB1 = bindB1.data.botSecret;
    console.log(`   B1 botSecret: ${botSecretB1.substring(0, 8)}...`);

    // ============================================
    // Setup A2 + B2 on Entity 0 (will this override?)
    // ============================================
    console.log('\n--- Setup Pair 2 (A2 + B2) on Entity 0 ---\n');

    const deviceA2 = `device-A2-${Date.now()}`;
    const secretA2 = `secret-A2-${Date.now()}`;

    console.log('3. A2 registers Entity 0...');
    const regA2 = await api('POST', '/api/device/register', {
        entityId: 0,
        deviceId: deviceA2,
        deviceSecret: secretA2,
        isTestDevice: true
    });
    console.log(`   Binding code: ${regA2.data.bindingCode}`);
    console.log(`   (Note: This should generate a NEW code, different from A1's)`);

    console.log('4. B2 binds to Entity 0...');
    const bindB2 = await api('POST', '/api/bind', { code: regA2.data.bindingCode });
    const botSecretB2 = bindB2.data.botSecret;
    console.log(`   B2 botSecret: ${botSecretB2.substring(0, 8)}...`);

    // ============================================
    // Test: Can B1 still control Entity 0?
    // ============================================
    console.log('\n--- Test: Can B1 still use its old botSecret? ---\n');

    console.log('5. B1 tries to transform Entity 0...');
    const transformB1 = await api('POST', '/api/transform', {
        entityId: 0,
        botSecret: botSecretB1,
        message: 'B1 says hello'
    });
    console.log(`   Status: ${transformB1.status}`);
    console.log(`   Result: ${transformB1.data.success ? 'SUCCESS' : 'FAILED - ' + transformB1.data.message}`);

    console.log('\n6. B2 tries to transform Entity 0...');
    const transformB2 = await api('POST', '/api/transform', {
        entityId: 0,
        botSecret: botSecretB2,
        message: 'B2 says hello'
    });
    console.log(`   Status: ${transformB2.status}`);
    console.log(`   Result: ${transformB2.data.success ? 'SUCCESS' : 'FAILED - ' + transformB2.data.message}`);

    // ============================================
    // Check who owns Entity 0 now
    // ============================================
    console.log('\n--- Debug: Who owns Entity 0 now? ---\n');

    const slots = await api('GET', '/api/debug/slots');
    const entity0 = slots.data.slots.find(s => s.entityId === 0);
    console.log(`   Entity 0 state: ${entity0.state}`);
    console.log(`   Entity 0 message: ${entity0.message}`);

    // ============================================
    // Summary
    // ============================================
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));

    if (transformB1.status === 403 && transformB2.data.success) {
        console.log('\n EXPECTED BEHAVIOR:');
        console.log('   - Entity slots are EXCLUSIVE');
        console.log('   - When A2+B2 bound, they REPLACED A1+B1');
        console.log('   - B1\'s botSecret became INVALID');
        console.log('   - Only ONE device/bot pair can own an Entity at a time');
        console.log('\n If you need multiple pairs, use different Entity IDs:');
        console.log('   - A1+B1 -> Entity 0');
        console.log('   - A2+B2 -> Entity 1');
    } else if (transformB1.data.success && transformB2.data.success) {
        console.log('\n UNEXPECTED: Both B1 and B2 can control Entity 0!');
        console.log('   This indicates a potential security issue.');
    }
}

runTest().catch(console.error);
