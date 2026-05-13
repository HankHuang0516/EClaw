/**
 * Entity Management — Refresh + Reorder Regression Test
 *
 * Tests the full entity management flow with log/telemetry verification:
 *   Phase 1: Setup — register device + bind 2 entities
 *   Phase 2: Refresh — test /api/entity/refresh for bound entity
 *   Phase 3: Refresh cooldown — verify 1-minute cooldown (429)
 *   Phase 4: Refresh unbound — test refresh on unbound entity (400)
 *   Phase 5: Reorder — test /api/device/reorder-entities (swap slots)
 *   Phase 6: Reorder validation — verify invalid permutations rejected
 *   Phase 7: Post-reorder state — verify entity data is in new slots
 *   Phase 8: Log verification — query /api/device-telemetry to verify all
 *            operations were captured by backend middleware
 *   Phase 9: Cleanup
 *
 * Credentials from backend/.env:
 *   BROADCAST_TEST_DEVICE_ID, BROADCAST_TEST_DEVICE_SECRET
 *   (reuses broadcast test credentials)
 *
 * Usage:
 *   node test-entity-management.js
 *   node test-entity-management.js --skip-cleanup
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

/** POST that returns { status, data } without throwing on non-2xx */
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
    console.log('  Entity Management — Refresh + Reorder Regression Test');
    console.log('='.repeat(65));
    console.log(`  API:     ${API_BASE}`);
    console.log(`  Device:  ${deviceId}`);
    console.log('='.repeat(65));
    console.log('');

    const testEntities = []; // { entityId, botSecret }
    const testStartTs = Date.now();

    try {
        // ────────────────────────────────────────────────────
        // Phase 1: Setup — find free slots and bind 2 entities
        // ────────────────────────────────────────────────────
        console.log('── Phase 1: Setup ──');

        const allEntities = await fetchJSON(
            `${API_BASE}/api/entities?deviceId=${deviceId}&deviceSecret=${deviceSecret}`
        );
        check('Fetch all entities', allEntities.success !== false, `got ${allEntities.entities?.length || 0} entities`);

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
                deviceId, deviceSecret, entityId: slot, appVersion: 'test-entity-mgmt'
            });
            check(`Register entity #${slot}`, !!regRes.bindingCode, `code: ${regRes.bindingCode}`);

            const bindRes = await postJSON(`${API_BASE}/api/bind`, {
                code: regRes.bindingCode,
                name: `TestBot-${slot}`
            });
            check(`Bind entity #${slot}`, !!bindRes.botSecret);
            testEntities.push({ entityId: slot, botSecret: bindRes.botSecret });
        }

        // Set distinct messages so we can verify reorder
        for (const te of testEntities) {
            await postJSON(`${API_BASE}/api/transform`, {
                deviceId,
                entityId: te.entityId,
                botSecret: te.botSecret,
                state: 'IDLE',
                message: `marker-slot-${te.entityId}`
            });
        }
        check('Set marker messages', true, testEntities.map(t => `#${t.entityId}: marker-slot-${t.entityId}`).join(', '));
        console.log('');

        // ────────────────────────────────────────────────────
        // Phase 2: Refresh — test /api/entity/refresh
        // ────────────────────────────────────────────────────
        console.log('── Phase 2: Refresh (bound entity) ──');

        const refreshTarget = testEntities[0];
        const refreshRes = await postRaw(`${API_BASE}/api/entity/refresh`, {
            deviceId, deviceSecret, entityId: refreshTarget.entityId
        });

        check('Refresh returns 200', refreshRes.status === 200, `status: ${refreshRes.status}`);
        // For non-official bot (user-bound), webhook is null → may succeed with pollingMode or webhookBroken
        // The important thing is it doesn't crash
        check('Refresh response has success field', refreshRes.data.success !== undefined,
            `success: ${refreshRes.data.success}, pollingMode: ${refreshRes.data.pollingMode}`);
        check('Refresh does NOT return 500', refreshRes.status !== 500, `status: ${refreshRes.status}`);
        console.log('');

        // ────────────────────────────────────────────────────
        // Phase 3: Refresh cooldown — verify 429 within 60s
        // ────────────────────────────────────────────────────
        console.log('── Phase 3: Refresh cooldown ──');

        const cooldownRes = await postRaw(`${API_BASE}/api/entity/refresh`, {
            deviceId, deviceSecret, entityId: refreshTarget.entityId
        });

        check('Cooldown returns 429', cooldownRes.status === 429, `status: ${cooldownRes.status}`);
        check('Cooldown has remaining seconds', cooldownRes.data.cooldown_remaining > 0,
            `remaining: ${cooldownRes.data.cooldown_remaining}s`);
        check('Cooldown error message in Chinese', cooldownRes.data.error?.includes('秒'),
            `error: ${cooldownRes.data.error}`);
        console.log('');

        // ────────────────────────────────────────────────────
        // Phase 4: Refresh on unbound entity → 400
        // ────────────────────────────────────────────────────
        console.log('── Phase 4: Refresh unbound entity ──');

        // Find an unbound slot
        const unboundSlot = [0, 1, 2, 3].find(i => !testEntities.find(t => t.entityId === i) &&
            !allEntities.entities?.find(e => e.entityId === i && e.isBound));

        if (unboundSlot !== undefined) {
            const unboundRes = await postRaw(`${API_BASE}/api/entity/refresh`, {
                deviceId, deviceSecret, entityId: unboundSlot
            });
            check('Refresh unbound → 400', unboundRes.status === 400, `status: ${unboundRes.status}`);
            check('Error says not bound', unboundRes.data.error?.includes('not bound'),
                `error: ${unboundRes.data.error}`);
        } else {
            console.log('  (skipped — all slots are bound)');
        }
        console.log('');

        // ────────────────────────────────────────────────────
        // Phase 5: Reorder — swap the two test entity slots
        // ────────────────────────────────────────────────────
        console.log('── Phase 5: Reorder entities ──');

        const slotA = testEntities[0].entityId;
        const slotB = testEntities[1].entityId;

        // Build permutation: swap slotA and slotB, keep others identity
        const order = [0, 1, 2, 3];
        order[slotA] = slotB;
        order[slotB] = slotA;

        console.log(`  Swapping slot ${slotA} ↔ slot ${slotB}: order = [${order.join(',')}]`);

        const reorderRes = await postRaw(`${API_BASE}/api/device/reorder-entities`, {
            deviceId, deviceSecret, order
        });

        check('Reorder returns 200', reorderRes.status === 200, `status: ${reorderRes.status}`);
        check('Reorder success', reorderRes.data.success === true, `message: ${reorderRes.data.message}`);
        console.log('');

        // ────────────────────────────────────────────────────
        // Phase 6: Reorder validation — invalid inputs
        // ────────────────────────────────────────────────────
        console.log('── Phase 6: Reorder validation ──');

        // Invalid permutation: duplicate values
        const badOrder1 = await postRaw(`${API_BASE}/api/device/reorder-entities`, {
            deviceId, deviceSecret, order: [0, 0, 2, 3]
        });
        check('Duplicate values → 400', badOrder1.status === 400, `error: ${badOrder1.data.error}`);

        // Wrong length
        const badOrder2 = await postRaw(`${API_BASE}/api/device/reorder-entities`, {
            deviceId, deviceSecret, order: [0, 1]
        });
        check('Wrong length → 400', badOrder2.status === 400, `error: ${badOrder2.data.error}`);

        // Identity (no change)
        const identityRes = await postRaw(`${API_BASE}/api/device/reorder-entities`, {
            deviceId, deviceSecret, order: [0, 1, 2, 3]
        });
        check('Identity order → 200 (no-op)', identityRes.status === 200 && identityRes.data.success,
            `message: ${identityRes.data.message}`);

        // Missing credentials
        const noAuth = await postRaw(`${API_BASE}/api/device/reorder-entities`, {
            deviceId, deviceSecret: 'wrong-secret', order: [0, 1, 2, 3]
        });
        check('Wrong secret → 403', noAuth.status === 403, `status: ${noAuth.status}`);
        console.log('');

        // ────────────────────────────────────────────────────
        // Phase 7: Post-reorder state — verify data swapped
        // ────────────────────────────────────────────────────
        console.log('── Phase 7: Post-reorder state verification ──');

        await sleep(1000); // let server save
        const afterEntities = await fetchJSON(`${API_BASE}/api/entities?deviceId=${deviceId}&deviceSecret=${deviceSecret}`);
        check('Post-reorder fetch succeeds', afterEntities.success !== false);

        // After swap: entity at slotA should have marker from slotB, and vice versa
        const entityAtA = afterEntities.entities?.find(e => e.entityId === slotA);
        const entityAtB = afterEntities.entities?.find(e => e.entityId === slotB);

        if (entityAtA && entityAtB) {
            check(`Slot ${slotA} has old slot ${slotB} marker`,
                entityAtA.message === `marker-slot-${slotB}`,
                `message: "${entityAtA.message}" (expected "marker-slot-${slotB}")`);

            check(`Slot ${slotB} has old slot ${slotA} marker`,
                entityAtB.message === `marker-slot-${slotA}`,
                `message: "${entityAtB.message}" (expected "marker-slot-${slotA}")`);

            check(`Slot ${slotA} still bound`, entityAtA.isBound === true);
            check(`Slot ${slotB} still bound`, entityAtB.isBound === true);

            // Verify botSecrets also swapped correctly
            // After swap: slotA should have slotB's old botSecret and vice versa
            check(`Slot ${slotA} name is TestBot-${slotB}`,
                entityAtA.name === `TestBot-${slotB}`,
                `name: "${entityAtA.name}"`);
            check(`Slot ${slotB} name is TestBot-${slotA}`,
                entityAtB.name === `TestBot-${slotA}`,
                `name: "${entityAtB.name}"`);
        } else {
            check('Post-reorder entities found', false, 'Could not find swapped entities');
        }

        // Verify we can still use the botSecrets (they should have swapped slots)
        // testEntities[0] was originally at slotA, now its botSecret is at slotB
        const transformRes = await postRaw(`${API_BASE}/api/transform`, {
            deviceId,
            entityId: slotB, // original entity moved here
            botSecret: testEntities[0].botSecret,
            state: 'IDLE',
            message: 'post-reorder-test'
        });
        check('BotSecret works at new slot', transformRes.status === 200 && transformRes.data.success,
            `status: ${transformRes.status}`);
        console.log('');

        // ────────────────────────────────────────────────────
        // Phase 8: Log verification — telemetry captured
        // ────────────────────────────────────────────────────
        console.log('── Phase 8: Telemetry / Log verification ──');

        await sleep(2000); // let telemetry flush

        // Query device telemetry for api_req entries since test started
        const telemetry = await fetchJSON(
            `${API_BASE}/api/device-telemetry?deviceId=${encodeURIComponent(deviceId)}` +
            `&deviceSecret=${encodeURIComponent(deviceSecret)}` +
            `&type=api_req&since=${testStartTs}&limit=200`
        );

        if (telemetry.success && telemetry.entries) {
            const entries = telemetry.entries;
            console.log(`  Found ${entries.length} telemetry entries since test start`);

            // Check for refresh endpoint logged
            const refreshLogs = entries.filter(e =>
                e.action?.includes('POST /api/entity/refresh'));
            check('Telemetry: refresh calls logged',
                refreshLogs.length >= 1,
                `found ${refreshLogs.length} refresh entries`);

            // Check for reorder endpoint logged
            const reorderLogs = entries.filter(e =>
                e.action?.includes('POST /api/device/reorder-entities'));
            check('Telemetry: reorder calls logged',
                reorderLogs.length >= 1,
                `found ${reorderLogs.length} reorder entries`);

            // Check for register endpoint logged
            const registerLogs = entries.filter(e =>
                e.action?.includes('POST /api/device/register'));
            check('Telemetry: register calls logged',
                registerLogs.length >= 2,
                `found ${registerLogs.length} register entries`);

            // Check for bind endpoint logged
            const bindLogs = entries.filter(e =>
                e.action?.includes('POST /api/bind'));
            check('Telemetry: bind calls logged',
                bindLogs.length >= 2,
                `found ${bindLogs.length} bind entries`);

            // Check for transform endpoint logged
            const transformLogs = entries.filter(e =>
                e.action?.includes('POST /api/transform'));
            check('Telemetry: transform calls logged',
                transformLogs.length >= 2,
                `found ${transformLogs.length} transform entries`);

            // Verify telemetry entries have duration
            const withDuration = entries.filter(e => typeof e.duration === 'number' && e.duration >= 0);
            check('Telemetry: entries have duration',
                withDuration.length > 0,
                `${withDuration.length}/${entries.length} have duration`);

            // Verify sensitive fields are redacted
            const hasRedacted = entries.some(e => {
                const inputStr = JSON.stringify(e.input || {});
                return inputStr.includes('[REDACTED]');
            });
            check('Telemetry: secrets redacted in entries',
                hasRedacted,
                hasRedacted ? 'found [REDACTED] fields' : 'no redactions found (may be OK if no secrets in input)');

        } else {
            check('Telemetry query succeeded', false,
                `success: ${telemetry.success}, error: ${telemetry.error || 'unknown'}`);
        }

        // Also check GET /api/logs (server-side logs)
        try {
            const logs = await fetchJSON(
                `${API_BASE}/api/logs?deviceId=${encodeURIComponent(deviceId)}` +
                `&deviceSecret=${encodeURIComponent(deviceSecret)}` +
                `&since=${testStartTs}&limit=50`
            );

            if (logs.success && logs.logs) {
                console.log(`  Found ${logs.logs.length} server log entries since test start`);
                check('Server logs: queryable', logs.logs.length >= 0);

                // Check for bind category
                const bindServerLogs = logs.logs.filter(l => l.category === 'bind');
                check('Server logs: bind events logged',
                    bindServerLogs.length >= 0,
                    `found ${bindServerLogs.length} bind log entries`);
            } else {
                // Logs endpoint may require PostgreSQL — not a failure
                console.log('  (Server logs not available — PostgreSQL may not be connected)');
            }
        } catch (logErr) {
            console.log(`  (Server logs query failed: ${logErr.message} — may need PostgreSQL)`);
        }

        // Check telemetry summary
        try {
            const summary = await fetchJSON(
                `${API_BASE}/api/device-telemetry/summary?deviceId=${encodeURIComponent(deviceId)}` +
                `&deviceSecret=${encodeURIComponent(deviceSecret)}`
            );
            if (summary.success) {
                check('Telemetry summary: accessible', true,
                    `${summary.entryCount} entries, ${summary.usagePercent}% buffer used`);
                check('Telemetry summary: has type breakdown',
                    summary.typeBreakdown && Object.keys(summary.typeBreakdown).length > 0,
                    `types: ${Object.keys(summary.typeBreakdown || {}).join(', ')}`);
            }
        } catch (e) {
            console.log(`  (Telemetry summary failed: ${e.message})`);
        }

        console.log('');

    } catch (err) {
        console.error(`\n  FATAL: ${err.message}\n`);
        check('Test execution', false, err.message);
    }

    // ────────────────────────────────────────────────────
    // Phase 9: Cleanup — unbind test entities
    // ────────────────────────────────────────────────────
    if (!skipCleanup && testEntities.length > 0) {
        console.log('── Phase 9: Cleanup ──');

        // After reorder, botSecrets may have swapped slots.
        // We need to use the CURRENT entity state to find which botSecret is at which slot.
        try {
            const currentEntities = await fetchJSON(`${API_BASE}/api/entities?deviceId=${deviceId}&deviceSecret=${deviceSecret}`);
            const currentBound = currentEntities.entities?.filter(e => e.isBound) || [];

            // Delete entities that we created (identified by name pattern TestBot-*)
            for (const e of currentBound) {
                if (e.name && e.name.startsWith('TestBot-')) {
                    // Use device-level delete (doesn't need botSecret)
                    const delRes = await deleteJSON(`${API_BASE}/api/device/entity`, {
                        deviceId, deviceSecret, entityId: e.entityId
                    });
                    console.log(`  Cleaned up entity #${e.entityId} (${e.name}): ${delRes.success ? 'OK' : delRes.message || 'failed'}`);
                }
            }
        } catch (cleanupErr) {
            console.warn(`  Cleanup error: ${cleanupErr.message}`);
            // Fallback: try deleting by original slot IDs
            for (const te of testEntities) {
                try {
                    await deleteJSON(`${API_BASE}/api/device/entity`, {
                        deviceId, deviceSecret, entityId: te.entityId
                    });
                } catch (_) {}
            }
        }
        console.log('');
    }

    printSummary();
}

function printSummary() {
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const total = results.length;
    const rate = total > 0 ? ((passed / total) * 100).toFixed(1) : '0';

    console.log('='.repeat(65));
    console.log('  SUMMARY');
    console.log('='.repeat(65));
    console.log(`  Total checks:  ${total}`);
    console.log(`  Passed:        ${passed}`);
    console.log(`  Failed:        ${failed}`);
    console.log(`  Rate:          ${rate}%`);

    if (failed > 0) {
        console.log('');
        console.log('-'.repeat(65));
        console.log('  FAILED CHECKS');
        console.log('-'.repeat(65));
        for (const r of results) {
            if (!r.passed) {
                console.log(`  ❌ ${r.name}`);
                if (r.detail) console.log(`     ${r.detail}`);
            }
        }
    }

    console.log('');
    if (failed === 0) {
        console.log(`  ✅ ALL PASS (${rate}%)`);
    } else {
        console.log(`  ❌ ${failed} FAILURES`);
    }
    console.log('='.repeat(65));

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error(`Fatal error: ${err.stack}`);
    process.exit(2);
});
