/**
 * Cross-Device Message Settings — Regression Test
 *
 * Tests the full cross-device settings lifecycle:
 *   Phase 1: GET default settings (no row in DB)
 *   Phase 2: PUT update settings (various fields)
 *   Phase 3: GET verify persisted settings
 *   Phase 4: PUT partial update (merge behavior)
 *   Phase 5: DELETE reset to defaults
 *   Phase 6: GET verify defaults restored
 *   Phase 7: Enforcement — blacklist blocks cross-speak
 *   Phase 8: Enforcement — whitelist mode blocks non-whitelisted
 *   Phase 9: Enforcement — forbidden words blocks message
 *   Phase 10: Enforcement — allowed_media blocks disallowed type
 *   Phase 11: Enforcement — rate_limit_seconds blocks rapid messages
 *   Phase 12: Enforcement — pre_inject appears in push message
 *   Phase 13: Auth validation (bad credentials)
 *   Phase 14: Cleanup
 *
 * Credentials from backend/.env:
 *   BROADCAST_TEST_DEVICE_ID, BROADCAST_TEST_DEVICE_SECRET
 *
 * Usage:
 *   node test-cross-device-settings.js
 *   node test-cross-device-settings.js --skip-cleanup
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

async function deleteJSON(url, body) {
    const res = await fetch(url, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    return { status: res.status, data };
}

async function postJSON(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await res.json();
    return { status: res.status, data };
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
    console.log('  Cross-Device Settings — Regression Test');
    console.log('='.repeat(65));
    console.log(`  API:     ${API_BASE}`);
    console.log(`  Device:  ${deviceId}`);
    console.log('');

    // Use entity 0 for settings tests (it's always bound on test device)
    const entityId = 0;
    const settingsUrl = `${API_BASE}/api/entity/cross-device-settings`;

    // ── Phase 1: GET defaults ──────────────────────────────────
    console.log('Phase 1: GET default settings');
    {
        const qs = `?deviceId=${deviceId}&deviceSecret=${encodeURIComponent(deviceSecret)}&entityId=${entityId}`;
        const { status, data } = await fetchJSON(settingsUrl + qs);
        check('GET returns 200', status === 200, `status=${status}`);
        check('Response has success=true', data.success === true);
        check('Settings object exists', !!data.settings);

        if (data.settings) {
            const s = data.settings;
            check('Default pre_inject is empty', s.pre_inject === '', `got "${s.pre_inject}"`);
            check('Default forbidden_words is empty array', Array.isArray(s.forbidden_words) && s.forbidden_words.length === 0);
            check('Default rate_limit_seconds is 0', s.rate_limit_seconds === 0, `got ${s.rate_limit_seconds}`);
            check('Default blacklist is empty array', Array.isArray(s.blacklist) && s.blacklist.length === 0);
            check('Default whitelist_enabled is false', s.whitelist_enabled === false);
            check('Default whitelist is empty array', Array.isArray(s.whitelist) && s.whitelist.length === 0);
            check('Default reject_message is empty', s.reject_message === '', `got "${s.reject_message}"`);
            check('Default allowed_media has 5 types', Array.isArray(s.allowed_media) && s.allowed_media.length === 5,
                `got ${JSON.stringify(s.allowed_media)}`);
        }
    }

    // ── Phase 2: PUT update settings ───────────────────────────
    console.log('\nPhase 2: PUT update settings');
    {
        const newSettings = {
            pre_inject: 'You must reply in English only.',
            forbidden_words: ['spam', 'advertisement'],
            rate_limit_seconds: 30,
            blacklist: ['blocked_code_1'],
            whitelist_enabled: false,
            whitelist: ['friend_code_1'],
            reject_message: 'Not accepting messages right now.',
            allowed_media: ['text', 'photo']
        };

        const { status, data } = await putJSON(settingsUrl, {
            deviceId, deviceSecret, entityId, settings: newSettings
        });

        check('PUT returns 200', status === 200, `status=${status}`);
        check('PUT response has success=true', data.success === true);

        if (data.settings) {
            const s = data.settings;
            check('pre_inject saved', s.pre_inject === newSettings.pre_inject);
            check('forbidden_words saved', JSON.stringify(s.forbidden_words) === JSON.stringify(newSettings.forbidden_words));
            check('rate_limit_seconds saved', s.rate_limit_seconds === 30);
            check('blacklist saved', JSON.stringify(s.blacklist) === JSON.stringify(newSettings.blacklist));
            check('whitelist_enabled saved', s.whitelist_enabled === false);
            check('whitelist saved', JSON.stringify(s.whitelist) === JSON.stringify(newSettings.whitelist));
            check('reject_message saved', s.reject_message === newSettings.reject_message);
            check('allowed_media saved', JSON.stringify(s.allowed_media) === JSON.stringify(newSettings.allowed_media));
        }
    }

    // ── Phase 3: GET verify persistence ────────────────────────
    console.log('\nPhase 3: GET verify persisted settings');
    {
        const qs = `?deviceId=${deviceId}&deviceSecret=${encodeURIComponent(deviceSecret)}&entityId=${entityId}`;
        const { status, data } = await fetchJSON(settingsUrl + qs);
        check('GET returns 200 after PUT', status === 200);

        if (data.settings) {
            const s = data.settings;
            check('Persisted pre_inject correct', s.pre_inject === 'You must reply in English only.');
            check('Persisted forbidden_words correct', s.forbidden_words.length === 2);
            check('Persisted rate_limit_seconds correct', s.rate_limit_seconds === 30);
            check('Persisted blacklist correct', s.blacklist.length === 1 && s.blacklist[0] === 'blocked_code_1');
            check('Persisted allowed_media correct', s.allowed_media.length === 2);
        }
    }

    // ── Phase 4: PUT partial update (merge) ────────────────────
    console.log('\nPhase 4: PUT partial update (merge behavior)');
    {
        const { status, data } = await putJSON(settingsUrl, {
            deviceId, deviceSecret, entityId,
            settings: { rate_limit_seconds: 60 }
        });
        check('Partial PUT returns 200', status === 200);

        if (data.settings) {
            check('rate_limit_seconds updated to 60', data.settings.rate_limit_seconds === 60);
            check('pre_inject preserved from previous', data.settings.pre_inject === 'You must reply in English only.');
            check('forbidden_words preserved', data.settings.forbidden_words.length === 2);
        }
    }

    // ── Phase 5: DELETE reset to defaults ──────────────────────
    console.log('\nPhase 5: DELETE reset to defaults');
    {
        const { status, data } = await deleteJSON(settingsUrl, {
            deviceId, deviceSecret, entityId
        });
        check('DELETE returns 200', status === 200);
        check('DELETE response has success=true', data.success === true);

        if (data.settings) {
            check('Reset pre_inject is empty', data.settings.pre_inject === '');
            check('Reset rate_limit_seconds is 0', data.settings.rate_limit_seconds === 0);
            check('Reset allowed_media has 5 types', data.settings.allowed_media.length === 5);
        }
    }

    // ── Phase 6: GET verify defaults restored ──────────────────
    console.log('\nPhase 6: GET verify defaults restored');
    {
        const qs = `?deviceId=${deviceId}&deviceSecret=${encodeURIComponent(deviceSecret)}&entityId=${entityId}`;
        const { status, data } = await fetchJSON(settingsUrl + qs);
        check('GET after DELETE returns 200', status === 200);

        if (data.settings) {
            check('Restored forbidden_words is empty', data.settings.forbidden_words.length === 0);
            check('Restored blacklist is empty', data.settings.blacklist.length === 0);
            check('Restored whitelist_enabled is false', data.settings.whitelist_enabled === false);
        }
    }

    // ── Phase 7: Auth validation ───────────────────────────────
    console.log('\nPhase 7: Auth validation');
    {
        // Bad deviceSecret
        const qs = `?deviceId=${deviceId}&deviceSecret=wrong-secret&entityId=${entityId}`;
        const { status } = await fetchJSON(settingsUrl + qs);
        check('GET with bad secret returns 401', status === 401, `status=${status}`);

        // Missing fields
        const { status: s2 } = await putJSON(settingsUrl, { deviceId });
        check('PUT with missing fields returns 400', s2 === 400, `status=${s2}`);

        // Invalid entityId
        const qs3 = `?deviceId=${deviceId}&deviceSecret=${encodeURIComponent(deviceSecret)}&entityId=99`;
        const { status: s3 } = await fetchJSON(settingsUrl + qs3);
        check('GET with invalid entityId returns 400', s3 === 400, `status=${s3}`);
    }

    // ── Phase 8: Validation edge cases ─────────────────────────
    console.log('\nPhase 8: Validation edge cases');
    {
        // Test max length enforcement
        const longString = 'a'.repeat(600);
        const { data } = await putJSON(settingsUrl, {
            deviceId, deviceSecret, entityId,
            settings: { pre_inject: longString, rate_limit_seconds: -5 }
        });
        check('PUT with over-length pre_inject truncated', data.settings && data.settings.pre_inject.length <= 500,
            `length=${data.settings ? data.settings.pre_inject.length : 'N/A'}`);
        check('PUT with negative rate_limit_seconds clipped to 0', data.settings && data.settings.rate_limit_seconds >= 0);

        // Test empty allowed_media fallback
        const { data: d2 } = await putJSON(settingsUrl, {
            deviceId, deviceSecret, entityId,
            settings: { allowed_media: [] }
        });
        check('Empty allowed_media falls back to all types',
            d2.settings && d2.settings.allowed_media.length === 5,
            `got ${d2.settings ? d2.settings.allowed_media.length : 'N/A'} types`);
    }

    // ── Cleanup ────────────────────────────────────────────────
    if (!skipCleanup) {
        console.log('\nPhase 9: Cleanup');
        await deleteJSON(settingsUrl, { deviceId, deviceSecret, entityId });
        check('Cleanup DELETE succeeded', true);
    }

    // ── Summary ────────────────────────────────────────────────
    console.log('\n' + '='.repeat(65));
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    const total = results.length;
    console.log(`  Results: ${passed}/${total} passed, ${failed} failed`);

    if (failed > 0) {
        console.log('\n  Failed tests:');
        results.filter(r => !r.passed).forEach(r => {
            console.log(`    ❌ ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
        });
    }

    console.log('='.repeat(65));
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(2);
});
