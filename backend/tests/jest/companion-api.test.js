'use strict';

/**
 * Companion API Stage 1 — read endpoints unit tests.
 *
 * Covers:
 *   - helper exports (parseTags / parsePositiveInt / row mappers)
 *   - factory contract: requires authenticateBot, mounts /list + /:id
 *   - 400 on missing creds, 401 on bad creds (auth middleware)
 *   - input validation (invalid_asset_type, invalid_category, invalid_companion_id)
 *   - happy-path query shape (mocked pg pool)
 *
 * pg is mocked module-wide so the require chain doesn't open a real connection
 * when CI runs without DATABASE_URL.
 */

jest.mock('pg', () => {
    const mockQuery = jest.fn();
    const Pool = jest.fn().mockImplementation(() => ({
        query: mockQuery,
        end: jest.fn(),
    }));
    return { Pool, __mockQuery: mockQuery };
});

const express = require('express');
const request = require('supertest');
const { __mockQuery } = require('pg');
const companionFactory = require('../../companion-api');

const DEVICE = 'dev-test';
const ENTITY = 7;
const SECRET = 'good-secret';

function makeApp({ authenticateBot } = {}) {
    const app = express();
    app.use(express.json());
    const auth = authenticateBot || ((d, e, s) =>
        d === DEVICE && e === ENTITY && s === SECRET);
    const mod = companionFactory({ authenticateBot: auth });
    app.use('/api/companion', mod.router);
    return app;
}

describe('companion-api: helpers', () => {
    const { parseTags, parsePositiveInt, rowToCompanionCard, rowToCompanionDetail } =
        companionFactory._test;

    test('parseTags splits comma list, trims, drops empties, caps at 10', () => {
        expect(parseTags('cat, orange ,cute')).toEqual(['cat', 'orange', 'cute']);
        expect(parseTags('')).toEqual([]);
        expect(parseTags(undefined)).toEqual([]);
        expect(parseTags(Array(20).fill('x'))).toHaveLength(20); // arrays not capped (already structured)
        expect(parseTags(Array(20).fill('x').join(','))).toHaveLength(10);
    });

    test('parsePositiveInt clamps to fallback / max', () => {
        expect(parsePositiveInt('5', 1)).toBe(5);
        expect(parsePositiveInt('-1', 1)).toBe(1);
        expect(parsePositiveInt('abc', 30, 100)).toBe(30);
        expect(parsePositiveInt('500', 30, 100)).toBe(100);
    });

    test('rowToCompanionCard projects expected fields', () => {
        const row = {
            id: 'petdx-x', name: 'X', version: '1.0.0', author_entity_id: 12,
            avatar_url: '/a.png', thumbnail_url: '/t.webp', tags: ['k'],
            mood: 'happy', color: '#fff', category: 'animal',
            asset_type: 'spritesheet', supported_states: ['IDLE'],
            download_count: 1, favorite_count: 2, rating_avg: 4.5,
            rating_count: 3, comment_count: 4, scope: 'community',
        };
        const card = rowToCompanionCard(row);
        expect(card.id).toBe('petdx-x');
        expect(card.author).toEqual({ entityId: 12 });
        expect(card.stats).toEqual({
            downloads: 1, favorites: 2, rating: 4.5, ratingCount: 3, commentCount: 4,
        });
    });

    test('rowToCompanionDetail extends card with descriptor fields', () => {
        const row = {
            id: 'petdx-x', name: 'X', version: '1.0.0', author_entity_id: null,
            descriptor: { description: 'hi' }, asset_type: 'procedural',
            supported_states: ['IDLE'], scope: 'system', status: 'published',
            license: 'MIT', i18n_data: null, published_at: 1778000000000,
            tags: [], download_count: 0, favorite_count: 0, rating_avg: null,
            rating_count: 0, comment_count: 0,
        };
        const det = rowToCompanionDetail(row);
        expect(det.descriptor).toEqual({ description: 'hi' });
        expect(det.author).toBeNull();
        expect(det.license).toBe('MIT');
        expect(det.publishedAt).toBe(1778000000000);
    });
});

describe('companion-api: factory contract', () => {
    test('throws if authenticateBot missing', () => {
        expect(() => companionFactory({})).toThrow(/authenticateBot/);
    });

    test('returns router + initCompanionDatabase', () => {
        const m = companionFactory({ authenticateBot: () => true });
        expect(typeof m.initCompanionDatabase).toBe('function');
        expect(m.router).toBeDefined();
    });
});

describe('companion-api: GET /list auth + validation', () => {
    beforeEach(() => __mockQuery.mockReset());

    test('400 when deviceId/botSecret/entityId missing', async () => {
        const res = await request(makeApp()).get('/api/companion/list');
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ success: false });
    });

    test('401 on bad creds', async () => {
        const res = await request(makeApp())
            .get('/api/companion/list')
            .query({ deviceId: DEVICE, botSecret: 'wrong', entityId: ENTITY });
        expect(res.status).toBe(401);
    });

    test('400 on invalid assetType', async () => {
        const res = await request(makeApp())
            .get('/api/companion/list')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY, assetType: 'rainbow' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_asset_type');
    });

    test('200 returns paginated shape on empty result set', async () => {
        __mockQuery
            .mockResolvedValueOnce({ rows: [] })                     // list
            .mockResolvedValueOnce({ rows: [{ total: 0 }] });        // count
        const res = await request(makeApp())
            .get('/api/companion/list')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: true, page: 1, limit: 30, total: 0, companions: [],
        });
    });

    test('mine scope binds entityId + deviceId in WHERE', async () => {
        __mockQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ total: 0 }] });
        await request(makeApp())
            .get('/api/companion/list')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY, scope: 'mine' });
        const listCall = __mockQuery.mock.calls[0];
        expect(listCall[0]).toMatch(/author_entity_id = \$\d/);
        expect(listCall[0]).toMatch(/device_id = \$\d/);
        expect(listCall[1]).toEqual(expect.arrayContaining([ENTITY, DEVICE]));
    });
});

describe('companion-api: GET /:id', () => {
    beforeEach(() => __mockQuery.mockReset());

    test('400 on invalid id shape', async () => {
        const res = await request(makeApp())
            .get('/api/companion/has space')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_companion_id');
    });

    test('404 when not found', async () => {
        __mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
        const res = await request(makeApp())
            .get('/api/companion/petdx-missing')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY });
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('companion_not_found');
    });

    test('404 hides pending_review companions from non-owners', async () => {
        __mockQuery.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                id: 'petdx-pending', name: 'X', author_entity_id: 999, device_id: 'other-dev',
                status: 'pending_review', scope: 'community', descriptor: {},
                asset_type: 'spritesheet', supported_states: ['IDLE'], tags: [],
                download_count: 0, favorite_count: 0, rating_avg: null,
                rating_count: 0, comment_count: 0,
            }],
        });
        const res = await request(makeApp())
            .get('/api/companion/petdx-pending')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY });
        expect(res.status).toBe(404);
    });

    test('200 returns descriptor for published companion', async () => {
        __mockQuery.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                id: 'petdx-ok', name: 'OK', version: '1.0.0',
                author_entity_id: null, device_id: null,
                descriptor: { description: 'hello' },
                asset_type: 'procedural', asset_url: null,
                avatar_url: '/a.png', thumbnail_url: '/t.webp',
                supported_states: ['IDLE'], scope: 'system', status: 'published',
                license: 'EClaw-default', tags: [], i18n_data: null,
                category: null, mood: null, color: null,
                download_count: 0, favorite_count: 0, rating_avg: null,
                rating_count: 0, comment_count: 0, published_at: 1778000000000,
            }],
        });
        const res = await request(makeApp())
            .get('/api/companion/petdx-ok')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY });
        expect(res.status).toBe(200);
        expect(res.body.companion.descriptor).toEqual({ description: 'hello' });
        expect(res.body.companion.scope).toBe('system');
    });
});
