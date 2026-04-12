/**
 * Organization Hierarchy Chart — Integration Test
 *
 * Tests the full org chart lifecycle against live server:
 *   Phase 1: GET default (no org chart saved yet)
 *   Phase 2: PUT hierarchy
 *   Phase 3: GET verify persisted hierarchy
 *   Phase 4: PUT partial update (options only)
 *   Phase 5: GET verify merged state
 *   Phase 6: PUT cycle detection (should fail)
 *   Phase 7: PUT max depth exceeded (should fail)
 *   Phase 8: Reset to default
 *   Phase 9: Auth validation (bad credentials)
 *
 * Credentials from backend/.env:
 *   BROADCAST_TEST_DEVICE_ID, BROADCAST_TEST_DEVICE_SECRET
 *
 * Usage:
 *   node test-org-chart.js
 */

const path = require('path');
const fs = require('fs');

// ── Config ──────────────────────────────────────────────────
const API_BASE = 'https://eclawbot.com';

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
    const data = await res.json();
    return { status: res.status, data };
}

async function putJSON(url, body) {
    const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    return { status: res.status, data };
}

// ── Test Runner ─────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, msg) {
    if (condition) {
        passed++;
        console.log(`  ✅ ${msg}`);
    } else {
        failed++;
        console.error(`  ❌ ${msg}`);
    }
}

// ── Main ────────────────────────────────────────────────────
async function main() {
    const env = loadEnvFile();
    const DEVICE_ID = env.BROADCAST_TEST_DEVICE_ID;
    const DEVICE_SECRET = env.BROADCAST_TEST_DEVICE_SECRET;

    if (!DEVICE_ID || !DEVICE_SECRET) {
        console.error('Missing BROADCAST_TEST_DEVICE_ID or BROADCAST_TEST_DEVICE_SECRET in .env');
        process.exit(1);
    }

    const authQS = `deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`;

    console.log('\n=== Phase 1: GET default org chart ===');
    {
        const { status, data } = await fetchJSON(`${API_BASE}/api/device/org-chart?${authQS}`);
        assert(status === 200, `GET returns 200 (got ${status})`);
        assert(data.success === true, 'Response has success: true');
        assert(data.orgChart !== undefined, 'Response contains orgChart');
        assert(typeof data.orgChart.options === 'object', 'orgChart has options object');
    }

    console.log('\n=== Phase 2: PUT hierarchy ===');
    {
        const hierarchy = { USER: [0, 1], '0': [2] };
        const { status, data } = await putJSON(`${API_BASE}/api/device/org-chart`, {
            deviceId: DEVICE_ID,
            deviceSecret: DEVICE_SECRET,
            hierarchy,
        });
        assert(status === 200, `PUT hierarchy returns 200 (got ${status})`);
        assert(data.success === true, 'PUT returns success: true');
        assert(JSON.stringify(data.orgChart?.hierarchy) === JSON.stringify(hierarchy), 'Returned hierarchy matches input');
    }

    console.log('\n=== Phase 3: GET verify persisted ===');
    {
        const { status, data } = await fetchJSON(`${API_BASE}/api/device/org-chart?${authQS}`);
        assert(status === 200, `GET returns 200`);
        const h = data.orgChart?.hierarchy;
        assert(Array.isArray(h?.USER), 'hierarchy.USER is array');
        assert(h.USER.includes(0) && h.USER.includes(1), 'USER has entities 0 and 1');
        assert(Array.isArray(h?.['0']), 'hierarchy["0"] is array');
        assert(h['0'].includes(2), 'Entity 0 has child 2');
    }

    console.log('\n=== Phase 4: PUT partial update (options only) ===');
    {
        const { status, data } = await putJSON(`${API_BASE}/api/device/org-chart`, {
            deviceId: DEVICE_ID,
            deviceSecret: DEVICE_SECRET,
            options: { kanbanReviewer: true, taskForward: false, allForward: false },
        });
        assert(status === 200, `PUT options returns 200 (got ${status})`);
        assert(data.orgChart?.options?.kanbanReviewer === true, 'kanbanReviewer set to true');
    }

    console.log('\n=== Phase 5: GET verify merged state ===');
    {
        const { status, data } = await fetchJSON(`${API_BASE}/api/device/org-chart?${authQS}`);
        assert(status === 200, `GET returns 200`);
        // Hierarchy should still be from Phase 2
        assert(data.orgChart?.hierarchy?.USER?.includes(0), 'Hierarchy preserved after options-only update');
        assert(data.orgChart?.options?.kanbanReviewer === true, 'kanbanReviewer still true');
    }

    console.log('\n=== Phase 6: PUT cycle detection (should fail) ===');
    {
        // Entity 0 under 1, entity 1 under 0 → entity 0 appears under both USER and entity 1
        const { status, data } = await putJSON(`${API_BASE}/api/device/org-chart`, {
            deviceId: DEVICE_ID,
            deviceSecret: DEVICE_SECRET,
            hierarchy: { USER: [0], '0': [1], '1': [0] },
        });
        assert(status === 400, `Cycle hierarchy returns 400 (got ${status})`);
        assert(data.success === false, 'Cycle hierarchy rejected');
    }

    console.log('\n=== Phase 7: PUT max depth exceeded (should fail) ===');
    {
        // Depth 6: USER→0→1→2→3→4→5
        const { status, data } = await putJSON(`${API_BASE}/api/device/org-chart`, {
            deviceId: DEVICE_ID,
            deviceSecret: DEVICE_SECRET,
            hierarchy: { USER: [0], '0': [1], '1': [2], '2': [3], '3': [4], '4': [5] },
        });
        assert(status === 400, `Depth 6 hierarchy returns 400 (got ${status})`);
        assert(data.success === false, 'Depth > 5 rejected');
    }

    console.log('\n=== Phase 8: Reset to default ===');
    {
        const { status, data } = await putJSON(`${API_BASE}/api/device/org-chart`, {
            deviceId: DEVICE_ID,
            deviceSecret: DEVICE_SECRET,
            hierarchy: { USER: [0, 1, 2] },
            options: { kanbanReviewer: false, taskForward: false, allForward: false },
        });
        assert(status === 200, `Reset returns 200 (got ${status})`);
        assert(data.orgChart?.options?.kanbanReviewer === false, 'kanbanReviewer reset to false');
    }

    console.log('\n=== Phase 9: Auth validation ===');
    {
        const { status } = await fetchJSON(`${API_BASE}/api/device/org-chart?deviceId=fake&deviceSecret=fake`);
        assert(status === 401, `Bad credentials returns 401 (got ${status})`);
    }

    // ── Summary ─────────────────────────────────────────────
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        console.log('❌ SOME TESTS FAILED');
        process.exit(1);
    } else {
        console.log('✅ ALL TESTS PASSED');
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
