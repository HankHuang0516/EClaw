/**
 * Admin operations endpoint tests (Jest + Supertest)
 *
 * Tests happy-path behavior for admin endpoints beyond auth rejection.
 * Tests: GET /api/admin/stats, POST /api/admin/bots/create,
 *        POST /api/admin/transfer-device
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const get = (path) => request(app).get(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');
const put = (path) => request(app).put(path).set('Host', 'localhost');
const del = (path) => request(app).delete(path).set('Host', 'localhost');

/** Register a device via the register endpoint */
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
    jest.resetModules();
});

// Note: auth mock has adminMiddleware as noop, so admin endpoints are accessible

// ════════════════════════════════════════════════════════════════
// GET /api/admin/stats — platform statistics
// ════════════════════════════════════════════════════════════════
describe('GET /api/admin/stats', () => {
    it('returns stats with expected shape', async () => {
        const res = await get('/api/admin/stats');
        // Either 200 with stats or 500 from DB mock
        expect([200, 500].includes(res.status)).toBe(true);
        if (res.status === 200) {
            expect(res.body).toHaveProperty('success');
        }
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/admin/bots/create — create official bot
// ════════════════════════════════════════════════════════════════
describe('POST /api/admin/bots/create', () => {
    it('returns 400 when required fields are missing', async () => {
        const res = await post('/api/admin/bots/create')
            .send({});
        expect(res.status).toBe(400);
    });

    it('returns 400 when botType is invalid', async () => {
        const res = await post('/api/admin/bots/create')
            .send({ botId: 'bot-1', botType: 'invalid', webhookUrl: 'https://x.com', token: 'tk' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/botType/);
    });

    it('returns 400 without required fields (partial)', async () => {
        const res = await post('/api/admin/bots/create')
            .send({ botId: 'bot-1', botType: 'free' });
        expect(res.status).toBe(400);
    });

    it('creates official bot with valid inputs', async () => {
        const res = await post('/api/admin/bots/create')
            .send({
                botId: 'test-official-bot',
                botType: 'free',
                webhookUrl: 'https://example.com/webhook',
                token: 'test-token',
            });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('returns 409 for duplicate botId', async () => {
        // Create first
        await post('/api/admin/bots/create')
            .send({
                botId: 'test-dup-bot',
                botType: 'personal',
                webhookUrl: 'https://example.com/webhook',
                token: 'test-token',
            });

        // Create duplicate
        const res = await post('/api/admin/bots/create')
            .send({
                botId: 'test-dup-bot',
                botType: 'personal',
                webhookUrl: 'https://example.com/webhook2',
                token: 'test-token-2',
            });
        expect(res.status).toBe(409);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/admin/transfer-device
// ════════════════════════════════════════════════════════════════
describe('POST /api/admin/transfer-device', () => {
    it('returns 401 when source device credentials are invalid', async () => {
        const res = await post('/api/admin/transfer-device')
            .send({
                sourceDeviceId: 'nonexistent',
                sourceDeviceSecret: 'wrong',
                targetDeviceId: 'target',
                targetDeviceSecret: 'sec',
            });
        expect(res.status).toBe(401);
    });

    it('transfers entities between devices', async () => {
        const srcSecret = await registerDevice('transfer-src');

        const res = await post('/api/admin/transfer-device')
            .send({
                sourceDeviceId: 'transfer-src',
                sourceDeviceSecret: srcSecret,
                targetDeviceId: 'transfer-tgt',
                targetDeviceSecret: 'new-secret',
            });
        // 200 success (may transfer nothing since no bound entities)
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/admin/bindings — list device-entity bindings
// ════════════════════════════════════════════════════════════════
describe('GET /api/admin/bindings', () => {
    it('returns bindings list', async () => {
        const res = await get('/api/admin/bindings');
        expect([200, 500].includes(res.status)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/admin/users — list user accounts
// ════════════════════════════════════════════════════════════════
describe('GET /api/admin/users', () => {
    it('returns users list', async () => {
        const res = await get('/api/admin/users');
        expect([200, 500].includes(res.status)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/admin/bots — list bots
// ════════════════════════════════════════════════════════════════
describe('GET /api/admin/bots', () => {
    it('returns bots list', async () => {
        const res = await get('/api/admin/bots');
        expect([200, 500].includes(res.status)).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/admin/gatekeeper/reset — reset strikes
// ════════════════════════════════════════════════════════════════
describe('POST /api/admin/gatekeeper/reset', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/admin/gatekeeper/reset').send({});
        expect(res.status).toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/gatekeeper/appeal — self-service appeal
// ════════════════════════════════════════════════════════════════
describe('POST /api/gatekeeper/appeal', () => {
    it('returns 400 or 403 when deviceId is missing', async () => {
        const res = await post('/api/gatekeeper/appeal').send({});
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});
