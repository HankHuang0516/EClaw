/**
 * api_refs.js auth + scan tests (Jest).
 *
 * Verifies the auth helper accepts the EClaw-shaped credentials (per #6's
 * NACK on PR #3132): `devices[deviceId].deviceSecret` for portal callers and
 * `devices[deviceId].entities[entityId].botSecret` for bot callers, and
 * rejects mismatched/missing credentials.
 *
 * Also exercises the pure scan-text helper so the regex set is regression-
 * checked separately from the DB path.
 */

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

const createRefsModule = require('../../api_refs');
const { scanText, normalizeFromId, cacheKey, keyOf } = require('../../api_refs')._private;
const express = require('express');
const http = require('http');

function makeDevices() {
    return {
        'dev-A': {
            deviceSecret: 'sec-A',
            entities: {
                2: { botSecret: 'bot-A2' },
                3: { botSecret: 'bot-A3' },
            },
        },
        'dev-B': {
            deviceSecret: 'sec-B',
            entities: {
                2: { botSecret: 'bot-B2' },
            },
        },
    };
}

function spinUp() {
    const devices = makeDevices();
    // Force enable so the endpoint actually exercises auth (and skip the timer).
    const prevEnabled = process.env.ECLAW_REFS_INDEX_ENABLED;
    process.env.ECLAW_REFS_INDEX_ENABLED = '1';
    const mod = createRefsModule(devices);
    process.env.ECLAW_REFS_INDEX_ENABLED = prevEnabled;
    mod._internals.stopScanLoop(); // don't keep the scan timer alive in tests

    const app = express();
    app.use('/api', mod.router);
    return { app, devices, mod };
}

function request(app, urlPath) {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, () => {
            const port = server.address().port;
            http.get(`http://127.0.0.1:${port}${urlPath}`, (res) => {
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

describe('api_refs scanText regex set (spec §3.2 patterns)', () => {
    test('extracts card ids, spec/doc paths, and PR numbers', () => {
        const out = scanText(
            'see card_aa15ed2618c9246d11a0f6b1 + ' +
            'docs/specs/portal-bidirectional-refs.md + ' +
            'docs/research/2026-06-03-mobile-use-comparison.md + ' +
            'PR #3124, also CARD_AA15ED2618C9246D11A0F6B1 (case-insensitive)'
        );
        const kinds = out.map(r => r.kind);
        expect(kinds).toContain('card');
        expect(kinds).toContain('spec');
        expect(kinds).toContain('doc');
        expect(kinds).toContain('pr');
        // card_ matches are deduped by lowercased id
        expect(out.filter(r => r.kind === 'card').length).toBe(1);
        expect(out.find(r => r.kind === 'pr').id).toBe('3124');
    });

    test('returns empty array on null/empty text', () => {
        expect(scanText('')).toEqual([]);
        expect(scanText(null)).toEqual([]);
        expect(scanText(undefined)).toEqual([]);
    });
});

describe('api_refs normalizeFromId', () => {
    test.each([
        ['card_aa15ed2618c9246d11a0f6b1', { kind: 'card', id: 'card_aa15ed2618c9246d11a0f6b1' }],
        ['docs/specs/portal-bidirectional-refs.md', { kind: 'spec', id: 'docs/specs/portal-bidirectional-refs.md' }],
        ['docs/research/2026-06-03-mobile-use-comparison.md', { kind: 'doc', id: 'docs/research/2026-06-03-mobile-use-comparison.md' }],
        ['3124', { kind: 'pr', id: '3124' }],
        ['#3124', { kind: 'pr', id: '3124' }],
    ])('normalizes %s', (input, expected) => {
        expect(normalizeFromId(input)).toEqual(expected);
    });

    test('rejects unknown shapes', () => {
        expect(normalizeFromId('')).toBeNull();
        expect(normalizeFromId(null)).toBeNull();
        expect(normalizeFromId('foo://bar')).toBeNull();
    });
});

describe('api_refs cacheKey + keyOf', () => {
    test('cacheKey includes deviceId for multi-device isolation', () => {
        expect(cacheKey('dev-A', 'card', 'card_x')).toBe('dev-A|card|card_x');
        expect(cacheKey('dev-A', 'card', 'card_x'))
            .not.toBe(cacheKey('dev-B', 'card', 'card_x'));
    });
    test('keyOf is kind|id', () => {
        expect(keyOf('spec', 'docs/specs/foo.md')).toBe('spec|docs/specs/foo.md');
    });
});

describe('api_refs auth (HTTP) — deviceSecret path (portal caller)', () => {
    test('GET /api/refs with valid deviceSecret returns success', async () => {
        const { app } = spinUp();
        const r = await request(app, '/api/refs?from=card_aa15ed2618c9246d11a0f6b1&deviceId=dev-A&deviceSecret=sec-A');
        expect(r.status).toBe(200);
        expect(r.json.success).toBe(true);
    });

    test('GET /api/refs with wrong deviceSecret → 401', async () => {
        const { app } = spinUp();
        const r = await request(app, '/api/refs?from=card_aa15ed2618c9246d11a0f6b1&deviceId=dev-A&deviceSecret=wrong');
        expect(r.status).toBe(401);
    });

    test('GET /api/refs with deviceSecret from another device → 401', async () => {
        const { app } = spinUp();
        const r = await request(app, '/api/refs?from=card_aa15ed2618c9246d11a0f6b1&deviceId=dev-A&deviceSecret=sec-B');
        expect(r.status).toBe(401);
    });
});

describe('api_refs auth (HTTP) — botSecret path (bot caller)', () => {
    test('GET /api/refs with valid entityId+botSecret returns success', async () => {
        const { app } = spinUp();
        const r = await request(app, '/api/refs?from=card_aa15ed2618c9246d11a0f6b1&deviceId=dev-A&entityId=2&botSecret=bot-A2');
        expect(r.status).toBe(200);
        expect(r.json.success).toBe(true);
    });

    test('GET /api/refs with botSecret but no entityId still matches by scan → success', async () => {
        const { app } = spinUp();
        const r = await request(app, '/api/refs?from=card_aa15ed2618c9246d11a0f6b1&deviceId=dev-A&botSecret=bot-A3');
        expect(r.status).toBe(200);
        expect(r.json.success).toBe(true);
    });

    test('GET /api/refs with wrong botSecret → 401', async () => {
        const { app } = spinUp();
        const r = await request(app, '/api/refs?from=card_aa15ed2618c9246d11a0f6b1&deviceId=dev-A&entityId=2&botSecret=wrong');
        expect(r.status).toBe(401);
    });

    test('GET /api/refs with cross-device botSecret → 401', async () => {
        const { app } = spinUp();
        const r = await request(app, '/api/refs?from=card_aa15ed2618c9246d11a0f6b1&deviceId=dev-A&entityId=2&botSecret=bot-B2');
        expect(r.status).toBe(401);
    });
});

describe('api_refs auth (HTTP) — missing credentials', () => {
    test('no deviceId → 401', async () => {
        const { app } = spinUp();
        const r = await request(app, '/api/refs?from=card_aa15ed2618c9246d11a0f6b1');
        expect(r.status).toBe(401);
    });

    test('deviceId only, no secret → 401', async () => {
        const { app } = spinUp();
        const r = await request(app, '/api/refs?from=card_aa15ed2618c9246d11a0f6b1&deviceId=dev-A');
        expect(r.status).toBe(401);
    });

    test('unknown deviceId → 401', async () => {
        const { app } = spinUp();
        const r = await request(app, '/api/refs?from=card_aa15ed2618c9246d11a0f6b1&deviceId=nonexistent&deviceSecret=foo');
        expect(r.status).toBe(401);
    });
});

describe('api_refs feature flag off (default)', () => {
    test('GET /api/refs returns success:true with empty refs when ECLAW_REFS_INDEX_ENABLED is unset', async () => {
        const prevEnabled = process.env.ECLAW_REFS_INDEX_ENABLED;
        delete process.env.ECLAW_REFS_INDEX_ENABLED;
        const devices = makeDevices();
        const mod = createRefsModule(devices);
        mod._internals.stopScanLoop();
        const app = express();
        app.use('/api', mod.router);
        process.env.ECLAW_REFS_INDEX_ENABLED = prevEnabled;

        // Even with valid creds, when flag is off the endpoint short-circuits.
        const r = await request(app, '/api/refs?from=card_aa15ed2618c9246d11a0f6b1&deviceId=dev-A&deviceSecret=sec-A');
        expect(r.status).toBe(200);
        expect(r.json.success).toBe(true);
        expect(r.json.refs).toEqual([]);
        expect(r.json.enabled).toBe(false);
    });
});
