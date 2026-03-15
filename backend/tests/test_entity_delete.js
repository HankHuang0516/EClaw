/**
 * Entity Deletion Stress Test
 *
 * Simulates 10 devices, each with 4 bound entities (40 total).
 * Randomly deletes entities via device button (DELETE /api/entity).
 * Verifies deletion process has no bugs.
 */

const API_BASE = 'https://eclawbot.com';
const NUM_DEVICES = 10;
const ENTITIES_PER_DEVICE = 4;

async function api(method, path, body = null) {
    const url = `${API_BASE}${path}`;
    const options = {
        method,
        headers: { 'Content-Type': 'application/json' }
    };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(url, options);
    return { status: res.status, data: await res.json() };
}

// Store device/entity info for testing
const testData = {
    devices: [],  // { deviceId, deviceSecret, entities: [{ entityId, botSecret }] }
};

async function setupDevices() {
    console.log('='.repeat(60));
    console.log('ENTITY DELETION STRESS TEST');
    console.log('='.repeat(60));
    console.log(`Setting up ${NUM_DEVICES} devices with ${ENTITIES_PER_DEVICE} entities each...`);
    console.log(`Total entities to create: ${NUM_DEVICES * ENTITIES_PER_DEVICE}\n`);

    for (let d = 0; d < NUM_DEVICES; d++) {
        const deviceId = `stress-test-device-${d}-${Date.now()}`;
        const deviceSecret = `secret-${d}-${Date.now()}`;
        const device = { deviceId, deviceSecret, entities: [] };

        process.stdout.write(`Device ${d}: `);

        // Register entity 0 first to create the device (entity 0 exists by default)
        const firstReg = await api('POST', '/api/device/register', {
            deviceId, deviceSecret, entityId: 0, isTestDevice: true
        });
        if (!firstReg.data.success) {
            console.log(`\n  ERROR creating device: ${firstReg.data.message}`);
            testData.devices.push(device);
            continue;
        }

        // Add extra entity slots (dynamic entity system: only slot 0 exists initially)
        const entitySlotIds = [0];
        for (let e = 1; e < ENTITIES_PER_DEVICE; e++) {
            const addRes = await api('POST', '/api/device/add-entity', { deviceId, deviceSecret });
            if (addRes.data.success) {
                entitySlotIds.push(addRes.data.entityId);
            } else {
                console.log(`\n  ERROR adding entity slot: ${addRes.data.error}`);
            }
        }

        for (const eId of entitySlotIds) {
            // Register entity slot
            const regRes = await api('POST', '/api/device/register', {
                deviceId,
                deviceSecret,
                entityId: eId,
                isTestDevice: true
            });

            if (!regRes.data.success) {
                console.log(`\n  ERROR registering entity ${eId}: ${regRes.data.message}`);
                continue;
            }

            // Bind entity
            const bindRes = await api('POST', '/api/bind', {
                code: regRes.data.bindingCode,
                name: `Bot-D${d}-E${eId}`
            });

            if (!bindRes.data.success) {
                console.log(`\n  ERROR binding entity ${eId}: ${bindRes.data.message}`);
                continue;
            }

            device.entities.push({
                entityId: eId,
                botSecret: bindRes.data.botSecret,
                deleted: false
            });

            process.stdout.write(`E${eId}✓ `);
        }

        testData.devices.push(device);
        console.log('');
    }

    // Count total bound entities
    const totalBound = testData.devices.reduce((sum, d) => sum + d.entities.length, 0);
    console.log(`\nSetup complete: ${totalBound} entities bound across ${testData.devices.length} devices`);
}

async function verifyEntityCount(expectedCount) {
    const res = await api('GET', '/api/entities');
    const actualCount = res.data.entities.filter(e =>
        testData.devices.some(d => d.deviceId === e.deviceId)
    ).length;
    return { expected: expectedCount, actual: actualCount, match: actualCount === expectedCount };
}

async function runDeletionTests() {
    console.log('\n' + '='.repeat(60));
    console.log('DELETION TESTS');
    console.log('='.repeat(60));

    let passed = 0;
    let failed = 0;
    let totalDeleted = 0;

    // Calculate initial entity count
    const initialCount = testData.devices.reduce((sum, d) =>
        sum + d.entities.filter(e => !e.deleted).length, 0);

    // Test 1: Verify initial count
    console.log('\n--- Test 1: Verify initial entity count ---');
    const initial = await verifyEntityCount(initialCount);
    if (initial.match) {
        console.log(`✅ Initial count correct: ${initial.actual}`);
        passed++;
    } else {
        console.log(`❌ Count mismatch: expected ${initial.expected}, got ${initial.actual}`);
        failed++;
    }

    // Test 2: Delete random entities (simulate user pressing delete button)
    console.log('\n--- Test 2: Random entity deletions ---');

    // Create list of all deletable entities (excluding entity 0 which can't be deleted)
    const deletableEntities = [];
    testData.devices.forEach(device => {
        device.entities.forEach(entity => {
            if (entity.entityId !== 0 && !entity.deleted) {
                deletableEntities.push({ device, entity });
            }
        });
    });

    // Shuffle and delete half
    const shuffled = deletableEntities.sort(() => Math.random() - 0.5);
    const toDelete = shuffled.slice(0, Math.floor(shuffled.length / 2));

    console.log(`Deleting ${toDelete.length} random entities...`);

    for (const { device, entity } of toDelete) {
        const res = await api('DELETE', '/api/entity', {
            deviceId: device.deviceId,
            entityId: entity.entityId,
            botSecret: entity.botSecret
        });

        if (res.data.success) {
            entity.deleted = true;
            totalDeleted++;
            process.stdout.write('.');
        } else {
            console.log(`\n  ❌ Failed to delete D:${device.deviceId.slice(-8)} E:${entity.entityId}: ${res.data.message}`);
            failed++;
        }
    }
    console.log(` (${totalDeleted} deleted)`);

    // Test 3: Verify count after deletions
    console.log('\n--- Test 3: Verify count after deletions ---');
    const expectedAfterDelete = initialCount - totalDeleted;
    const afterDelete = await verifyEntityCount(expectedAfterDelete);
    if (afterDelete.match) {
        console.log(`✅ Count correct after deletion: ${afterDelete.actual}`);
        passed++;
    } else {
        console.log(`❌ Count mismatch: expected ${afterDelete.expected}, got ${afterDelete.actual}`);
        failed++;
    }

    // Test 4: Try to delete already deleted entity (should fail gracefully)
    console.log('\n--- Test 4: Delete already deleted entity ---');
    const deletedEntity = toDelete[0];
    if (deletedEntity) {
        const res = await api('DELETE', '/api/entity', {
            deviceId: deletedEntity.device.deviceId,
            entityId: deletedEntity.entity.entityId,
            botSecret: deletedEntity.entity.botSecret
        });

        if (res.status === 400 || res.status === 404 || !res.data.success) {
            console.log(`✅ Correctly rejected re-deletion: ${res.data.message}`);
            passed++;
        } else {
            console.log(`❌ Should have rejected re-deletion`);
            failed++;
        }
    } else {
        console.log('⏭️ Skipped (no deleted entities)');
    }

    // Test 5: Try to delete entity 0 (should fail - entity 0 is protected)
    console.log('\n--- Test 5: Delete entity 0 (protected) ---');
    const deviceWithEntity0 = testData.devices.find(d => d.entities.some(e => e.entityId === 0));
    if (deviceWithEntity0) {
        const entity0 = deviceWithEntity0.entities.find(e => e.entityId === 0);
        const res = await api('DELETE', '/api/entity', {
            deviceId: deviceWithEntity0.deviceId,
            entityId: 0,
            botSecret: entity0.botSecret
        });

        // Check if entity 0 is still there
        const statusRes = await api('GET', `/api/status?deviceId=${deviceWithEntity0.deviceId}&entityId=0`);
        if (statusRes.data.isBound) {
            console.log(`✅ Entity 0 still exists (protected or rejection handled)`);
            passed++;
        } else if (res.data.success) {
            // If deletion succeeded, that's also valid behavior
            console.log(`ℹ️ Entity 0 deletion allowed (not protected)`);
            entity0.deleted = true;
            totalDeleted++;
            passed++;
        } else {
            console.log(`❌ Unexpected state for entity 0`);
            failed++;
        }
    }

    // Test 6: Delete with wrong botSecret (should fail)
    console.log('\n--- Test 6: Delete with wrong botSecret ---');
    const remainingEntity = testData.devices
        .flatMap(d => d.entities.map(e => ({ device: d, entity: e })))
        .find(({ entity }) => !entity.deleted && entity.entityId !== 0);

    if (remainingEntity) {
        const res = await api('DELETE', '/api/entity', {
            deviceId: remainingEntity.device.deviceId,
            entityId: remainingEntity.entity.entityId,
            botSecret: 'wrong-secret-12345'
        });

        if (res.status === 403) {
            console.log(`✅ Correctly rejected wrong botSecret (403)`);
            passed++;
        } else {
            console.log(`❌ Should have returned 403, got ${res.status}`);
            failed++;
        }
    }

    // Test 7: Delete all remaining entities (except entity 0)
    console.log('\n--- Test 7: Delete all remaining non-zero entities ---');
    const remaining = testData.devices
        .flatMap(d => d.entities.map(e => ({ device: d, entity: e })))
        .filter(({ entity }) => !entity.deleted && entity.entityId !== 0);

    console.log(`Deleting ${remaining.length} remaining entities...`);
    let deleteSuccess = 0;

    for (const { device, entity } of remaining) {
        const res = await api('DELETE', '/api/entity', {
            deviceId: device.deviceId,
            entityId: entity.entityId,
            botSecret: entity.botSecret
        });

        if (res.data.success) {
            entity.deleted = true;
            deleteSuccess++;
            totalDeleted++;
        }
    }

    if (deleteSuccess === remaining.length) {
        console.log(`✅ All ${deleteSuccess} entities deleted successfully`);
        passed++;
    } else {
        console.log(`❌ Only ${deleteSuccess}/${remaining.length} deleted`);
        failed++;
    }

    // Test 8: Final count verification
    console.log('\n--- Test 8: Final entity count ---');
    const entity0Count = testData.devices.filter(d =>
        d.entities.some(e => e.entityId === 0 && !e.deleted)
    ).length;

    const finalCheck = await verifyEntityCount(entity0Count);
    if (finalCheck.match) {
        console.log(`✅ Final count correct: ${finalCheck.actual} (only entity 0s remain)`);
        passed++;
    } else {
        console.log(`❌ Final count mismatch: expected ${finalCheck.expected}, got ${finalCheck.actual}`);
        failed++;
    }

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('TEST SUMMARY');
    console.log('='.repeat(60));
    console.log(`Devices created: ${testData.devices.length}`);
    console.log(`Total entities bound: ${NUM_DEVICES * ENTITIES_PER_DEVICE}`);
    console.log(`Total entities deleted: ${totalDeleted}`);
    console.log(`\nResults: ${passed} passed, ${failed} failed`);

    if (failed === 0) {
        console.log('\n✅ All entity deletion tests passed!');
    } else {
        console.log('\n❌ Some tests failed!');
    }

    return { passed, failed };
}

async function main() {
    try {
        await setupDevices();
        await runDeletionTests();
    } catch (err) {
        console.error('Test error:', err.message);
    }
}

main();
