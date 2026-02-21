/**
 * Entity Cards Stability — Regression Test for #16 / #29
 *
 * Verifies that entity cards do not disappear due to:
 *   1. Transient empty API responses
 *   2. Server restart / persistence not yet loaded
 *   3. Polling during edit mode (web portal parity)
 *
 * Phases:
 *   Phase 1: Setup — register device + bind 1 entity
 *   Phase 2: Verify GET /api/entities returns bound entity + serverReady flag
 *   Phase 3: Simulate rapid polling — verify consistency across 10 rapid calls
 *   Phase 4: Verify serverReady field is present in response
 *   Phase 5: Verify entity_poll logging when device returns 0 entities
 *   Phase 6: Cleanup
 *
 * Credentials from backend/.env:
 *   BROADCAST_TEST_DEVICE_ID, BROADCAST_TEST_DEVICE_SECRET
 *
 * Usage:
 *   node test-entity-cards-stability.js
 *   node test-entity-cards-stability.js --skip-cleanup
 */

const path = require('path');
const fs = require('fs');

// ── Config ──────────────────────────────────────────────────
const API_BASE = process.env.API_BASE || 'https://eclaw.up.railway.app';

// ── .env loader ─────────────────────────────────────────────
function loadEnvFile() {
    const envPath = path.resolve(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return {};
    const vars = {};
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
        line = line.trim();
        if (!line || line.startsWith('#')) return;
        const idx = line.indexOf('=');
        if (idx > 0) vars[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });
    return vars;
}

// ── HTTP Helpers ────────────────────────────────────────────
async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
    return res.json();
}

async function postJSON(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`POST ${url} → ${res.status}: ${JSON.stringify(data)}`);
    return data;
}

async function deleteJSON(url, body) {
    const res = await fetch(url, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return res.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Test Result Tracking ────────────────────────────────────
const results = [];
function check(name, passed, detail = '') {
    results.push({ name, passed, detail });
    const icon = passed ? '✅' : '❌';
    const suffix = detail ? ` — ${detail}` : '';
    console.log(`  ${icon} ${name}${suffix}`);
}

function printSummary() {
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    console.log('');
    console.log('─'.repeat(65));
    console.log(`  Results: ${passed} passed, ${failed} failed, ${results.length} total`);
    if (failed > 0) {
        console.log('  Failed tests:');
        results.filter(r => !r.passed).forEach(r => {
            console.log(`    ❌ ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
        });
    }
    console.log('─'.repeat(65));
}

// ── Main ────────────────────────────────────────────────────
async function main() {
    const env = loadEnvFile();
    const args = process.argv.slice(2);
    const skipCleanup = args.includes('--skip-cleanup');

    const deviceId = env.BROADCAST_TEST_DEVICE_ID || process.env.BROADCAST_TEST_DEVICE_ID || '';
    const deviceSecret = env.BROADCAST_TEST_DEVICE_SECRET || process.env.BROADCAST_TEST_DEVICE_SECRET || '';

    if (!deviceId || !deviceSecret) {
        console.error('Error: BROADCAST_TEST_DEVICE_ID and BROADCAST_TEST_DEVICE_SECRET required in backend/.env');
        process.exit(1);
    }

    console.log('='.repeat(65));
    console.log('  Entity Cards Stability — Regression Test (#16/#29)');
    console.log('='.repeat(65));
    console.log(`  API:     ${API_BASE}`);
    console.log(`  Device:  ${deviceId}`);
    console.log('='.repeat(65));
    console.log('');

    let testEntitySlot = -1;
    let testBotSecret = null;

    try {
        // ────────────────────────────────────────────────────
        // Phase 1: Setup — find a free slot and bind 1 entity
        // ────────────────────────────────────────────────────
        console.log('── Phase 1: Setup ──');

        const allEntities = await fetchJSON(
            `${API_BASE}/api/entities?deviceId=${deviceId}`
        );
        check('Fetch all entities', allEntities.success !== false,
            `got ${allEntities.entities?.length || 0} entities`);

        // Find a free (unbound) slot
        const occupiedSlots = new Set((allEntities.entities || []).map(e => e.entityId));
        for (let i = 0; i < 4; i++) {
            if (!occupiedSlots.has(i)) {
                testEntitySlot = i;
                break;
            }
        }

        if (testEntitySlot === -1) {
            console.log('  ⚠ All 4 slots occupied — using existing entities for read-only tests');
        } else {
            // Register + bind test entity
            const regRes = await postJSON(`${API_BASE}/api/device/register`, {
                deviceId, deviceSecret, entityId: testEntitySlot, appVersion: 'test-cards-stability'
            });
            check(`Register entity #${testEntitySlot}`, !!regRes.bindingCode,
                `code: ${regRes.bindingCode}`);

            const bindRes = await postJSON(`${API_BASE}/api/bind`, {
                code: regRes.bindingCode,
                name: `StabilityTest-${testEntitySlot}`
            });
            check(`Bind entity #${testEntitySlot}`, !!bindRes.botSecret);
            testBotSecret = bindRes.botSecret;
        }

        // ────────────────────────────────────────────────────
        // Phase 2: Verify entities endpoint returns correctly
        // ────────────────────────────────────────────────────
        console.log('');
        console.log('── Phase 2: Entity Response Validation ──');

        const entitiesRes = await fetchJSON(
            `${API_BASE}/api/entities?deviceId=${deviceId}`
        );

        const boundCount = (entitiesRes.entities || []).length;
        check('Entities response has entities array', Array.isArray(entitiesRes.entities));
        check('At least 1 bound entity returned', boundCount > 0, `count: ${boundCount}`);
        check('activeCount matches entities.length',
            entitiesRes.activeCount === boundCount,
            `activeCount=${entitiesRes.activeCount}, entities.length=${boundCount}`);
        check('serverReady field present', 'serverReady' in entitiesRes,
            `serverReady=${entitiesRes.serverReady}`);
        check('serverReady is true (persistence loaded)', entitiesRes.serverReady === true);

        // Verify each entity has required fields
        const requiredFields = ['entityId', 'isBound', 'character', 'state'];
        const allFieldsPresent = (entitiesRes.entities || []).every(e =>
            requiredFields.every(f => f in e)
        );
        check('All entities have required fields', allFieldsPresent,
            `checked: ${requiredFields.join(', ')}`);

        // ────────────────────────────────────────────────────
        // Phase 3: Rapid polling — 10 consecutive requests
        // Must all return consistent non-empty results
        // ────────────────────────────────────────────────────
        console.log('');
        console.log('── Phase 3: Rapid Polling Stability ──');

        let minCount = Infinity;
        let maxCount = 0;
        let emptyResponses = 0;
        let allServerReady = true;

        for (let i = 0; i < 10; i++) {
            const pollRes = await fetchJSON(
                `${API_BASE}/api/entities?deviceId=${deviceId}`
            );
            const count = (pollRes.entities || []).length;
            if (count === 0) emptyResponses++;
            if (count < minCount) minCount = count;
            if (count > maxCount) maxCount = count;
            if (!pollRes.serverReady) allServerReady = false;
            // Small delay to simulate realistic polling
            await sleep(100);
        }

        check('No empty responses in 10 polls', emptyResponses === 0,
            `empty: ${emptyResponses}/10`);
        check('Consistent entity count across polls', minCount === maxCount,
            `min=${minCount}, max=${maxCount}`);
        check('All polls report serverReady=true', allServerReady);

        // ────────────────────────────────────────────────────
        // Phase 4: Verify entity count matches maxEntitiesPerDevice
        // ────────────────────────────────────────────────────
        console.log('');
        console.log('── Phase 4: Count Consistency ──');

        const finalRes = await fetchJSON(
            `${API_BASE}/api/entities?deviceId=${deviceId}`
        );
        check('maxEntitiesPerDevice is 4', finalRes.maxEntitiesPerDevice === 4,
            `got: ${finalRes.maxEntitiesPerDevice}`);
        check('activeCount <= maxEntitiesPerDevice',
            finalRes.activeCount <= finalRes.maxEntitiesPerDevice,
            `${finalRes.activeCount} <= ${finalRes.maxEntitiesPerDevice}`);

        // Verify all entity IDs are valid (0-3)
        const invalidIds = (finalRes.entities || []).filter(e =>
            e.entityId < 0 || e.entityId >= 4
        );
        check('All entityIds in valid range (0-3)', invalidIds.length === 0,
            invalidIds.length > 0 ? `invalid: ${invalidIds.map(e => e.entityId).join(',')}` : '');

        // ────────────────────────────────────────────────────
        // Phase 5: Non-existent device returns empty correctly
        // ────────────────────────────────────────────────────
        console.log('');
        console.log('── Phase 5: Edge Cases ──');

        const fakeDeviceRes = await fetchJSON(
            `${API_BASE}/api/entities?deviceId=FAKE_DEVICE_${Date.now()}`
        );
        check('Fake device returns 0 entities', fakeDeviceRes.activeCount === 0);
        check('Fake device response has serverReady field',
            'serverReady' in fakeDeviceRes);

    } catch (err) {
        console.error('');
        console.error(`  💥 Test error: ${err.message}`);
        check('Test execution', false, err.message);
    }

    // ────────────────────────────────────────────────────
    // Phase 6: Cleanup
    // ────────────────────────────────────────────────────
    if (testEntitySlot >= 0 && testBotSecret && !skipCleanup) {
        console.log('');
        console.log('── Phase 6: Cleanup ──');
        try {
            await deleteJSON(`${API_BASE}/api/entity/remove`, {
                deviceId, deviceSecret, entityId: testEntitySlot
            });
            check(`Cleanup entity #${testEntitySlot}`, true);
        } catch (err) {
            check(`Cleanup entity #${testEntitySlot}`, false, err.message);
        }
    }

    printSummary();

    const failed = results.filter(r => !r.passed).length;
    process.exit(failed > 0 ? 1 : 0);
}

main();
