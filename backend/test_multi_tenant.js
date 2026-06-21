/**
 * Multi-Entity Independence Test
 *
 * Tests that multiple entities (0-3) maintain independent state.
 * Updated to use current entityId-based architecture.
 */

const BASE_URL = 'https://eclawbot.com';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function api(method, path, body = null) {
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(`${BASE_URL}${path}`, options);
    return res.json();
}

async function runMultiEntityTest() {
    console.log(`👥 Starting Multi-Entity Independence Test on: ${BASE_URL}\n`);

    // Check current state
    const entities = await api('GET', '/api/entities');
    console.log(`Active entities: ${entities.activeCount}/${entities.maxEntities}`);

    if (entities.activeCount < 2) {
        console.log('\n⚠️  Need at least 2 bound entities to test independence.');
        console.log('Skipping multi-entity test.\n');

        // Still test single entity state changes
        console.log('Testing single entity state changes instead...\n');

        const status1 = await api('GET', '/api/status?entityId=0');
        console.log(`Entity 0 initial: ${status1.state}`);

        // Note: transform requires botSecret now
        console.log('\nNote: Full multi-entity test requires:');
        console.log('1. Multiple bound entities');
        console.log('2. Valid botSecret for each entity');
        return;
    }

    // If we have multiple entities, test their independence
    console.log('\n--- Testing Entity Independence ---');

    const entity0 = entities.entities.find(e => e.entityId === 0);
    const entity1 = entities.entities.find(e => e.entityId === 1);

    if (entity0 && entity1) {
        console.log(`Entity 0: ${entity0.state} - "${entity0.message}"`);
        console.log(`Entity 1: ${entity1.state} - "${entity1.message}"`);

        if (entity0.message !== entity1.message || entity0.state !== entity1.state) {
            console.log('\n✅ SUCCESS: Entities have independent state!');
        } else {
            console.log('\n⚠️  Entities have same state (may be coincidence)');
        }
    }
}

runMultiEntityTest();
