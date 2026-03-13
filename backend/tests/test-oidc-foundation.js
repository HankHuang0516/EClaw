#!/usr/bin/env node
/**
 * OIDC Foundation — Regression Test (#175)
 *
 * Tests OIDC foundation endpoints:
 *   1. GET /api/auth/oauth/providers → { success, providers }
 *   2. GET /api/auth/oauth/config → googleClientId, facebookAppId
 *   3. POST /api/auth/oauth/oidc with missing fields → 400
 *   4. POST /api/auth/oauth/oidc with unknown provider → 400
 *
 * No credentials needed for most tests.
 *
 * Usage:
 *   node test-oidc-foundation.js
 *   node test-oidc-foundation.js --local
 */

const args = process.argv.slice(2);
const API_BASE = args.includes('--local') ? 'http://localhost:3000' : 'https://eclawbot.com';

// ── HTTP Helpers ────────────────────────────────────────────
async function fetchRaw(url) {
    const res = await fetch(url);
    let data;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
}

async function postJSON(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    let data;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
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
    console.log('='.repeat(65));
    console.log('  OIDC Foundation — Regression Test (#175)');
    console.log('='.repeat(65));
    console.log(`  API: ${API_BASE}`);
    console.log('');

    // ── Phase 1: GET /api/auth/oauth/providers ──────────────
    console.log('Phase 1: OAuth providers list');
    try {
        const { status, data } = await fetchRaw(`${API_BASE}/api/auth/oauth/providers`);
        check('GET /api/auth/oauth/providers returns 200', status === 200,
            `status=${status}`);

        const hasSuccess = data && data.success === true;
        check('Response has success=true', hasSuccess,
            `success=${data?.success}`);

        const providers = data?.providers;
        const isArray = Array.isArray(providers);
        check('providers is an array', isArray,
            `type=${typeof providers}`);

        if (isArray) {
            const providerNames = providers.map(p => typeof p === 'string' ? p : p?.name || p?.id);
            const hasGoogle = providerNames.some(n => n && n.toLowerCase().includes('google'));
            check('Providers include google', hasGoogle,
                `providers=[${providerNames.join(', ')}]`);

            const hasFacebook = providerNames.some(n => n && n.toLowerCase().includes('facebook'));
            check('Providers include facebook', hasFacebook,
                `providers=[${providerNames.join(', ')}]`);
        }
    } catch (err) {
        check('GET /api/auth/oauth/providers', false, err.message);
    }

    // ── Phase 2: GET /api/auth/oauth/config ─────────────────
    console.log('');
    console.log('Phase 2: OAuth config');
    try {
        const { status, data } = await fetchRaw(`${API_BASE}/api/auth/oauth/config`);
        check('GET /api/auth/oauth/config returns 200', status === 200,
            `status=${status}`);

        if (data) {
            const hasGoogleId = 'googleClientId' in data;
            check('Config has googleClientId field', hasGoogleId,
                `keys: ${Object.keys(data).join(', ')}`);

            const hasFacebookId = 'facebookAppId' in data;
            check('Config has facebookAppId field', hasFacebookId,
                `keys: ${Object.keys(data).join(', ')}`);
        } else {
            check('Config response is not null', false, 'data is null');
        }
    } catch (err) {
        check('GET /api/auth/oauth/config', false, err.message);
    }

    // ── Phase 3: POST /api/auth/oauth/oidc with missing fields → 400
    console.log('');
    console.log('Phase 3: OIDC token exchange — missing fields');
    try {
        const { status, data } = await postJSON(`${API_BASE}/api/auth/oauth/oidc`, {});
        check('POST /api/auth/oauth/oidc with empty body returns 400', status === 400,
            `status=${status}`);
    } catch (err) {
        check('POST /api/auth/oauth/oidc empty body', false, err.message);
    }

    try {
        const { status, data } = await postJSON(`${API_BASE}/api/auth/oauth/oidc`, {
            provider: 'google',
            // missing token / code
        });
        check('POST with provider only (missing token) returns 400', status === 400,
            `status=${status}`);
    } catch (err) {
        check('POST with provider only', false, err.message);
    }

    // ── Phase 4: POST /api/auth/oauth/oidc with unknown provider → 400
    console.log('');
    console.log('Phase 4: OIDC token exchange — unknown provider');
    try {
        const { status, data } = await postJSON(`${API_BASE}/api/auth/oauth/oidc`, {
            provider: 'unknown_provider_xyz',
            token: 'fake-token',
            code: 'fake-code',
        });
        check('POST with unknown provider returns 400', status === 400,
            `status=${status}`);

        const hasError = data && (data.error || data.message);
        check('Error response includes error message', !!hasError,
            `error=${data?.error || data?.message || 'none'}`);
    } catch (err) {
        check('POST with unknown provider', false, err.message);
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
