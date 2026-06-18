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

// ════════════════════════════════════════════════════════════════
// GET /api/device/fcm-status — diagnostic read endpoint
// Reports whether the backend has an FCM/APNs token registered for the
// device, without exposing the token itself. Added to investigate "no
// notifications despite enabled" (card_5385cfeacade16ce86b56378).
// ════════════════════════════════════════════════════════════════
describe('GET /api/device/fcm-status', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await get('/api/device/fcm-status');
        expect(res.status).toBe(400);
    });

    it('returns 401 with wrong deviceSecret', async () => {
        await registerDevice('test-fcm-status-401');
        const res = await get('/api/device/fcm-status?deviceId=test-fcm-status-401&deviceSecret=wrong');
        expect(res.status).toBe(401);
    });

    it('reports unregistered when no token has been sent', async () => {
        const deviceSecret = await registerDevice('test-fcm-status-empty');
        const res = await get(`/api/device/fcm-status?deviceId=test-fcm-status-empty&deviceSecret=${deviceSecret}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.fcm.registered).toBe(false);
        expect(res.body.fcm.prefix).toBeNull();
        expect(res.body.apns.registered).toBe(false);
    });

    it('reports registered + prefix after fcm-token POST', async () => {
        const deviceSecret = await registerDevice('test-fcm-status-set');
        await post('/api/device/fcm-token')
            .send({ deviceId: 'test-fcm-status-set', deviceSecret, token: 'fcmToken-abcdef-123456' });

        const res = await get(`/api/device/fcm-status?deviceId=test-fcm-status-set&deviceSecret=${deviceSecret}`);
        expect(res.status).toBe(200);
        expect(res.body.fcm.registered).toBe(true);
        expect(res.body.fcm.prefix).toBe('fcmToken-abc');
        // Sanity: never leak the full token
        const body = JSON.stringify(res.body);
        expect(body).not.toContain('fcmToken-abcdef-123456');
    });

    it('exposes firebaseAdminInitialized boolean', async () => {
        const deviceSecret = await registerDevice('test-fcm-status-fb');
        const res = await get(`/api/device/fcm-status?deviceId=test-fcm-status-fb&deviceSecret=${deviceSecret}`);
        expect(res.status).toBe(200);
        expect(typeof res.body.firebaseAdminInitialized).toBe('boolean');
    });
});

// ════════════════════════════════════════════════════════════════
// buildFcmNotificationData — FCM `data` payload builder
// Regression guard: sendFcm() calls notifModule.buildFcmNotificationData(notif)
// on EVERY Android push. It was called but never defined/exported, so every
// FCM send threw a TypeError that a silent .catch(()=>{}) swallowed — Android
// "task done" notifications died silently for weeks. These tests fail loudly if
// the export is ever dropped again or returns a non-string value (FCM rejects
// non-string data fields).
// ════════════════════════════════════════════════════════════════
describe('buildFcmNotificationData', () => {
    const notifications = require('../../notifications');

    it('is exported as a function', () => {
        expect(typeof notifications.buildFcmNotificationData).toBe('function');
    });

    it('maps a kanban_done notification to an all-string FCM data payload', () => {
        const data = notifications.buildFcmNotificationData({
            id: 42,
            type: 'kanban',
            category: 'kanban_done',
            title: '✅ 任務完成',
            body: 'Ship the thing',
            link: '/portal/kanban.html?card=abc',
            metadata: { cardId: 'abc', isAuto: false }
        });
        // FCM requires every data value to be a string
        for (const [k, v] of Object.entries(data)) {
            expect(typeof v).toBe('string');
        }
        expect(data.category).toBe('kanban_done');
        expect(data.title).toBe('✅ 任務完成');
        expect(data.link).toBe('/portal/kanban.html?card=abc');
        expect(data.notifId).toBe('42');
        expect(JSON.parse(data.metadata)).toEqual({ cardId: 'abc', isAuto: false });
    });

    it('never throws on missing/empty fields (returns empty strings)', () => {
        const data = notifications.buildFcmNotificationData({});
        expect(typeof data.title).toBe('string');
        expect(data.title).toBe('');
        expect(data.body).toBe('');
        expect(data.category).toBe('');
    });

    it('passes through an already-stringified metadata unchanged', () => {
        const data = notifications.buildFcmNotificationData({ metadata: '{"x":1}' });
        expect(data.metadata).toBe('{"x":1}');
    });
});
