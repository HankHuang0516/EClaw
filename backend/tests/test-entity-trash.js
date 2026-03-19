#!/usr/bin/env node
/**
 * Entity Trash — Regression Test
 *
 * Tests the entity trash (soft-delete recovery) feature:
 *   1. Bind a test entity, then unbind → verify it appears in trash
 *   2. List trash items → verify structure and content
 *   3. Restore entity from trash → verify entity is re-bound
 *   4. Bind, permanent-delete → verify it appears in trash
 *   5. Permanently delete trash item → verify it's gone
 *   6. Auth validation (invalid credentials rejected)
 *
 * Credentials from backend/.env:
 *   BROADCAST_TEST_DEVICE_ID, BROADCAST_TEST_DEVICE_SECRET
 *
 * Usage:
 *   node test-entity-trash.js
 *   node test-entity-trash.js --local
 */

const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const API_BASE = args.includes('--local') ? 'http://localhost:3000' : 'https://eclawbot.com';

const TAG = '[EntityTrash Test]';

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

async function req(method, url, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.substring(0, 300) }; }
    return { status: res.status, data };
}
const postJSON = (url, body) => req('POST', url, body);
const getJSON = (url) => req('GET', url);
const deleteJSON = (url, body) => req('DELETE', url, body);

const results = [];
function check(name, passed, detail = '') {
    results.push({ name, passed, detail });
    console.log(`  ${passed ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
    const env = loadEnvFile();
    const deviceId = env.BROADCAST_TEST_DEVICE_ID || process.env.BROADCAST_TEST_DEVICE_ID || '';
    const deviceSecret = env.BROADCAST_TEST_DEVICE_SECRET || process.env.BROADCAST_TEST_DEVICE_SECRET || '';

    if (!deviceId || !deviceSecret) {
        console.error(`${TAG} Error: BROADCAST_TEST_DEVICE_ID and BROADCAST_TEST_DEVICE_SECRET required in backend/.env`);
        process.exit(1);
    }

    console.log('='.repeat(70));
    console.log(`  ${TAG} Entity Trash (Soft-Delete Recovery) — Regression Test`);
    console.log('='.repeat(70));
    console.log(`  API:    ${API_BASE}`);
    console.log(`  Device: ${deviceId}`);
    console.log('');

    // Track entities we create for cleanup
    const createdSlots = [];

    // ═══════════════════════════════════════════════════════════
    // Phase 1: Unbind saves to trash
    // ═══════════════════════════════════════════════════════════
    console.log('Phase 1: Unbind saves entity to trash');
    console.log('-'.repeat(50));

    // Create a new entity slot
    const addRes1 = await postJSON(`${API_BASE}/api/device/add-entity`, { deviceId, deviceSecret });
    check('1a. Create test entity slot', addRes1.status === 200 && addRes1.data?.entityId !== undefined,
        `entityId=${addRes1.data?.entityId}`);
    const slot1 = addRes1.data?.entityId;
    if (slot1 !== undefined) createdSlots.push(slot1);

    // Bind via device/register
    const botSecret1 = `trash-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const bindRes1 = await postJSON(`${API_BASE}/api/device/register`, {
        deviceId, deviceSecret, entityId: slot1,
        character: 'TrashTestBot',
        botSecret: botSecret1,
        webhook: 'https://example.com/trash-test-webhook'
    });
    check('1b. Bind test entity', bindRes1.status === 200, `status=${bindRes1.status}`);

    // Unbind via DELETE /api/entity (bot-side)
    const unbindRes1 = await deleteJSON(`${API_BASE}/api/entity`, {
        deviceId, entityId: slot1, botSecret: botSecret1
    });
    check('1c. Unbind entity via bot-side DELETE', unbindRes1.status === 200, `status=${unbindRes1.status}`);

    // Check trash
    const trashRes1 = await getJSON(`${API_BASE}/api/device/entity-trash?deviceId=${encodeURIComponent(deviceId)}&deviceSecret=${encodeURIComponent(deviceSecret)}`);
    check('1d. GET entity-trash returns 200', trashRes1.status === 200, `status=${trashRes1.status}`);

    const trashItems1 = trashRes1.data?.items || [];
    const trashItem1 = trashItems1.find(t => t.character === 'TrashTestBot');
    check('1e. Unbound entity found in trash', !!trashItem1,
        trashItem1 ? `trashId=${trashItem1.id} name=${trashItem1.name}` : 'not found');

    if (trashItem1) {
        check('1f. Trash item has correct character', trashItem1.character === 'TrashTestBot');
        check('1g. Trash item has expiresAt', !!trashItem1.expiresAt);
        check('1h. Trash item has deletedAt', !!trashItem1.deletedAt);
    }

    console.log('');

    // ═══════════════════════════════════════════════════════════
    // Phase 2: Restore from trash
    // ═══════════════════════════════════════════════════════════
    console.log('Phase 2: Restore entity from trash');
    console.log('-'.repeat(50));

    if (trashItem1) {
        const restoreRes = await postJSON(`${API_BASE}/api/device/entity-trash/${trashItem1.id}/restore`, {
            deviceId, deviceSecret
        });
        check('2a. Restore from trash returns 200', restoreRes.status === 200, `status=${restoreRes.status}`);

        const restoredSlot = restoreRes.data?.entityId;
        check('2b. Restored entity has slot ID', restoredSlot !== undefined, `entityId=${restoredSlot}`);
        if (restoredSlot !== undefined && !createdSlots.includes(restoredSlot) && restoredSlot !== slot1) {
            createdSlots.push(restoredSlot);
        }

        // Verify entity is bound
        const entitiesRes = await getJSON(`${API_BASE}/api/entities?deviceId=${encodeURIComponent(deviceId)}`);
        const restoredEntity = (entitiesRes.data?.entities || []).find(e => e.entityId === restoredSlot);
        check('2c. Restored entity is bound', restoredEntity?.isBound === true, `isBound=${restoredEntity?.isBound}`);
        check('2d. Restored entity has correct character', restoredEntity?.character === 'TrashTestBot',
            `character=${restoredEntity?.character}`);

        // Verify trash item is removed
        const trashRes2 = await getJSON(`${API_BASE}/api/device/entity-trash?deviceId=${encodeURIComponent(deviceId)}&deviceSecret=${encodeURIComponent(deviceSecret)}`);
        const stillInTrash = (trashRes2.data?.items || []).find(t => t.id === trashItem1.id);
        check('2e. Trash item removed after restore', !stillInTrash);

        // Clean up: unbind restored entity for next phase
        if (restoredEntity?.isBound) {
            const botSec = restoredEntity?.botSecret || restoreRes.data?.botSecret;
            // Use device-side unbind since we might not have botSecret
            await deleteJSON(`${API_BASE}/api/device/entity`, { deviceId, deviceSecret, entityId: restoredSlot });
        }
    } else {
        check('2a. Restore from trash (skipped: no trash item)', false, 'prerequisite failed');
    }

    console.log('');

    // ═══════════════════════════════════════════════════════════
    // Phase 3: Permanent delete saves to trash
    // ═══════════════════════════════════════════════════════════
    console.log('Phase 3: Permanent delete saves to trash');
    console.log('-'.repeat(50));

    // Create + bind another entity
    const addRes2 = await postJSON(`${API_BASE}/api/device/add-entity`, { deviceId, deviceSecret });
    const slot2 = addRes2.data?.entityId;
    if (slot2 !== undefined) createdSlots.push(slot2);

    const botSecret2 = `trash-perm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await postJSON(`${API_BASE}/api/device/register`, {
        deviceId, deviceSecret, entityId: slot2,
        character: 'TrashPermBot',
        botSecret: botSecret2,
        webhook: 'https://example.com/trash-perm-webhook'
    });

    // Permanently delete
    const permDelRes = await deleteJSON(`${API_BASE}/api/device/entity/${slot2}/permanent`, {
        deviceId, deviceSecret
    });
    check('3a. Permanent delete returns 200', permDelRes.status === 200, `status=${permDelRes.status}`);
    // Remove from cleanup tracking since it's permanently deleted
    const slot2Idx = createdSlots.indexOf(slot2);
    if (slot2Idx >= 0) createdSlots.splice(slot2Idx, 1);

    // Check trash
    const trashRes3 = await getJSON(`${API_BASE}/api/device/entity-trash?deviceId=${encodeURIComponent(deviceId)}&deviceSecret=${encodeURIComponent(deviceSecret)}`);
    const trashItem3 = (trashRes3.data?.items || []).find(t => t.character === 'TrashPermBot');
    check('3b. Permanently deleted entity found in trash', !!trashItem3,
        trashItem3 ? `trashId=${trashItem3.id}` : 'not found');

    console.log('');

    // ═══════════════════════════════════════════════════════════
    // Phase 4: Permanently delete trash item
    // ═══════════════════════════════════════════════════════════
    console.log('Phase 4: Permanently delete from trash');
    console.log('-'.repeat(50));

    if (trashItem3) {
        const permTrashDel = await deleteJSON(`${API_BASE}/api/device/entity-trash/${trashItem3.id}`, {
            deviceId, deviceSecret
        });
        check('4a. Delete from trash returns 200', permTrashDel.status === 200, `status=${permTrashDel.status}`);

        // Verify it's gone
        const trashRes4 = await getJSON(`${API_BASE}/api/device/entity-trash?deviceId=${encodeURIComponent(deviceId)}&deviceSecret=${encodeURIComponent(deviceSecret)}`);
        const stillThere = (trashRes4.data?.items || []).find(t => t.id === trashItem3.id);
        check('4b. Trash item permanently gone', !stillThere);
    } else {
        check('4a. Delete from trash (skipped)', false, 'prerequisite failed');
    }

    console.log('');

    // ═══════════════════════════════════════════════════════════
    // Phase 5: Auth validation
    // ═══════════════════════════════════════════════════════════
    console.log('Phase 5: Auth validation');
    console.log('-'.repeat(50));

    const badAuthRes = await getJSON(`${API_BASE}/api/device/entity-trash?deviceId=${encodeURIComponent(deviceId)}&deviceSecret=wrong-secret`);
    check('5a. Invalid deviceSecret rejected (403)', badAuthRes.status === 403, `status=${badAuthRes.status}`);

    const noAuthRes = await getJSON(`${API_BASE}/api/device/entity-trash?deviceId=${encodeURIComponent(deviceId)}`);
    check('5b. Missing deviceSecret rejected (400)', noAuthRes.status === 400, `status=${noAuthRes.status}`);

    const badRestoreRes = await postJSON(`${API_BASE}/api/device/entity-trash/99999/restore`, {
        deviceId, deviceSecret
    });
    check('5c. Restore non-existent trash item rejected (404)', badRestoreRes.status === 404, `status=${badRestoreRes.status}`);

    console.log('');

    // ═══════════════════════════════════════════════════════════
    // Cleanup
    // ═══════════════════════════════════════════════════════════
    console.log('Cleanup');
    console.log('-'.repeat(50));

    // Clean up any remaining test trash items
    const finalTrash = await getJSON(`${API_BASE}/api/device/entity-trash?deviceId=${encodeURIComponent(deviceId)}&deviceSecret=${encodeURIComponent(deviceSecret)}`);
    for (const item of (finalTrash.data?.items || [])) {
        if (item.character === 'TrashTestBot' || item.character === 'TrashPermBot') {
            await deleteJSON(`${API_BASE}/api/device/entity-trash/${item.id}`, { deviceId, deviceSecret });
            console.log(`  Cleaned up trash item #${item.id} (${item.character})`);
        }
    }

    // Clean up created entity slots
    for (const slotId of createdSlots) {
        try {
            // Unbind if bound
            await deleteJSON(`${API_BASE}/api/device/entity`, { deviceId, deviceSecret, entityId: slotId });
        } catch {}
        try {
            // Permanently delete slot
            await deleteJSON(`${API_BASE}/api/device/entity/${slotId}/permanent`, { deviceId, deviceSecret });
            console.log(`  Cleaned up entity slot #${slotId}`);
        } catch {}
    }

    // ═══════════════════════════════════════════════════════════
    // Summary
    // ═══════════════════════════════════════════════════════════
    console.log('');
    console.log('='.repeat(70));
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    console.log(`  ${TAG} Results: ${passed} passed, ${failed} failed (${results.length} total)`);
    console.log('='.repeat(70));

    if (failed > 0) {
        console.log('');
        console.log('Failed tests:');
        results.filter(r => !r.passed).forEach(r => {
            console.log(`  ❌ ${r.name} — ${r.detail}`);
        });
    }

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error(`${TAG} Fatal error:`, err);
    process.exit(1);
});
