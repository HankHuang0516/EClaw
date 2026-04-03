/**
 * Channel Auth Bypass — channel_api_key as alternative to botSecret
 *
 * Tests that channel-bound bots can use channel_api_key in place of botSecret
 * for all bot API endpoints. This removes the requirement for channel bots
 * to know their botSecret (which has no self-lookup endpoint).
 */

require('./helpers/mock-setup');

const db = require('../../db');

// Mock channel account lookup
const MOCK_CHANNEL_ACCOUNT = {
    id: 42,
    device_id: 'ch-auth-dev',
    channel_api_key: 'eck_test_channel_auth_bypass_key',
    channel_api_secret: 'ecs_test_secret',
    status: 'active',
    e2ee_capable: false
};

db.getChannelAccountByKey = jest.fn().mockImplementation(async (key) => {
    if (key === MOCK_CHANNEL_ACCOUNT.channel_api_key) return MOCK_CHANNEL_ACCOUNT;
    return null;
});
db.getChannelAccountsByDevice = jest.fn().mockResolvedValue([]);
db.createChannelAccount = jest.fn().mockResolvedValue(MOCK_CHANNEL_ACCOUNT);
db.getChannelAccountById = jest.fn().mockResolvedValue(null);
db.deleteChannelAccount = jest.fn().mockResolvedValue(true);
db.updateChannelCallback = jest.fn().mockResolvedValue(true);
db.updateChannelE2eeCapable = jest.fn().mockResolvedValue(true);
db.clearChannelCallback = jest.fn().mockResolvedValue(true);
db.getChannelAccountByDevice = jest.fn().mockResolvedValue(null);

const request = require('supertest');
let app;

const DEVICE_ID = 'ch-auth-test-device';
const DEVICE_SECRET = 'ch-auth-test-secret';
const ENTITY_ID = 0;

const get = (path) => request(app).get(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');
const del = (path) => request(app).delete(path).set('Host', 'localhost');
const put = (path) => request(app).put(path).set('Host', 'localhost');

beforeAll(async () => {
    app = require('../../index');

    // Register device
    await post('/api/device/register')
        .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, entityId: ENTITY_ID });

    // Bind entity to simulate a channel-bound bot
    // We need to set up the entity as channel-bound with our mock channel account ID
    const { devices } = require('../../index');
    const device = devices[DEVICE_ID];
    if (device && device.entities[ENTITY_ID]) {
        device.entities[ENTITY_ID].isBound = true;
        device.entities[ENTITY_ID].bindingType = 'channel';
        device.entities[ENTITY_ID].channelAccountId = MOCK_CHANNEL_ACCOUNT.id;
        device.entities[ENTITY_ID].botSecret = 'real_bot_secret_unused';
        device.entities[ENTITY_ID].name = 'ChannelBot';
        device.entities[ENTITY_ID].character = 'LOBSTER';
        device.entities[ENTITY_ID].state = 'IDLE';
        device.entities[ENTITY_ID].message = 'Ready';
    }
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
});

// ── POST /api/transform ──

describe('POST /api/transform — channel_api_key auth', () => {
    it('succeeds with valid channel_api_key (no botSecret)', async () => {
        const res = await post('/api/transform').send({
            deviceId: DEVICE_ID,
            entityId: ENTITY_ID,
            channel_api_key: MOCK_CHANNEL_ACCOUNT.channel_api_key,
            state: 'WORKING',
            message: 'Hello from channel bot'
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('fails with invalid channel_api_key', async () => {
        const res = await post('/api/transform').send({
            deviceId: DEVICE_ID,
            entityId: ENTITY_ID,
            channel_api_key: 'eck_invalid_key',
            state: 'WORKING'
        });
        expect(res.status).toBe(403);
    });

    it('still works with valid botSecret', async () => {
        const res = await post('/api/transform').send({
            deviceId: DEVICE_ID,
            entityId: ENTITY_ID,
            botSecret: 'real_bot_secret_unused',
            state: 'IDLE'
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ── POST /api/entity/broadcast ──

describe('POST /api/entity/broadcast — channel_api_key auth', () => {
    it('succeeds with valid channel_api_key', async () => {
        const res = await post('/api/entity/broadcast').send({
            deviceId: DEVICE_ID,
            fromEntityId: ENTITY_ID,
            channel_api_key: MOCK_CHANNEL_ACCOUNT.channel_api_key,
            text: 'Broadcast from channel bot'
        });
        // Should succeed (200) — no other entities to broadcast to, but auth passes
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('fails with invalid channel_api_key', async () => {
        const res = await post('/api/entity/broadcast').send({
            deviceId: DEVICE_ID,
            fromEntityId: ENTITY_ID,
            channel_api_key: 'eck_wrong',
            text: 'Should fail'
        });
        expect(res.status).toBe(403);
    });
});

// ── GET /api/whoami ──

describe('GET /api/whoami — channel_api_key auth', () => {
    it('succeeds with channel_api_key + deviceId + entityId', async () => {
        const res = await get('/api/whoami')
            .query({
                channel_api_key: MOCK_CHANNEL_ACCOUNT.channel_api_key,
                deviceId: DEVICE_ID,
                entityId: ENTITY_ID
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.name).toBe('ChannelBot');
        expect(res.body.deviceId).toBe(DEVICE_ID);
    });

    it('fails without deviceId when using channel_api_key', async () => {
        const res = await get('/api/whoami')
            .query({ channel_api_key: MOCK_CHANNEL_ACCOUNT.channel_api_key });
        expect(res.status).toBe(400);
    });
});

// ── GET /api/client/pending ──

describe('GET /api/client/pending — channel_api_key auth', () => {
    it('returns messages with valid channel_api_key', async () => {
        const res = await get('/api/client/pending')
            .query({
                deviceId: DEVICE_ID,
                entityId: ENTITY_ID,
                channel_api_key: MOCK_CHANNEL_ACCOUNT.channel_api_key
            });
        expect(res.status).toBe(200);
        expect(res.body.deviceId).toBe(DEVICE_ID);
    });

    it('returns peek mode without any auth', async () => {
        const res = await get('/api/client/pending')
            .query({ deviceId: DEVICE_ID, entityId: ENTITY_ID });
        expect(res.status).toBe(200);
        expect(res.body.note).toMatch(/botSecret/i);
    });
});

// ── PUT /api/entity/identity ──

describe('PUT /api/entity/identity — channel_api_key auth', () => {
    it('succeeds with channel_api_key', async () => {
        const res = await put('/api/entity/identity').send({
            deviceId: DEVICE_ID,
            entityId: ENTITY_ID,
            channel_api_key: MOCK_CHANNEL_ACCOUNT.channel_api_key,
            identity: { role: 'assistant', instructions: ['Be helpful'] }
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ── GET /api/entity/identity ──

describe('GET /api/entity/identity — channel_api_key auth', () => {
    it('succeeds with channel_api_key via header', async () => {
        const res = await get('/api/entity/identity')
            .set('x-channel-api-key', MOCK_CHANNEL_ACCOUNT.channel_api_key)
            .query({ deviceId: DEVICE_ID, entityId: ENTITY_ID });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ── PUT /api/entity/agent-card ──

describe('PUT /api/entity/agent-card — channel_api_key auth', () => {
    it('succeeds with channel_api_key', async () => {
        const res = await put('/api/entity/agent-card').send({
            deviceId: DEVICE_ID,
            entityId: ENTITY_ID,
            channel_api_key: MOCK_CHANNEL_ACCOUNT.channel_api_key,
            agentCard: { name: 'ChannelBot', description: 'A channel-bound bot' }
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ── POST /api/bot/sync-message ──

describe('POST /api/bot/sync-message — channel_api_key auth', () => {
    it('succeeds with channel_api_key', async () => {
        const res = await post('/api/bot/sync-message').send({
            deviceId: DEVICE_ID,
            entityId: ENTITY_ID,
            channel_api_key: MOCK_CHANNEL_ACCOUNT.channel_api_key,
            message: 'Synced message from channel bot'
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('fails with wrong channel_api_key', async () => {
        const res = await post('/api/bot/sync-message').send({
            deviceId: DEVICE_ID,
            entityId: ENTITY_ID,
            channel_api_key: 'eck_wrong',
            message: 'Should fail'
        });
        expect(res.status).toBe(403);
    });
});

// ── GET /api/bot/push-status ──

describe('GET /api/bot/push-status — channel_api_key auth', () => {
    it('succeeds with channel_api_key', async () => {
        const res = await get('/api/bot/push-status')
            .query({
                deviceId: DEVICE_ID,
                entityId: ENTITY_ID,
                channel_api_key: MOCK_CHANNEL_ACCOUNT.channel_api_key
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ── POST /api/channel/message ──

describe('POST /api/channel/message — without botSecret', () => {
    it('succeeds with only channel_api_key (no botSecret)', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: MOCK_CHANNEL_ACCOUNT.channel_api_key,
            deviceId: DEVICE_ID,
            entityId: ENTITY_ID,
            message: 'Channel message without botSecret'
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('fails with wrong channel_api_key and no botSecret', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: 'eck_wrong',
            deviceId: DEVICE_ID,
            entityId: ENTITY_ID,
            message: 'Should fail'
        });
        expect(res.status).toBe(403);
    });
});
