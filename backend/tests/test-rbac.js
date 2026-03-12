#!/usr/bin/env node
/**
 * RBAC Endpoints — Regression Test (#178)
 *
 * Tests Role-Based Access Control endpoints:
 *   1. GET /api/auth/roles without auth → 401
 *   2. GET /api/auth/user-roles without auth → 401
 *   3. POST /api/auth/user-roles without auth → 401
 *
 * These are admin-only endpoints, so we verify they exist and
 * return proper 401 error codes without cookie auth.
 *
 * No credentials needed.
 *
 * Usage:
 *   node test-rbac.js
 *   node test-rbac.js --local
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

async function putJSON(url, body) {
    const res = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    let data;
    try { data = await res.json(); } catch { data = null; }
    return { status: res.status, data };
}

async function deleteRaw(url) {
    const res = await fetch(url, { method: 'DELETE' });
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
    console.log('  RBAC Endpoints — Regression Test (#178)');
    console.log('='.repeat(65));
    console.log(`  API: ${API_BASE}`);
    console.log('');

    // ── Phase 1: GET /api/auth/roles without auth ───────────
    console.log('Phase 1: GET /api/auth/roles without auth');
    try {
        const { status, data } = await fetchRaw(`${API_BASE}/api/auth/roles`);
        check('GET /api/auth/roles returns 401', status === 401,
            `status=${status}`);

        if (data) {
            const hasError = data.error || data.message;
            check('Response includes error message', !!hasError,
                `error=${data.error || data.message || 'none'}`);
        }
    } catch (err) {
        check('GET /api/auth/roles', false, err.message);
    }

    // ── Phase 2: GET /api/auth/user-roles without auth ──────
    console.log('');
    console.log('Phase 2: GET /api/auth/user-roles without auth');
    try {
        const { status, data } = await fetchRaw(`${API_BASE}/api/auth/user-roles`);
        check('GET /api/auth/user-roles returns 401', status === 401,
            `status=${status}`);

        if (data) {
            const hasError = data.error || data.message;
            check('Response includes error message', !!hasError,
                `error=${data.error || data.message || 'none'}`);
        }
    } catch (err) {
        check('GET /api/auth/user-roles', false, err.message);
    }

    // ── Phase 3: POST /api/auth/user-roles without auth ─────
    console.log('');
    console.log('Phase 3: POST /api/auth/user-roles without auth');
    try {
        const { status, data } = await postJSON(`${API_BASE}/api/auth/user-roles`, {
            userId: 'test-user',
            role: 'admin',
        });
        check('POST /api/auth/user-roles returns 401', status === 401,
            `status=${status}`);

        if (data) {
            const hasError = data.error || data.message;
            check('Response includes error message', !!hasError,
                `error=${data.error || data.message || 'none'}`);
        }
    } catch (err) {
        check('POST /api/auth/user-roles', false, err.message);
    }

    // ── Phase 4: PUT /api/auth/user-roles without auth ──────
    console.log('');
    console.log('Phase 4: PUT /api/auth/user-roles without auth');
    try {
        const { status } = await putJSON(`${API_BASE}/api/auth/user-roles`, {
            userId: 'test-user',
            role: 'editor',
        });
        check('PUT /api/auth/user-roles returns 401', status === 401,
            `status=${status}`);
    } catch (err) {
        check('PUT /api/auth/user-roles', false, err.message);
    }

    // ── Phase 5: DELETE /api/auth/user-roles without auth ───
    console.log('');
    console.log('Phase 5: DELETE /api/auth/user-roles without auth');
    try {
        const { status } = await deleteRaw(`${API_BASE}/api/auth/user-roles?userId=test-user&role=admin`);
        check('DELETE /api/auth/user-roles returns 401', status === 401,
            `status=${status}`);
    } catch (err) {
        check('DELETE /api/auth/user-roles', false, err.message);
    }

    // ── Phase 6: Endpoints return JSON, not HTML ────────────
    console.log('');
    console.log('Phase 6: Error responses are JSON');
    try {
        const res = await fetch(`${API_BASE}/api/auth/roles`);
        const contentType = res.headers.get('content-type') || '';
        check('Error response Content-Type is JSON', contentType.includes('application/json'),
            `content-type=${contentType}`);
    } catch (err) {
        check('Error response Content-Type check', false, err.message);
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
