/**
 * Entity Name Preservation Test
 *
 * 驗證修復：實體名稱在 unbind/rebind 操作中不會被重設為 null。
 *
 * Bug 重現：
 *   實體 #1 和 #3 (月租版 personal bot) 名字在版本更新時被初始化，
 *   但實體 #2 (免費版 free bot) 不受影響。
 *   原因：訂閱過期清理 / autoUnbindEntity / bind-free / bind-personal
 *   都使用 createDefaultEntity() 完全覆蓋實體，導致 name 被重設為 null。
 *
 * Run: node tests/test_entity_name_preservation.js
 */

const API_BASE = process.env.API_BASE || 'https://eclawbot.com';

// ============================================
// Helpers
// ============================================

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

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

let passed = 0;
let failed = 0;
let skipped = 0;

function assert(condition, testName, detail = '') {
    if (condition) {
        console.log(`  ✅ ${testName}`);
        passed++;
    } else {
        console.log(`  ❌ ${testName}${detail ? ' — ' + detail : ''}`);
        failed++;
    }
}

function skip(testName, reason) {
    console.log(`  ⏭️  ${testName} — ${reason}`);
    skipped++;
}

/**
 * Setup helper: register + bind an entity, return botSecret
 */
async function setupEntity(deviceId, deviceSecret, entityId, bindName = null) {
    const reg = await api('POST', '/api/device/register', {
        deviceId, deviceSecret, entityId, isTestDevice: true
    });
    if (!reg.data.success) throw new Error(`Register failed: ${reg.data.message}`);

    const bind = await api('POST', '/api/bind', {
        code: reg.data.bindingCode,
        name: bindName
    });
    if (!bind.data.success) throw new Error(`Bind failed: ${bind.data.message}`);

    return bind.data.botSecret;
}

/**
 * Rename helper: device owner renames an entity
 */
async function renameEntity(deviceId, deviceSecret, entityId, newName) {
    const res = await api('PUT', '/api/device/entity/name', {
        deviceId, deviceSecret, entityId, name: newName
    });
    return res;
}

/**
 * Get entity name from status endpoint
 */
async function getEntityName(deviceId, entityId) {
    const res = await api('GET', `/api/status?deviceId=${deviceId}&entityId=${entityId}`);
    return res.data.name;
}

/**
 * Get entity status
 */
async function getEntityStatus(deviceId, entityId) {
    const res = await api('GET', `/api/status?deviceId=${deviceId}&entityId=${entityId}`);
    return res.data;
}

// ============================================
// Test Scenarios
// ============================================

async function runTests() {
    console.log('='.repeat(60));
    console.log('ENTITY NAME PRESERVATION TEST');
    console.log('='.repeat(60));
    console.log(`Target: ${API_BASE}`);
    console.log(`Date:   ${new Date().toISOString()}\n`);

    const ts = Date.now();
    const deviceId = `test-name-preserve-${ts}`;
    const deviceSecret = `secret-${ts}`;

    // ============================================
    // Setup: Create device with 4 entities, all named
    // ============================================
    console.log('--- Setup: Create device with 4 named entities ---\n');

    const customNames = ['小花', '阿明', '小白', '大黃'];
    const botSecrets = {};

    // Entity 0 exists by default; add slots for entities 1, 2, 3
    // First register entity 0 to create the device
    const createdIds = [0]; // track IDs in creation order
    botSecrets[0] = await setupEntity(deviceId, deviceSecret, 0);
    await renameEntity(deviceId, deviceSecret, 0, customNames[0]);
    const name0 = await getEntityName(deviceId, 0);
    console.log(`  Entity 0: bound ✓, name = "${name0}"`);

    for (let i = 1; i < 4; i++) {
        try {
            // Add new entity slot (dynamic entity system)
            const addRes = await api('POST', '/api/device/add-entity', { deviceId, deviceSecret });
            if (!addRes.data.success) throw new Error(`add-entity failed: ${addRes.data.error}`);
            const newId = addRes.data.entityId;
            createdIds.push(newId);
            botSecrets[newId] = await setupEntity(deviceId, deviceSecret, newId);
            await renameEntity(deviceId, deviceSecret, newId, customNames[i]);
            const name = await getEntityName(deviceId, newId);
            console.log(`  Entity ${newId}: bound ✓, name = "${name}"`);
        } catch (e) {
            console.log(`  Entity ${i}: setup failed — ${e.message}`);
        }
    }

    // Map logical indices to actual entity IDs and names
    const entityIds = createdIds; // [0, id1, id2, id3] in creation order
    // Build name mapping: entityId → customName
    const nameMap = {};
    for (let i = 0; i < entityIds.length; i++) {
        nameMap[entityIds[i]] = customNames[i];
    }
    console.log(`  Device entity IDs: [${entityIds.join(', ')}]`);
    console.log(`  Name mapping: ${JSON.stringify(nameMap)}`);

    console.log('');

    // ============================================
    // Scenario 1: Bug 重現 — DELETE /api/entity (bot-side)
    // 刪除後實體名稱應被保留
    // ============================================
    console.log('--- Scenario 1: DELETE /api/entity (bot-side unbind) —');
    console.log('    名稱應在 unbind 後保留 ---\n');

    {
        const eId = 0;
        const nameBefore = await getEntityName(deviceId, eId);
        assert(nameBefore === nameMap[eId],
            `Entity ${eId} has custom name before delete`,
            `expected "${nameMap[eId]}", got "${nameBefore}"`);

        // Delete via bot
        const del = await api('DELETE', '/api/entity', {
            deviceId, entityId: eId, botSecret: botSecrets[eId]
        });
        assert(del.data.success, `DELETE /api/entity succeeded`);

        // Check name is preserved
        const nameAfter = await getEntityName(deviceId, eId);
        assert(nameAfter === nameMap[eId],
            `Entity ${eId} name preserved after bot-side delete`,
            `expected "${nameMap[eId]}", got "${nameAfter}"`);

        // Check entity is unbound
        const status = await getEntityStatus(deviceId, eId);
        assert(status.isBound === false,
            `Entity ${eId} is unbound after delete`);

        // Rebind and verify name behavior
        botSecrets[eId] = await setupEntity(deviceId, deviceSecret, eId);
        const nameAfterRebind = await getEntityName(deviceId, eId);
        // /api/bind sets entity.name = name || null directly, not via createDefaultEntity
        // So after rebind without name param, name will be null. That's expected.
        console.log(`  ℹ️  After rebind (no name param): name = ${nameAfterRebind === null ? 'null' : `"${nameAfterRebind}"`}`);

        // Restore name for subsequent tests
        await renameEntity(deviceId, deviceSecret, eId, nameMap[eId]);
    }

    console.log('');

    // ============================================
    // Scenario 2: DELETE /api/device/entity (device-side)
    // 裝置端刪除後名稱應被保留
    // ============================================
    console.log('--- Scenario 2: DELETE /api/device/entity (device-side unbind) —');
    console.log('    名稱應在 unbind 後保留 ---\n');

    {
        const eId = entityIds[1];
        const nameBefore = await getEntityName(deviceId, eId);
        assert(nameBefore === nameMap[eId],
            `Entity ${eId} has custom name before delete`,
            `expected "${nameMap[eId]}", got "${nameBefore}"`);

        // Delete via device owner
        const del = await api('DELETE', '/api/device/entity', {
            deviceId, deviceSecret, entityId: eId
        });
        assert(del.data.success, `DELETE /api/device/entity succeeded`);

        // Check name is preserved
        const nameAfter = await getEntityName(deviceId, eId);
        assert(nameAfter === nameMap[eId],
            `Entity ${eId} name preserved after device-side delete`,
            `expected "${nameMap[eId]}", got "${nameAfter}"`);

        // Check entity is unbound
        const status = await getEntityStatus(deviceId, eId);
        assert(status.isBound === false,
            `Entity ${eId} is unbound after delete`);
    }

    console.log('');

    // ============================================
    // Scenario 3: Transform 不帶 name 欄位
    // name 不應被清除
    // ============================================
    console.log('--- Scenario 3: POST /api/transform without name field —');
    console.log('    名稱不應被意外清除 ---\n');

    {
        const eId = entityIds[2];
        const nameBefore = await getEntityName(deviceId, eId);
        assert(nameBefore === nameMap[eId],
            `Entity ${eId} has custom name before transform`,
            `expected "${nameMap[eId]}", got "${nameBefore}"`);

        // Transform without name field
        const tf = await api('POST', '/api/transform', {
            deviceId, entityId: eId, botSecret: botSecrets[eId],
            state: 'HAPPY', message: 'Testing transform without name'
        });
        assert(tf.data.success, `Transform without name succeeded`);

        // Name should be unchanged
        const nameAfter = await getEntityName(deviceId, eId);
        assert(nameAfter === nameMap[eId],
            `Entity ${eId} name unchanged after transform (no name field)`,
            `expected "${nameMap[eId]}", got "${nameAfter}"`);
    }

    console.log('');

    // ============================================
    // Scenario 4: Transform 帶 name 欄位
    // name 應被更新
    // ============================================
    console.log('--- Scenario 4: POST /api/transform with name field —');
    console.log('    名稱應被更新為新值 ---\n');

    {
        const eId = entityIds[2];
        const newName = '新名字';

        const tf = await api('POST', '/api/transform', {
            deviceId, entityId: eId, botSecret: botSecrets[eId],
            state: 'IDLE', message: 'Testing name update',
            name: newName
        });
        assert(tf.data.success, `Transform with name succeeded`);

        const nameAfter = await getEntityName(deviceId, eId);
        assert(nameAfter === newName,
            `Entity ${eId} name updated via transform`,
            `expected "${newName}", got "${nameAfter}"`);

        // Restore original name for later tests
        await api('POST', '/api/transform', {
            deviceId, entityId: eId, botSecret: botSecrets[eId],
            name: nameMap[eId]
        });
    }

    console.log('');

    // ============================================
    // Scenario 5: Transform 帶 name: "" (空字串)
    // name 應變為 null (空字串視為清除)
    // ============================================
    console.log('--- Scenario 5: POST /api/transform with name: "" —');
    console.log('    空字串 name 應將名稱清除為 null ---\n');

    {
        const eId = entityIds[3];
        const nameBefore = await getEntityName(deviceId, eId);
        assert(nameBefore === nameMap[eId],
            `Entity ${eId} has custom name before empty-string transform`,
            `expected "${nameMap[eId]}", got "${nameBefore}"`);

        // Transform with empty name
        const tf = await api('POST', '/api/transform', {
            deviceId, entityId: eId, botSecret: botSecrets[eId],
            name: ''
        });
        assert(tf.data.success, `Transform with empty name succeeded`);

        const nameAfter = await getEntityName(deviceId, eId);
        assert(nameAfter === null,
            `Entity ${eId} name cleared to null by empty string`,
            `expected null, got "${nameAfter}"`);

        // Restore name
        await api('POST', '/api/transform', {
            deviceId, entityId: eId, botSecret: botSecrets[eId],
            name: nameMap[eId]
        });
    }

    console.log('');

    // ============================================
    // Scenario 6: 多實體隔離 — 刪除一個不影響其他
    // ============================================
    console.log('--- Scenario 6: Multi-entity isolation —');
    console.log('    刪除一個實體不影響其他實體的名稱 ---\n');

    {
        const id1 = entityIds[1], id2 = entityIds[2], id3 = entityIds[3];
        // Rebind entity 1 (was deleted in Scenario 2)
        botSecrets[id1] = await setupEntity(deviceId, deviceSecret, id1);
        await renameEntity(deviceId, deviceSecret, id1, nameMap[id1]);

        // Verify all 4 have names
        for (let idx = 0; idx < entityIds.length; idx++) {
            const eid = entityIds[idx];
            const name = await getEntityName(deviceId, eid);
            assert(name === nameMap[eid],
                `Entity ${eid} has name "${nameMap[eid]}" before isolation test`,
                `got "${name}"`);
        }

        // Delete entity at index 2
        await api('DELETE', '/api/device/entity', {
            deviceId, deviceSecret, entityId: id2
        });

        // Entity at index 2 should keep its name (unbound)
        const name2 = await getEntityName(deviceId, id2);
        assert(name2 === nameMap[id2],
            `Entity ${id2} name preserved after own deletion`,
            `expected "${nameMap[id2]}", got "${name2}"`);

        // Other entities should be completely unaffected
        for (const eid of [entityIds[0], id1, id3]) {
            const name = await getEntityName(deviceId, eid);
            assert(name === nameMap[eid],
                `Entity ${eid} name unaffected by entity ${id2}'s deletion`,
                `expected "${nameMap[eid]}", got "${name}"`);

            const status = await getEntityStatus(deviceId, eid);
            assert(status.isBound === true,
                `Entity ${eid} still bound after entity ${id2}'s deletion`);
        }

        // Rebind entity at index 2 for later tests
        botSecrets[id2] = await setupEntity(deviceId, deviceSecret, id2);
        await renameEntity(deviceId, deviceSecret, id2, nameMap[id2]);
    }

    console.log('');

    // ============================================
    // Scenario 7: Rename 後立即 DELETE 再 rebind
    // 完整的 rename → unbind → rebind 循環
    // ============================================
    console.log('--- Scenario 7: Full rename → unbind → rebind cycle —');
    console.log('    名稱在完整循環後應被保留 ---\n');

    {
        const eId = entityIds[3];
        const specialName = '特殊名字🦞';

        // Step 1: Rename
        await renameEntity(deviceId, deviceSecret, eId, specialName);
        const afterRename = await getEntityName(deviceId, eId);
        assert(afterRename === specialName,
            `Step 1: Entity ${eId} renamed to "${specialName}"`);

        // Step 2: Unbind (device-side)
        await api('DELETE', '/api/device/entity', {
            deviceId, deviceSecret, entityId: eId
        });
        const afterUnbind = await getEntityName(deviceId, eId);
        assert(afterUnbind === specialName,
            `Step 2: Name preserved after unbind`,
            `expected "${specialName}", got "${afterUnbind}"`);

        // Step 3: Rebind (with new bot, no name in bind request)
        botSecrets[eId] = await setupEntity(deviceId, deviceSecret, eId);
        // /api/bind sets entity.name = name || null, overwriting preserved name
        // This is expected behavior for /api/bind (bot explicitly sets name)
        const afterRebind = await getEntityName(deviceId, eId);
        console.log(`  ℹ️  After rebind (no name in bind): name = ${afterRebind === null ? 'null' : `"${afterRebind}"`}`);

        // Step 4: Rebind WITH name
        await api('DELETE', '/api/device/entity', {
            deviceId, deviceSecret, entityId: eId
        });
        const reg = await api('POST', '/api/device/register', {
            deviceId, deviceSecret, entityId: eId, isTestDevice: true
        });
        const bind = await api('POST', '/api/bind', {
            code: reg.data.bindingCode,
            name: specialName
        });
        botSecrets[eId] = bind.data.botSecret;
        const afterNamedRebind = await getEntityName(deviceId, eId);
        assert(afterNamedRebind === specialName,
            `Step 4: Name set correctly via bind request`,
            `expected "${specialName}", got "${afterNamedRebind}"`);
    }

    console.log('');

    // ============================================
    // Scenario 8: bind-free override 保留名稱
    // (需要官方免費版機器人，沒有則跳過)
    // ============================================
    console.log('--- Scenario 8: bind-free override preserves name —');
    console.log('    官方免費版覆蓋綁定時保留自訂名稱 ---\n');

    {
        const eId = 0;
        // Ensure entity has a custom name
        await renameEntity(deviceId, deviceSecret, eId, nameMap[eId]);
        const nameBefore = await getEntityName(deviceId, eId);

        // Try bind-free (may fail if no official bots available)
        const res = await api('POST', '/api/official-borrow/bind-free', {
            deviceId, deviceSecret, entityId: eId
        });

        if (res.data.success) {
            const nameAfter = await getEntityName(deviceId, eId);
            assert(nameAfter === nameBefore,
                `Entity ${eId} name preserved after bind-free override`,
                `expected "${nameBefore}", got "${nameAfter}"`);
        } else if (res.status === 404 || (res.data.error && res.data.error.includes('No free bot'))) {
            skip(`bind-free override test`, 'No free bots available in pool');
        } else if (res.data.error && res.data.error.includes('僅限借用一個')) {
            skip(`bind-free override test`, 'Device already has a free bot binding');
        } else {
            skip(`bind-free override test`, `Unexpected: ${res.data.error || res.data.message}`);
        }
    }

    console.log('');

    // ============================================
    // Scenario 9: bind-personal override 保留名稱
    // (需要官方月租版機器人 + 訂閱，沒有則跳過)
    // ============================================
    console.log('--- Scenario 9: bind-personal override preserves name —');
    console.log('    官方月租版覆蓋綁定時保留自訂名稱 ---\n');

    {
        const eId = entityIds[1];
        await renameEntity(deviceId, deviceSecret, eId, nameMap[eId]);
        const nameBefore = await getEntityName(deviceId, eId);

        const res = await api('POST', '/api/official-borrow/bind-personal', {
            deviceId, deviceSecret, entityId: eId
        });

        if (res.data.success) {
            const nameAfter = await getEntityName(deviceId, eId);
            assert(nameAfter === nameBefore,
                `Entity ${eId} name preserved after bind-personal override`,
                `expected "${nameBefore}", got "${nameAfter}"`);
        } else if (res.status === 404 || (res.data.error && res.data.error === 'sold_out')) {
            skip(`bind-personal override test`, 'No personal bots available');
        } else if (res.status === 403) {
            skip(`bind-personal override test`, 'Subscription required');
        } else {
            skip(`bind-personal override test`, `Unexpected: ${res.data.error || res.data.message}`);
        }
    }

    console.log('');

    // ============================================
    // Scenario 10: 名稱最大長度邊界測試
    // ============================================
    console.log('--- Scenario 10: Name boundary tests ---\n');

    {
        const eId = entityIds[2];
        // Rebind if needed
        const status = await getEntityStatus(deviceId, eId);
        if (!status.isBound) {
            botSecrets[eId] = await setupEntity(deviceId, deviceSecret, eId);
        }

        // Test: exactly 20 chars (max allowed)
        const name20 = '一二三四五六七八九十一二三四五六七八九十';
        const res20 = await renameEntity(deviceId, deviceSecret, eId, name20);
        assert(res20.data.success,
            `20-char name accepted`);

        const name20After = await getEntityName(deviceId, eId);
        assert(name20After === name20,
            `20-char name stored correctly`,
            `expected "${name20}", got "${name20After}"`);

        // Test: 21 chars (should be rejected)
        const name21 = '一二三四五六七八九十一二三四五六七八九十一';
        const res21 = await renameEntity(deviceId, deviceSecret, eId, name21);
        assert(res21.status === 400,
            `21-char name rejected (400)`,
            `got status ${res21.status}`);

        // Test: name should still be the 20-char one
        const nameStill = await getEntityName(deviceId, eId);
        assert(nameStill === name20,
            `Name unchanged after rejected 21-char rename`,
            `expected "${name20}", got "${nameStill}"`);

        // Test: rename to null (clear name)
        const resNull = await renameEntity(deviceId, deviceSecret, eId, null);
        assert(resNull.data.success, `Rename to null accepted`);

        const nameNull = await getEntityName(deviceId, eId);
        assert(nameNull === null,
            `Name cleared to null`,
            `expected null, got "${nameNull}"`);
    }

    console.log('');

    // ============================================
    // Scenario 11: 快速連續操作 — rename 後立即 delete
    // 測試 race condition
    // ============================================
    console.log('--- Scenario 11: Rapid rename + delete sequence —');
    console.log('    快速連續操作不應丟失名稱 ---\n');

    {
        const eId = entityIds[2];
        // Rebind if needed
        let status = await getEntityStatus(deviceId, eId);
        if (!status.isBound) {
            botSecrets[eId] = await setupEntity(deviceId, deviceSecret, eId);
        }

        const rapidName = '快速測試';
        // Rapid rename
        await renameEntity(deviceId, deviceSecret, eId, rapidName);

        // Immediate delete
        await api('DELETE', '/api/device/entity', {
            deviceId, deviceSecret, entityId: eId
        });

        // Check name preserved
        const nameAfter = await getEntityName(deviceId, eId);
        assert(nameAfter === rapidName,
            `Name preserved after rapid rename+delete`,
            `expected "${rapidName}", got "${nameAfter}"`);
    }

    console.log('');

    // ============================================
    // Scenario 12: Bug 重現場景 — 模擬實際使用者情境
    // 3 個實體分別命名，刪除 #1 和 #3，只有 #2 保留
    // ============================================
    console.log('--- Scenario 12: Bug reproduction — original user scenario —');
    console.log('    模擬：刪除實體 #1 和 #3 後名稱應保留，#2 不受影響 ---\n');

    {
        const ts2 = Date.now();
        const dId = `test-bug-repro-${ts2}`;
        const dSec = `secret-repro-${ts2}`;
        const secrets = {};
        const reproIds = [];

        // Create device by registering entity 0 (default slot), then add 2 more slots
        await setupEntity(dId, dSec, 0);
        for (let i = 0; i < 2; i++) {
            const addRes = await api('POST', '/api/device/add-entity', { deviceId: dId, deviceSecret: dSec });
            if (!addRes.data.success) throw new Error(`add-entity failed: ${addRes.data.error}`);
        }

        // Get actual entity IDs (dynamic system may create extra slots)
        const reproEntities = await api('GET', `/api/entities?deviceId=${dId}`);
        const allIds = (reproEntities.data.entityIds || []).sort((a, b) => a - b);
        // Use only first 3 slots for this test scenario
        const testIds = allIds.slice(0, 3);
        console.log(`  [Repro] Device entity IDs: [${allIds.join(', ')}], using first 3: [${testIds.join(', ')}]`);

        // Unbind entity 0 first (we'll use the 3 slots for our test)
        await api('DELETE', '/api/device/entity', { deviceId: dId, deviceSecret: dSec, entityId: testIds[0] });

        // Bind all 3 slots with names
        const nameLabels = ['月月', '免免', '租租'];
        const names = {};
        for (let i = 0; i < testIds.length; i++) {
            const eId = testIds[i];
            secrets[eId] = await setupEntity(dId, dSec, eId, nameLabels[i]);
            await renameEntity(dId, dSec, eId, nameLabels[i]);
            names[eId] = nameLabels[i];
            reproIds.push(eId);
        }

        // Verify all names set
        for (const eId of reproIds) {
            const name = await getEntityName(dId, eId);
            assert(name === names[eId],
                `[Repro] Entity ${eId} initial name = "${names[eId]}"`,
                `got "${name}"`);
        }

        // Simulate: unbind first and third entities (as if subscription expired)
        // This is the code path that was buggy: createDefaultEntity() wiped name
        await api('DELETE', '/api/device/entity', { deviceId: dId, deviceSecret: dSec, entityId: reproIds[0] });
        await api('DELETE', '/api/device/entity', { deviceId: dId, deviceSecret: dSec, entityId: reproIds[2] });

        // Middle entity should still be bound and named
        const midId = reproIds[1];
        const name2 = await getEntityName(dId, midId);
        const status2 = await getEntityStatus(dId, midId);
        assert(name2 === names[midId] && status2.isBound === true,
            `[Repro] Entity ${midId} still bound with name "${names[midId]}" (unaffected)`,
            `name="${name2}", isBound=${status2.isBound}`);

        // First and third entities should be unbound BUT names preserved
        for (const eId of [reproIds[0], reproIds[2]]) {
            const name = await getEntityName(dId, eId);
            const st = await getEntityStatus(dId, eId);
            assert(st.isBound === false,
                `[Repro] Entity ${eId} is unbound`);
            assert(name === names[eId],
                `[Repro] Entity ${eId} name "${names[eId]}" preserved after unbind`,
                `got "${name}"`);
        }
    }

    console.log('');

    // ============================================
    // Scenario 13: 跨實體 transform 不影響其他實體名稱
    // ============================================
    console.log('--- Scenario 13: Transform on one entity does not affect others ---\n');

    {
        // Re-setup all entities to ensure fresh botSecrets
        // (previous scenarios like bind-free may have replaced botSecrets)
        for (let i = 0; i < entityIds.length; i++) {
            const eid = entityIds[i];
            // Always unbind + rebind to get fresh botSecret
            try { await api('DELETE', '/api/entity/' + eid, { deviceId, botSecret: botSecrets[eid] }); } catch {}
            botSecrets[eid] = await setupEntity(deviceId, deviceSecret, eid);
            await renameEntity(deviceId, deviceSecret, eid, customNames[i]);
        }

        // Transform entity 0 with a new name
        const eid0 = entityIds[0];
        await api('POST', '/api/transform', {
            deviceId, entityId: eid0, botSecret: botSecrets[eid0],
            name: '被改名的', message: 'name changed via transform'
        });

        // Entity 0's name changed
        const name0 = await getEntityName(deviceId, eid0);
        assert(name0 === '被改名的',
            `Entity ${eid0} name changed via transform`,
            `expected "被改名的", got "${name0}"`);

        // Others should be untouched
        for (let i = 1; i < entityIds.length; i++) {
            const eid = entityIds[i];
            const name = await getEntityName(deviceId, eid);
            assert(name === customNames[i],
                `Entity ${eid} name unaffected by entity ${eid0}'s transform`,
                `expected "${customNames[i]}", got "${name}"`);
        }
    }

    console.log('');

    // ============================================
    // Log / Telemetry API Verification
    // ============================================
    console.log('--- Log / Telemetry API Verification ---\n');

    {
        const telRes = await api('GET',
            `/api/device-telemetry?deviceId=${deviceId}&deviceSecret=${encodeURIComponent(deviceSecret)}&type=api_req`
        );
        if (telRes.status === 200 && telRes.data.entries) {
            const actions = telRes.data.entries.map(e => e.action);
            assert(telRes.data.entries.length > 0, 'Telemetry captured API calls', `count=${telRes.data.entries.length}`);
            assert(actions.some(a => a.includes('/api/device/register')), 'Telemetry logged POST /api/device/register');
            assert(actions.some(a => a.includes('/api/status')), 'Telemetry logged GET /api/status');
            assert(actions.some(a => a.includes('/api/transform')), 'Telemetry logged POST /api/transform');
            assert(actions.some(a => a.includes('/api/device/entity/name')), 'Telemetry logged PUT /api/device/entity/name');
            const withDuration = telRes.data.entries.filter(e => e.duration != null && e.duration > 0);
            assert(withDuration.length > 0, 'Telemetry entries include response duration', `${withDuration.length}/${telRes.data.entries.length}`);
        } else {
            skip('Telemetry verification', 'API not available');
        }

        const logRes = await api('GET',
            `/api/logs?deviceId=${deviceId}&deviceSecret=${encodeURIComponent(deviceSecret)}&limit=50`
        );
        assert(logRes.status === 200 && logRes.data.success, 'Server log API accessible', `status=${logRes.status}`);
    }

    console.log('');

    // ============================================
    // Summary
    // ============================================
    console.log('='.repeat(60));
    console.log('TEST SUMMARY');
    console.log('='.repeat(60));
    console.log(`  Passed:  ${passed}`);
    console.log(`  Failed:  ${failed}`);
    console.log(`  Skipped: ${skipped}`);
    console.log(`  Total:   ${passed + failed + skipped}`);
    console.log('');

    if (failed === 0) {
        console.log('✅ All tests passed!');
    } else {
        console.log(`❌ ${failed} test(s) failed!`);
    }

    console.log('='.repeat(60));
    return { passed, failed, skipped };
}

// ============================================
// Main
// ============================================
runTests().catch(err => {
    console.error('\n❌ Test runner error:', err.message);
    process.exit(1);
});
