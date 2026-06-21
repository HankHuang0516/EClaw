/**
 * Test script for entity name feature
 * Run: node test_name_feature.js
 */

const API_BASE = 'https://eclawbot.com';

async function testNameFeature() {
    console.log('=== Entity Name Feature Test ===\n');

    // Test 1: Check if name field exists in entities response
    console.log('Test 1: GET /api/entities - Check name field in response');
    try {
        const res = await fetch(`${API_BASE}/api/entities`);
        const data = await res.json();
        console.log('Response:', JSON.stringify(data, null, 2));

        if (data.entities && data.entities.length > 0) {
            const entity = data.entities[0];
            console.log('\nFirst entity fields:', Object.keys(entity));
            console.log('Has name field:', 'name' in entity);
            console.log('Name value:', entity.name);
        } else {
            console.log('No bound entities found. Bind an entity first to test.');
        }
    } catch (e) {
        console.error('Error:', e.message);
    }

    console.log('\n---\n');

    // Test 2: Check debug endpoint
    console.log('Test 2: GET /api/debug/devices - Check name in debug output');
    try {
        const res = await fetch(`${API_BASE}/api/debug/devices`);
        const data = await res.json();
        console.log('Response:', JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('Error:', e.message);
    }

    console.log('\n=== Test Complete ===');
    console.log('\nTo test with a bound entity:');
    console.log('1. Generate binding code in Android app');
    console.log('2. Bind with name: curl -X POST ' + API_BASE + '/api/bind -H "Content-Type: application/json" -d \'{"code":"YOUR_CODE","name":"測試名字"}\'');
    console.log('3. Check status: curl ' + API_BASE + '/api/entities');
}

testNameFeature();
