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

// Phase 6 store-on-create avatar derive constructs an S3 client inline. Mock the
// SDK so tests drive the R2 round-trip deterministically via __setS3Send().
let mockS3SendImpl = async () => { throw new Error('s3 not stubbed'); };
jest.mock('@aws-sdk/client-s3', () => ({
    S3Client: jest.fn().mockImplementation(() => ({ send: (...a) => mockS3SendImpl(...a) })),
    GetObjectCommand: jest.fn(function (input) { this.input = input; this._type = 'get'; }),
    PutObjectCommand: jest.fn(function (input) { this.input = input; this._type = 'put'; }),
}));
function __setS3Send(fn) { mockS3SendImpl = fn; }

const express = require('express');
const request = require('supertest');
const { __mockQuery } = require('pg');
const companionFactory = require('../../companion-api');

const DEVICE = 'dev-test';
const ENTITY = 7;
const SECRET = 'good-secret';

const DEVICE_SECRET = 'good-device-secret';

function makeApp({ authenticateBot, authenticateDeviceOrBot } = {}) {
    const app = express();
    app.use(express.json());
    const authBot = authenticateBot || ((d, e, s) =>
        d === DEVICE && e === ENTITY && s === SECRET);
    const authDevOrBot = authenticateDeviceOrBot || (({ deviceId, deviceSecret, botSecret, entityId }) => {
        if (deviceId !== DEVICE) return false;
        if (deviceSecret === DEVICE_SECRET) return true;
        if (botSecret === SECRET && entityId === ENTITY) return true;
        return false;
    });
    const mod = companionFactory({
        authenticateBot: authBot,
        authenticateDeviceOrBot: authDevOrBot,
    });
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

    // ── Pagination params (petdx-browser prev/next page-flip contract) ────
    // The portal pager calls /list with explicit page=N&limit=60. These tests
    // pin the response shape (page+limit+total) so the frontend can compute
    // totalPages = ceil(total/limit) and disable prev/next accurately.
    test('echoes page=N&limit=60 back in response + reflects them in SQL OFFSET/LIMIT', async () => {
        __mockQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ total: 240 }] });
        const res = await request(makeApp())
            .get('/api/companion/list')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY, page: '3', limit: '60' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: true, page: 3, limit: 60, total: 240, companions: [],
        });
        // SQL params end with [..., limit, offset]; offset = (3-1)*60 = 120.
        const listCallParams = __mockQuery.mock.calls[0][1];
        expect(listCallParams[listCallParams.length - 2]).toBe(60);
        expect(listCallParams[listCallParams.length - 1]).toBe(120);
    });

    test('limit is clamped to MAX_LIMIT (100) when caller asks for 9999', async () => {
        __mockQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ total: 0 }] });
        const res = await request(makeApp())
            .get('/api/companion/list')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY, limit: '9999' });
        expect(res.status).toBe(200);
        expect(res.body.limit).toBe(100);
    });

    test('bad page/limit input falls back to defaults (page=1, limit=30)', async () => {
        __mockQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ total: 0 }] });
        const res = await request(makeApp())
            .get('/api/companion/list')
            .query({
                deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY,
                page: 'abc', limit: '-7',
            });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ page: 1, limit: 30 });
    });

    test('page=N with no result rows still returns the requested page number (frontend clamps via total)', async () => {
        // Server doesn't clamp page against total — the frontend does (so the
        // user gets feedback before a wasted round-trip). Pin that contract.
        __mockQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ total: 5 }] });
        const res = await request(makeApp())
            .get('/api/companion/list')
            .query({
                deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY,
                page: '99', limit: '60',
            });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ page: 99, limit: 60, total: 5, companions: [] });
    });
});

describe('companion-api: deviceSecret auth path (portal pages)', () => {
    beforeEach(() => __mockQuery.mockReset());

    test('200 with deviceSecret only (no entityId) for default scope', async () => {
        __mockQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [{ total: 0 }] });
        const res = await request(makeApp())
            .get('/api/companion/list')
            .query({ deviceId: DEVICE, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('400 when scope=mine requested with deviceSecret-only auth', async () => {
        const res = await request(makeApp())
            .get('/api/companion/list')
            .query({ deviceId: DEVICE, deviceSecret: DEVICE_SECRET, scope: 'mine' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('scope_mine_requires_entity');
    });

    test('401 on wrong deviceSecret', async () => {
        const res = await request(makeApp())
            .get('/api/companion/list')
            .query({ deviceId: DEVICE, deviceSecret: 'wrong' });
        expect(res.status).toBe(401);
    });

    test('detail accepts deviceSecret and returns published companion', async () => {
        __mockQuery.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                id: 'petdx-pub', name: 'P', version: '1.0.0',
                author_entity_id: null, device_id: null,
                descriptor: {}, asset_type: 'procedural', asset_url: null,
                avatar_url: null, thumbnail_url: null,
                supported_states: ['IDLE'], scope: 'system', status: 'published',
                license: 'EClaw-default', tags: [], i18n_data: null,
                category: null, mood: null, color: null,
                download_count: 0, favorite_count: 0, rating_avg: null,
                rating_count: 0, comment_count: 0, published_at: 1778000000000,
            }],
        });
        const res = await request(makeApp())
            .get('/api/companion/petdx-pub')
            .query({ deviceId: DEVICE, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(200);
        expect(res.body.companion.id).toBe('petdx-pub');
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

// ── Stage 2 ────────────────────────────────────────────────────────────
// favorites / select / current. We mock pg query side-effects in sequence,
// so the order of mockResolvedValueOnce calls matches the route's query
// order. Tests only assert on shape + bind args, not transactional safety.

describe('companion-api: GET /current', () => {
    beforeEach(() => __mockQuery.mockReset());

    test('200 returns null selection + empty favorites for fresh user', async () => {
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 0, rows: [] })   // select_log lookup
            .mockResolvedValueOnce({ rowCount: 0, rows: [] });  // favorites
        const res = await request(makeApp())
            .get('/api/companion/current')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, selection: null, favorites: [] });
    });

    test('200 returns full descriptor + favorite list when populated', async () => {
        __mockQuery
            .mockResolvedValueOnce({
                rowCount: 1,
                rows: [{
                    companion_id: 'petdx-pub', selected_at: 1778100000000, source: 'portal',
                    id: 'petdx-pub', name: 'Pub', version: '1.0.0', author_entity_id: null,
                    descriptor: { description: 'p' }, asset_type: 'procedural',
                    asset_url: null, avatar_url: null, thumbnail_url: null,
                    supported_states: ['IDLE'], scope: 'system', status: 'published',
                    license: 'EClaw-default', tags: [], i18n_data: null,
                    category: null, mood: null, color: null,
                    download_count: 0, favorite_count: 0, rating_avg: null,
                    rating_count: 0, comment_count: 0, published_at: 1778000000000,
                }],
            })
            .mockResolvedValueOnce({
                rowCount: 1,
                rows: [{ companion_id: 'petdx-fav', created_at: 1778090000000 }],
            });
        const res = await request(makeApp())
            .get('/api/companion/current')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY });
        expect(res.status).toBe(200);
        expect(res.body.selection.companion.id).toBe('petdx-pub');
        expect(res.body.selection.selectedAt).toBe(1778100000000);
        expect(res.body.favorites).toEqual([
            { companionId: 'petdx-fav', favoritedAt: 1778090000000 },
        ]);
    });

    test('binds entityId IS NOT DISTINCT FROM null on device-only auth', async () => {
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 0, rows: [] })
            .mockResolvedValueOnce({ rowCount: 0, rows: [] });
        await request(makeApp())
            .get('/api/companion/current')
            .query({ deviceId: DEVICE, deviceSecret: DEVICE_SECRET });
        const selectCall = __mockQuery.mock.calls[0];
        expect(selectCall[0]).toMatch(/IS NOT DISTINCT FROM/);
        expect(selectCall[1]).toEqual([DEVICE, null]);
    });
});

describe('companion-api: POST /select', () => {
    beforeEach(() => __mockQuery.mockReset());

    test('400 on missing companionId', async () => {
        const res = await request(makeApp())
            .post('/api/companion/select')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_companion_id');
    });

    test('400 on bad source', async () => {
        const res = await request(makeApp())
            .post('/api/companion/select')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ companionId: 'petdx-x', source: 'cron' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_source');
    });

    test('404 when companion missing', async () => {
        __mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
        const res = await request(makeApp())
            .post('/api/companion/select')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ companionId: 'petdx-nope' });
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('companion_not_found');
    });

    test('200 inserts log row and echoes selection', async () => {
        __mockQuery
            .mockResolvedValueOnce({                            // companions lookup
                rowCount: 1,
                rows: [{
                    id: 'petdx-pub', status: 'published', scope: 'system',
                    device_id: null, author_entity_id: null,
                }],
            })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });  // INSERT
        const res = await request(makeApp())
            .post('/api/companion/select')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ companionId: 'petdx-pub', source: 'app' });
        expect(res.status).toBe(200);
        expect(res.body.selection.companionId).toBe('petdx-pub');
        expect(res.body.selection.source).toBe('app');
        const insertCall = __mockQuery.mock.calls[1];
        expect(insertCall[0]).toMatch(/INSERT INTO companion_select_log/);
        expect(insertCall[1].slice(0, 3)).toEqual([DEVICE, ENTITY, 'petdx-pub']);
        expect(insertCall[1][4]).toBe('app');
    });
});

describe('companion-api: POST /:id/favorite', () => {
    beforeEach(() => __mockQuery.mockReset());

    test('400 on bad action', async () => {
        const res = await request(makeApp())
            .post('/api/companion/petdx-x/favorite')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ action: 'star' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_action');
    });

    test('404 when companion missing', async () => {
        __mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
        const res = await request(makeApp())
            .post('/api/companion/petdx-nope/favorite')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ action: 'add' });
        expect(res.status).toBe(404);
    });

    test('toggle on a non-favorite companion adds + bumps count', async () => {
        const baseCompanion = {
            id: 'petdx-pub', status: 'published', scope: 'system',
            device_id: null, author_entity_id: null, favorite_count: 4,
        };
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 1, rows: [baseCompanion] })       // lookup
            .mockResolvedValueOnce({ rowCount: 0, rows: [] })                    // exists?
            .mockResolvedValueOnce({ rowCount: 1, rows: [] })                    // INSERT fav
            .mockResolvedValueOnce({ rowCount: 1, rows: [] })                    // UPDATE count
            .mockResolvedValueOnce({ rowCount: 1, rows: [{ favorite_count: 5 }] }); // re-read
        const res = await request(makeApp())
            .post('/api/companion/petdx-pub/favorite')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({});
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            success: true, favorited: true, companionId: 'petdx-pub', favoriteCount: 5,
        });
    });

    test('toggle on an existing favorite removes + decrements count', async () => {
        const baseCompanion = {
            id: 'petdx-pub', status: 'published', scope: 'system',
            device_id: null, author_entity_id: null, favorite_count: 5,
        };
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 1, rows: [baseCompanion] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [{ '?column?': 1 }] })   // exists
            .mockResolvedValueOnce({ rowCount: 1, rows: [] })                    // DELETE
            .mockResolvedValueOnce({ rowCount: 1, rows: [] })                    // UPDATE
            .mockResolvedValueOnce({ rowCount: 1, rows: [{ favorite_count: 4 }] });
        const res = await request(makeApp())
            .post('/api/companion/petdx-pub/favorite')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ action: 'toggle' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ favorited: false, favoriteCount: 4 });
    });

    test('add on already-favorite is a no-op (count unchanged)', async () => {
        const baseCompanion = {
            id: 'petdx-pub', status: 'published', scope: 'system',
            device_id: null, author_entity_id: null, favorite_count: 5,
        };
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 1, rows: [baseCompanion] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [{ '?column?': 1 }] })   // exists
            .mockResolvedValueOnce({ rowCount: 1, rows: [{ favorite_count: 5 }] }); // re-read only
        const res = await request(makeApp())
            .post('/api/companion/petdx-pub/favorite')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ action: 'add' });
        expect(res.status).toBe(200);
        expect(res.body.favorited).toBe(true);
        expect(res.body.favoriteCount).toBe(5);
        // Only 3 queries: lookup + exists + re-read. No INSERT/UPDATE.
        expect(__mockQuery.mock.calls).toHaveLength(3);
    });
});

// ── Stage 3 ────────────────────────────────────────────────────────────
// ratings + comments. Mocked query order matches the route order.

describe('companion-api: GET /:id/rating', () => {
    beforeEach(() => __mockQuery.mockReset());

    test('200 stars=null when caller has no rating yet', async () => {
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 1, rows: [{ '?column?': 1 }] })  // exists
            .mockResolvedValueOnce({ rowCount: 0, rows: [] });
        const res = await request(makeApp())
            .get('/api/companion/petdx-pub/rating')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ companionId: 'petdx-pub', stars: null });
    });

    test('200 returns existing stars', async () => {
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 1, rows: [{ '?column?': 1 }] })
            .mockResolvedValueOnce({
                rowCount: 1,
                rows: [{ stars: 4, created_at: 1, updated_at: 2 }],
            });
        const res = await request(makeApp())
            .get('/api/companion/petdx-pub/rating')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY });
        expect(res.body.stars).toBe(4);
    });
});

describe('companion-api: POST /:id/rating', () => {
    beforeEach(() => __mockQuery.mockReset());

    test('400 on stars out of range', async () => {
        const res = await request(makeApp())
            .post('/api/companion/petdx-pub/rating')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ stars: 7 });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_stars');
    });

    test('200 inserts when no prior row exists, recomputes avg+count', async () => {
        const baseCompanion = {
            id: 'petdx-pub', status: 'published', scope: 'system',
            device_id: null, author_entity_id: null,
        };
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 1, rows: [baseCompanion] })       // companions lookup
            .mockResolvedValueOnce({ rowCount: 0, rows: [] })                    // exists rating
            .mockResolvedValueOnce({ rowCount: 1, rows: [] })                    // INSERT
            .mockResolvedValueOnce({ rowCount: 1, rows: [{ n: 3, avg: 4.33 }] }) // agg
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });                   // UPDATE companions
        const res = await request(makeApp())
            .post('/api/companion/petdx-pub/rating')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ stars: 5 });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            stars: 5, ratingAvg: 4.33, ratingCount: 3,
        });
    });

    test('200 updates existing rating without inserting a new row', async () => {
        const baseCompanion = {
            id: 'petdx-pub', status: 'published', scope: 'system',
            device_id: null, author_entity_id: null,
        };
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 1, rows: [baseCompanion] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 99 }] })          // existing
            .mockResolvedValueOnce({ rowCount: 1, rows: [] })                    // UPDATE rating
            .mockResolvedValueOnce({ rowCount: 1, rows: [{ n: 1, avg: 2.0 }] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });
        const res = await request(makeApp())
            .post('/api/companion/petdx-pub/rating')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ stars: 2 });
        expect(res.status).toBe(200);
        const updateCall = __mockQuery.mock.calls[2];
        expect(updateCall[0]).toMatch(/UPDATE companion_ratings/);
        expect(updateCall[1][0]).toBe(2);
    });
});

describe('companion-api: comments list + create + delete', () => {
    beforeEach(() => __mockQuery.mockReset());

    test('200 GET /comments returns paginated soft-delete-filtered list', async () => {
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 1, rows: [{ '?column?': 1 }] })   // exists
            .mockResolvedValueOnce({                                             // list
                rowCount: 1,
                rows: [{ id: 7, entity_id: 12, text: 'hi', created_at: 1778100000000 }],
            })
            .mockResolvedValueOnce({ rowCount: 1, rows: [{ n: 1 }] });           // count
        const res = await request(makeApp())
            .get('/api/companion/petdx-pub/comments')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY });
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(1);
        expect(res.body.comments[0]).toEqual({
            id: '7', author: { entityId: 12 }, text: 'hi', createdAt: 1778100000000,
        });
    });

    test('400 on empty comment text', async () => {
        const res = await request(makeApp())
            .post('/api/companion/petdx-pub/comment')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ text: '   ' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_comment_text');
    });

    test('400 on overlong comment text', async () => {
        const res = await request(makeApp())
            .post('/api/companion/petdx-pub/comment')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ text: 'x'.repeat(501) });
        expect(res.status).toBe(400);
    });

    test('200 POST /comment inserts and bumps comment_count', async () => {
        const baseCompanion = {
            id: 'petdx-pub', status: 'published', scope: 'system',
            device_id: null, author_entity_id: null,
        };
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 1, rows: [baseCompanion] })
            .mockResolvedValueOnce({                                             // INSERT RETURNING
                rowCount: 1,
                rows: [{ id: 42, created_at: 1778200000000 }],
            })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });                   // UPDATE count
        const res = await request(makeApp())
            .post('/api/companion/petdx-pub/comment')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ text: '好可愛!' });
        expect(res.status).toBe(200);
        expect(res.body.comment).toMatchObject({
            id: '42', companionId: 'petdx-pub',
            author: { entityId: ENTITY }, text: '好可愛!',
        });
    });

    test('403 when neither author nor companion owner tries to delete', async () => {
        __mockQuery.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                id: 5, companion_id: 'petdx-pub',
                device_id: 'someone-else', entity_id: 999, deleted_at: null,
                owner_device_id: 'other-dev', owner_entity_id: 1,
            }],
        });
        const res = await request(makeApp())
            .delete('/api/companion/comment/5')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY });
        expect(res.status).toBe(403);
    });

    test('200 author can delete own comment, decrements count', async () => {
        __mockQuery
            .mockResolvedValueOnce({                                             // SELECT
                rowCount: 1,
                rows: [{
                    id: 5, companion_id: 'petdx-pub',
                    device_id: DEVICE, entity_id: ENTITY, deleted_at: null,
                    owner_device_id: null, owner_entity_id: null,
                }],
            })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] })                    // UPDATE deleted_at
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });                   // UPDATE count
        const res = await request(makeApp())
            .delete('/api/companion/comment/5')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, commentId: '5' });
    });

    test('404 when comment already soft-deleted', async () => {
        __mockQuery.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                id: 5, companion_id: 'petdx-pub',
                device_id: DEVICE, entity_id: ENTITY, deleted_at: 1778000000000,
                owner_device_id: null, owner_entity_id: null,
            }],
        });
        const res = await request(makeApp())
            .delete('/api/companion/comment/5')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY });
        expect(res.status).toBe(404);
    });
});

// ── Stage 4 ────────────────────────────────────────────────────────────
// submit / pending / review / delete. submit is bot-auth (needs entityId);
// pending + review are deviceSecret-only; delete accepts both creator (bot)
// and device owner (deviceSecret).

describe('companion-api: validateSubmittedDescriptor', () => {
    const { validateSubmittedDescriptor } = companionFactory._test;
    const minimal = () => ({
        id: 'petdx-test', name: 'Test Pet', version: '1.0.0',
        descriptor: { id: 'petdx-test' }, assetType: 'procedural',
        supportedStates: ['IDLE'], license: 'EClaw-default',
    });

    test('null on minimal valid body', () => {
        expect(validateSubmittedDescriptor(minimal())).toBeNull();
    });

    test('rejects bad id', () => {
        const b = { ...minimal(), id: 'BadID!' };
        expect(validateSubmittedDescriptor(b)).toBe('invalid_companion_id');
    });

    test('rejects empty name', () => {
        const b = { ...minimal(), name: '   ' };
        expect(validateSubmittedDescriptor(b)).toBe('invalid_name');
    });

    test('rejects 41-char name', () => {
        const b = { ...minimal(), name: 'x'.repeat(41) };
        expect(validateSubmittedDescriptor(b)).toBe('invalid_name');
    });

    test('rejects bad semver', () => {
        const b = { ...minimal(), version: '1.0' };
        expect(validateSubmittedDescriptor(b)).toBe('invalid_version');
    });

    test('rejects descriptor.id mismatch', () => {
        const b = { ...minimal(), descriptor: { id: 'petdx-other' } };
        expect(validateSubmittedDescriptor(b)).toBe('descriptor_id_mismatch');
    });

    test('rejects unknown asset_type', () => {
        const b = { ...minimal(), assetType: 'rainbow' };
        expect(validateSubmittedDescriptor(b)).toBe('invalid_asset_type');
    });

    test('rejects bad supported_states', () => {
        const b = { ...minimal(), supportedStates: ['idle'] };
        expect(validateSubmittedDescriptor(b)).toBe('invalid_supported_states');
    });

    test('rejects unknown license', () => {
        const b = { ...minimal(), license: 'GPL-3.0' };
        expect(validateSubmittedDescriptor(b)).toBe('invalid_license');
    });

    test('rejects unknown category', () => {
        const b = { ...minimal(), category: 'plant' };
        expect(validateSubmittedDescriptor(b)).toBe('invalid_category');
    });

    test('rejects > 10 tags', () => {
        const b = { ...minimal(), tags: Array(11).fill('cute') };
        expect(validateSubmittedDescriptor(b)).toBe('invalid_tags');
    });

    test('rejects profanity in name', () => {
        const b = { ...minimal(), name: 'Hello fuck' };
        expect(validateSubmittedDescriptor(b)).toBe('profanity_detected');
    });
});

describe('companion-api: POST /submit', () => {
    beforeEach(() => __mockQuery.mockReset());
    const validBody = () => ({
        id: 'petdx-mybot', name: 'My Bot', version: '1.0.0',
        descriptor: { id: 'petdx-mybot', description: 'a friendly bot' },
        assetType: 'procedural', supportedStates: ['IDLE', 'BUSY'],
        license: 'CC0', category: 'mascot', tags: ['friendly'],
    });

    test('400 when caller has no entityId (deviceSecret-only)', async () => {
        const res = await request(makeApp())
            .post('/api/companion/submit')
            .query({ deviceId: DEVICE, deviceSecret: DEVICE_SECRET })
            .send(validBody());
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('submit_requires_entity');
    });

    test('400 on validation failure', async () => {
        const res = await request(makeApp())
            .post('/api/companion/submit')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ ...validBody(), assetType: 'rainbow' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_asset_type');
    });

    test('409 on duplicate id', async () => {
        __mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{}] });
        const res = await request(makeApp())
            .post('/api/companion/submit')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send(validBody());
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('companion_id_exists');
    });

    test('201 happy path inserts pending_review row', async () => {
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 0, rows: [] })  // exists check
            .mockResolvedValueOnce({ rowCount: 1, rows: [] }); // INSERT
        const res = await request(makeApp())
            .post('/api/companion/submit')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send(validBody());
        expect(res.status).toBe(201);
        expect(res.body.companion).toMatchObject({
            id: 'petdx-mybot', status: 'pending_review',
            scope: 'community', author: { entityId: ENTITY },
        });
        const insertCall = __mockQuery.mock.calls[1];
        expect(insertCall[0]).toMatch(/INSERT INTO companions/);
        expect(insertCall[0]).toMatch(/'pending_review'/);
        expect(insertCall[1]).toEqual(expect.arrayContaining([
            'petdx-mybot', 'My Bot', '1.0.0', ENTITY, DEVICE,
        ]));
    });

    test('429 on rate-limit (6th submit in window)', async () => {
        // Each submit calls exists check + INSERT — 2 mocks per attempt
        for (let i = 0; i < 5; i++) {
            __mockQuery
                .mockResolvedValueOnce({ rowCount: 0, rows: [] })
                .mockResolvedValueOnce({ rowCount: 1, rows: [] });
        }
        const app = makeApp();
        const body = validBody();
        for (let i = 0; i < 5; i++) {
            const r = await request(app)
                .post('/api/companion/submit')
                .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
                .send({ ...body, id: `petdx-mybot-${i}`, descriptor: { id: `petdx-mybot-${i}` } });
            expect(r.status).toBe(201);
        }
        // 6th should hit rate limit BEFORE any pg call (no extra mock needed)
        const r6 = await request(app)
            .post('/api/companion/submit')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ ...body, id: 'petdx-mybot-extra', descriptor: { id: 'petdx-mybot-extra' } });
        expect(r6.status).toBe(429);
        expect(r6.body.error).toBe('rate_limit_exceeded');
    });
});

describe('companion-api: Phase 6 store-on-create avatar derive', () => {
    const sharp = require('sharp');
    const { petdxSlugFromUrl, deriveSpriteAvatarUrl } = companionFactory._test;
    let spriteBytes;

    beforeAll(async () => {
        // A real (tiny) WebP so extractFrameZero's sharp pipeline runs for real.
        spriteBytes = await sharp({
            create: { width: 64, height: 64, channels: 3, background: { r: 12, g: 34, b: 56 } },
        }).webp().toBuffer();
    });
    beforeEach(() => { __mockQuery.mockReset(); __setS3Send(async () => { throw new Error('s3 not stubbed'); }); });

    // Permissive auth so each test can use a FRESH entityId — the submit
    // rate-limiter is keyed by entityId in module state and ENTITY=7 is already
    // exhausted by the prior /submit describe.
    const freeApp = () => makeApp({
        authenticateDeviceOrBot: ({ deviceId, botSecret }) => deviceId === DEVICE && botSecret === SECRET,
    });

    const spriteBody = (over = {}) => ({
        id: 'petdx-zoro', name: 'Zoro', version: '1.0.0',
        descriptor: { id: 'petdx-zoro', description: 'a sprite bot', asset: { frameWidth: 64, frameHeight: 64 } },
        assetType: 'spritesheet', supportedStates: ['IDLE'],
        license: 'CC0', assetUrl: '/api/petdx/petdx-zoro/sprite.webp', ...over,
    });

    test('petdxSlugFromUrl extracts slug from sprite proxy URL', () => {
        expect(petdxSlugFromUrl('/api/petdx/petdx-zoro/sprite.webp')).toBe('petdx-zoro');
        expect(petdxSlugFromUrl('https://eclawbot.com/api/petdx/abc-123/sprite.webp')).toBe('abc-123');
        expect(petdxSlugFromUrl('/api/petdx/x/avatar.webp')).toBeNull(); // not a sprite url
        expect(petdxSlugFromUrl(null)).toBeNull();
    });

    test('deriveSpriteAvatarUrl returns null (never throws) when R2 GET fails', async () => {
        __setS3Send(async () => { throw new Error('NoSuchKey'); });
        const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
        const out = await deriveSpriteAvatarUrl({
            r2: new S3Client({}), GetObjectCommand, PutObjectCommand, bucket: 'eclaw-files',
            slug: 'petdx-zoro', descriptor: {}, log: () => {},
        });
        expect(out).toBeNull();
    });

    test('spritesheet submit stores derived avatar.webp URL on R2 success', async () => {
        __setS3Send(async (cmd) => {
            if (cmd._type === 'get') return { Body: { transformToByteArray: async () => spriteBytes } };
            return {}; // put ok
        });
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 0, rows: [] })   // exists check
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });  // INSERT
        const res = await request(freeApp())
            .post('/api/companion/submit')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: 901 })
            .send(spriteBody());
        expect(res.status).toBe(201);
        const insertParams = __mockQuery.mock.calls[1][1];
        // INSERT param order: ...assetType[6], asset_url[7], avatar_url[8], thumbnail_url[9]...
        // asset_url keeps the sprite sheet; avatar_url is the DERIVED single frame.
        expect(insertParams[7]).toBe('/api/petdx/petdx-zoro/sprite.webp');
        expect(insertParams[8]).toBe('/api/petdx/petdx-zoro/avatar.webp');
    });

    test('spritesheet submit still succeeds (201) when derive fails; sprite-as-avatar is nulled', async () => {
        __setS3Send(async () => { throw new Error('R2 down'); });
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 0, rows: [] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });
        const res = await request(freeApp())
            .post('/api/companion/submit')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: 902 })
            .send(spriteBody({ avatarUrl: '/api/petdx/petdx-zoro/sprite.webp' }));
        expect(res.status).toBe(201); // avatar work never fails the submit
        const insertParams = __mockQuery.mock.calls[1][1];
        // §2.1 invariant: never persist a sprite sheet as the avatar. Derive failed and the
        // client avatar == asset_url (sprite) → avatar_url nulled; backfill cron repoints later.
        expect(insertParams[7]).toBe('/api/petdx/petdx-zoro/sprite.webp'); // asset_url kept
        expect(insertParams[8]).toBeNull(); // avatar_url nulled, NOT the sprite
    });

    test('400 when avatarUrl === assetUrl (vector) — §2.1 invariant', async () => {
        __mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // exists check (before guard)
        const res = await request(freeApp())
            .post('/api/companion/submit')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: 904 })
            .send({
                id: 'vec-bot', name: 'Vec', version: '1.0.0',
                descriptor: { id: 'vec-bot' }, assetType: 'vector', supportedStates: ['IDLE'],
                license: 'CC0', assetUrl: '/assets/vec.svg', avatarUrl: '/assets/vec.svg',
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('avatar_url_must_differ_from_asset_url');
    });

    test('vector submit with a distinct avatarUrl stores it as-is (no derive, no R2)', async () => {
        const send = jest.fn(async () => ({}));
        __setS3Send(send);
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 0, rows: [] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });
        const res = await request(freeApp())
            .post('/api/companion/submit')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: 905 })
            .send({
                id: 'vec-bot2', name: 'Vec2', version: '1.0.0',
                descriptor: { id: 'vec-bot2' }, assetType: 'vector', supportedStates: ['IDLE'],
                license: 'CC0', assetUrl: '/assets/v2.svg', avatarUrl: '/assets/v2-avatar.png',
            });
        expect(res.status).toBe(201);
        expect(send).not.toHaveBeenCalled(); // non-spritesheet never derives
        expect(__mockQuery.mock.calls[1][1][8]).toBe('/assets/v2-avatar.png');
    });

    test('procedural submit never touches R2 (no derive)', async () => {
        const send = jest.fn(async () => ({}));
        __setS3Send(send);
        __mockQuery
            .mockResolvedValueOnce({ rowCount: 0, rows: [] })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });
        const res = await request(freeApp())
            .post('/api/companion/submit')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: 903 })
            .send({ ...spriteBody(), assetType: 'procedural', assetUrl: undefined });
        expect(res.status).toBe(201);
        expect(send).not.toHaveBeenCalled();
    });
});

describe('companion-api: GET /pending', () => {
    beforeEach(() => __mockQuery.mockReset());

    test('403 when called with bot auth (no deviceSecret)', async () => {
        const res = await request(makeApp())
            .get('/api/companion/pending')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('device_owner_only');
    });

    test('200 returns pending_review companions on this device', async () => {
        __mockQuery
            .mockResolvedValueOnce({
                rowCount: 1,
                rows: [{
                    id: 'petdx-pending', name: 'P', version: '1.0.0',
                    author_entity_id: ENTITY, device_id: DEVICE,
                    descriptor: { id: 'petdx-pending' }, asset_type: 'procedural',
                    asset_url: null, avatar_url: null, thumbnail_url: null,
                    supported_states: ['IDLE'], scope: 'community', status: 'pending_review',
                    license: 'CC0', tags: [], i18n_data: null,
                    category: null, mood: null, color: null,
                    download_count: 0, favorite_count: 0, rating_avg: null,
                    rating_count: 0, comment_count: 0, published_at: null,
                    created_at: 1778100000000,
                }],
            })
            .mockResolvedValueOnce({ rowCount: 1, rows: [{ n: 1 }] });
        const res = await request(makeApp())
            .get('/api/companion/pending')
            .query({ deviceId: DEVICE, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(200);
        expect(res.body.total).toBe(1);
        expect(res.body.companions[0]).toMatchObject({
            id: 'petdx-pending', status: 'pending_review',
        });
    });
});

describe('companion-api: POST /:id/review', () => {
    beforeEach(() => __mockQuery.mockReset());

    test('403 when bot auth tries to review', async () => {
        const res = await request(makeApp())
            .post('/api/companion/petdx-x/review')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY })
            .send({ decision: 'approve' });
        expect(res.status).toBe(403);
        expect(res.body.error).toBe('device_owner_only');
    });

    test('400 on invalid decision', async () => {
        const res = await request(makeApp())
            .post('/api/companion/petdx-x/review')
            .query({ deviceId: DEVICE, deviceSecret: DEVICE_SECRET })
            .send({ decision: 'maybe' });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_decision');
    });

    test('404 when companion missing', async () => {
        __mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
        const res = await request(makeApp())
            .post('/api/companion/petdx-missing/review')
            .query({ deviceId: DEVICE, deviceSecret: DEVICE_SECRET })
            .send({ decision: 'approve' });
        expect(res.status).toBe(404);
    });

    test('403 when reviewing companion from another device', async () => {
        __mockQuery.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{ id: 'petdx-x', status: 'pending_review', device_id: 'other-dev' }],
        });
        const res = await request(makeApp())
            .post('/api/companion/petdx-x/review')
            .query({ deviceId: DEVICE, deviceSecret: DEVICE_SECRET })
            .send({ decision: 'approve' });
        expect(res.status).toBe(403);
    });

    test('409 when companion is already published', async () => {
        __mockQuery.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{ id: 'petdx-x', status: 'published', device_id: DEVICE }],
        });
        const res = await request(makeApp())
            .post('/api/companion/petdx-x/review')
            .query({ deviceId: DEVICE, deviceSecret: DEVICE_SECRET })
            .send({ decision: 'approve' });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('not_pending_review');
    });

    test('200 approve flips status to published', async () => {
        __mockQuery
            .mockResolvedValueOnce({
                rowCount: 1,
                rows: [{ id: 'petdx-x', status: 'pending_review', device_id: DEVICE }],
            })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });
        const res = await request(makeApp())
            .post('/api/companion/petdx-x/review')
            .query({ deviceId: DEVICE, deviceSecret: DEVICE_SECRET })
            .send({ decision: 'approve' });
        expect(res.status).toBe(200);
        expect(res.body.companion).toMatchObject({ id: 'petdx-x', status: 'published' });
        const updateCall = __mockQuery.mock.calls[1];
        expect(updateCall[0]).toMatch(/SET status = 'published'/);
    });

    test('200 reject stores reason', async () => {
        __mockQuery
            .mockResolvedValueOnce({
                rowCount: 1,
                rows: [{ id: 'petdx-x', status: 'pending_review', device_id: DEVICE }],
            })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });
        const res = await request(makeApp())
            .post('/api/companion/petdx-x/review')
            .query({ deviceId: DEVICE, deviceSecret: DEVICE_SECRET })
            .send({ decision: 'reject', reason: 'Sprite too low-res' });
        expect(res.status).toBe(200);
        expect(res.body.companion).toMatchObject({
            id: 'petdx-x', status: 'rejected', rejectReason: 'Sprite too low-res',
        });
    });
});

describe('companion-api: DELETE /:id', () => {
    beforeEach(() => __mockQuery.mockReset());

    test('400 on invalid id shape', async () => {
        const res = await request(makeApp())
            .delete('/api/companion/Bad ID')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY });
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_companion_id');
    });

    test('404 when companion missing', async () => {
        __mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
        const res = await request(makeApp())
            .delete('/api/companion/petdx-missing')
            .query({ deviceId: DEVICE, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(404);
    });

    test('409 when companion is already published', async () => {
        __mockQuery.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{ id: 'petdx-x', status: 'published', device_id: DEVICE, author_entity_id: ENTITY }],
        });
        const res = await request(makeApp())
            .delete('/api/companion/petdx-x')
            .query({ deviceId: DEVICE, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe('not_pending_review');
    });

    test('403 when outsider tries to delete', async () => {
        __mockQuery.mockResolvedValueOnce({
            rowCount: 1,
            rows: [{
                id: 'petdx-x', status: 'pending_review',
                device_id: DEVICE, author_entity_id: 999, // not us
            }],
        });
        const res = await request(makeApp())
            .delete('/api/companion/petdx-x')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY });
        expect(res.status).toBe(403);
    });

    test('200 creator deletes own pending_review', async () => {
        __mockQuery
            .mockResolvedValueOnce({
                rowCount: 1,
                rows: [{
                    id: 'petdx-x', status: 'pending_review',
                    device_id: DEVICE, author_entity_id: ENTITY,
                }],
            })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });
        const res = await request(makeApp())
            .delete('/api/companion/petdx-x')
            .query({ deviceId: DEVICE, botSecret: SECRET, entityId: ENTITY });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, companionId: 'petdx-x' });
    });

    test('200 device owner deletes any pending_review on their device', async () => {
        __mockQuery
            .mockResolvedValueOnce({
                rowCount: 1,
                rows: [{
                    id: 'petdx-x', status: 'pending_review',
                    device_id: DEVICE, author_entity_id: 999,
                }],
            })
            .mockResolvedValueOnce({ rowCount: 1, rows: [] });
        const res = await request(makeApp())
            .delete('/api/companion/petdx-x')
            .query({ deviceId: DEVICE, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(200);
    });
});
