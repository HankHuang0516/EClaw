/**
 * 4th Entity Visibility — Regression Test for #48
 *
 * Reproduces: "4th entity bound but not showing on home screen"
 *
 * Tests:
 *   1. Register device + bind entities 0-2
 *   2. Bind entity 3 (the 4th entity)
 *   3. Immediately poll GET /api/entities rapidly (simulating Android client)
 *   4. Verify entity 3 is ALWAYS present in every response
 *   5. Verify POST /api/device/status returns entity 3 correctly
 *   6. Verify entity count is always 4 after binding
 *   7. Verify response timing — check if any response is missing entity 3
 *   8. Check server logs for any entity_poll warnings
 *
 * Usage:
 *   node tests/test-4th-entity-visibility.js
 */

const path = require('path');
const fs = require('fs');

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
    return { status: res.status, data: await res.json() };
}

async function postJSON(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return { status: res.status, data: await res.json() };
}

async function deleteJSON(url, body) {
    const res = await fetch(url, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return { status: res.status, data: await res.json() };
}

// ── Test State ──────────────────────────────────────────────
const DEVICE_ID = `test-4th-entity-${Date.now()}`;
const DEVICE_SECRET = `test-secret-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const botSecrets = {};
let passed = 0;
let failed = 0;

function check(label, condition) {
    if (condition) {
        console.log(`  ✅ ${label}`);
        passed++;
    } else {
        console.log(`  ❌ ${label}`);
        failed++;
    }
}

// ── Main Test ───────────────────────────────────────────────
async function main() {
    console.log('============================================================');
    console.log('4TH ENTITY VISIBILITY — REGRESSION TEST (#48)');
    console.log('============================================================');
    console.log(`API: ${API_BASE}`);
    console.log(`Device: ${DEVICE_ID}`);
    console.log('');

    // ── Phase 1: Setup — register device + bind entities 0-2 ──
    console.log('--- Phase 1: Setup — bind entities 0, 1, 2 ---');

    for (let entityId = 0; entityId < 3; entityId++) {
        const reg = await postJSON(`${API_BASE}/api/device/register`, {
            deviceId: DEVICE_ID,
            deviceSecret: DEVICE_SECRET,
            entityId
        });
        check(`Entity ${entityId} register succeeded`, reg.status === 200 && reg.data.success);

        const bind = await postJSON(`${API_BASE}/api/bind`, {
            code: reg.data.bindingCode,
            name: `Bot-${entityId}`
        });
        check(`Entity ${entityId} bind succeeded`, bind.status === 200 && bind.data.success);
        botSecrets[entityId] = bind.data.botSecret;
        console.log(`  Entity ${entityId}: bound ✓`);
    }

    // Verify 3 entities
    const before = await fetchJSON(`${API_BASE}/api/entities?deviceId=${DEVICE_ID}`);
    check('3 entities bound before 4th bind', before.data.entities.length === 3);
    console.log('');

    // ── Phase 2: Bind entity 3 (the 4th entity) ──
    console.log('--- Phase 2: Bind entity 3 (the 4th entity) ---');

    const reg3 = await postJSON(`${API_BASE}/api/device/register`, {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entityId: 3
    });
    check('Entity 3 registration succeeded', reg3.status === 200);

    const bind3 = await postJSON(`${API_BASE}/api/bind`, {
        code: reg3.data.bindingCode,
        name: 'Bot-3'
    });
    check('Entity 3 binding succeeded', bind3.status === 200 && bind3.data.success);
    botSecrets[3] = bind3.data.botSecret;
    console.log('');

    // ── Phase 3: Rapid polling immediately after bind ──
    console.log('--- Phase 3: Rapid polling (20 calls, ~50ms apart) ---');
    console.log('  Simulating Android client rapid polling after entity 3 bind...');

    const pollResults = [];
    const RAPID_POLLS = 20;
    const POLL_INTERVAL_MS = 50;

    for (let i = 0; i < RAPID_POLLS; i++) {
        const start = Date.now();
        const result = await fetchJSON(`${API_BASE}/api/entities?deviceId=${DEVICE_ID}`);
        const duration = Date.now() - start;

        const entityIds = result.data.entities.map(e => e.entityId).sort();
        const hasEntity3 = entityIds.includes(3);
        const count = result.data.entities.length;

        pollResults.push({
            poll: i + 1,
            count,
            entityIds,
            hasEntity3,
            duration,
            serverReady: result.data.serverReady
        });

        if (!hasEntity3) {
            console.log(`  ⚠️  Poll ${i + 1}: Entity 3 MISSING! entities=${JSON.stringify(entityIds)} (${duration}ms)`);
        }

        if (POLL_INTERVAL_MS > 0) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        }
    }

    const missingCount = pollResults.filter(r => !r.hasEntity3).length;
    const wrongCountPolls = pollResults.filter(r => r.count !== 4);

    check(`All ${RAPID_POLLS} polls returned entity 3`, missingCount === 0);
    check(`All ${RAPID_POLLS} polls returned exactly 4 entities`, wrongCountPolls.length === 0);

    if (missingCount > 0) {
        console.log(`  ⚠️  Entity 3 was missing in ${missingCount}/${RAPID_POLLS} polls`);
        pollResults.filter(r => !r.hasEntity3).forEach(r => {
            console.log(`    Poll ${r.poll}: count=${r.count}, entities=${JSON.stringify(r.entityIds)}, duration=${r.duration}ms`);
        });
    }
    if (wrongCountPolls.length > 0) {
        console.log(`  ⚠️  Wrong entity count in ${wrongCountPolls.length}/${RAPID_POLLS} polls`);
        wrongCountPolls.forEach(r => {
            console.log(`    Poll ${r.poll}: count=${r.count}, entities=${JSON.stringify(r.entityIds)}, duration=${r.duration}ms`);
        });
    }

    const avgDuration = Math.round(pollResults.reduce((sum, r) => sum + r.duration, 0) / RAPID_POLLS);
    console.log(`  Average poll duration: ${avgDuration}ms`);
    console.log('');

    // ── Phase 4: POST /api/device/status for entity 3 ──
    console.log('--- Phase 4: POST /api/device/status for entity 3 ---');

    const statusResult = await postJSON(`${API_BASE}/api/device/status`, {
        deviceId: DEVICE_ID,
        entityId: 3,
        deviceSecret: DEVICE_SECRET
    });
    check('device/status returns 200 for entity 3', statusResult.status === 200);
    check('device/status shows entity 3 isBound=true', statusResult.data.isBound === true);
    check('device/status entity 3 has correct entityId', statusResult.data.entityId === 3);
    console.log('');

    // ── Phase 5: Verify all 4 entities individually via /api/status ──
    console.log('--- Phase 5: Verify all 4 entities via /api/status ---');

    for (let entityId = 0; entityId < 4; entityId++) {
        const s = await fetchJSON(`${API_BASE}/api/status?deviceId=${DEVICE_ID}&entityId=${entityId}`);
        check(`Entity ${entityId} isBound=${s.data.isBound}`, s.data.isBound === true);
    }
    console.log('');

    // ── Phase 6: Simulate bind-then-immediate-status (Android flow) ──
    console.log('--- Phase 6: Simulate Android bind → immediate poll flow ---');
    console.log('  Unbinding entity 3, then rebinding and immediately polling...');

    // Unbind entity 3
    await deleteJSON(`${API_BASE}/api/entity`, {
        deviceId: DEVICE_ID,
        entityId: 3,
        botSecret: botSecrets[3]
    });

    // Verify entity 3 is unbound
    const afterUnbind = await fetchJSON(`${API_BASE}/api/entities?deviceId=${DEVICE_ID}`);
    check('Entity 3 unbound successfully', afterUnbind.data.entities.length === 3);

    // Re-register + bind entity 3 and IMMEDIATELY poll (no delay)
    const reReg = await postJSON(`${API_BASE}/api/device/register`, {
        deviceId: DEVICE_ID,
        deviceSecret: DEVICE_SECRET,
        entityId: 3
    });
    const reBind = await postJSON(`${API_BASE}/api/bind`, {
        code: reReg.data.bindingCode,
        name: 'Bot-3-rebound'
    });
    botSecrets[3] = reBind.data.botSecret;

    // Immediately poll — 0ms delay
    const immediatePoll = await fetchJSON(`${API_BASE}/api/entities?deviceId=${DEVICE_ID}`);
    const immediateIds = immediatePoll.data.entities.map(e => e.entityId).sort();
    check('Immediate poll after rebind returns 4 entities', immediatePoll.data.entities.length === 4);
    check('Immediate poll includes entity 3', immediateIds.includes(3));

    // 5 more rapid polls
    let allHave3 = true;
    for (let i = 0; i < 5; i++) {
        const r = await fetchJSON(`${API_BASE}/api/entities?deviceId=${DEVICE_ID}`);
        if (!r.data.entities.some(e => e.entityId === 3)) {
            allHave3 = false;
            console.log(`  ⚠️  Rapid poll ${i + 1} after rebind: entity 3 MISSING`);
        }
    }
    check('All 5 rapid polls after rebind include entity 3', allHave3);
    console.log('');

    // ── Phase 7: Check server logs for entity_poll warnings ──
    console.log('--- Phase 7: Check server logs ---');

    const env = loadEnvFile();
    const logDeviceId = env.BROADCAST_TEST_DEVICE_ID;
    const logDeviceSecret = env.BROADCAST_TEST_DEVICE_SECRET;

    if (logDeviceId && logDeviceSecret) {
        const logs = await fetchJSON(
            `${API_BASE}/api/logs?deviceId=${logDeviceId}&deviceSecret=${logDeviceSecret}` +
            `&filterDevice=${DEVICE_ID}&category=entity_poll&limit=20`
        );
        const entityPollWarnings = (logs.data.logs || []).filter(l => l.level === 'warn');
        check('No entity_poll warnings for test device', entityPollWarnings.length === 0);
        if (entityPollWarnings.length > 0) {
            entityPollWarnings.forEach(l => console.log(`  ⚠️  ${l.message}`));
        }
    } else {
        console.log('  ⏭️  Skipping log check (no BROADCAST_TEST credentials in .env)');
    }
    console.log('');

    // ── Phase 8: Log API response details for debugging ──
    console.log('--- Phase 8: Full API response snapshot ---');

    const snapshot = await fetchJSON(`${API_BASE}/api/entities?deviceId=${DEVICE_ID}`);
    console.log(`  entities count: ${snapshot.data.entities.length}`);
    console.log(`  activeCount: ${snapshot.data.activeCount}`);
    console.log(`  serverReady: ${snapshot.data.serverReady}`);
    snapshot.data.entities.forEach(e => {
        console.log(`  Entity ${e.entityId}: isBound=${e.isBound}, name=${e.name}, state=${e.state}, character=${e.character}`);
    });
    console.log('');

    // ── Cleanup ──
    console.log('--- Cleanup ---');
    for (let entityId = 3; entityId >= 0; entityId--) {
        try {
            await deleteJSON(`${API_BASE}/api/entity`, {
                deviceId: DEVICE_ID,
                entityId,
                botSecret: botSecrets[entityId]
            });
            console.log(`  Entity ${entityId}: unbound ✓`);
        } catch (e) {
            console.log(`  Entity ${entityId}: cleanup failed (${e.message})`);
        }
    }

    // ── Summary ──
    console.log('');
    console.log('============================================================');
    console.log(`4TH ENTITY VISIBILITY TEST SUMMARY`);
    console.log('============================================================');
    console.log(`Results: ${passed} passed, ${failed} failed`);
    console.log('============================================================');

    if (failed > 0) {
        console.log('');
        console.log('❌ TEST FAILED — Server API returned inconsistent entity 3 visibility');
        console.log('   This confirms the bug is server-side (API level).');
    } else {
        console.log('');
        console.log('✅ All server-side tests passed');
        console.log('   Entity 3 is always present in API responses.');
        console.log('   Bug is likely CLIENT-SIDE (Android StateRepository filtering).');
        console.log('');
        console.log('   Suspected root cause:');
        console.log('   StateRepository.getMultiEntityStatusFlow() filters entities by');
        console.log('   layoutPrefs.getRegisteredEntityIds(). When entity 3 is newly bound,');
        console.log('   SharedPreferences.apply() is async — subsequent poll may read stale');
        console.log('   registeredIds missing entity 3, causing it to be filtered out.');
    }

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Test crashed:', err);
    process.exit(2);
});
