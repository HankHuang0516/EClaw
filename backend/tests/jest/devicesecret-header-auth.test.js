/**
 * Secret-leakage hardening — header-based credential auth (Jest).
 *
 * Background: deviceSecret / botSecret used to be required in the GET URL query
 * string, which leaks them into browser history, server/Cloudflare access logs
 * and the Referer header. Stage 1 made the affected endpoints ADDITIVELY accept
 * the secret via request headers (X-Device-Secret / X-Bot-Secret, and an
 * Authorization: Bearer token), via the shared extract-creds.js helper.
 *
 * These tests assert, against a REAL affected endpoint (GET /api/refs):
 *   - auth SUCCEEDS when the secret arrives ONLY via the new header
 *     (the URL query carries no secret — the path that previously 401'd),
 *   - auth still SUCCEEDS via the legacy query param (back-compat),
 *   - auth is REJECTED when no secret is supplied anywhere.
 * Plus focused unit tests of the extract-creds helper itself.
 *
 * No real secret values are used — only test fixtures.
 */

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

const createRefsModule = require('../../api_refs');
const extractCreds = require('../../extract-creds');
const express = require('express');
const http = require('http');

const FROM = 'card_aa15ed2618c9246d11a0f6b1';

function makeDevices() {
    return {
        'dev-A': {
            deviceSecret: 'sec-A',
            entities: {
                2: { botSecret: 'bot-A2' },
                3: { botSecret: 'bot-A3' },
            },
        },
    };
}

function spinUp() {
    const devices = makeDevices();
    const prevEnabled = process.env.ECLAW_REFS_INDEX_ENABLED;
    process.env.ECLAW_REFS_INDEX_ENABLED = '1';
    const mod = createRefsModule(devices);
    process.env.ECLAW_REFS_INDEX_ENABLED = prevEnabled;
    mod._internals.stopScanLoop();
    const app = express();
    app.use('/api', mod.router);
    return { app, devices, mod };
}

// GET helper that supports custom request headers.
function request(app, urlPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const port = server.address().port;
            http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
                let body = '';
                res.on('data', (c) => (body += c));
                res.on('end', () => {
                    server.close();
                    try {
                        resolve({ status: res.statusCode, json: body ? JSON.parse(body) : null });
                    } catch (e) { reject(e); }
                });
            }).on('error', reject);
        });
    });
}

describe('header-auth: deviceSecret/botSecret via headers (no secret in URL)', () => {
    test('NEW: deviceSecret via X-Device-Secret header (no secret in query) → 200', async () => {
        const { app } = spinUp();
        // The URL carries only the non-secret deviceId; the secret is a header.
        const r = await request(app, `/api/refs?from=${FROM}&deviceId=dev-A`, {
            'X-Device-Secret': 'sec-A',
        });
        expect(r.status).toBe(200);
        expect(r.json.success).toBe(true);
    });

    test('NEW: botSecret via X-Bot-Secret header + entityId in query → 200', async () => {
        const { app } = spinUp();
        const r = await request(app, `/api/refs?from=${FROM}&deviceId=dev-A&entityId=2`, {
            'X-Bot-Secret': 'bot-A2',
        });
        expect(r.status).toBe(200);
        expect(r.json.success).toBe(true);
    });

    test('NEW: Authorization Bearer <deviceSecret> → 200', async () => {
        const { app } = spinUp();
        const r = await request(app, `/api/refs?from=${FROM}&deviceId=dev-A`, {
            Authorization: 'Bearer sec-A',
        });
        expect(r.status).toBe(200);
        expect(r.json.success).toBe(true);
    });

    test('NEW: wrong deviceSecret via header → 401', async () => {
        const { app } = spinUp();
        const r = await request(app, `/api/refs?from=${FROM}&deviceId=dev-A`, {
            'X-Device-Secret': 'wrong',
        });
        expect(r.status).toBe(401);
    });
});

describe('back-compat: legacy query-param secret still works', () => {
    test('deviceSecret via query → 200', async () => {
        const { app } = spinUp();
        const r = await request(app, `/api/refs?from=${FROM}&deviceId=dev-A&deviceSecret=sec-A`);
        expect(r.status).toBe(200);
        expect(r.json.success).toBe(true);
    });
});

describe('rejection: no secret supplied anywhere', () => {
    test('deviceId only, no secret in query OR header → 401', async () => {
        const { app } = spinUp();
        const r = await request(app, `/api/refs?from=${FROM}&deviceId=dev-A`);
        expect(r.status).toBe(401);
    });
});

describe('extractCreds helper (unit)', () => {
    test('reads secrets from X-* headers when query/body absent', () => {
        const req = {
            query: { deviceId: 'dev-A', entityId: '2' },
            body: {},
            headers: { 'x-device-secret': 'sec-A', 'x-bot-secret': 'bot-A2' },
        };
        const c = extractCreds(req);
        expect(c.deviceId).toBe('dev-A');
        expect(c.deviceSecret).toBe('sec-A');
        expect(c.botSecret).toBe('bot-A2');
        expect(c.entityId).toBe('2');
    });

    test('query/body still take precedence over headers (additive, non-breaking)', () => {
        const req = {
            query: { deviceSecret: 'from-query' },
            body: {},
            headers: { 'x-device-secret': 'from-header' },
        };
        expect(extractCreds(req).deviceSecret).toBe('from-query');
    });

    test('Authorization Bearer surfaces as both device- and bot-secret candidate', () => {
        const req = { query: {}, body: {}, headers: { authorization: 'Bearer tok-X' } };
        const c = extractCreds(req);
        expect(c.deviceSecret).toBe('tok-X');
        expect(c.botSecret).toBe('tok-X');
    });

    test('returns undefined secrets when nothing supplied', () => {
        const c = extractCreds({ query: {}, body: {}, headers: {} });
        expect(c.deviceSecret).toBeUndefined();
        expect(c.botSecret).toBeUndefined();
    });
});
