/**
 * POST /api/device/tts — delivery-awareness tests (Jest + Supertest)
 *
 * Regression coverage for Bug #161 / GH #2862
 * ("tts 語音發送失敗 手機裝置沒聽到聲音"):
 *
 * The endpoint used to emit a Socket.IO event + fire sendFcm() without ever
 * checking whether EITHER channel could reach the device, yet always returned
 * success:true. When the device was offline AND had no fcmToken
 * (log: "fcm_send: skip: no fcmToken for device") the audio silently vanished
 * but the bot was told it succeeded.
 *
 * These tests pin the response *shape* so a regression to silent
 * fire-and-forget is caught:
 *   - validation / auth still behaves
 *   - offline + no FCM  -> success:true BUT delivered:false +
 *                          warning:"tts_not_delivered" + via:[] + message present
 *   - lang/speed/pitch echoed back and clamped to defaults
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const post = (path) => request(app).post(path).set('Host', 'localhost');

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

describe('POST /api/device/tts — validation & auth', () => {
    it('400 when deviceId missing', async () => {
        const res = await post('/api/device/tts').send({ text: 'hi' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('400 when text missing', async () => {
        const res = await post('/api/device/tts').send({ deviceId: 'tts-d1' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('400 when text exceeds 500 chars', async () => {
        const deviceId = 'tts-long';
        const secret = await registerDevice(deviceId);
        const res = await post('/api/device/tts')
            .send({ deviceId, deviceSecret: secret, entityId: 0, text: 'x'.repeat(501) });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/500 characters/i);
    });

    it('404 for unknown device', async () => {
        const res = await post('/api/device/tts')
            .send({ deviceId: 'tts-nope', deviceSecret: 'sec', text: 'hi' });
        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
    });

    it('400 for negative entityId', async () => {
        const deviceId = 'tts-neg';
        const secret = await registerDevice(deviceId);
        const res = await post('/api/device/tts')
            .send({ deviceId, deviceSecret: secret, entityId: -1, text: 'hi' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid entityId/i);
    });

    it('403/400 for wrong botSecret on unbound entity', async () => {
        const deviceId = 'tts-auth';
        await registerDevice(deviceId);
        const res = await post('/api/device/tts')
            .send({ deviceId, botSecret: 'wrong', entityId: 0, text: 'hi' });
        expect([400, 403]).toContain(res.status);
        expect(res.body.success).toBe(false);
    });
});

describe('POST /api/device/tts — Bug #161 delivery awareness', () => {
    it('offline device with no FCM token reports delivered:false + tts_not_delivered', async () => {
        const deviceId = 'tts-offline';
        const secret = await registerDevice(deviceId);

        const res = await post('/api/device/tts')
            .send({ deviceId, deviceSecret: secret, entityId: 0, text: '您好' });

        // Request itself is valid (200/success:true) but delivery is honestly false
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.delivered).toBe(false);
        expect(res.body.warning).toBe('tts_not_delivered');
        expect(Array.isArray(res.body.via)).toBe(true);
        expect(res.body.via).toHaveLength(0);
        // Non-empty, actionable message so a bot does not falsely claim success
        expect(typeof res.body.message).toBe('string');
        expect(res.body.message.length).toBeGreaterThan(0);
    });

    it('response always carries the delivered flag (never silent fire-and-forget)', async () => {
        const deviceId = 'tts-shape';
        const secret = await registerDevice(deviceId);
        const res = await post('/api/device/tts')
            .send({ deviceId, deviceSecret: secret, entityId: 0, text: 'hello' });
        expect(res.body).toHaveProperty('delivered');
        expect(res.body).toHaveProperty('via');
    });

    it('echoes & clamps lang/speed/pitch to defaults for out-of-range input', async () => {
        const deviceId = 'tts-params';
        const secret = await registerDevice(deviceId);
        const res = await post('/api/device/tts')
            .send({ deviceId, deviceSecret: secret, entityId: 0, text: 'hi',
                    lang: 'en-US', speed: 99, pitch: 0.01 });
        expect(res.status).toBe(200);
        expect(res.body.lang).toBe('en-US');
        expect(res.body.speed).toBe(1.0); // 99 out of [0.5,2.0] -> default
        expect(res.body.pitch).toBe(1.0); // 0.01 out of range -> default
    });
});
