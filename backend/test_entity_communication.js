/**
 * Entity-to-Entity Communication Test
 * Tests messaging between 4 bound entities
 *
 * Prerequisites: All 4 entities must be bound (run after binding flow)
 *
 * Usage: node test_entity_communication.js
 */

const API_BASE = process.env.API_BASE || 'https://eclawbot.com';

async function api(method, endpoint, body = null) {
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(`${API_BASE}${endpoint}`, options);
    return res.json();
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
    console.log('======================================');
    console.log('Entity-to-Entity Communication Tests');
    console.log('======================================\n');

    // Check current entity states
    console.log('1. Checking bound entities...');
    const entities = await api('GET', '/api/entities');
    console.log(`   Active entities: ${entities.activeCount}/${entities.maxEntities}`);

    if (entities.activeCount < 2) {
        console.log('\n   ERROR: At least 2 entities must be bound to run tests.');
        console.log('   Please bind entities first using the Android app.');
        return;
    }

    entities.entities.forEach(e => {
        const emoji = e.character === 'LOBSTER' ? '🦞' : '🐷';
        console.log(`   ${emoji} Entity #${e.entityId}: ${e.state} - "${e.message}"`);
    });

    // Test 1: Direct message Entity 0 -> Entity 1
    console.log('\n2. Testing direct message (Entity 0 -> Entity 1)...');
    const msg1 = await api('POST', '/api/entity/0/speak-to/1', {
        text: 'Hello Entity 1! This is Entity 0 speaking.'
    });
    console.log(`   Result: ${msg1.success ? 'SUCCESS' : 'FAILED'} - ${msg1.message}`);

    // Test 2: Direct message Entity 1 -> Entity 0
    console.log('\n3. Testing direct message (Entity 1 -> Entity 0)...');
    const msg2 = await api('POST', '/api/entity/1/speak-to/0', {
        text: 'Hey Entity 0! Got your message!'
    });
    console.log(`   Result: ${msg2.success ? 'SUCCESS' : 'FAILED'} - ${msg2.message}`);

    // Test 3: Check pending messages for Entity 1
    console.log('\n4. Checking pending messages for Entity 1...');
    const pending1 = await api('GET', '/api/client/pending?entityId=1');
    console.log(`   Pending count: ${pending1.count}`);
    pending1.messages.forEach(m => {
        console.log(`   - From ${m.from}: "${m.text}"`);
    });

    // Test 4: Check pending messages for Entity 0
    console.log('\n5. Checking pending messages for Entity 0...');
    const pending0 = await api('GET', '/api/client/pending?entityId=0');
    console.log(`   Pending count: ${pending0.count}`);
    pending0.messages.forEach(m => {
        console.log(`   - From ${m.from}: "${m.text}"`);
    });

    // Test 5: Broadcast from Entity 0 to all
    console.log('\n6. Testing broadcast (Entity 0 -> All)...');
    const broadcast = await api('POST', '/api/entity/broadcast', {
        from: 0,
        text: 'Attention all entities! This is a broadcast from Entity 0!'
    });
    console.log(`   Result: ${broadcast.success ? 'SUCCESS' : 'FAILED'} - ${broadcast.message}`);

    // Test 6: Check all entities received broadcast
    console.log('\n7. Verifying broadcast delivery...');
    for (let i = 1; i < entities.activeCount; i++) {
        const pending = await api('GET', `/api/client/pending?entityId=${i}`);
        const hasBroadcast = pending.messages.some(m => m.text.includes('broadcast'));
        console.log(`   Entity #${i}: ${hasBroadcast ? 'Received broadcast' : 'No broadcast'}`);
    }

    // Test 7: Cross-entity conversation simulation
    console.log('\n8. Simulating cross-entity conversation...');

    // Entity 0 (Lobster) starts
    await api('POST', '/api/transform', {
        entityId: 0,
        state: 'EXCITED',
        message: 'Hey everyone! Let\'s chat!'
    });
    console.log('   🦞 Entity 0: "Hey everyone! Let\'s chat!"');
    await sleep(500);

    // Entity 1 (Pig) responds
    await api('POST', '/api/transform', {
        entityId: 1,
        state: 'EXCITED',
        message: 'Oink! I\'m here!'
    });
    await api('POST', '/api/entity/1/speak-to/0', { text: 'Nice to meet you, Lobster!' });
    console.log('   🐷 Entity 1: "Oink! I\'m here!" -> "Nice to meet you, Lobster!"');
    await sleep(500);

    // Entity 2 joins (if bound)
    if (entities.activeCount > 2) {
        await api('POST', '/api/transform', {
            entityId: 2,
            state: 'IDLE',
            message: 'Hello friends!'
        });
        await api('POST', '/api/entity/2/speak-to/0', { text: 'Lobster #2 reporting!' });
        await api('POST', '/api/entity/2/speak-to/1', { text: 'Hey Pig!' });
        console.log('   🦞 Entity 2: "Hello friends!" -> speaks to 0 and 1');
        await sleep(500);
    }

    // Entity 3 joins (if bound)
    if (entities.activeCount > 3) {
        await api('POST', '/api/transform', {
            entityId: 3,
            state: 'EATING',
            message: 'Munch munch...'
        });
        await api('POST', '/api/entity/broadcast', { from: 3, text: 'Anyone want some food?' });
        console.log('   🐷 Entity 3: "Munch munch..." -> broadcasts to all');
        await sleep(500);
    }

    // Final state check
    console.log('\n9. Final entity states...');
    const finalEntities = await api('GET', '/api/entities');
    finalEntities.entities.forEach(e => {
        const emoji = e.character === 'LOBSTER' ? '🦞' : '🐷';
        console.log(`   ${emoji} Entity #${e.entityId}: ${e.state} - "${e.message}"`);
    });

    // Summary
    console.log('\n======================================');
    console.log('Test Summary');
    console.log('======================================');
    console.log(`Total entities: ${entities.activeCount}`);
    console.log('Direct messaging: TESTED');
    console.log('Broadcast messaging: TESTED');
    console.log('Pending messages: TESTED');
    console.log('Cross-entity conversation: TESTED');
    console.log('\nAll tests completed!');
}

// Run tests
runTests().catch(err => {
    console.error('Test error:', err.message);
});
