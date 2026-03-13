#!/usr/bin/env node
/**
 * Regression test: cron-type schedule update must NOT violate NOT NULL on scheduled_at
 *
 * Bug: when repeatType === 'cron', finalScheduledAt is null.
 *      updateSchedule() was passing null to DB → NOT NULL constraint violation.
 * Fix: scheduler.js skips null values; schedule.html omits scheduledAt from
 *      update payload when null.
 *
 * Usage:
 *   node test-schedule-cron-update.js
 *   node test-schedule-cron-update.js --local
 */

'use strict';

const path = require('path');
const fs   = require('fs');

const args     = process.argv.slice(2);
const API_BASE = args.includes('--local') ? 'http://localhost:3000' : 'https://eclawbot.com';

function loadEnv() {
    const p = path.resolve(__dirname, '..', '.env');
    if (!fs.existsSync(p)) return {};
    const vars = {};
    fs.readFileSync(p, 'utf8').split('\n').forEach(line => {
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
    const res  = await fetch(url, opts);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
    return { status: res.status, data };
}

function pass(msg) { console.log(`  ✅ ${msg}`); }
function fail(msg) { console.error(`  ❌ ${msg}`); process.exitCode = 1; }

async function main() {
    const env = loadEnv();
    const deviceId     = env.BROADCAST_TEST_DEVICE_ID;
    const deviceSecret = env.BROADCAST_TEST_DEVICE_SECRET;

    if (!deviceId || !deviceSecret) {
        console.error('Missing BROADCAST_TEST_DEVICE_ID / BROADCAST_TEST_DEVICE_SECRET in backend/.env');
        process.exit(1);
    }

    console.log(`\n[test-schedule-cron-update] API: ${API_BASE}\n`);
    let scheduleId = null;

    try {
        // ── 1. Create a cron-type schedule ──────────────────────────────────
        console.log('Step 1: Create cron schedule');
        const createRes = await req('POST', `${API_BASE}/api/schedules`, {
            deviceId,
            deviceSecret,
            entityId: 0,
            message: 'regression-test-cron',
            repeatType: 'cron',
            cronExpr: '0 9 * * *',   // daily at 09:00
            label: 'regression-cron-null-fix'
        });

        if (createRes.status !== 200 && createRes.status !== 201) {
            fail(`Create failed: ${createRes.status} ${JSON.stringify(createRes.data)}`);
            return;
        }
        scheduleId = createRes.data.schedule ? createRes.data.schedule.id : createRes.data.id;
        pass(`Created cron schedule #${scheduleId}`);

        // Verify scheduled_at stored correctly (may be epoch/now as fallback, that's OK)
        // The key invariant is: creation succeeded without NOT NULL error.

        // ── 2. Update with message only (scheduledAt omitted — mirrors the bug scenario) ──
        console.log('Step 2: Update message only (no scheduledAt in payload)');
        const updateRes = await req('PUT', `${API_BASE}/api/schedules/${scheduleId}`, {
            deviceId,
            deviceSecret,
            entityId: 0,
            message: 'regression-test-cron-updated',
            repeatType: 'cron',
            cronExpr: '0 9 * * *',
            label: 'regression-cron-null-fix',
            timezone: null
            // scheduledAt intentionally omitted — this is the regression scenario
        });

        if (updateRes.status !== 200) {
            fail(`Update failed with ${updateRes.status}: ${JSON.stringify(updateRes.data)}`);
            fail('REGRESSION: null scheduledAt violated NOT NULL constraint — fix broken');
            return;
        }
        pass('Update succeeded without DB NOT NULL error');

        // ── 3. Verify updated message persisted ──────────────────────────────
        console.log('Step 3: Verify updated message');
        const getRes = await req('GET', `${API_BASE}/api/schedules?deviceId=${deviceId}&deviceSecret=${deviceSecret}`);
        if (getRes.status !== 200) {
            fail(`GET schedules failed: ${getRes.status}`);
            return;
        }
        const schedules = Array.isArray(getRes.data) ? getRes.data : (getRes.data.schedules || []);
        const s = schedules.find(x => x.id === scheduleId);
        if (!s) {
            fail(`Schedule #${scheduleId} not found in list`);
            return;
        }
        if (s.message !== 'regression-test-cron-updated') {
            fail(`Message not updated: "${s.message}"`);
            return;
        }
        pass(`Message updated correctly: "${s.message}"`);

    } finally {
        // ── Cleanup ──────────────────────────────────────────────────────────
        if (scheduleId) {
            console.log(`\nCleanup: deleting schedule #${scheduleId}`);
            const delRes = await req('DELETE', `${API_BASE}/api/schedules/${scheduleId}`, { deviceId, deviceSecret });
            if (delRes.status === 200) {
                pass(`Schedule #${scheduleId} deleted`);
            } else {
                console.warn(`  ⚠️  Cleanup failed: ${delRes.status}`);
            }
        }
    }

    const ok = process.exitCode !== 1;
    console.log(`\n${ok ? '✅ All checks passed' : '❌ Some checks FAILED'}\n`);
}

main().catch(err => {
    console.error('Unexpected error:', err);
    process.exit(1);
});
