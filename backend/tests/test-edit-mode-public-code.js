#!/usr/bin/env node
/**
 * Edit Mode Public Code Preservation — Regression Test
 *
 * Verifies that publicCode is preserved when entities are reordered
 * via the edit mode swap (drag-and-drop). This is a regression test
 * for the bug where public code UI disappeared after swapping entity
 * positions in edit mode.
 *
 * Test flow:
 *   Phase 1: Setup — bind 2 entities, verify both have publicCodes
 *   Phase 2: Reorder — swap the two entity slots
 *   Phase 3: Verify — publicCodes are preserved and correctly mapped
 *   Phase 4: Double-swap — swap back, verify publicCodes return to original
 *   Phase 5: Cleanup
 *
 * Credentials from backend/.env:
 *   BROADCAST_TEST_DEVICE_ID, BROADCAST_TEST_DEVICE_SECRET
 *
 * Usage:
 *   node test-edit-mode-public-code.js
 *   node test-edit-mode-public-code.js --local
 *   node test-edit-mode-public-code.js --skip-cleanup
 */

const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const API_BASE = args.includes('--local') ? 'http://localhost:3000' : 'https://eclawbot.com';
const skipCleanup = args.includes('--skip-cleanup');

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

async function postRaw(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    return { status: res.status, data };
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
    const passCount = results.filter(r => r.passed).length;
    const failCount = results.filter(r => !r.passed).length;
    console.log('\n' + '='.repeat(65));
    console.log(`  Results: ${passCount} passed, ${failCount} failed, ${results.length} total`);
    if (failCount > 0) {
        console.log('  Failed:');
        results.filter(r => !r.passed).forEach(r => {
            console.log(`    ❌ ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
        });
    }
    console.log('='.repeat(65));
}

// ── Main ────────────────────────────────────────────────────
async function main() {
    const env = loadEnvFile();

    const deviceId = env.BROADCAST_TEST_DEVICE_ID || process.env.BROADCAST_TEST_DEVICE_ID || '';
    const deviceSecret = env.BROADCAST_TEST_DEVICE_SECRET || process.env.BROADCAST_TEST_DEVICE_SECRET || '';

    if (!deviceId || !deviceSecret) {
        console.error('Error: BROADCAST_TEST_DEVICE_ID and BROADCAST_TEST_DEVICE_SECRET required in backend/.env');
        process.exit(1);
    }

    console.log('='.repeat(65));
    console.log('  Edit Mode Public Code Preservation — Regression Test');
    console.log('='.repeat(65));
    console.log(`  API:     ${API_BASE}`);
    console.log(`  Device:  ${deviceId}`);
    console.log('='.repeat(65));
    console.log('');

    const testEntities = []; // { entityId, botSecret, publicCode }

    try {
        // ────────────────────────────────────────────────────
        // Phase 1: Setup — bind 2 entities and capture publicCodes
        // ────────────────────────────────────────────────────
        console.log('── Phase 1: Setup ──');

        const allEntities = await fetchJSON(
            `${API_BASE}/api/entities?deviceId=${deviceId}`
        );
        check('Fetch all entities', allEntities.success !== false,
            `got ${allEntities.entities?.length || 0} entities`);

        // Find 2 free (unbound) slots
        const freeSlots = [];
        for (let i = 0; i < 4; i++) {
            const e = allEntities.entities?.find(e => e.entityId === i);
            if (!e || !e.isBound) freeSlots.push(i);
            if (freeSlots.length >= 2) break;
        }

        if (freeSlots.length < 2) {
            console.error('  Need at least 2 free entity slots. Unbind some entities first.');
            printSummary();
            process.exit(1);
        }
        console.log(`  Using free slots: ${freeSlots.join(', ')}`);

        // Register + bind 2 test entities
        for (const slot of freeSlots) {
            const regRes = await postJSON(`${API_BASE}/api/device/register`, {
                deviceId, deviceSecret, entityId: slot, appVersion: 'test-edit-mode-pc'
            });
            check(`Register entity #${slot}`, !!regRes.bindingCode, `code: ${regRes.bindingCode}`);

            const bindRes = await postJSON(`${API_BASE}/api/bind`, {
                code: regRes.bindingCode,
                name: `PCTest-${slot}`
            });
            check(`Bind entity #${slot}`, !!bindRes.botSecret);
            testEntities.push({ entityId: slot, botSecret: bindRes.botSecret, publicCode: null });
        }

        // Fetch entities again to get publicCodes
        await sleep(500);
        const withCodes = await fetchJSON(
            `${API_BASE}/api/entities?deviceId=${deviceId}`
        );

        for (const te of testEntities) {
            const entity = withCodes.entities?.find(e => e.entityId === te.entityId);
            te.publicCode = entity?.publicCode || null;
            check(`Entity #${te.entityId} has publicCode`,
                !!te.publicCode,
                `code: ${te.publicCode || '(none)'}`);
        }

        // Set distinct messages as markers
        for (const te of testEntities) {
            await postJSON(`${API_BASE}/api/transform`, {
                deviceId,
                entityId: te.entityId,
                botSecret: te.botSecret,
                state: 'IDLE',
                message: `pc-marker-${te.entityId}`
            });
        }
        check('Set marker messages', true);
        console.log('');

        // ────────────────────────────────────────────────────
        // Phase 2: Reorder — swap the two test entity slots
        // ────────────────────────────────────────────────────
        console.log('── Phase 2: Reorder (swap) ──');

        const slotA = testEntities[0].entityId;
        const slotB = testEntities[1].entityId;
        const codeA = testEntities[0].publicCode;
        const codeB = testEntities[1].publicCode;

        console.log(`  Swapping slot ${slotA} (code: ${codeA}) ↔ slot ${slotB} (code: ${codeB})`);

        const order = [0, 1, 2, 3];
        order[slotA] = slotB;
        order[slotB] = slotA;

        const reorderRes = await postRaw(`${API_BASE}/api/device/reorder-entities`, {
            deviceId, deviceSecret, order
        });

        check('Reorder returns 200', reorderRes.status === 200, `status: ${reorderRes.status}`);
        check('Reorder success', reorderRes.data.success === true);
        console.log('');

        // ────────────────────────────────────────────────────
        // Phase 3: Verify — publicCodes preserved after swap
        // ────────────────────────────────────────────────────
        console.log('── Phase 3: Public code preservation ──');

        await sleep(1000);
        const afterSwap = await fetchJSON(
            `${API_BASE}/api/entities?deviceId=${deviceId}`
        );
        check('Post-swap fetch succeeds', afterSwap.success !== false);

        const entityAtA = afterSwap.entities?.find(e => e.entityId === slotA);
        const entityAtB = afterSwap.entities?.find(e => e.entityId === slotB);

        if (entityAtA && entityAtB) {
            // After swap: slotA should have slotB's old data (and publicCode)
            check(`Slot ${slotA} has publicCode (was slot ${slotB}'s)`,
                !!entityAtA.publicCode,
                `code: ${entityAtA.publicCode || '(MISSING!)'}`);

            check(`Slot ${slotB} has publicCode (was slot ${slotA}'s)`,
                !!entityAtB.publicCode,
                `code: ${entityAtB.publicCode || '(MISSING!)'}`);

            // The codes should have swapped: slotA now has codeB, slotB now has codeA
            check(`Slot ${slotA} publicCode matches old slot ${slotB}`,
                entityAtA.publicCode === codeB,
                `got: ${entityAtA.publicCode}, expected: ${codeB}`);

            check(`Slot ${slotB} publicCode matches old slot ${slotA}`,
                entityAtB.publicCode === codeA,
                `got: ${entityAtB.publicCode}, expected: ${codeA}`);

            // Verify marker messages also swapped
            check(`Slot ${slotA} has slot ${slotB}'s marker`,
                entityAtA.message === `pc-marker-${slotB}`,
                `message: "${entityAtA.message}"`);

            check(`Slot ${slotB} has slot ${slotA}'s marker`,
                entityAtB.message === `pc-marker-${slotA}`,
                `message: "${entityAtB.message}"`);

            // Verify both still bound
            check(`Slot ${slotA} still bound`, entityAtA.isBound === true);
            check(`Slot ${slotB} still bound`, entityAtB.isBound === true);
        } else {
            check('Post-swap entities found', false, 'Could not find swapped entities');
        }
        console.log('');

        // ────────────────────────────────────────────────────
        // Phase 4: Double-swap — swap back, verify codes return
        // ────────────────────────────────────────────────────
        console.log('── Phase 4: Double-swap (swap back) ──');

        // Swap back to original positions
        const reorderBack = await postRaw(`${API_BASE}/api/device/reorder-entities`, {
            deviceId, deviceSecret, order // same permutation swaps back
        });
        check('Swap-back returns 200', reorderBack.status === 200);

        await sleep(1000);
        const afterSwapBack = await fetchJSON(
            `${API_BASE}/api/entities?deviceId=${deviceId}`
        );

        const entityBackA = afterSwapBack.entities?.find(e => e.entityId === slotA);
        const entityBackB = afterSwapBack.entities?.find(e => e.entityId === slotB);

        if (entityBackA && entityBackB) {
            // After swapping back, codes should be in original positions
            check(`Slot ${slotA} publicCode back to original`,
                entityBackA.publicCode === codeA,
                `got: ${entityBackA.publicCode}, expected: ${codeA}`);

            check(`Slot ${slotB} publicCode back to original`,
                entityBackB.publicCode === codeB,
                `got: ${entityBackB.publicCode}, expected: ${codeB}`);

            check(`Slot ${slotA} marker back to original`,
                entityBackA.message === `pc-marker-${slotA}`,
                `message: "${entityBackA.message}"`);

            check(`Slot ${slotB} marker back to original`,
                entityBackB.message === `pc-marker-${slotB}`,
                `message: "${entityBackB.message}"`);
        } else {
            check('Post-swap-back entities found', false, 'Could not find entities');
        }
        console.log('');

        // ────────────────────────────────────────────────────
        // Phase 5: Public code still works for cross-device lookup
        // ────────────────────────────────────────────────────
        console.log('── Phase 5: Public code lookup ──');

        // Verify publicCode can still be used for cross-device communication
        // by calling the contacts/add endpoint
        if (codeA) {
            const lookupRes = await postRaw(`${API_BASE}/api/contacts/add`, {
                deviceId, deviceSecret, publicCode: codeA
            });
            // We expect either success or "already your own entity" error — both mean the code is valid
            const codeRecognized = lookupRes.status === 200 ||
                (lookupRes.data.error && lookupRes.data.error.includes('own'));
            check(`Public code "${codeA}" still recognized`,
                codeRecognized,
                `status: ${lookupRes.status}, response: ${JSON.stringify(lookupRes.data).slice(0, 100)}`);
        }
        console.log('');

    } catch (err) {
        console.error(`\n  FATAL: ${err.message}\n`);
        check('Test execution', false, err.message);
    }

    // ────────────────────────────────────────────────────
    // Phase 6: Cleanup — unbind test entities
    // ────────────────────────────────────────────────────
    if (!skipCleanup && testEntities.length > 0) {
        console.log('── Phase 6: Cleanup ──');

        try {
            // Re-fetch current state (positions may have changed)
            const currentEntities = await fetchJSON(
                `${API_BASE}/api/entities?deviceId=${deviceId}`
            );
            const boundEntities = currentEntities.entities || [];

            for (const te of testEntities) {
                // Find the entity by name (position may have changed due to swaps)
                const current = boundEntities.find(e =>
                    e.name === `PCTest-${te.entityId}`
                );
                if (current) {
                    try {
                        await deleteJSON(`${API_BASE}/api/unbind`, {
                            deviceId,
                            entityId: current.entityId,
                            botSecret: te.botSecret
                        });
                        console.log(`  Unbound PCTest-${te.entityId} (slot ${current.entityId})`);
                    } catch (e) {
                        // Try with deviceSecret as fallback
                        try {
                            await deleteJSON(`${API_BASE}/api/unbind`, {
                                deviceId, deviceSecret,
                                entityId: current.entityId
                            });
                            console.log(`  Unbound PCTest-${te.entityId} via deviceSecret`);
                        } catch (e2) {
                            console.log(`  Warning: Could not unbind PCTest-${te.entityId}: ${e2.message}`);
                        }
                    }
                }
            }
        } catch (cleanupErr) {
            console.log(`  Warning: Cleanup error: ${cleanupErr.message}`);
        }
    } else if (skipCleanup) {
        console.log('── Cleanup skipped (--skip-cleanup) ──');
    }

    printSummary();
    process.exit(results.some(r => !r.passed) ? 1 : 0);
}

main();
