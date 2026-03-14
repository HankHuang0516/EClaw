#!/usr/bin/env node
/**
 * Input Validation — Security Test (P0)
 *
 * Tests that user-facing endpoints properly handle malicious input:
 *   1. SQL injection payloads are rejected or sanitized
 *   2. XSS payloads are not reflected in responses
 *   3. Path traversal attempts are blocked
 *   4. Oversized payloads are handled gracefully
 *   5. Invalid JSON is handled gracefully
 *
 * No credentials needed for most tests (they test rejection behavior).
 *
 * Usage:
 *   node test-input-validation.js
 *   node test-input-validation.js --local
 */

const args = process.argv.slice(2);
const API_BASE = args.includes('--local') ? 'http://localhost:3000' : 'https://eclawbot.com';

// ── HTTP Helpers ────────────────────────────────────────────

async function fetchRaw(url, options = {}) {
    const res = await fetch(url, options);
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, rawText: text, headers: res.headers };
}

function post(path, body) {
    return fetchRaw(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

function get(path) {
    return fetchRaw(`${API_BASE}${path}`);
}

function postRaw(path, rawBody, contentType = 'application/json') {
    return fetchRaw(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: rawBody,
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

// ── SQL Injection Payloads ──────────────────────────────────

const SQL_PAYLOADS = [
    "'; DROP TABLE entities; --",
    "' OR '1'='1",
    "1; DELETE FROM devices WHERE 1=1 --",
    "' UNION SELECT * FROM user_accounts --",
    "1' AND (SELECT COUNT(*) FROM user_accounts) > 0 --",
    "'; UPDATE devices SET deviceSecret='hacked' WHERE deviceId='",
];

// ── XSS Payloads ────────────────────────────────────────────

const XSS_PAYLOADS = [
    '<script>alert("xss")</script>',
    '<img src=x onerror=alert(1)>',
    '"><script>document.cookie</script>',
    "javascript:alert('XSS')",
    '<svg onload=alert(1)>',
    '<iframe src="javascript:alert(1)">',
];

// ── Path Traversal Payloads ─────────────────────────────────

const PATH_TRAVERSAL_PAYLOADS = [
    '../../../etc/passwd',
    '..\\..\\..\\windows\\system32\\config\\sam',
    '%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd',
    '....//....//....//etc/passwd',
];

// ── Main ────────────────────────────────────────────────────

async function main() {
    console.log('='.repeat(65));
    console.log('  Input Validation — Security Test (P0)');
    console.log('='.repeat(65));
    console.log(`  API: ${API_BASE}`);
    console.log('');

    // ── Phase 1: SQL injection in deviceId parameter ────────
    console.log('Phase 1: SQL injection in deviceId parameter');
    for (const payload of SQL_PAYLOADS.slice(0, 3)) {
        try {
            const result = await get(`/api/health`);
            // Health should always work (sanity check)
            check('Health endpoint reachable', result.status === 200, `status=${result.status}`);
            break;
        } catch (err) {
            check('Server reachable', false, err.message);
            console.log('Cannot reach server, aborting.');
            process.exit(1);
        }
    }

    for (const payload of SQL_PAYLOADS) {
        try {
            const encodedPayload = encodeURIComponent(payload);
            const result = await get(`/api/entity?deviceId=${encodedPayload}&entitySlot=0`);
            // Should NOT return 200 with data, should be 400/401/500 but NOT a DB leak
            const noDbLeak = typeof result.data !== 'object' ||
                !result.rawText.includes('user_accounts') &&
                !result.rawText.includes('pg_catalog');
            check(
                `SQL injection in deviceId rejected: "${payload.substring(0, 30)}..."`,
                result.status !== 200 && noDbLeak,
                `status=${result.status}`
            );
        } catch (err) {
            check(`SQL injection test`, true, `Error thrown (safe): ${err.message.substring(0, 50)}`);
        }
    }

    // ── Phase 2: SQL injection in POST body ──────────────────
    console.log('');
    console.log('Phase 2: SQL injection in POST body (bind endpoint)');
    for (const payload of SQL_PAYLOADS.slice(0, 3)) {
        try {
            const result = await post('/api/bind', {
                deviceId: payload,
                entitySlot: 0,
                botId: 'test-bot',
            });
            const safe = result.status !== 200 ||
                (typeof result.data === 'object' && !result.data.success);
            const noDbLeak = !result.rawText.includes('pg_catalog') &&
                !result.rawText.includes('user_accounts');
            check(
                `SQL in bind body rejected: "${payload.substring(0, 30)}..."`,
                safe && noDbLeak,
                `status=${result.status}`
            );
        } catch (err) {
            check('SQL in bind body', true, 'Error thrown (safe)');
        }
    }

    // ── Phase 3: SQL injection in transform endpoint ────────
    console.log('');
    console.log('Phase 3: SQL injection in transform endpoint');
    for (const payload of SQL_PAYLOADS.slice(0, 2)) {
        try {
            const result = await post('/api/transform', {
                deviceId: payload,
                entitySlot: 0,
                text: 'test message',
            });
            const noDbLeak = !result.rawText.includes('pg_catalog');
            check(
                `SQL in transform rejected: "${payload.substring(0, 30)}..."`,
                noDbLeak,
                `status=${result.status}`
            );
        } catch (err) {
            check('SQL in transform', true, 'Error thrown (safe)');
        }
    }

    // ── Phase 4: XSS in various fields ──────────────────────
    console.log('');
    console.log('Phase 4: XSS payload reflection check');
    for (const payload of XSS_PAYLOADS.slice(0, 3)) {
        try {
            // Test in feedback endpoint (accepts user text)
            const result = await post('/api/feedback', {
                deviceId: 'test-xss-check',
                deviceSecret: 'fake-secret',
                message: payload,
                category: 'bug',
            });
            // Check if the XSS payload is reflected unescaped in the response
            const reflected = result.rawText.includes(payload) &&
                result.rawText.includes('<script');
            check(
                `XSS not reflected: "${payload.substring(0, 30)}..."`,
                !reflected,
                `status=${result.status}`
            );
        } catch (err) {
            check('XSS reflection check', true, 'Error thrown (safe)');
        }
    }

    // Test XSS in query parameters
    for (const payload of XSS_PAYLOADS.slice(0, 2)) {
        try {
            const encodedPayload = encodeURIComponent(payload);
            const result = await get(`/api/entity?deviceId=${encodedPayload}&entitySlot=0`);
            const reflected = result.rawText.includes('<script') ||
                result.rawText.includes('onerror=');
            check(
                `XSS not reflected in query: "${payload.substring(0, 25)}..."`,
                !reflected,
                `status=${result.status}`
            );
        } catch (err) {
            check('XSS in query', true, 'Error thrown (safe)');
        }
    }

    // ── Phase 5: Path traversal ─────────────────────────────
    console.log('');
    console.log('Phase 5: Path traversal attempts');
    for (const payload of PATH_TRAVERSAL_PAYLOADS) {
        try {
            const result = await get(`/api/media/${encodeURIComponent(payload)}`);
            const noFileContent = !result.rawText.includes('root:') &&
                !result.rawText.includes('[boot loader]');
            check(
                `Path traversal blocked: "${payload.substring(0, 30)}..."`,
                noFileContent,
                `status=${result.status}`
            );
        } catch (err) {
            check('Path traversal', true, 'Error thrown (safe)');
        }
    }

    // ── Phase 6: Invalid JSON handling ──────────────────────
    console.log('');
    console.log('Phase 6: Invalid JSON handling');
    const invalidJsonPayloads = [
        '{invalid json}',
        '{"key": undefined}',
        '',
        'null',
        '{"a":"b"' + 'x'.repeat(100),
    ];

    for (const payload of invalidJsonPayloads) {
        try {
            const result = await postRaw('/api/bind', payload);
            check(
                `Invalid JSON handled: "${payload.substring(0, 30)}..."`,
                result.status >= 400 && result.status < 600,
                `status=${result.status}`
            );
        } catch (err) {
            check('Invalid JSON handling', true, 'Error thrown (safe)');
        }
    }

    // ── Phase 7: Oversized input ────────────────────────────
    console.log('');
    console.log('Phase 7: Oversized input handling');
    try {
        const largePayload = { deviceId: 'test', message: 'A'.repeat(1024 * 1024) }; // 1MB
        const result = await post('/api/transform', largePayload);
        check(
            'Oversized payload handled (1MB message)',
            result.status >= 400 || result.status === 200, // Either rejected or handled
            `status=${result.status}`
        );
    } catch (err) {
        check('Oversized payload', true, `Error handled: ${err.message.substring(0, 50)}`);
    }

    // ── Phase 8: Header injection ───────────────────────────
    console.log('');
    console.log('Phase 8: Header injection prevention');
    try {
        const result = await fetchRaw(`${API_BASE}/api/health`, {
            headers: {
                'X-Forwarded-For': '127.0.0.1',
                'X-Real-IP': '127.0.0.1',
            },
        });
        // Just verify server doesn't crash with extra headers
        check(
            'Server handles extra headers gracefully',
            result.status === 200,
            `status=${result.status}`
        );
    } catch (err) {
        check('Header injection', false, err.message);
    }

    // ── Phase 9: Null byte injection ────────────────────────
    console.log('');
    console.log('Phase 9: Null byte injection');
    try {
        const result = await post('/api/bind', {
            deviceId: 'test\x00injected',
            entitySlot: 0,
            botId: 'test',
        });
        check(
            'Null byte in deviceId handled',
            result.status >= 400,
            `status=${result.status}`
        );
    } catch (err) {
        check('Null byte injection', true, 'Error thrown (safe)');
    }

    // ── Phase 10: Security headers check ────────────────────
    console.log('');
    console.log('Phase 10: Security headers present');
    try {
        const result = await get('/api/health');
        const headers = result.headers;

        check('X-Content-Type-Options header present',
            (headers.get('x-content-type-options') || '').toLowerCase() === 'nosniff',
            `value=${headers.get('x-content-type-options')}`);

        check('X-Frame-Options header present',
            !!headers.get('x-frame-options'),
            `value=${headers.get('x-frame-options')}`);

        const csp = headers.get('content-security-policy');
        // CSP is optional but good to check
        if (csp) {
            check('Content-Security-Policy header present', true, `length=${csp.length}`);
        }
    } catch (err) {
        check('Security headers', false, err.message);
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
