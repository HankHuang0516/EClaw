/**
 * Channel API endpoint validation tests (Jest + Supertest)
 *
 * Tests: GET/POST /api/channel/provision, DELETE /api/channel/account/:id,
 *        POST /api/channel/provision-device, POST/GET/DELETE /api/channel/test-sink,
 *        POST /api/channel/register, DELETE /api/channel/register,
 *        POST /api/channel/bind, POST /api/channel/message
 */

require('./helpers/mock-setup');

// Add missing db functions used by channel-api
const db = require('../../db');
db.getChannelAccountByKey = jest.fn().mockResolvedValue(null);
db.getChannelAccountsByDevice = jest.fn().mockResolvedValue([]);
db.createChannelAccount = jest.fn().mockResolvedValue({ id: 1, channel_api_key: 'eck_test', channel_api_secret: 'ecs_test' });
db.getChannelAccountById = jest.fn().mockResolvedValue(null);
db.deleteChannelAccount = jest.fn().mockResolvedValue(true);
db.updateChannelCallback = jest.fn().mockResolvedValue(true);
db.updateChannelE2eeCapable = jest.fn().mockResolvedValue(true);
db.clearChannelCallback = jest.fn().mockResolvedValue(true);
db.getChannelAccountByDevice = jest.fn().mockResolvedValue(null);

const request = require('supertest');
let app;

const get = (path) => request(app).get(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');
const del = (path) => request(app).delete(path).set('Host', 'localhost');

async function registerDevice(id) {
    const secret = `secret-${id}`;
    await post('/api/device/register')
        .send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    return secret;
}

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
});

// ── GET /api/channel/provision ──

describe('GET /api/channel/provision', () => {
    it('returns 400 if deviceId is missing', async () => {
        const res = await get('/api/channel/provision');
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns accounts list for valid device', async () => {
        db.getChannelAccountsByDevice.mockResolvedValueOnce([
            { id: 1, channel_api_key: 'eck_abc', callback_url: 'https://x.com/cb', e2ee_capable: false, status: 'active', created_at: new Date().toISOString() }
        ]);
        const res = await get('/api/channel/provision?deviceId=chan-dev-1');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.accounts)).toBe(true);
    });
});

// ── POST /api/channel/provision ──

describe('POST /api/channel/provision', () => {
    it('returns 400 if deviceId is missing', async () => {
        const res = await post('/api/channel/provision').send({});
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 404 for unknown device', async () => {
        const res = await post('/api/channel/provision').send({ deviceId: 'no-such-device' });
        expect(res.status).toBe(404);
    });

    it('returns api key pair for registered device', async () => {
        const deviceId = 'chan-prov-1';
        await registerDevice(deviceId);
        const res = await post('/api/channel/provision').send({ deviceId });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.channel_api_key).toBeDefined();
        expect(res.body.channel_api_secret).toBeDefined();
    });
});

// ── POST /api/channel/provision-device ──

describe('POST /api/channel/provision-device', () => {
    it('returns 401 if deviceId is missing', async () => {
        const res = await post('/api/channel/provision-device').send({});
        expect(res.status).toBe(401);
    });

    it('returns 403 for wrong deviceSecret', async () => {
        const deviceId = 'chan-pd-1';
        await registerDevice(deviceId);
        const res = await post('/api/channel/provision-device')
            .send({ deviceId, deviceSecret: 'wrong' });
        expect(res.status).toBe(403);
    });

    it('returns api key pair for valid credentials', async () => {
        const deviceId = 'chan-pd-2';
        const secret = await registerDevice(deviceId);
        const res = await post('/api/channel/provision-device')
            .send({ deviceId, deviceSecret: secret });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.channel_api_key).toBeDefined();
    });
});

// ── DELETE /api/channel/account/:id ──

describe('DELETE /api/channel/account/:id', () => {
    it('returns 400 if deviceId is missing', async () => {
        const res = await del('/api/channel/account/1').send({});
        expect(res.status).toBe(400);
    });

    it('returns 404 if account not found', async () => {
        db.getChannelAccountById.mockResolvedValueOnce(null);
        const res = await del('/api/channel/account/999')
            .send({ deviceId: 'some-device' });
        expect(res.status).toBe(404);
    });

    it('returns 404 if account belongs to different device', async () => {
        db.getChannelAccountById.mockResolvedValueOnce({ id: 1, device_id: 'other-device' });
        const res = await del('/api/channel/account/1')
            .send({ deviceId: 'my-device' });
        expect(res.status).toBe(404);
    });
});

// ── POST/GET/DELETE /api/channel/test-sink ──

describe('POST /api/channel/test-sink', () => {
    it('stores payload and returns success', async () => {
        const res = await post('/api/channel/test-sink?slot=jest')
            .send({ text: 'hello' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.slot).toBe('jest');
    });
});

describe('GET /api/channel/test-sink', () => {
    it('returns 401 without device credentials', async () => {
        const res = await get('/api/channel/test-sink');
        expect(res.status).toBe(401);
    });

    it('returns payloads for valid device', async () => {
        const deviceId = 'chan-sink-1';
        const secret = await registerDevice(deviceId);
        const res = await get(`/api/channel/test-sink?deviceId=${deviceId}&deviceSecret=${secret}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.payloads)).toBe(true);
    });
});

describe('DELETE /api/channel/test-sink', () => {
    it('returns 401 without device credentials', async () => {
        const res = await del('/api/channel/test-sink');
        expect(res.status).toBe(401);
    });
});

// ── POST /api/channel/register ──

describe('POST /api/channel/register', () => {
    it('returns 401 without channel_api_key', async () => {
        const res = await post('/api/channel/register').send({});
        expect(res.status).toBe(401);
    });

    it('returns 403 for invalid api key', async () => {
        db.getChannelAccountByKey.mockResolvedValueOnce(null);
        const res = await post('/api/channel/register')
            .send({ channel_api_key: 'bad_key', callback_url: 'https://example.com/cb' });
        expect(res.status).toBe(403);
    });

    it('returns 400 if callback_url is missing', async () => {
        db.getChannelAccountByKey.mockResolvedValueOnce({ id: 1, device_id: 'dev-1', channel_api_key: 'eck_valid', channel_api_secret: 'ecs_s' });
        const res = await post('/api/channel/register')
            .send({ channel_api_key: 'eck_valid' });
        expect(res.status).toBe(400);
        expect(res.body.message).toContain('callback_url');
    });

    it('registers callback successfully', async () => {
        const deviceId = 'chan-reg-1';
        await registerDevice(deviceId);
        db.getChannelAccountByKey.mockResolvedValueOnce({
            id: 1, device_id: deviceId, channel_api_key: 'eck_valid', channel_api_secret: 'ecs_s'
        });
        const res = await post('/api/channel/register')
            .send({ channel_api_key: 'eck_valid', callback_url: 'https://example.com/cb' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.deviceId).toBe(deviceId);
    });
});

// ── DELETE /api/channel/register ──

describe('DELETE /api/channel/register', () => {
    it('returns 401 without channel_api_key', async () => {
        const res = await del('/api/channel/register').send({});
        expect(res.status).toBe(401);
    });

    it('unregisters successfully', async () => {
        db.getChannelAccountByKey.mockResolvedValueOnce({
            id: 1, device_id: 'dev-1', channel_api_key: 'eck_valid'
        });
        const res = await del('/api/channel/register')
            .send({ channel_api_key: 'eck_valid' });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ── POST /api/channel/bind ──

describe('POST /api/channel/bind', () => {
    it('returns 401 without channel_api_key', async () => {
        const res = await post('/api/channel/bind').send({});
        expect(res.status).toBe(401);
    });

    it('returns 403 for invalid api key', async () => {
        db.getChannelAccountByKey.mockResolvedValueOnce(null);
        const res = await post('/api/channel/bind')
            .send({ channel_api_key: 'bad_key' });
        expect(res.status).toBe(403);
    });
});

// ── POST /api/channel/message ──

describe('POST /api/channel/message', () => {
    it('returns 400 when required fields are missing', async () => {
        const res = await post('/api/channel/message').send({});
        expect(res.status).toBe(400);
        expect(res.body.message).toContain('required');
    });

    it('returns 400 when only channel_api_key is provided', async () => {
        const res = await post('/api/channel/message')
            .send({ channel_api_key: 'eck_test' });
        expect(res.status).toBe(400);
    });

    it('returns 403 for invalid api key when all fields provided', async () => {
        db.getChannelAccountByKey.mockResolvedValueOnce(null);
        const res = await post('/api/channel/message')
            .send({ channel_api_key: 'bad_key', deviceId: 'dev-1', entityId: 0, botSecret: 'bs' });
        expect(res.status).toBe(403);
    });
});
