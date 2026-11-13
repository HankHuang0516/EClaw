/** Regression boundaries for the optional admin bot snapshot (no server startup). */
require('./helpers/mock-setup');

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');
const request = require('supertest');
const db = require('../../db');
const authModule = require('../../auth')();

// Execute the actual route registration and handler with the shared repo DB mocks.
const source = fs.readFileSync(path.join(__dirname, '../../index.js'), 'utf8');
const routeStart = source.indexOf("app.get('/api/admin/bots',");
const routeEnd = source.indexOf('// GET /api/admin/invite/clicks', routeStart);
if (routeStart < 0 || routeEnd < 0) throw new Error('Admin bot route boundaries not found');
const routeSource = source.slice(routeStart, routeEnd);

function makeHarness({ usePostgreSQL = true } = {}) {
    const rows = [
        {
            bot_id: 'stale', bot_type: 'personal', status: 'assigned',
            assigned_device_id: 'missing-device', assigned_entity_id: '0',
            assigned_at: '1700000000000', created_at: '1690000000000',
            display_name: 'Personal bot', assigned_user_email: 'owner@example.test',
            webhook_url: 'https://example.test/private-webhook', token: 'synthetic-private-token'
        },
        {
            bot_id: 'bound', bot_type: 'personal', status: 'assigned',
            assigned_device_id: 'bound-device', assigned_entity_id: '2',
            assigned_at: '1700000001000', created_at: '1690000001000',
            display_name: '', assigned_user_email: 'bound@example.test',
            webhook_url: null, token: null
        },
        {
            bot_id: 'free', bot_type: 'free', status: 'disabled',
            assigned_device_id: null, assigned_entity_id: null, assigned_at: null,
            created_at: null, display_name: null, assigned_user_email: null,
            webhook_url: 'https://example.test/free-private-webhook', token: 'synthetic-free-token'
        }
    ];
    const responses = [
        { rows },
        { rows: [{ bot_id: 'free', binding_count: '3', user_emails: ['free@example.test'] }] },
        { rows: [{ bot_id: 'free', conversations_24h: '48', unique_users_24h: '12' }] }
    ];
    const query = authModule.pool.query;
    query.mockReset();
    for (const response of responses) query.mockResolvedValueOnce(response);
    db.saveOfficialBot.mockClear();
    db.removeOfficialBinding.mockClear();

    const devices = { 'bound-device': { entities: { 2: { isBound: true } } } };
    const officialBots = Object.fromEntries(rows.map(row => [row.bot_id, { ...row }]));
    const officialBindingsCache = {
        'missing-device:0': { botId: 'stale' },
        'bound-device:2': { botId: 'bound' }
    };
    const getBindingCacheKey = jest.fn((deviceId, entityId) => `${deviceId}:${entityId}`);
    const adminAuth = jest.fn();
    const adminCheck = jest.fn();
    const app = { get: jest.fn() };
    const logger = { log: jest.fn(), error: jest.fn() };
    vm.runInNewContext(routeSource, {
        app, adminAuth, adminCheck, authModule, db, devices, officialBots,
        officialBindingsCache, getBindingCacheKey, usePostgreSQL, console: logger
    });
    const handler = app.get.mock.calls[0][3];
    const res = { json: jest.fn(), status: jest.fn(), set: jest.fn(), vary: jest.fn() };
    res.status.mockReturnValue(res);
    const state = () => JSON.parse(JSON.stringify({ rows, devices, officialBots, officialBindingsCache }));

    return {
        rows, responses, query, devices, officialBots, officialBindingsCache,
        getBindingCacheKey, app, adminAuth, adminCheck, logger, res, state,
        async run(queryParams = {}) {
            await handler({ query: queryParams }, res);
            return res.json.mock.calls[0][0];
        }
    };
}

function expectNoCleanup(harness, before) {
    expect(harness.state()).toEqual(before);
    expect(db.saveOfficialBot).not.toHaveBeenCalled();
    expect(db.removeOfficialBinding).not.toHaveBeenCalled();
    expect(harness.getBindingCacheKey).not.toHaveBeenCalled();
    expect(harness.logger.log).not.toHaveBeenCalled();
    for (const [sql] of harness.query.mock.calls) {
        expect(sql.trim()).toMatch(/^SELECT\b/);
        expect(sql).not.toMatch(/\b(?:UPDATE|INSERT|DELETE|UPSERT)\b/i);
    }
}

function makeHttpApp(harness) {
    const app = express();
    app.use((_req, res, next) => {
        res.set('Cache-Control', 'public, max-age=3600');
        res.vary('Origin');
        next();
    });
    harness.adminAuth.mockImplementation((_req, _res, next) => next());
    harness.adminCheck.mockImplementation((_req, _res, next) => next());
    app.get(...harness.app.get.mock.calls[0]);
    return app;
}

describe('GET /api/admin/bots?readOnly=1', () => {
    test('keeps adminAuth and adminCheck in order on the existing route', () => {
        const h = makeHarness();
        expect(h.app.get).toHaveBeenCalledTimes(1);
        expect(h.app.get).toHaveBeenCalledWith(
            '/api/admin/bots', h.adminAuth, h.adminCheck, expect.any(Function)
        );
    });

    test.each(['get', 'head'])('%s snapshots override cache policy and append auth Vary fields', async method => {
        const h = makeHarness();
        const before = h.state();
        const response = await request(makeHttpApp(h))[method]('/api/admin/bots?readOnly=1');

        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('private, no-store');
        expect(response.headers.vary.split(/,\s*/)).toEqual(['Origin', 'Cookie', 'Authorization']);
        expect(h.adminAuth).toHaveBeenCalledTimes(1);
        expect(h.adminCheck).toHaveBeenCalledTimes(1);
        if (method === 'head') expect(response.text).toBeUndefined();
        else expect(response.body.success).toBe(true);
        expectNoCleanup(h, before);
    });

    test.each(['get', 'head'])('%s errors retain the private/no-store policy', async method => {
        const h = makeHarness();
        const before = h.state();
        h.query.mockReset().mockRejectedValueOnce(new Error('synthetic query failure'));
        const response = await request(makeHttpApp(h))[method]('/api/admin/bots?readOnly=1');

        expect(response.status).toBe(500);
        expect(response.headers['cache-control']).toBe('private, no-store');
        expect(response.headers.vary.split(/,\s*/)).toEqual(['Origin', 'Cookie', 'Authorization']);
        expectNoCleanup(h, before);
    });

    test.each([true, false])('preserves real states and every nonsecret field (PostgreSQL=%s)', async usePostgreSQL => {
        const h = makeHarness({ usePostgreSQL });
        const before = h.state();
        const body = await h.run({ readOnly: '1' });

        expect(body).toEqual({
            success: true,
            bots: [
                {
                    botId: 'stale', displayName: 'Personal bot', botType: 'personal', status: 'assigned',
                    assignedDeviceId: 'missing-device', assignedEntityId: 0,
                    assignedUserEmail: 'owner@example.test', assignedAt: 1700000000000,
                    createdAt: 1690000000000, bindingCount: 0, boundUserEmails: [],
                    conversations24h: 0, avgConvPer5h: 0, uniqueUsers24h: 0, avgUsersPer5h: 0
                },
                {
                    botId: 'bound', displayName: null, botType: 'personal', status: 'assigned',
                    assignedDeviceId: 'bound-device', assignedEntityId: 2,
                    assignedUserEmail: 'bound@example.test', assignedAt: 1700000001000,
                    createdAt: 1690000001000, bindingCount: 0, boundUserEmails: [],
                    conversations24h: 0, avgConvPer5h: 0, uniqueUsers24h: 0, avgUsersPer5h: 0
                },
                {
                    botId: 'free', displayName: null, botType: 'free', status: 'disabled',
                    assignedDeviceId: null, assignedEntityId: null, assignedUserEmail: null,
                    assignedAt: null, createdAt: null, bindingCount: 3,
                    boundUserEmails: ['free@example.test'], conversations24h: 48,
                    avgConvPer5h: 10, uniqueUsers24h: 12, avgUsersPer5h: 2.5
                }
            ]
        });
        expect(h.res.status).not.toHaveBeenCalled();
        expect(h.query).toHaveBeenCalledTimes(3);
        expectNoCleanup(h, before);
    });

    test('never selects or returns credential keys/values, even if the driver supplies them', async () => {
        const h = makeHarness();
        const body = await h.run({ readOnly: '1' });

        for (const [sql] of h.query.mock.calls) {
            expect(sql).not.toMatch(/\b(?:webhook_url|token)\b/i);
            expect(sql).not.toMatch(/SELECT\s+(?:\w+\.)?\*/i);
        }
        for (const bot of body.bots) {
            expect(bot).not.toHaveProperty('webhookUrl');
            expect(bot).not.toHaveProperty('webhook_url');
            expect(bot).not.toHaveProperty('token');
        }
        const serialized = JSON.stringify(body);
        for (const row of h.rows) {
            if (row.webhook_url) expect(serialized).not.toContain(row.webhook_url);
            if (row.token) expect(serialized).not.toContain(row.token);
        }
    });

    test('does not read credential values when building the snapshot', async () => {
        const h = makeHarness();
        for (const row of h.rows) {
            for (const key of ['webhook_url', 'token']) {
                Object.defineProperty(row, key, {
                    get() { throw new Error('Credential accessed'); }
                });
            }
        }
        const body = await h.run({ readOnly: '1' });
        expect(body.success).toBe(true);
        expect(h.logger.error).not.toHaveBeenCalled();
    });

    test('returns an empty successful snapshot when there are no bots', async () => {
        const h = makeHarness();
        h.rows.length = 0;
        const before = h.state();
        expect(await h.run({ readOnly: '1' })).toEqual({ success: true, bots: [] });
        expectNoCleanup(h, before);
    });

    test.each([0, 1, 2])('keeps the error contract and avoids cleanup when SELECT %s fails', async failedQuery => {
        const h = makeHarness();
        const before = h.state();
        h.query.mockReset();
        for (let index = 0; index < failedQuery; index++) {
            h.query.mockResolvedValueOnce(h.responses[index]);
        }
        h.query.mockRejectedValueOnce(new Error('synthetic query failure'));

        expect(await h.run({ readOnly: '1' })).toEqual({ success: false, error: 'Failed to get bots' });
        expect(h.res.status).toHaveBeenCalledWith(500);
        expect(h.res.set).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
        expect(h.res.vary.mock.calls).toEqual([['Cookie'], ['Authorization']]);
        expect(h.query).toHaveBeenCalledTimes(failedQuery + 1);
        expectNoCleanup(h, before);
    });
});

describe('GET /api/admin/bots legacy behavior', () => {
    test.each([
        ['absent', {}], ['zero', { readOnly: '0' }], ['text true', { readOnly: 'true' }],
        ['padded', { readOnly: '01' }], ['number', { readOnly: 1 }],
        ['boolean', { readOnly: true }], ['repeated query', { readOnly: ['1', '1'] }],
        ['nested query', { readOnly: { value: '1' } }]
    ])('retains credentials and stale cleanup when readOnly is %s', async (_label, queryParams) => {
        const h = makeHarness();
        const boundBefore = { ...h.officialBots.bound };
        const body = await h.run(queryParams);

        expect(body.success).toBe(true);
        expect(h.res.set).not.toHaveBeenCalled();
        expect(h.res.vary).not.toHaveBeenCalled();
        expect(h.query.mock.calls[0][0]).toMatch(/o\.webhook_url, o\.token/);
        expect(body.bots[0]).toMatchObject({
            status: 'available', assignedDeviceId: null, assignedEntityId: null,
            assignedAt: null, assignedUserEmail: null,
            webhookUrl: 'https://example.test/private-webhook', token: 'synthetic-private-token'
        });
        expect(body.bots[1]).toMatchObject({
            status: 'assigned', assignedDeviceId: 'bound-device', assignedEntityId: 2,
            webhookUrl: null, token: null
        });
        expect(h.officialBots.stale.status).toBe('available');
        expect(h.officialBots.bound).toEqual(boundBefore);
        expect(h.officialBindingsCache).toEqual({ 'bound-device:2': { botId: 'bound' } });
        expect(db.saveOfficialBot).toHaveBeenCalledTimes(1);
        expect(db.saveOfficialBot).toHaveBeenCalledWith(h.officialBots.stale);
        expect(db.removeOfficialBinding).toHaveBeenCalledTimes(1);
        expect(db.removeOfficialBinding).toHaveBeenCalledWith('missing-device', 0);
    });

    test.each(['get', 'head'])('%s legacy responses leave existing cache headers unchanged', async method => {
        const h = makeHarness();
        const response = await request(makeHttpApp(h))[method]('/api/admin/bots');

        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('public, max-age=3600');
        expect(response.headers.vary).toBe('Origin');
    });

    test('still cleans the in-memory assignment/cache without PostgreSQL writes', async () => {
        const h = makeHarness({ usePostgreSQL: false });
        const body = await h.run();
        expect(body.bots[0].status).toBe('available');
        expect(h.officialBots.stale.status).toBe('available');
        expect(h.officialBindingsCache).not.toHaveProperty('missing-device:0');
        expect(db.saveOfficialBot).not.toHaveBeenCalled();
        expect(db.removeOfficialBinding).not.toHaveBeenCalled();
    });
});
