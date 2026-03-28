#!/usr/bin/env node
/**
 * UX Live Validation — Layer 3
 * Hits the live server to validate portal pages and API endpoints.
 *
 *   1. Portal page reachability (14 pages → HTTP 200, text/html)
 *   2. Security headers on portal responses
 *   3. Auth protection (unauthenticated API → 401/403)
 *   4. Authenticated API smoke test (JSON schema basics)
 *   5. Static asset resolution (shared JS files referenced by portal)
 *
 * Credentials: BROADCAST_TEST_DEVICE_ID + BROADCAST_TEST_DEVICE_SECRET (optional)
 *   Without credentials, auth-dependent checks are skipped.
 *
 * Usage:
 *   node backend/tests/test-ux-live-validation.js
 *   node backend/tests/test-ux-live-validation.js --local
 */

const path = require('path');
const fs = require('fs');

// ── Load .env ────────────────────────────────────────────────
const envPath = path.resolve(__dirname, '../.env');
if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    for (const line of envContent.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx);
            const val = trimmed.slice(eqIdx + 1);
            if (!process.env[key]) process.env[key] = val;
        }
    }
}

// ── Config ───────────────────────────────────────────────────
const args = process.argv.slice(2);
const API_BASE = args.includes('--local') ? 'http://localhost:3000' : 'https://eclawbot.com';

const DEVICE_ID = process.env.BROADCAST_TEST_DEVICE_ID;
const DEVICE_SECRET = process.env.BROADCAST_TEST_DEVICE_SECRET;
const HAS_CREDS = !!(DEVICE_ID && DEVICE_SECRET);

const PORTAL_PAGES = [
    'index.html',
    'dashboard.html',
    'chat.html',
    'kanban.html',
    'settings.html',
    'env-vars.html',
    'files.html',
    'feedback.html',
    'admin.html',
    'card-holder.html',
    'info.html',
    'delete-account.html',
    'screen-control.html',
];

const SHARED_ASSETS = [
    'shared/api.js',
    'shared/auth.js',
    'shared/telemetry.js',
    'shared/i18n.js',
];

// API endpoints that MUST reject unauthenticated requests
const AUTH_PROTECTED_ENDPOINTS = [
    { method: 'GET',  path: '/api/entities?deviceId=FAKE_ID&deviceSecret=WRONG' },
    { method: 'GET',  path: '/api/chat/history?deviceId=FAKE_ID&deviceSecret=WRONG&entityId=0' },
    { method: 'GET',  path: '/api/feedback?deviceId=FAKE_ID&deviceSecret=WRONG' },
    { method: 'GET',  path: '/api/schedules?deviceId=FAKE_ID&deviceSecret=WRONG' },
    { method: 'GET',  path: '/api/device-vars?deviceId=FAKE_ID&deviceSecret=WRONG' },
    { method: 'GET',  path: '/api/contacts?deviceId=FAKE_ID&deviceSecret=WRONG' },
    { method: 'GET',  path: '/api/logs?deviceId=FAKE_ID&deviceSecret=WRONG' },
];

// Authenticated endpoints with expected response shape
const AUTHED_SMOKE_ENDPOINTS = [
    {
        method: 'GET',
        path: () => `/api/entities?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`,
        expectStatus: 200,
        expectShape: { isArray: true },
        label: 'GET /api/entities',
    },
    {
        method: 'GET',
        path: () => `/api/status?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`,
        expectStatus: 200,
        expectShape: { hasKey: 'entities' },
        label: 'GET /api/status',
    },
    {
        method: 'GET',
        path: () => `/api/feedback?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`,
        expectStatus: 200,
        expectShape: { isArray: true },
        label: 'GET /api/feedback',
    },
    {
        method: 'GET',
        path: () => `/api/schedules?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`,
        expectStatus: 200,
        expectShape: { isArray: true },
        label: 'GET /api/schedules',
    },
    {
        method: 'GET',
        path: () => `/api/contacts?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`,
        expectStatus: 200,
        expectShape: { isArray: true },
        label: 'GET /api/contacts',
    },
    {
        method: 'GET',
        path: () => `/api/device-vars?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`,
        expectStatus: 200,
        expectShape: { isArray: true },
        label: 'GET /api/device-vars',
    },
    {
        method: 'GET',
        path: () => `/api/device-preferences?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`,
        expectStatus: 200,
        expectShape: { isObject: true },
        label: 'GET /api/device-preferences',
    },
    {
        method: 'GET',
        path: () => `/api/mission/dashboard?deviceId=${DEVICE_ID}&deviceSecret=${DEVICE_SECRET}`,
        expectStatus: 200,
        expectShape: { isObject: true },
        label: 'GET /api/mission/dashboard',
    },
];

// Public endpoints (no auth needed)
const PUBLIC_ENDPOINTS = [
    { method: 'GET', path: '/api/health',   expectStatus: 200, label: 'GET /api/health' },
    { method: 'GET', path: '/api/version',  expectStatus: 200, label: 'GET /api/version' },
    { method: 'GET', path: '/api/docs',     expectStatus: [200, 301, 302], label: 'GET /api/docs' },
    { method: 'GET', path: '/api/auth/oauth/providers', expectStatus: 200, label: 'GET /api/auth/oauth/providers' },
    { method: 'GET', path: '/api/skill-templates', expectStatus: 200, label: 'GET /api/skill-templates' },
    { method: 'GET', path: '/api/soul-templates',  expectStatus: 200, label: 'GET /api/soul-templates' },
    { method: 'GET', path: '/api/rule-templates',  expectStatus: 200, label: 'GET /api/rule-templates' },
    { method: 'GET', path: '/.well-known/agent.json', expectStatus: 200, label: 'GET /.well-known/agent.json' },
];

// ── Result Tracking ─────────────────────────────────────────
const results = [];
function check(name, passed, detail = '') {
    results.push({ name, passed, detail });
    const icon = passed ? '\u2705' : '\u274C';
    const suffix = detail ? ` \u2014 ${detail}` : '';
    console.log(`  ${icon} ${name}${suffix}`);
}

function warn(name, detail = '') {
    results.push({ name, passed: 'warn', detail });
    console.log(`  \u26A0\uFE0F  ${name} \u2014 ${detail}`);
}

// ── HTTP Helper ─────────────────────────────────────────────
async function httpGet(urlPath, opts = {}) {
    const url = `${API_BASE}${urlPath}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
        const res = await fetch(url, {
            method: opts.method || 'GET',
            headers: opts.headers || {},
            redirect: opts.redirect || 'follow',
            signal: controller.signal,
        });
        clearTimeout(timeout);
        return res;
    } catch (err) {
        clearTimeout(timeout);
        throw err;
    }
}

// ── Main ────────────────────────────────────────────────────
async function main() {
    console.log('\n\u{1F310} UX Live Validation \u2014 Layer 3\n');
    console.log(`  Server: ${API_BASE}`);
    console.log(`  Credentials: ${HAS_CREDS ? 'available' : 'not set (auth tests skipped)'}`);
    console.log('');

    // ── Phase 1: Portal Page Reachability ───────────────────
    console.log('\u2500\u2500 Phase 1: Portal Page Reachability \u2500\u2500\n');

    for (const page of PORTAL_PAGES) {
        try {
            const res = await httpGet(`/portal/${page}`);
            const ct = res.headers.get('content-type') || '';
            const isHtml = ct.includes('text/html');
            const ok = res.status === 200 && isHtml;
            check(`Portal ${page}`, ok,
                `status=${res.status}, content-type=${ct.split(';')[0]}`);
        } catch (err) {
            check(`Portal ${page}`, false, err.message);
        }
    }

    // ── Phase 2: Security Headers ───────────────────────────
    console.log('\n\u2500\u2500 Phase 2: Security Headers on Portal \u2500\u2500\n');

    try {
        const res = await httpGet('/portal/dashboard.html');
        const headers = res.headers;

        const hsts = headers.get('strict-transport-security');
        check('HSTS header present', !!hsts, hsts || 'missing');

        const xcto = headers.get('x-content-type-options');
        check('X-Content-Type-Options: nosniff', xcto === 'nosniff', xcto || 'missing');

        const xfo = headers.get('x-frame-options');
        check('X-Frame-Options: DENY', xfo === 'DENY', xfo || 'missing');

        const rp = headers.get('referrer-policy');
        check('Referrer-Policy present', !!rp, rp || 'missing');
    } catch (err) {
        check('Security headers check', false, err.message);
    }

    // ── Phase 3: Static Asset Resolution ────────────────────
    console.log('\n\u2500\u2500 Phase 3: Static Asset Resolution \u2500\u2500\n');

    for (const asset of SHARED_ASSETS) {
        try {
            const res = await httpGet(`/portal/${asset}`);
            const ct = res.headers.get('content-type') || '';
            const isJs = ct.includes('javascript') || ct.includes('text/plain');
            const ok = res.status === 200;
            check(`Asset ${asset}`, ok,
                `status=${res.status}${ok && !isJs ? ', unexpected content-type: ' + ct : ''}`);
        } catch (err) {
            check(`Asset ${asset}`, false, err.message);
        }
    }

    // Also check robots.txt and sitemap.xml (SEO assets)
    for (const seoFile of ['robots.txt', 'sitemap.xml']) {
        try {
            const res = await httpGet(`/${seoFile}`);
            check(`SEO ${seoFile}`, res.status === 200, `status=${res.status}`);
        } catch (err) {
            check(`SEO ${seoFile}`, false, err.message);
        }
    }

    // ── Phase 4: Public API Endpoints ───────────────────────
    console.log('\n\u2500\u2500 Phase 4: Public API Endpoints \u2500\u2500\n');

    for (const ep of PUBLIC_ENDPOINTS) {
        try {
            const res = await httpGet(ep.path);
            const statusOk = Array.isArray(ep.expectStatus)
                ? ep.expectStatus.includes(res.status)
                : res.status === ep.expectStatus;
            check(ep.label, statusOk, `status=${res.status}`);
        } catch (err) {
            check(ep.label, false, err.message);
        }
    }

    // ── Phase 5: Auth Protection ────────────────────────────
    console.log('\n\u2500\u2500 Phase 5: Auth Protection (bad credentials \u2192 reject) \u2500\u2500\n');

    for (const ep of AUTH_PROTECTED_ENDPOINTS) {
        try {
            const res = await httpGet(ep.path);
            // Accept any 4xx as "protected"
            const rejected = res.status >= 400 && res.status < 500;
            check(`Auth-protect ${ep.method} ${ep.path.split('?')[0]}`, rejected,
                `status=${res.status}${rejected ? '' : ' (expected 4xx)'}`);
        } catch (err) {
            check(`Auth-protect ${ep.path.split('?')[0]}`, false, err.message);
        }
    }

    // ── Phase 6: Authenticated Smoke Tests ──────────────────
    if (HAS_CREDS) {
        console.log('\n\u2500\u2500 Phase 6: Authenticated API Smoke Tests \u2500\u2500\n');

        for (const ep of AUTHED_SMOKE_ENDPOINTS) {
            try {
                const urlPath = typeof ep.path === 'function' ? ep.path() : ep.path;
                const res = await httpGet(urlPath);
                const statusOk = res.status === ep.expectStatus;

                if (!statusOk) {
                    check(ep.label, false, `status=${res.status}, expected ${ep.expectStatus}`);
                    continue;
                }

                // Parse JSON and validate shape
                const body = await res.json();
                let shapeOk = true;
                let shapeDetail = '';

                if (ep.expectShape) {
                    if (ep.expectShape.isArray) {
                        shapeOk = Array.isArray(body);
                        shapeDetail = shapeOk ? `array[${body.length}]` : `expected array, got ${typeof body}`;
                    } else if (ep.expectShape.hasKey) {
                        shapeOk = body !== null && typeof body === 'object' && ep.expectShape.hasKey in body;
                        shapeDetail = shapeOk
                            ? `has .${ep.expectShape.hasKey}`
                            : `missing .${ep.expectShape.hasKey}`;
                    } else if (ep.expectShape.isObject) {
                        shapeOk = body !== null && typeof body === 'object' && !Array.isArray(body);
                        shapeDetail = shapeOk ? 'object' : `expected object, got ${Array.isArray(body) ? 'array' : typeof body}`;
                    }
                }

                check(ep.label, statusOk && shapeOk,
                    `status=${res.status}, ${shapeDetail}`);
            } catch (err) {
                check(ep.label, false, err.message);
            }
        }
    } else {
        console.log('\n\u2500\u2500 Phase 6: Authenticated API Smoke Tests (SKIPPED) \u2500\u2500\n');
        warn('Auth smoke tests skipped', 'set BROADCAST_TEST_DEVICE_ID + BROADCAST_TEST_DEVICE_SECRET');
    }

    // ── Summary ─────────────────────────────────────────────
    const passed = results.filter(r => r.passed === true).length;
    const warned = results.filter(r => r.passed === 'warn').length;
    const failed = results.filter(r => r.passed === false).length;

    console.log('\n' + '\u2550'.repeat(60));
    console.log(`\n  \u2705 Passed: ${passed}   \u26A0\uFE0F  Warned: ${warned}   \u274C Failed: ${failed}\n`);

    if (failed > 0) {
        console.log('  Failed checks:');
        results.filter(r => r.passed === false).forEach(r => {
            console.log(`    \u274C ${r.name}${r.detail ? ` \u2014 ${r.detail}` : ''}`);
        });
        console.log('');
    }

    // Report-only: exit 0
    console.log(`  ${passed + warned + failed} total, ${passed} passed, ${failed} failed`);
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
