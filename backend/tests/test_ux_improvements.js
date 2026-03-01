/**
 * UX Improvements Verification Tests
 * Tests for: Agent Cards, Layout Editor, API responses
 *
 * Verifies critical fields like isBound are present in API responses
 */

const API_BASE = 'https://eclawbot.com';

// Generate unique IDs for testing
const testDeviceId = 'test-ux-' + Date.now();
const testDeviceSecret = 'secret-' + Date.now();

async function api(method, path, body = null) {
    const url = `${API_BASE}${path}`;
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
    if (body) options.body = JSON.stringify(body);

    const response = await fetch(url, options);
    return response.json();
}

async function runTests() {
    console.log('='.repeat(60));
    console.log('UX IMPROVEMENTS VERIFICATION TESTS');
    console.log('='.repeat(60));
    console.log(`Test Device ID: ${testDeviceId}`);
    console.log(`API Base: ${API_BASE}`);

    let passed = 0;
    let failed = 0;

    // =====================================================
    // Test 1: /api/entities returns proper structure
    // =====================================================
    console.log('\n--- Test 1: /api/entities response structure ---');
    try {
        const response = await api('GET', '/api/entities');
        console.log('Response:', JSON.stringify(response, null, 2));

        if (!response.entities) {
            console.log('FAIL: Missing entities array');
            failed++;
        } else if (typeof response.activeCount !== 'number') {
            console.log('FAIL: Missing activeCount');
            failed++;
        } else {
            console.log('PASS: Response has correct structure');
            passed++;

            // If there are entities, check they have isBound
            if (response.entities.length > 0) {
                const firstEntity = response.entities[0];
                if (firstEntity.isBound === true) {
                    console.log('PASS: Entity has isBound: true');
                    passed++;
                } else {
                    console.log('FAIL: Entity missing isBound field or not true');
                    console.log('Entity:', firstEntity);
                    failed++;
                }

                // Check required fields
                const requiredFields = ['entityId', 'character', 'state', 'message', 'lastUpdated'];
                const missingFields = requiredFields.filter(f => !(f in firstEntity));
                if (missingFields.length === 0) {
                    console.log('PASS: Entity has all required fields');
                    passed++;
                } else {
                    console.log('FAIL: Entity missing fields:', missingFields);
                    failed++;
                }
            } else {
                console.log('INFO: No bound entities to test (bind one first)');
            }
        }
    } catch (e) {
        console.log('FAIL: API error -', e.message);
        failed++;
    }

    // =====================================================
    // Test 2: /api/entities with deviceId filter
    // =====================================================
    console.log('\n--- Test 2: /api/entities with deviceId filter ---');
    try {
        const response = await api('GET', `/api/entities?deviceId=${testDeviceId}`);

        if (response.entities && Array.isArray(response.entities)) {
            console.log('PASS: Filter by deviceId works');
            console.log(`Entities for ${testDeviceId}: ${response.entities.length}`);
            passed++;
        } else {
            console.log('FAIL: Invalid response for filtered query');
            failed++;
        }
    } catch (e) {
        console.log('FAIL: API error -', e.message);
        failed++;
    }

    // =====================================================
    // Test 3: /api/device/register creates device with deviceSecret
    // =====================================================
    console.log('\n--- Test 3: /api/device/register (with deviceSecret) ---');
    let bindingCode = null;
    try {
        const response = await api('POST', '/api/device/register', {
            deviceId: testDeviceId,
            deviceSecret: testDeviceSecret,
            entityId: 0,
            isTestDevice: true
        });

        if (response.success && (response.code || response.bindingCode)) {
            console.log('PASS: Device registration successful');
            bindingCode = response.code || response.bindingCode;
            console.log(`Binding code: ${bindingCode}`);
            passed++;
        } else if (response.success === false) {
            console.log('FAIL: Device registration failed');
            console.log('Response:', response);
            failed++;
        }
    } catch (e) {
        console.log('FAIL: API error -', e.message);
        failed++;
    }

    // =====================================================
    // Test 4: Unbound entity should NOT appear in /api/entities
    // =====================================================
    console.log('\n--- Test 4: Unbound entity not in /api/entities ---');
    try {
        const entitiesResp = await api('GET', `/api/entities?deviceId=${testDeviceId}`);
        if (entitiesResp.entities.length === 0) {
            console.log('PASS: Unbound entity correctly excluded from /api/entities');
            passed++;
        } else {
            console.log('FAIL: Unbound entity should not appear in /api/entities');
            console.log('Found:', entitiesResp.entities);
            failed++;
        }
    } catch (e) {
        console.log('FAIL: API error -', e.message);
        failed++;
    }

    // =====================================================
    // Test 5: /api/status returns entity status with isBound
    // =====================================================
    console.log('\n--- Test 5: /api/status includes isBound ---');
    try {
        const status = await api('GET', `/api/status?deviceId=${testDeviceId}&entityId=0`);

        if ('isBound' in status) {
            console.log('PASS: /api/status includes isBound field');
            console.log(`isBound: ${status.isBound}`);
            passed++;
        } else {
            console.log('FAIL: /api/status missing isBound field');
            console.log('Response:', status);
            failed++;
        }
    } catch (e) {
        console.log('FAIL: API error -', e.message);
        failed++;
    }

    // =====================================================
    // Test 6: /api/device/status returns entity with isBound
    // =====================================================
    console.log('\n--- Test 6: /api/device/status includes isBound ---');
    try {
        const status = await api('POST', '/api/device/status', {
            deviceId: testDeviceId,
            deviceSecret: testDeviceSecret,
            entityId: 0  // Required field
        });

        if ('isBound' in status) {
            console.log('PASS: /api/device/status includes isBound field');
            console.log(`Entity 0 isBound: ${status.isBound}`);
            passed++;
        } else if (status.success === false) {
            console.log('FAIL: API returned error:', status.message);
            failed++;
        } else {
            console.log('FAIL: /api/device/status missing isBound field');
            console.log('Response:', status);
            failed++;
        }
    } catch (e) {
        console.log('FAIL: API error -', e.message);
        failed++;
    }

    // =====================================================
    // Test 7: Bind simulation - test binding flow
    // =====================================================
    console.log('\n--- Test 7: Full bind flow (register + bind + check) ---');
    if (bindingCode) {
        try {
            // Simulate bot binding
            const bindResponse = await api('POST', '/api/bind', {
                code: bindingCode,
                name: 'Test Bot'
            });

            if (bindResponse.success && bindResponse.botSecret) {
                console.log('PASS: Binding successful');
                console.log(`Bot secret received: ${bindResponse.botSecret.substring(0, 8)}...`);
                passed++;

                // Now check if entity appears in /api/entities WITH isBound
                const entitiesResp = await api('GET', `/api/entities?deviceId=${testDeviceId}`);
                const boundEntity = entitiesResp.entities.find(e => e.entityId === 0);

                if (boundEntity && boundEntity.isBound === true) {
                    console.log('PASS: Bound entity has isBound: true in /api/entities');
                    passed++;
                } else if (boundEntity) {
                    console.log('FAIL: Bound entity missing isBound field!');
                    console.log('Entity:', boundEntity);
                    failed++;
                } else {
                    console.log('FAIL: Bound entity not found in /api/entities');
                    failed++;
                }

                // Test 8: Check name field
                console.log('\n--- Test 8: Entity name field ---');
                if (boundEntity && boundEntity.name === 'Test Bot') {
                    console.log('PASS: Entity name correctly set');
                    passed++;
                } else if (boundEntity) {
                    console.log('FAIL: Entity name not set correctly');
                    console.log('Expected: "Test Bot", Got:', boundEntity.name);
                    failed++;
                }
            } else {
                console.log('FAIL: Binding failed');
                console.log('Response:', bindResponse);
                failed++;
            }
        } catch (e) {
            console.log('FAIL: API error -', e.message);
            failed++;
        }
    } else {
        console.log('SKIP: No binding code from Test 3');
    }

    // =====================================================
    // Log / Telemetry API Verification
    // =====================================================
    console.log('\n--- Log / Telemetry API Verification ---');
    // Wait for async telemetry writes to flush
    await new Promise(r => setTimeout(r, 2000));
    try {
        const telData = await api('GET',
            `/api/device-telemetry?deviceId=${testDeviceId}&deviceSecret=${encodeURIComponent(testDeviceSecret)}&type=api_req`
        );
        if (telData.entries && telData.entries.length > 0) {
            const actions = telData.entries.map(e => e.action);
            if (actions.some(a => a.includes('/api/device/register'))) { console.log('PASS: Telemetry logged POST /api/device/register'); passed++; }
            else { console.log('FAIL: Missing POST /api/device/register in telemetry'); failed++; }
            if (actions.some(a => a.includes('/api/entities'))) { console.log('PASS: Telemetry logged GET /api/entities'); passed++; }
            else { console.log('FAIL: Missing GET /api/entities in telemetry'); failed++; }
            if (actions.some(a => a.includes('/api/status'))) { console.log('PASS: Telemetry logged GET /api/status'); passed++; }
            else { console.log('FAIL: Missing GET /api/status in telemetry'); failed++; }
            const withDuration = telData.entries.filter(e => e.duration != null && e.duration > 0);
            if (withDuration.length > 0) { console.log(`PASS: Telemetry entries have duration (${withDuration.length}/${telData.entries.length})`); passed++; }
            else { console.log('FAIL: No telemetry entries have duration'); failed++; }
        } else {
            console.log('INFO: Telemetry API returned no entries');
        }

        const logData = await api('GET',
            `/api/logs?deviceId=${testDeviceId}&deviceSecret=${encodeURIComponent(testDeviceSecret)}&limit=50`
        );
        if (logData.success) { console.log(`PASS: Server log API accessible (${logData.count} entries)`); passed++; }
        else { console.log('FAIL: Server log API not accessible'); failed++; }
    } catch (e) {
        console.log('FAIL: Telemetry verification error -', e.message);
        failed++;
    }

    // =====================================================
    // Summary
    // =====================================================
    console.log('\n' + '='.repeat(60));
    console.log(`RESULTS: ${passed} passed, ${failed} failed`);
    console.log('='.repeat(60));

    if (failed > 0) {
        console.log('\n⚠️  Some tests failed. Please check the backend.');
        console.log('\nCritical checks:');
        console.log('  - /api/entities must include isBound: true for bound entities');
        console.log('  - Android filters by isBound field, missing = no cards shown');
    } else {
        console.log('\n✅ All tests passed!');
    }

    return { passed, failed };
}

runTests().catch(console.error);
