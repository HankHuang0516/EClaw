/**
 * ENV Vars Merge — Regression Test
 *
 * Tests the cross-platform merge behavior for device variables:
 *   Phase 1: Clear any existing vars
 *   Phase 2: Web syncs {A: "1", B: "2"}
 *   Phase 3: APP syncs {B: "3", C: "4"} — B should split into B_Web + B_APP
 *   Phase 4: Verify merged result has A, B_Web, B_APP, C
 *   Phase 5: Web syncs again — should get merged vars back (no re-split)
 *   Phase 6: Legacy mode (no source) — should replace all
 *   Phase 7: Cleanup
 *
 * Credentials from backend/.env:
 *   BROADCAST_TEST_DEVICE_ID, BROADCAST_TEST_DEVICE_SECRET
 *
 * Usage:
 *   node test-vars-merge.js
 */

const path = require('path');
const fs = require('fs');

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

// ── Test Runner ─────────────────────────────────────────────
let passed = 0, failed = 0;

function assert(condition, msg) {
    if (condition) {
        console.log(`  ✓ ${msg}`);
        passed++;
    } else {
        console.log(`  ✗ ${msg}`);
        failed++;
    }
}

(async () => {
    const env = loadEnvFile();
    const DEVICE_ID = env.BROADCAST_TEST_DEVICE_ID;
    const DEVICE_SECRET = env.BROADCAST_TEST_DEVICE_SECRET;

    if (!DEVICE_ID || !DEVICE_SECRET) {
        console.error('Missing BROADCAST_TEST_DEVICE_ID or BROADCAST_TEST_DEVICE_SECRET in backend/.env');
        process.exit(1);
    }

    const base = { deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET };

    console.log('\n═══ ENV Vars Merge Test ═══\n');

    // Phase 1: Clear
    console.log('Phase 1: Clear existing vars');
    const del = await deleteJSON(`${API_BASE}/api/device-vars`, base);
    assert(del.data.success, 'DELETE /api/device-vars succeeds');

    // Phase 2: Web syncs {A: "1", B: "2"}
    console.log('\nPhase 2: Web syncs {A: "1", B: "2"}');
    const r2 = await postJSON(`${API_BASE}/api/device-vars`, {
        ...base, source: 'web', vars: { A: '1', B: '2' }, locked: false
    });
    assert(r2.data.success, 'POST succeeds');
    assert(r2.data.count === 2, `count = ${r2.data.count} (expected 2)`);
    assert(r2.data.mergedVars && r2.data.mergedVars.A === '1', 'mergedVars.A = "1"');
    assert(r2.data.mergedVars && r2.data.mergedVars.B === '2', 'mergedVars.B = "2"');
    assert(r2.data.sources && r2.data.sources.A === 'web', 'sources.A = "web"');

    // Phase 3: APP syncs {B: "3", C: "4"} — B conflicts
    console.log('\nPhase 3: APP syncs {B: "3", C: "4"} — expect B to split');
    const r3 = await postJSON(`${API_BASE}/api/device-vars`, {
        ...base, source: 'app', vars: { B: '3', C: '4' }, locked: false
    });
    assert(r3.data.success, 'POST succeeds');
    const mv3 = r3.data.mergedVars || {};
    const src3 = r3.data.sources || {};
    assert(mv3.A === '1', `A preserved = "${mv3.A}" (expected "1")`);
    assert(mv3.B === undefined, `B (unsuffixed) removed = ${mv3.B} (expected undefined)`);
    assert(mv3.B_Web === '2', `B_Web = "${mv3.B_Web}" (expected "2")`);
    assert(mv3.B_APP === '3', `B_APP = "${mv3.B_APP}" (expected "3")`);
    assert(mv3.C === '4', `C = "${mv3.C}" (expected "4")`);
    assert(src3.B_Web === 'web', 'sources.B_Web = "web"');
    assert(src3.B_APP === 'app', 'sources.B_APP = "app"');
    assert(r3.data.conflicts && r3.data.conflicts.length === 1, `conflicts count = ${r3.data.conflicts?.length} (expected 1)`);

    // Phase 4: Verify total count
    console.log('\nPhase 4: Verify merged state');
    assert(r3.data.count === 4, `total keys = ${r3.data.count} (expected 4: A, B_Web, B_APP, C)`);

    // Phase 5: Web syncs again with merged vars — no re-split
    console.log('\nPhase 5: Web re-syncs merged vars — should be stable');
    const r5 = await postJSON(`${API_BASE}/api/device-vars`, {
        ...base, source: 'web', vars: mv3, locked: false
    });
    assert(r5.data.success, 'POST succeeds');
    const mv5 = r5.data.mergedVars || {};
    assert(mv5.A === '1', 'A still "1"');
    assert(mv5.B_Web === '2', 'B_Web still "2"');
    assert(mv5.B_APP === '3', 'B_APP still "3"');
    assert(mv5.C === '4', 'C still "4"');
    assert(!r5.data.conflicts || r5.data.conflicts.length === 0, 'no new conflicts');

    // Phase 6: Legacy mode (no source) — replace all
    console.log('\nPhase 6: Legacy mode (no source) — replace all');
    const r6 = await postJSON(`${API_BASE}/api/device-vars`, {
        ...base, vars: { X: '99' }, locked: false
    });
    assert(r6.data.success, 'POST succeeds');
    assert(r6.data.count === 1, `count = ${r6.data.count} (expected 1)`);
    assert(!r6.data.mergedVars, 'no mergedVars in legacy mode');

    // Phase 7: Cleanup
    console.log('\nPhase 7: Cleanup');
    await deleteJSON(`${API_BASE}/api/device-vars`, base);
    assert(true, 'Cleanup done');

    // Summary
    console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══\n`);
    process.exit(failed > 0 ? 1 : 0);
})();
