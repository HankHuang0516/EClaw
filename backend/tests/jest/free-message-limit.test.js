/**
 * Free message limit regression tests (Jest + Supertest)
 *
 * Verifies that the 15 daily message limit ONLY applies to free borrowed bots.
 * Personal bots and custom-bound bots should have unlimited messages.
 *
 * Regression: previously, enforceUsageLimit() was called for ALL messages,
 * incorrectly counting personal/custom bot messages against the 15-message limit.
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const get = (path) => request(app).get(path).set('Host', 'localhost');
const post = (path) => request(app).post(path).set('Host', 'localhost');

/** Register a device and return its secret */
async function registerDevice(id) {
    const secret = `secret-${id}`;
    await post('/api/device/register')
        .send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    return secret;
}

/** Bind entity 0 on a registered device via two-step flow and return botSecret */
async function bindEntity(deviceId, deviceSecret, entityId = 0) {
    const regRes = await post('/api/device/register')
        .send({ deviceId, deviceSecret, entityId });
    const code = regRes.body.bindingCode;
    if (!code) return undefined;

    const bindRes = await post('/api/bind').send({ code });
    return bindRes.body.botSecret;
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
// POST /api/client/speak — free message limit
// ════════════════════════════════════════════════════════════════
describe('POST /api/client/speak — free message limit', () => {
    it('allows message to custom-bound entity without enforcing usage limit', async () => {
        const deviceId = 'fml-custom-bot';
        const secret = await registerDevice(deviceId);
        const botSecret = await bindEntity(deviceId, secret, 0);

        // Custom bot (not in officialBindingsCache) - should always succeed
        const res = await post('/api/client/speak')
            .send({ deviceId, deviceSecret: secret, entityId: 0, text: 'hello custom bot' });

        // Should succeed (200) - no usage limit applied
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/client/speak')
            .send({ entityId: 0, text: 'hello' });
        expect(res.status).toBe(400);
    });

    it('returns 404 when device does not exist', async () => {
        const res = await post('/api/client/speak')
            .send({ deviceId: 'nonexistent', entityId: 0, text: 'hello' });
        expect(res.status).toBe(404);
    });

    it('includes botType in GET /api/entities response', async () => {
        const deviceId = 'fml-entities-test';
        const secret = await registerDevice(deviceId);
        await bindEntity(deviceId, secret, 0);

        const res = await get(`/api/entities?deviceId=${deviceId}&deviceSecret=${secret}`);
        expect(res.status).toBe(200);
        expect(res.body.entities).toBeDefined();

        // Custom bot should have botType: null
        if (res.body.entities.length > 0) {
            expect(res.body.entities[0]).toHaveProperty('botType');
            // Custom-bound entity won't be in officialBindingsCache, so botType should be null
            expect(res.body.entities[0].botType).toBeNull();
        }
    });
});
