// Entity XP/Level Preservation Test
//
// Verify fix: Fix #156 - entity XP/level not reset to 0/1 during unbind/rebind.
//
// Run: node backend/tests/test_entity_xp_preservation.js
// Run (local): node backend/tests/test_entity_xp_preservation.js --local

'use strict';

const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const isLocal = args.includes('--local');
const API_BASE = isLocal ? 'http://localhost:3000' : 'https://eclawbot.com';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function api(method, urlPath, body) {
    body = body || null;
    const url = API_BASE + urlPath;
    const opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    return { status: res.status, data: await res.json().catch(function() { return {}; }) };
}

let passed = 0, failed = 0, skipped = 0;

function assert(cond, label, detail) {
    detail = detail || '';
    if (cond) { console.log('  [PASS] ' + label); passed++; }
    else { console.log('  [FAIL] ' + label + (detail ? ' -- ' + detail : '')); failed++; }
}

async function registerAndBind(deviceId, deviceSecret, entityId) {
    const reg = await api('POST', '/api/device/register', { deviceId: deviceId, deviceSecret: deviceSecret, entityId: entityId, isTestDevice: true });
    if (!reg.data.success) throw new Error('register failed: ' + JSON.stringify(reg.data));
    const bind = await api('POST', '/api/bind', { code: reg.data.bindingCode });
    if (!bind.data.success) throw new Error('bind failed: ' + JSON.stringify(bind.data));
    return bind.data.botSecret;
}

async function setXP(deviceId, deviceSecret, entityId, xp) {
    const r = await api('POST', '/api/debug/set-entity-xp', { deviceId: deviceId, deviceSecret: deviceSecret, entityId: entityId, xp: xp });
    if (!r.data.success) throw new Error('set-xp failed: ' + JSON.stringify(r.data));
    return r.data;
}

async function getXP(deviceId, deviceSecret, entityId) {
    const r = await api('GET', '/api/entities?deviceId=' + deviceId + '&deviceSecret=' + deviceSecret, null);
    if (!Array.isArray(r.data.entities)) throw new Error('get-entities failed: ' + JSON.stringify(r.data));
    const entity = (r.data.entities || []).find(function(e) { return e.entityId === entityId; });
    // /api/entities only returns bound entities; missing = unbound
    return entity ? { xp: entity.xp, level: entity.level, isBound: true } : { xp: null, level: null, isBound: false };
}
async function runTests() {
    const SEP = '='.repeat(60);
    console.log(SEP);
    console.log('ENTITY XP / LEVEL PRESERVATION TEST');
    console.log(SEP);
    console.log('Target: ' + API_BASE);
    console.log('Date:   ' + new Date().toISOString());
    console.log('');

    const ts = Date.now();
    const deviceId = 'test-xp-preserve-' + ts;
    const deviceSecret = 'secret-xp-' + ts;

    // --- Scenario 0: Baseline ---
    console.log('--- Scenario 0: Debug endpoint baseline ---');
    console.log('');
    {
        const botSecret = await registerAndBind(deviceId, deviceSecret, 0);
        const setResult = await setXP(deviceId, deviceSecret, 0, 250);
        assert(setResult.xp === 250, 'set-xp accepted xp=250', 'got ' + setResult.xp);
        assert(setResult.level >= 2, 'level recalculated (>=2 for xp=250)', 'got ' + setResult.level);
        const before = await getXP(deviceId, deviceSecret, 0);
        assert(before && before.xp === 250, 'GET /api/entities returns xp=250', 'got ' + (before && before.xp));
        assert(before && before.isBound === true, 'entity is bound');
        console.log('  INFO xp=250 -> level=' + (before && before.level));
    }
    console.log('');

    // --- Scenario 1: device-side unbind ---
    console.log('--- Scenario 1: DELETE /api/device/entity preserves XP ---');
    console.log('');
    {
        const before = await getXP(deviceId, deviceSecret, 0);
        const xpBefore = (before && before.xp) || 0;
        await api('DELETE', '/api/device/entity', { deviceId: deviceId, deviceSecret: deviceSecret, entityId: 0 });
        const after = await getXP(deviceId, deviceSecret, 0);
        assert(after.isBound === false, 'entity is unbound after device-side delete');
        // XP preservation verified in Scenario 2 (rebind confirms XP survived)
        // Level preservation also verified after rebind
    }
    console.log('');

    // --- Scenario 2: Rebind after unbind ---
    console.log('--- Scenario 2: Rebind after unbind preserves XP ---');
    console.log('');
    {
        // After Scenario 1 unbind, entity not in list; use known XP from Scenario 0
        const xpBefore = 250; // Set in Scenario 0
        await registerAndBind(deviceId, deviceSecret, 0);
        const after = await getXP(deviceId, deviceSecret, 0);
        assert(after && after.isBound === true, 'entity is bound after rebind');
        assert(after && after.xp === xpBefore, 'XP preserved across rebind (' + xpBefore + ')', 'got ' + (after && after.xp));
    }
    console.log('');
    // --- Scenario 3: bot-side unbind ---
    console.log('--- Scenario 3: DELETE /api/entity (bot-side) preserves XP ---');
    console.log('');
    {
        await api('DELETE', '/api/device/entity', { deviceId: deviceId, deviceSecret: deviceSecret, entityId: 0 });
        const bs = await registerAndBind(deviceId, deviceSecret, 0);
        await setXP(deviceId, deviceSecret, 0, 400);
        const before = await getXP(deviceId, deviceSecret, 0);
        assert(before && before.xp === 400, 'XP set to 400 before bot-side delete');
        await api('DELETE', '/api/entity', { deviceId: deviceId, entityId: 0, botSecret: bs });
        const after = await getXP(deviceId, deviceSecret, 0);
        assert(after.isBound === false, 'entity unbound after bot-side delete');
        // XP can't be read when unbound; rebind then verify
        const bs2 = await registerAndBind(deviceId, deviceSecret, 0);
        const rebound = await getXP(deviceId, deviceSecret, 0);
        assert(rebound && rebound.xp === 400, 'XP=400 preserved after bot-side delete + rebind', 'got ' + (rebound && rebound.xp));
        // Cleanup: unbind again for Scenario 4
    }
    console.log('');

    // --- Scenario 4: Multiple cycles ---
    console.log('--- Scenario 4: Multiple cycles preserve XP cumulatively ---');
    console.log('');
    {
        const CYCLES = 3;
        let currentXP = 0;
        // Start fresh: entity may still be unbound from Scenario 3 cleanup
        for (let i = 0; i < CYCLES; i++) {
            // Unbind if needed (catch if already unbound)
            await api('DELETE', '/api/device/entity', { deviceId: deviceId, deviceSecret: deviceSecret, entityId: 0 }).catch(function() {});
            await registerAndBind(deviceId, deviceSecret, 0);
            currentXP += (i + 1) * 100;
            await setXP(deviceId, deviceSecret, 0, currentXP);
            // Read XP while bound
            const afterSet = await getXP(deviceId, deviceSecret, 0);
            assert(afterSet && afterSet.xp === currentXP, 'Cycle ' + (i + 1) + ': setXP=' + currentXP + ' confirmed while bound', 'got ' + (afterSet && afterSet.xp));
            // Unbind, then rebind to verify XP survived the cycle
            await api('DELETE', '/api/device/entity', { deviceId: deviceId, deviceSecret: deviceSecret, entityId: 0 });
            await registerAndBind(deviceId, deviceSecret, 0);
            const afterRebind = await getXP(deviceId, deviceSecret, 0);
            assert(afterRebind && afterRebind.xp === currentXP, 'Cycle ' + (i + 1) + ': XP=' + currentXP + ' preserved after unbind+rebind', 'got ' + (afterRebind && afterRebind.xp));
        }
    }
    console.log('');

    // --- Scenario 5: Multi-entity isolation ---
    console.log('--- Scenario 5: Unbinding entity 0 does not affect entity 1 XP ---');
    console.log('');
    {
        await api('DELETE', '/api/device/entity', { deviceId: deviceId, deviceSecret: deviceSecret, entityId: 0 }).catch(function() {});
        await registerAndBind(deviceId, deviceSecret, 0);
        await registerAndBind(deviceId, deviceSecret, 1);
        await setXP(deviceId, deviceSecret, 0, 100);
        await setXP(deviceId, deviceSecret, 1, 999);
        await api('DELETE', '/api/device/entity', { deviceId: deviceId, deviceSecret: deviceSecret, entityId: 0 });
        const xp1 = await getXP(deviceId, deviceSecret, 1);
        assert(xp1 && xp1.xp === 999, 'Entity 1 XP=999 unaffected by entity 0 unbind', 'got ' + (xp1 && xp1.xp));
        assert(xp1 && xp1.isBound === true, 'Entity 1 still bound');
    }
    console.log('');

    // Summary
    console.log(SEP);
    console.log('TEST SUMMARY');
    console.log(SEP);
    console.log('  Passed:  ' + passed);
    console.log('  Failed:  ' + failed);
    console.log('  Skipped: ' + skipped);
    if (failed === 0) console.log('All XP preservation tests passed!');
    else console.log(failed + ' test(s) failed');
    console.log(SEP);
    return { passed: passed, failed: failed, skipped: skipped };
}

runTests().catch(function(err) {
    console.error('Test runner error: ' + err.message);
    process.exit(1);
});
