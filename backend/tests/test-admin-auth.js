#!/usr/bin/env node
/**
 * Admin Endpoints — Auth Protection Test (P0)
 *
 * Verifies ALL admin-only endpoints reject unauthenticated requests.
 * Two protection patterns are tested:
 *   A) Cookie-based: authMiddleware + adminMiddleware → expect 401
 *   B) Token-based: verifyAdmin(req) → expect 403
 *
 * No credentials needed — we only verify rejection.
 *
 * Usage:
 *   node test-admin-auth.js
 *   node test-admin-auth.js --local
 */

const args = process.argv.slice(2);
const API_BASE = args.includes('--local') ? 'http://localhost:3000' : 'https://eclawbot.com';

// ── HTTP Helpers ────────────────────────────────────────────

async function fetchRaw(url, options = {}) {
    const res = await fetch(url, options);
    let data;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
}

function get(path) {
    return fetchRaw(`${API_BASE}${path}`);
}

function post(path, body = {}) {
    return fetchRaw(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function put(path, body = {}) {
    return fetchRaw(`${API_BASE}${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function del(path) {
    return fetchRaw(`${API_BASE}${path}`, { method: 'DELETE' });
}

function patch(path, body = {}) {
    return fetchRaw(`${API_BASE}${path}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

// ── Test Result Tracking ────────────────────────────────────

const results = [];
function check(name, passed, detail = '') {
    results.push({ name, passed, detail });
    const icon = passed ? '✅' : '❌';
    const suffix = detail ? ` — ${detail}` : '';
    console.log(`  ${icon} ${name}${suffix}`);
}

// ── Test Definitions ────────────────────────────────────────

/**
 * Cookie-based admin endpoints (authMiddleware + adminMiddleware).
 * Without a valid JWT cookie, these should return 401.
 */
const cookieAdminEndpoints = [
    { method: 'GET',    path: '/api/admin/stats',            desc: 'Platform stats' },
    { method: 'GET',    path: '/api/admin/bindings',         desc: 'Binding list' },
    { method: 'GET',    path: '/api/admin/users',            desc: 'User list' },
    { method: 'GET',    path: '/api/admin/bots',             desc: 'Bot list' },
    { method: 'POST',   path: '/api/admin/push-update',      desc: 'Push update notification' },
    { method: 'POST',   path: '/api/admin/bots/create',      desc: 'Create bot' },
    { method: 'POST',   path: '/api/admin/gatekeeper/reset', desc: 'Reset gatekeeper strikes' },
    { method: 'DELETE', path: '/api/admin/official-bot/test-nonexistent', desc: 'Delete official bot' },
    { method: 'GET',    path: '/api/audit-logs',             desc: 'Audit logs' },
];

/**
 * Token-based admin endpoints (verifyAdmin check).
 * Without x-admin-token header AND not localhost, these should return 403.
 */
const tokenAdminEndpoints = [
    { method: 'POST',   path: '/api/admin/official-bot/register', desc: 'Register official bot',    body: { botId: 'test', botType: 'free' } },
    { method: 'GET',    path: '/api/admin/official-bots',         desc: 'List official bots' },
    { method: 'PUT',    path: '/api/admin/official-bot/test-nonexistent', desc: 'Update official bot', body: {} },
    { method: 'DELETE', path: '/api/skill-templates/test-nonexistent',    desc: 'Delete skill template' },
    { method: 'DELETE', path: '/api/soul-templates/test-nonexistent',     desc: 'Delete soul template' },
    { method: 'DELETE', path: '/api/rule-templates/test-nonexistent',     desc: 'Delete rule template' },
];

/**
 * Contribution review endpoints (admin-only via verifyAdmin or cookie).
 */
const contributionEndpoints = [
    { method: 'GET', path: '/api/skill-templates/contributions', desc: 'Skill contributions' },
    { method: 'GET', path: '/api/soul-templates/contributions',  desc: 'Soul contributions' },
    { method: 'GET', path: '/api/rule-templates/contributions',  desc: 'Rule contributions' },
];

// ── Main ────────────────────────────────────────────────────

async function main() {
    console.log('='.repeat(65));
    console.log('  Admin Endpoints — Auth Protection Test (P0)');
    console.log('='.repeat(65));
    console.log(`  API: ${API_BASE}`);
    console.log('');

    // ── Phase 1: Cookie-based admin endpoints → 401 ─────────
    console.log('Phase 1: Cookie-based admin endpoints (expect 401)');
    for (const ep of cookieAdminEndpoints) {
        try {
            let result;
            switch (ep.method) {
                case 'GET':    result = await get(ep.path); break;
                case 'POST':   result = await post(ep.path, ep.body || {}); break;
                case 'DELETE': result = await del(ep.path); break;
                default:       result = await get(ep.path);
            }
            check(
                `${ep.method} ${ep.path} rejects unauthenticated (${ep.desc})`,
                result.status === 401,
                `status=${result.status}`
            );
        } catch (err) {
            check(`${ep.method} ${ep.path} (${ep.desc})`, false, err.message);
        }
    }

    // ── Phase 2: Token-based admin endpoints → 403 ──────────
    console.log('');
    console.log('Phase 2: Token-based admin endpoints (expect 403)');
    for (const ep of tokenAdminEndpoints) {
        try {
            let result;
            switch (ep.method) {
                case 'GET':    result = await get(ep.path); break;
                case 'POST':   result = await post(ep.path, ep.body || {}); break;
                case 'PUT':    result = await put(ep.path, ep.body || {}); break;
                case 'DELETE': result = await del(ep.path); break;
                default:       result = await get(ep.path);
            }
            check(
                `${ep.method} ${ep.path} rejects without token (${ep.desc})`,
                result.status === 403,
                `status=${result.status}`
            );
        } catch (err) {
            check(`${ep.method} ${ep.path} (${ep.desc})`, false, err.message);
        }
    }

    // ── Phase 3: Contribution review endpoints ──────────────
    console.log('');
    console.log('Phase 3: Contribution review endpoints (expect 401 or 403)');
    for (const ep of contributionEndpoints) {
        try {
            const result = await get(ep.path);
            const rejected = result.status === 401 || result.status === 403;
            check(
                `${ep.method} ${ep.path} rejects unauthenticated (${ep.desc})`,
                rejected,
                `status=${result.status}`
            );
        } catch (err) {
            check(`${ep.method} ${ep.path} (${ep.desc})`, false, err.message);
        }
    }

    // ── Phase 4: Error responses are JSON ───────────────────
    console.log('');
    console.log('Phase 4: Error responses are well-formed JSON');
    for (const ep of cookieAdminEndpoints.slice(0, 3)) {
        try {
            const res = await fetch(`${API_BASE}${ep.path}`);
            const contentType = res.headers.get('content-type') || '';
            check(
                `${ep.method} ${ep.path} error response is JSON`,
                contentType.includes('application/json'),
                `content-type=${contentType}`
            );
            const body = await res.json();
            const hasError = !!(body.error || body.message);
            check(
                `${ep.method} ${ep.path} includes error message`,
                hasError,
                `body keys: ${Object.keys(body).join(', ')}`
            );
        } catch (err) {
            check(`${ep.method} ${ep.path} JSON check`, false, err.message);
        }
    }

    // ── Phase 5: Fake auth cookie is rejected ───────────────
    console.log('');
    console.log('Phase 5: Fake JWT cookie is rejected');
    try {
        const res = await fetch(`${API_BASE}/api/admin/stats`, {
            headers: { 'Cookie': 'authToken=fake.jwt.token.here' },
        });
        let data;
        try { data = await res.json(); } catch { data = null; }
        check(
            'GET /api/admin/stats rejects fake JWT',
            res.status === 401 || res.status === 403,
            `status=${res.status}`
        );
    } catch (err) {
        check('Fake JWT rejection', false, err.message);
    }

    // ── Phase 6: Fake admin token is rejected ───────────────
    console.log('');
    console.log('Phase 6: Wrong admin token is rejected');
    try {
        const result = await fetchRaw(`${API_BASE}/api/admin/official-bot/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-admin-token': 'wrong-token-12345',
            },
            body: JSON.stringify({ botId: 'test', botType: 'free' }),
        });
        check(
            'POST /api/admin/official-bot/register rejects wrong token',
            result.status === 403,
            `status=${result.status}`
        );
    } catch (err) {
        check('Wrong admin token rejection', false, err.message);
    }

    // ── Phase 7: Transfer device requires valid credentials ─
    console.log('');
    console.log('Phase 7: Transfer device auth check');
    try {
        const result = await post('/api/admin/transfer-device', {
            sourceDeviceId: 'fake-device',
            sourceDeviceSecret: 'fake-secret',
            targetDeviceId: 'fake-target',
            targetDeviceSecret: 'fake-target-secret',
        });
        check(
            'POST /api/admin/transfer-device rejects invalid credentials',
            result.status === 401 || result.status === 403 || result.status === 400,
            `status=${result.status}`
        );
    } catch (err) {
        check('Transfer device auth', false, err.message);
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
