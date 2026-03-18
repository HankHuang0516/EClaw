/**
 * Bot registration & webhook endpoint tests (Jest + Supertest)
 *
 * Tests: POST /api/bot/register, DELETE /api/bot/register,
 *        bot tools API validation
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const get = (path) => request(app).get(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');
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

// ════════════════════════════════════════════════════════════════
// POST /api/bot/register
// ════════════════════════════════════════════════════════════════
describe('POST /api/bot/register', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/bot/register')
            .send({ botSecret: 'sec', webhook_url: 'https://x.com', token: 'tk', session_key: 'sk' });
        expect(res.status).toBe(400);
    });

    it('returns 404 for nonexistent device', async () => {
        const res = await post('/api/bot/register')
            .send({
                deviceId: 'nonexistent',
                botSecret: 'sec',
                webhook_url: 'https://x.com',
                token: 'tk',
                session_key: 'sk',
            });
        expect(res.status).toBe(404);
    });

    it('returns 400 for invalid entityId (negative)', async () => {
        const res = await post('/api/bot/register')
            .send({
                deviceId: 'dev-1',
                entityId: -5,
                botSecret: 'sec',
                webhook_url: 'https://x.com',
                token: 'tk',
                session_key: 'sk',
            });
        expect(res.status).toBe(400);
    });

    it('returns 400 when entity is not bound', async () => {
        await registerDevice('test-bot-reg');

        const res = await post('/api/bot/register')
            .send({
                deviceId: 'test-bot-reg',
                entityId: 0,
                botSecret: 'sec',
                webhook_url: 'https://x.com',
                token: 'tk',
                session_key: 'sk',
            });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/not bound/i);
    });

    it('returns 400 when webhook_url is missing', async () => {
        await registerDevice('test-bot-reg-wh');

        const res = await post('/api/bot/register')
            .send({
                deviceId: 'test-bot-reg-wh',
                entityId: 0,
                botSecret: 'valid',
                token: 'tk',
                session_key: 'sk',
            });
        // Entity not bound (400) or missing webhook (400)
        expect(res.status).toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════
// DELETE /api/bot/register
// ════════════════════════════════════════════════════════════════
describe('DELETE /api/bot/register', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await del('/api/bot/register')
            .send({ botSecret: 'sec' });
        expect(res.status).toBe(400);
    });

    it('returns 404 for nonexistent device', async () => {
        const res = await del('/api/bot/register')
            .send({ deviceId: 'nonexistent', botSecret: 'sec' });
        expect(res.status).toBe(404);
    });

    it('returns 400 for invalid entityId (negative)', async () => {
        const res = await del('/api/bot/register')
            .send({ deviceId: 'dev-1', entityId: -1, botSecret: 'sec' });
        expect(res.status).toBe(400);
    });

    it('returns 403 when botSecret is invalid', async () => {
        await registerDevice('test-bot-unreg');

        const res = await del('/api/bot/register')
            .send({ deviceId: 'test-bot-unreg', entityId: 0, botSecret: 'wrong-secret' });
        expect(res.status).toBe(403);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/bot/web-search — validation (auth required via authBot)
// ════════════════════════════════════════════════════════════════
describe('GET /api/bot/web-search', () => {
    it('rejects without bot auth', async () => {
        const res = await get('/api/bot/web-search?q=test');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/bot/web-fetch — validation (auth required via authBot)
// ════════════════════════════════════════════════════════════════
describe('GET /api/bot/web-fetch', () => {
    it('rejects without bot auth', async () => {
        const res = await get('/api/bot/web-fetch?url=https://example.com');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// GET /api/bot/push-status
// ════════════════════════════════════════════════════════════════
describe('GET /api/bot/push-status', () => {
    it('rejects without bot auth', async () => {
        const res = await get('/api/bot/push-status');
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/bot/sync-message — message sync
// ════════════════════════════════════════════════════════════════
describe('POST /api/bot/sync-message', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/bot/sync-message')
            .send({ botSecret: 'sec', message: 'hello' });
        expect(res.status).toBe(400);
    });
});
