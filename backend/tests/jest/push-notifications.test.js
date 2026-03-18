/**
 * Push notification endpoint tests (Jest + Supertest)
 *
 * Tests: GET /api/push/vapid-public-key, POST /api/push/subscribe,
 *        DELETE /api/push/unsubscribe, POST /api/device/fcm-token
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
// GET /api/push/vapid-public-key
// ════════════════════════════════════════════════════════════════
describe('GET /api/push/vapid-public-key', () => {
    it('returns 503 when VAPID_PUBLIC_KEY not configured', async () => {
        delete process.env.VAPID_PUBLIC_KEY;
        const res = await get('/api/push/vapid-public-key');
        expect(res.status).toBe(503);
        expect(res.body.error).toMatch(/not configured/i);
    });

    it('returns public key when configured', async () => {
        process.env.VAPID_PUBLIC_KEY = 'test-vapid-key-123';
        const res = await get('/api/push/vapid-public-key');
        expect(res.status).toBe(200);
        expect(res.body.publicKey).toBe('test-vapid-key-123');
        delete process.env.VAPID_PUBLIC_KEY;
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/push/subscribe
// ════════════════════════════════════════════════════════════════
describe('POST /api/push/subscribe', () => {
    it('returns 401 without device auth', async () => {
        const res = await post('/api/push/subscribe')
            .send({ subscription: { endpoint: 'https://example.com', keys: { p256dh: 'x', auth: 'y' } } });
        expect(res.status).toBe(401);
    });

    it('returns 400 when subscription is missing', async () => {
        const deviceSecret = await registerDevice('test-push-sub');

        const res = await post('/api/push/subscribe')
            .send({ deviceId: 'test-push-sub', deviceSecret });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/subscription/i);
    });

    it('returns 400 when subscription.endpoint is missing', async () => {
        const deviceSecret = await registerDevice('test-push-sub-ep');

        const res = await post('/api/push/subscribe')
            .send({
                deviceId: 'test-push-sub-ep',
                deviceSecret,
                subscription: { keys: { p256dh: 'x', auth: 'y' } },
            });
        expect(res.status).toBe(400);
    });

    it('returns 400 when subscription.keys is missing', async () => {
        const deviceSecret = await registerDevice('test-push-sub-keys');

        const res = await post('/api/push/subscribe')
            .send({
                deviceId: 'test-push-sub-keys',
                deviceSecret,
                subscription: { endpoint: 'https://example.com' },
            });
        expect(res.status).toBe(400);
    });
});

// ════════════════════════════════════════════════════════════════
// DELETE /api/push/unsubscribe
// ════════════════════════════════════════════════════════════════
describe('DELETE /api/push/unsubscribe', () => {
    it('returns 401 without device auth', async () => {
        const res = await del('/api/push/unsubscribe')
            .send({ endpoint: 'https://example.com' });
        expect(res.status).toBe(401);
    });

    it('returns 400 when endpoint is missing', async () => {
        const deviceSecret = await registerDevice('test-push-unsub');

        const res = await del('/api/push/unsubscribe')
            .send({ deviceId: 'test-push-unsub', deviceSecret });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/endpoint/i);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/device/fcm-token — FCM token registration
// ════════════════════════════════════════════════════════════════
describe('POST /api/device/fcm-token', () => {
    it('returns 400 or 404 when deviceId is missing', async () => {
        const res = await post('/api/device/fcm-token')
            .send({ token: 'fcm-token-123' });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('rejects for nonexistent device', async () => {
        const res = await post('/api/device/fcm-token')
            .send({ deviceId: 'nonexistent', deviceSecret: 'wrong', token: 'fcm-token-123' });
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});
