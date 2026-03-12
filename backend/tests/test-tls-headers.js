#!/usr/bin/env node
/**
 * TLS & Security Headers — Regression Test (#176)
 *
 * Tests that the live server returns proper security headers:
 *   1. Strict-Transport-Security header exists
 *   2. X-Content-Type-Options: nosniff
 *   3. X-Frame-Options: DENY
 *   4. Referrer-Policy: strict-origin-when-cross-origin
 *   5. /api/health responds with HTTP 200
 *
 * No credentials needed.
 *
 * Usage:
 *   node test-tls-headers.js
 *   node test-tls-headers.js --local
 */

const args = process.argv.slice(2);
const API_BASE = args.includes('--local') ? 'http://localhost:3000' : 'https://eclawbot.com';

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
    console.log('  TLS & Security Headers — Regression Test (#176)');
    console.log('='.repeat(65));
    console.log(`  API: ${API_BASE}`);
    console.log('');

    // ── Phase 1: Health check ───────────────────────────────
    console.log('Phase 1: Health check');
    try {
        const res = await fetch(`${API_BASE}/api/health`);
        check('/api/health returns 200', res.status === 200, `status=${res.status}`);
    } catch (err) {
        check('/api/health returns 200', false, err.message);
    }

    // ── Phase 2: Security headers ───────────────────────────
    console.log('');
    console.log('Phase 2: Security headers');
    try {
        const res = await fetch(`${API_BASE}/api/health`);
        const headers = res.headers;

        // Strict-Transport-Security
        const hsts = headers.get('strict-transport-security');
        check('Strict-Transport-Security header exists', !!hsts, hsts || 'missing');

        // X-Content-Type-Options
        const xcto = headers.get('x-content-type-options');
        check('X-Content-Type-Options is nosniff', xcto === 'nosniff', xcto || 'missing');

        // X-Frame-Options
        const xfo = headers.get('x-frame-options');
        check('X-Frame-Options is DENY', xfo === 'DENY', xfo || 'missing');

        // Referrer-Policy
        const rp = headers.get('referrer-policy');
        check('Referrer-Policy is strict-origin-when-cross-origin',
            rp === 'strict-origin-when-cross-origin', rp || 'missing');
    } catch (err) {
        check('Security headers fetch', false, err.message);
    }

    // ── Phase 3: Headers on a different endpoint ────────────
    console.log('');
    console.log('Phase 3: Headers consistency on root');
    try {
        const res = await fetch(`${API_BASE}/`);
        const headers = res.headers;

        const xcto = headers.get('x-content-type-options');
        check('Root endpoint also has X-Content-Type-Options', xcto === 'nosniff', xcto || 'missing');

        const xfo = headers.get('x-frame-options');
        check('Root endpoint also has X-Frame-Options', xfo === 'DENY', xfo || 'missing');
    } catch (err) {
        check('Root endpoint headers fetch', false, err.message);
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
