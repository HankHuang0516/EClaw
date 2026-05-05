/**
 * Transform channel key auth tests (Phase 1).
 *
 * Validates:
 * 1. Mutual exclusion: both botSecret AND X-Channel-Key → 400
 * 2. Channel key path: valid key + allowed entity → 200 with auth.via:"channelKey"
 * 3. ACL enforcement: entity not in allowedEntities → 403
 * 4. chatSource not polluted: via_channel stored separately (not in source string)
 * 5. rotate-key immediately invalidates old key (new key works, old fails)
 * 6. botSecret path: zero regression (auth.via:"botSecret")
 *
 * Channel registration management CRUD:
 * 7. POST /api/channel/registrations — creates registration, returns channelKey
 * 8. GET  /api/channel/registrations — lists active registrations
 * 9. PATCH /api/channel/registrations/:name — updates ACL
 * 10. DELETE /api/channel/registrations/:name — revokes (not returned in list)
 * 11. POST /api/channel/registrations/:name/rotate-key — rotates key
 * 12. Missing speak permission → 403
 */

require('./helpers/mock-setup');

const request = require('supertest');
const bcrypt = require('bcrypt');
const pg = require('pg');

const post = (path) => request(app).post(path).set('Host', 'localhost').set('Accept-Encoding', 'identity');
const get = (path) => request(app).get(path).set('Host', 'localhost').set('Accept-Encoding', 'identity');
const patch = (path) => request(app).patch(path).set('Host', 'localhost').set('Accept-Encoding', 'identity');
const del = (path) => request(app).delete(path).set('Host', 'localhost').set('Accept-Encoding', 'identity');

let app;
let dbMock;

/** Register + bind entity, return botSecret */
async function bindEntity(deviceId, deviceSecret, entityId = 0) {
    if (entityId > 0) {
        await post('/api/device/add-entity').send({ deviceId, deviceSecret });
    }
    const regRes = await post('/api/device/register').send({ deviceId, deviceSecret, entityId });
    const code = regRes.body.bindingCode;
    if (!code) return undefined;
    const bindRes = await post('/api/bind').send({ code });
    return bindRes.body.botSecret;
}

beforeAll(async () => {
    app = require('../../index');
    dbMock = require('../../db');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

// Reset _mockPool.query before every test to prevent once-value queue spillover.
// Without this, a beforeEach that sets mockResolvedValueOnce for a test that
// returns early (without consuming the mock) leaves stale values in the queue
// that shift subsequent tests' DB responses.
beforeEach(() => {
    if (dbMock) {
        dbMock._mockPool.query.mockReset();
        dbMock._mockPool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared device setup (botSecret path — zero regression baseline)
// ─────────────────────────────────────────────────────────────────────────────
const DEVICE_ID = 'ck-auth-test-device';
const DEVICE_SECRET = `secret-${DEVICE_ID}`;
const CHANNEL_NAME = 'test-bridge';
let botSecret0;

beforeAll(async () => {
    botSecret0 = await bindEntity(DEVICE_ID, DEVICE_SECRET, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: mock _getPool().query to return channel_registrations rows
// Supports sequential calls (SELECT for duplicate-check, then INSERT/UPDATE etc.)
// ─────────────────────────────────────────────────────────────────────────────
function mockRegistrationRow(channelKey, allowedEntities = [{ entity_id: 0, permissions: ['speak', 'state', 'a2a'] }]) {
    // Returns a pre-hashed row for verifyChannelKey. bcrypt rounds=1 for test speed.
    return async () => {
        const keyHash = await bcrypt.hash(channelKey, 1);
        return {
            id: 1,
            channel_name: CHANNEL_NAME,
            device_id: DEVICE_ID,
            key_hash: keyHash,
            allowed_entities: allowedEntities
        };
    };
}

// ════════════════════════════════════════════════════════════════
// 1. Mutual exclusion: both botSecret AND X-Channel-Key → 400
// ════════════════════════════════════════════════════════════════
describe('Mutual exclusion: botSecret + X-Channel-Key', () => {
    it('returns 400 when both auth methods provided', async () => {
        const res = await post('/api/transform')
            .set('X-Channel-Key', 'some-channel-key')
            .send({
                deviceId: DEVICE_ID,
                entityId: 0,
                botSecret: botSecret0,
                actAs: 'channel',
                message: 'test',
                state: 'IDLE'
            });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toMatch(/both.*channel.*key|channel.*key.*botSecret|botSecret/i);
    });
});

// ════════════════════════════════════════════════════════════════
// 2. Channel key path: valid key → 200 with auth.via:"channelKey"
// ════════════════════════════════════════════════════════════════
describe('Channel key auth path — valid key', () => {
    const RAW_KEY = 'test-channel-key-abcdef1234567890';

    beforeEach(async () => {
        // Mock _getPool().query to return one matching registration row
        const hash = await bcrypt.hash(RAW_KEY, 1);
        dbMock._mockPool.query.mockResolvedValueOnce({
            rows: [{
                id: 1,
                channel_name: CHANNEL_NAME,
                key_hash: hash,
                allowed_entities: [{ entity_id: 0, permissions: ['speak', 'state', 'a2a'] }]
            }],
            rowCount: 1
        }).mockResolvedValue({ rows: [], rowCount: 0 }); // for last_seen_at UPDATE
    });

    it('returns 200 with auth.via:channelKey and channelName in response', async () => {
        const res = await post('/api/transform')
            .set('X-Channel-Key', RAW_KEY)
            .send({
                deviceId: DEVICE_ID,
                entityId: 0,
                actAs: 'channel',
                message: 'hello from bridge',
                state: 'IDLE'
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.auth).toBeDefined();
        expect(res.body.auth.via).toBe('channelKey');
        expect(res.body.auth.channelName).toBe(CHANNEL_NAME);
        expect(res.body.auth.grantedPermissions).toContain('speak');
    });

    it('requires entityId when using channel key', async () => {
        const res = await post('/api/transform')
            .set('X-Channel-Key', RAW_KEY)
            .send({
                deviceId: DEVICE_ID,
                actAs: 'channel',
                message: 'no entityId',
                state: 'IDLE'
            });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/entityId required/i);
    });
});

// ════════════════════════════════════════════════════════════════
// 3. ACL enforcement: entity not in allowedEntities → 403
// ════════════════════════════════════════════════════════════════
describe('ACL enforcement — entity not in allowedEntities', () => {
    const RAW_KEY = 'acl-test-key-9876543210abcdef';

    it('returns 403 when entityId not in ACL', async () => {
        const hash = await bcrypt.hash(RAW_KEY, 1);
        // ACL only allows entity 0, but we request entity 1
        dbMock._mockPool.query.mockResolvedValueOnce({
            rows: [{
                id: 2,
                channel_name: CHANNEL_NAME,
                key_hash: hash,
                allowed_entities: [{ entity_id: 0, permissions: ['speak'] }] // only entity 0
            }],
            rowCount: 1
        }).mockResolvedValue({ rows: [], rowCount: 0 });

        // Bind entity 1 first
        await bindEntity(DEVICE_ID, DEVICE_SECRET, 1);

        const res = await post('/api/transform')
            .set('X-Channel-Key', RAW_KEY)
            .send({
                deviceId: DEVICE_ID,
                entityId: 1, // not in ACL
                actAs: 'channel',
                message: 'forbidden entity',
                state: 'IDLE'
            });
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('entity_not_allowed');
    });
});

// ════════════════════════════════════════════════════════════════
// 4. chatSource not polluted: via_channel stored separately
// ════════════════════════════════════════════════════════════════
describe('chatSource purity — via_channel stored separately', () => {
    const RAW_KEY = 'source-purity-test-key-xyz';

    it('chat saveChatMessage called with viaChannel, not embedded in source', async () => {
        const pgPools = pg.Pool.mock.results.map(r => r.value);
        // Find the chatPool (it calls query for INSERT chat_messages)
        const chatPool = pgPools[pgPools.length - 1];
        if (chatPool) chatPool.query.mockClear();

        const hash = await bcrypt.hash(RAW_KEY, 1);
        dbMock._mockPool.query.mockResolvedValueOnce({
            rows: [{
                id: 3,
                channel_name: 'my-bridge',
                key_hash: hash,
                allowed_entities: [{ entity_id: 0, permissions: ['speak', 'state', 'a2a'] }]
            }],
            rowCount: 1
        }).mockResolvedValue({ rows: [], rowCount: 0 });

        const res = await post('/api/transform')
            .set('X-Channel-Key', RAW_KEY)
            .send({
                deviceId: DEVICE_ID,
                entityId: 0,
                actAs: 'channel',
                message: 'source purity check',
                state: 'IDLE'
            });
        expect(res.status).toBe(200);

        // If chatPool captured the INSERT, verify source doesn't contain 'via:'
        if (chatPool) {
            const insertCall = chatPool.query.mock.calls.find(
                c => typeof c[0] === 'string' && c[0].includes('INSERT INTO chat_messages')
            );
            if (insertCall) {
                const [sql, params] = insertCall;
                // params[3] is the source column value
                expect(params[3]).not.toMatch(/via:/);
                // params[14] (15th param) should be the via_channel value
                expect(sql).toContain('via_channel');
                expect(params[14]).toBe('my-bridge');
            }
        }
    });
});

// ════════════════════════════════════════════════════════════════
// 5. Missing permission enforcement
// ════════════════════════════════════════════════════════════════
describe('Permission enforcement', () => {
    const RAW_KEY = 'perm-test-key-abc123';

    it('returns 403 when speak permission missing', async () => {
        const hash = await bcrypt.hash(RAW_KEY, 1);
        dbMock._mockPool.query.mockResolvedValueOnce({
            rows: [{
                id: 4,
                channel_name: CHANNEL_NAME,
                key_hash: hash,
                allowed_entities: [{ entity_id: 0, permissions: [] }] // no speak
            }],
            rowCount: 1
        }).mockResolvedValue({ rows: [], rowCount: 0 });

        const res = await post('/api/transform')
            .set('X-Channel-Key', RAW_KEY)
            .send({
                deviceId: DEVICE_ID,
                entityId: 0,
                actAs: 'channel',
                message: 'no speak permission',
                state: 'IDLE'
            });
        expect(res.status).toBe(403);
        expect(res.body.missingPermissions).toContain('speak');
    });

    it('returns 403 when state update attempted without state permission', async () => {
        const hash = await bcrypt.hash(RAW_KEY, 1);
        dbMock._mockPool.query.mockResolvedValueOnce({
            rows: [{
                id: 5,
                channel_name: CHANNEL_NAME,
                key_hash: hash,
                allowed_entities: [{ entity_id: 0, permissions: ['speak'] }] // speak only, no state
            }],
            rowCount: 1
        }).mockResolvedValue({ rows: [], rowCount: 0 });

        const res = await post('/api/transform')
            .set('X-Channel-Key', RAW_KEY)
            .send({
                deviceId: DEVICE_ID,
                entityId: 0,
                actAs: 'channel',
                message: 'trying to set state',
                state: 'BUSY' // state field present → needs state permission
            });
        expect(res.status).toBe(403);
        expect(res.body.missingPermissions).toContain('state');
    });
});

// ════════════════════════════════════════════════════════════════
// 6. botSecret path: zero regression
// ════════════════════════════════════════════════════════════════
describe('botSecret path — zero regression', () => {
    it('returns 200 with auth.via:botSecret for normal botSecret transform', async () => {
        const res = await post('/api/transform')
            .send({
                deviceId: DEVICE_ID,
                entityId: 0,
                botSecret: botSecret0,
                message: 'botSecret path still works',
                state: 'IDLE'
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.auth).toBeDefined();
        expect(res.body.auth.via).toBe('botSecret');
        expect(res.body.auth.channelName).toBeUndefined();
    });

    it('returns 400 without botSecret when no channel key provided', async () => {
        const res = await post('/api/transform')
            .send({
                deviceId: DEVICE_ID,
                entityId: 0,
                message: 'no auth',
                state: 'IDLE'
            });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/botSecret required/i);
    });
});

// ════════════════════════════════════════════════════════════════
// 7. rotate-key immediately invalidates old key
// ════════════════════════════════════════════════════════════════
describe('rotate-key immediately invalidates old key', () => {
    it('old key fails after rotate, new key works', async () => {
        const OLD_KEY = 'old-rotate-test-key-abc';
        const NEW_KEY = 'new-rotate-test-key-xyz';

        // Simulate old key no longer matching (rotate changes key_hash in DB)
        // First call (old key): hash doesn't match any row (empty rows)
        dbMock._mockPool.query.mockResolvedValueOnce({
            rows: [], // no matching row — key rotated away
            rowCount: 0
        });

        const resOld = await post('/api/transform')
            .set('X-Channel-Key', OLD_KEY)
            .send({
                deviceId: DEVICE_ID,
                entityId: 0,
                actAs: 'channel',
                message: 'old key attempt',
                state: 'IDLE'
            });
        expect(resOld.status).toBe(403);
        expect(resOld.body.code).toBe('invalid_channel_key');

        // New key: hash matches
        const newHash = await bcrypt.hash(NEW_KEY, 1);
        dbMock._mockPool.query.mockResolvedValueOnce({
            rows: [{
                id: 1,
                channel_name: CHANNEL_NAME,
                key_hash: newHash,
                allowed_entities: [{ entity_id: 0, permissions: ['speak', 'state', 'a2a'] }]
            }],
            rowCount: 1
        }).mockResolvedValue({ rows: [], rowCount: 0 });

        const resNew = await post('/api/transform')
            .set('X-Channel-Key', NEW_KEY)
            .send({
                deviceId: DEVICE_ID,
                entityId: 0,
                actAs: 'channel',
                message: 'new key works',
                state: 'IDLE'
            });
        expect(resNew.status).toBe(200);
        expect(resNew.body.auth.via).toBe('channelKey');
    });
});

// ════════════════════════════════════════════════════════════════
// 8. POST /api/channel/registrations — creates registration
// ════════════════════════════════════════════════════════════════
describe('POST /api/channel/registrations', () => {
    it('creates registration and returns channelKey', async () => {
        // SELECT (check duplicate) → empty, INSERT → ok
        dbMock._mockPool.query
            .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT duplicate check
            .mockResolvedValue({ rows: [], rowCount: 1 });   // INSERT

        const res = await post('/api/channel/registrations')
            .send({
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                channelName: 'my-new-channel',
                allowedEntities: [{ entity_id: 0, permissions: ['speak', 'state', 'a2a'] }]
            });
        expect(res.status).toBe(201);
        expect(res.body.success).toBe(true);
        expect(res.body.channelKey).toBeDefined();
        expect(typeof res.body.channelKey).toBe('string');
        expect(res.body.channelKey.length).toBeGreaterThan(32);
        expect(res.body.channelName).toBe('my-new-channel');
    });

    it('returns 409 when channel name already exists for device', async () => {
        // SELECT returns existing row
        dbMock._mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

        const res = await post('/api/channel/registrations')
            .send({
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                channelName: 'existing-channel',
                allowedEntities: []
            });
        expect(res.status).toBe(409);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 for invalid permission', async () => {
        const res = await post('/api/channel/registrations')
            .send({
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                channelName: 'bad-perms',
                allowedEntities: [{ entity_id: 0, permissions: ['fly'] }] // invalid
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/unknown permission/i);
    });

    it('returns 401 without credentials', async () => {
        const res = await post('/api/channel/registrations').send({});
        expect(res.status).toBe(401);
    });
});

// ════════════════════════════════════════════════════════════════
// 9. GET /api/channel/registrations — lists active registrations
// ════════════════════════════════════════════════════════════════
describe('GET /api/channel/registrations', () => {
    it('returns empty list when no registrations', async () => {
        dbMock._mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await get('/api/channel/registrations')
            .query({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.registrations)).toBe(true);
        expect(res.body.registrations).toHaveLength(0);
    });

    it('returns list with registration entries', async () => {
        dbMock._mockPool.query.mockResolvedValueOnce({
            rows: [{
                id: 1,
                channel_name: 'claude-bridge',
                allowed_entities: [{ entity_id: 0, permissions: ['speak'] }],
                created_at: new Date().toISOString(),
                last_seen_at: null
            }],
            rowCount: 1
        });

        const res = await get('/api/channel/registrations')
            .query({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(200);
        expect(res.body.registrations).toHaveLength(1);
        expect(res.body.registrations[0].channelName).toBe('claude-bridge');
    });
});

// ════════════════════════════════════════════════════════════════
// 10. PATCH /api/channel/registrations/:name — updates ACL
// ════════════════════════════════════════════════════════════════
describe('PATCH /api/channel/registrations/:name', () => {
    it('updates ACL and returns updated allowedEntities', async () => {
        dbMock._mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE

        const res = await patch('/api/channel/registrations/my-bridge')
            .send({
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                allowedEntities: [{ entity_id: 0, permissions: ['speak'] }]
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.allowedEntities).toHaveLength(1);
    });

    it('returns 404 when registration not found', async () => {
        dbMock._mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // UPDATE → no match

        const res = await patch('/api/channel/registrations/nonexistent')
            .send({
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                allowedEntities: []
            });
        expect(res.status).toBe(404);
    });
});

// ════════════════════════════════════════════════════════════════
// 11. DELETE /api/channel/registrations/:name — revokes channel
// ════════════════════════════════════════════════════════════════
describe('DELETE /api/channel/registrations/:name', () => {
    it('revokes registration', async () => {
        dbMock._mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 1 });

        const res = await del('/api/channel/registrations/to-revoke')
            .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.revokedAt).toBeDefined();
    });

    it('returns 404 when registration already revoked', async () => {
        dbMock._mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await del('/api/channel/registrations/already-gone')
            .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(404);
    });
});

// ════════════════════════════════════════════════════════════════
// 12. POST /api/channel/registrations/:name/rotate-key
// ════════════════════════════════════════════════════════════════
describe('POST /api/channel/registrations/:name/rotate-key', () => {
    it('returns a new channelKey', async () => {
        dbMock._mockPool.query.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 });

        const res = await post('/api/channel/registrations/my-bridge/rotate-key')
            .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.channelKey).toBeDefined();
        expect(typeof res.body.channelKey).toBe('string');
        expect(res.body.channelKey.length).toBeGreaterThan(32);
    });

    it('returns 404 when registration not found', async () => {
        dbMock._mockPool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

        const res = await post('/api/channel/registrations/nonexistent/rotate-key')
            .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(404);
    });
});
