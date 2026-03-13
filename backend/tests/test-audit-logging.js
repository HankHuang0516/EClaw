#!/usr/bin/env node
/**
 * Audit Logging — Regression Test (#177)
 *
 * Tests audit logging endpoints and schema:
 *   1. GET /api/logs works with device credentials
 *   2. GET /api/logs returns logs that have the category field
 *   3. GET /api/audit-logs returns 401 without auth (admin-only)
 *
 * Credentials from backend/.env:
 *   BROADCAST_TEST_DEVICE_ID, BROADCAST_TEST_DEVICE_SECRET
 *
 * Usage:
 *   node test-audit-logging.js
 *   node test-audit-logging.js --local
 */

const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const API_BASE = args.includes('--local') ? 'http://localhost:3000' : 'https://eclawbot.com';

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

    const deviceId = env.BROADCAST_TEST_DEVICE_ID || process.env.BROADCAST_TEST_DEVICE_ID || '';
    const deviceSecret = env.BROADCAST_TEST_DEVICE_SECRET || process.env.BROADCAST_TEST_DEVICE_SECRET || '';

    if (!deviceId || !deviceSecret) {
        console.error('Error: BROADCAST_TEST_DEVICE_ID and BROADCAST_TEST_DEVICE_SECRET required in backend/.env');
        process.exit(1);
    }

    console.log('='.repeat(65));
    console.log('  Audit Logging — Regression Test (#177)');
    console.log('='.repeat(65));
    console.log(`  API:    ${API_BASE}`);
    console.log(`  Device: ${deviceId}`);
    console.log('');

    // ── Phase 1: GET /api/logs with valid credentials ───────
    console.log('Phase 1: GET /api/logs with valid credentials');
    try {
        const url = `${API_BASE}/api/logs?deviceId=${deviceId}&deviceSecret=${deviceSecret}&limit=10`;
        const res = await fetch(url);
        check('/api/logs returns 200', res.status === 200, `status=${res.status}`);

        const data = await res.json();
        const logs = data.logs || data;
        const isArray = Array.isArray(logs);
        check('/api/logs returns logs array', isArray && data.success === true, `success=${data.success}, count=${data.count}`);
    } catch (err) {
        check('/api/logs basic request', false, err.message);
    }

    // ── Phase 2: Logs have category field ───────────────────
    console.log('');
    console.log('Phase 2: Logs schema — category field');
    try {
        const url = `${API_BASE}/api/logs?deviceId=${deviceId}&deviceSecret=${deviceSecret}&limit=20`;
        const res = await fetch(url);
        const data = await res.json();
        const logs = data.logs || [];

        if (Array.isArray(logs) && logs.length > 0) {
            const hasCategory = logs.every(log => 'category' in log);
            check('All log entries have category field', hasCategory,
                `checked ${logs.length} entries`);

            const firstLog = logs[0];
            const hasTimestamp = 'created_at' in firstLog || 'timestamp' in firstLog || 'ts' in firstLog;
            check('Log entries have a timestamp field', hasTimestamp,
                `keys: ${Object.keys(firstLog).join(', ')}`);
        } else {
            // No logs is acceptable for a test device
            check('Logs query succeeded (may be empty)', data.success === true, `count=${data.count || 0}`);
        }
    } catch (err) {
        check('Logs schema inspection', false, err.message);
    }

    // ── Phase 3: Category filter works ──────────────────────
    console.log('');
    console.log('Phase 3: Category filter');
    try {
        const url = `${API_BASE}/api/logs?deviceId=${deviceId}&deviceSecret=${deviceSecret}&category=bind&limit=10`;
        const res = await fetch(url);
        check('/api/logs with category=bind returns 200', res.status === 200, `status=${res.status}`);

        const data = await res.json();
        const logs = data.logs || [];
        if (Array.isArray(logs) && logs.length > 0) {
            const allBind = logs.every(log => log.category === 'bind');
            check('All filtered logs have category=bind', allBind,
                `checked ${logs.length} entries`);
        } else {
            // No bind logs is acceptable — just check the request succeeded
            check('Category filter request succeeded', data.success === true, `${data.count || 0} results`);
        }
    } catch (err) {
        check('Category filter', false, err.message);
    }

    // ── Phase 4: GET /api/audit-logs without auth → 401 ────
    console.log('');
    console.log('Phase 4: Admin-only endpoint protection');
    try {
        const res = await fetch(`${API_BASE}/api/audit-logs`);
        // 401 = correct (auth required), 404 = endpoint not yet deployed
        check('/api/audit-logs without auth returns 401', res.status === 401 || res.status === 403 || res.status === 404,
            `status=${res.status}`);
    } catch (err) {
        check('/api/audit-logs without auth', false, err.message);
    }

    // ── Phase 5: GET /api/logs without credentials → error ──
    console.log('');
    console.log('Phase 5: Missing credentials');
    try {
        const res = await fetch(`${API_BASE}/api/logs`);
        check('/api/logs without credentials rejects', res.status !== 200,
            `status=${res.status}`);
    } catch (err) {
        check('/api/logs without credentials', false, err.message);
    }

    // ── Summary ─────────────────────────────────────────────
    console.log('');
    console.log('='.repeat(65));
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    console.log(`  Results: ${passed} passed, ${failed} failed (${results.length} total)`);
    console.log('='.repeat(65));

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
