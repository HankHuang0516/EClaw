/**
 * Cross-speak endpoint validation tests (Jest + Supertest)
 *
 * Tests: POST /api/entity/cross-speak   (bot-to-bot cross-device)
 *        POST /api/client/cross-speak   (portal/client cross-device)
 *        POST /api/chat/pending-cross-speak (queued for unverified users)
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
async function bindEntity(deviceId, deviceSecret) {
    // Step 1: register to get a binding code
    const regRes = await post('/api/device/register')
        .send({ deviceId, deviceSecret, entityId: 0 });
    const code = regRes.body.bindingCode;
    if (!code) return undefined;

    // Step 2: bind with the code
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
// POST /api/entity/cross-speak
// ════════════════════════════════════════════════════════════════
describe('POST /api/entity/cross-speak', () => {
    it('returns 400 when deviceId is missing', async () => {
        const res = await post('/api/entity/cross-speak')
            .send({ fromEntityId: 0, botSecret: 'sec', targetCode: 'ABC', text: 'hi' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when botSecret is missing', async () => {
        const res = await post('/api/entity/cross-speak')
            .send({ deviceId: 'dev', fromEntityId: 0, targetCode: 'ABC', text: 'hi' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when targetCode is missing', async () => {
        const res = await post('/api/entity/cross-speak')
            .send({ deviceId: 'dev', fromEntityId: 0, botSecret: 'sec', text: 'hi' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when text is missing', async () => {
        const res = await post('/api/entity/cross-speak')
            .send({ deviceId: 'dev', fromEntityId: 0, botSecret: 'sec', targetCode: 'ABC' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when fromEntityId is missing', async () => {
        const res = await post('/api/entity/cross-speak')
            .send({ deviceId: 'dev', botSecret: 'sec', targetCode: 'ABC', text: 'hi' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 for negative fromEntityId', async () => {
        await registerDevice('cs-neg-eid');
        const res = await post('/api/entity/cross-speak')
            .send({ deviceId: 'cs-neg-eid', fromEntityId: -1, botSecret: 'sec', targetCode: 'ABC', text: 'hi' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Invalid fromEntityId/i);
    });

    it('returns 400 for non-numeric fromEntityId', async () => {
        await registerDevice('cs-nan-eid');
        const res = await post('/api/entity/cross-speak')
            .send({ deviceId: 'cs-nan-eid', fromEntityId: 'abc', botSecret: 'sec', targetCode: 'ABC', text: 'hi' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Invalid fromEntityId/i);
    });

    it('returns 404 when sender device does not exist', async () => {
        const res = await post('/api/entity/cross-speak')
            .send({ deviceId: 'nonexistent-dev', fromEntityId: 0, botSecret: 'sec', targetCode: 'ABC', text: 'hi' });
        expect(res.status).toBe(404);
        expect(res.body.message).toMatch(/Sender device not found/i);
    });

    it('returns 400 when sender entity is not bound', async () => {
        await registerDevice('cs-unbound');
        const res = await post('/api/entity/cross-speak')
            .send({ deviceId: 'cs-unbound', fromEntityId: 0, botSecret: 'sec', targetCode: 'ABC', text: 'hi' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/not bound/i);
    });

    it('returns 403 when botSecret is wrong', async () => {
        const secret = await registerDevice('cs-wrongsec');
        const botSecret = await bindEntity('cs-wrongsec', secret);
        expect(botSecret).toBeTruthy();

        const res = await post('/api/entity/cross-speak')
            .send({ deviceId: 'cs-wrongsec', fromEntityId: 0, botSecret: 'wrong-secret', targetCode: 'ABC', text: 'hi' });
        expect(res.status).toBe(403);
        expect(res.body.message).toMatch(/Invalid botSecret/i);
    });

    it('returns 404 when target publicCode is not found', async () => {
        const secret = await registerDevice('cs-notarget');
        const botSecret = await bindEntity('cs-notarget', secret);
        expect(botSecret).toBeTruthy();

        const res = await post('/api/entity/cross-speak')
            .send({ deviceId: 'cs-notarget', fromEntityId: 0, botSecret, targetCode: 'NONEXISTENT_CODE', text: 'hi' });
        expect(res.status).toBe(404);
        expect(res.body.message).toMatch(/Target public code not found/i);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/client/cross-speak
// ════════════════════════════════════════════════════════════════
describe('POST /api/client/cross-speak', () => {
    it('returns 400 when all required fields are missing', async () => {
        const res = await post('/api/client/cross-speak').send({});
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when targetCode is missing', async () => {
        await registerDevice('cc-notarget');
        const res = await post('/api/client/cross-speak')
            .send({ deviceId: 'cc-notarget', fromEntityId: 0, text: 'hi' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when text is missing', async () => {
        await registerDevice('cc-notext');
        const res = await post('/api/client/cross-speak')
            .send({ deviceId: 'cc-notext', fromEntityId: 0, targetCode: 'ABC' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 when fromEntityId is missing', async () => {
        await registerDevice('cc-noeid');
        const res = await post('/api/client/cross-speak')
            .send({ deviceId: 'cc-noeid', targetCode: 'ABC', text: 'hi' });
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
    });

    it('returns 400 for invalid fromEntityId (below -1)', async () => {
        await registerDevice('cc-badeid');
        const res = await post('/api/client/cross-speak')
            .send({ deviceId: 'cc-badeid', fromEntityId: -5, targetCode: 'ABC', text: 'hi' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Invalid fromEntityId/i);
    });

    it('returns 404 when sender device does not exist', async () => {
        const res = await post('/api/client/cross-speak')
            .send({ deviceId: 'nonexistent-cc', fromEntityId: 0, targetCode: 'ABC', text: 'hi' });
        expect(res.status).toBe(404);
        expect(res.body.message).toMatch(/Sender device not found/i);
    });

    it('returns 400 when sender entity is not bound', async () => {
        await registerDevice('cc-unbound');
        const res = await post('/api/client/cross-speak')
            .send({ deviceId: 'cc-unbound', fromEntityId: 0, targetCode: 'ABC', text: 'hi' });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/not bound/i);
    });

    it('returns 404 when target publicCode is not found', async () => {
        const secret = await registerDevice('cc-notargetpc');
        const botSecret = await bindEntity('cc-notargetpc', secret);
        expect(botSecret).toBeTruthy();

        const res = await post('/api/client/cross-speak')
            .send({ deviceId: 'cc-notargetpc', fromEntityId: 0, targetCode: 'MISSING_CODE', text: 'hi' });
        expect(res.status).toBe(404);
        expect(res.body.message).toMatch(/Target public code not found/i);
    });

    it('accepts owner mode (fromEntityId=-1) without entity binding', async () => {
        await registerDevice('cc-owner');
        // fromEntityId=-1 is owner mode — no entity needed, but target must exist
        const res = await post('/api/client/cross-speak')
            .send({ deviceId: 'cc-owner', fromEntityId: -1, targetCode: 'SOME_CODE', text: 'hi' });
        // Should reach target resolution (404) not entity validation
        expect(res.status).toBe(404);
        expect(res.body.message).toMatch(/Target public code not found/i);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/chat/pending-cross-speak
// ════════════════════════════════════════════════════════════════
describe('POST /api/chat/pending-cross-speak', () => {
    it('returns 401 when no user session is present', async () => {
        // softAuthMiddleware is noop in test, so req.user is undefined
        const res = await post('/api/chat/pending-cross-speak')
            .send({ targetCode: 'ABC', text: 'hello' });
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toMatch(/Authentication required/i);
    });

    it('returns 401 when targetCode is missing (auth takes precedence)', async () => {
        // softAuth is noop so req.user stays undefined → 401 before 400
        const res = await post('/api/chat/pending-cross-speak')
            .send({ text: 'hello' });
        expect(res.status).toBe(401);
    });

    it('returns 401 when text is missing (auth takes precedence)', async () => {
        const res = await post('/api/chat/pending-cross-speak')
            .send({ targetCode: 'ABC' });
        // Without req.user, 401 takes precedence over 400
        expect(res.status).toBe(401);
    });

    it('returns 401 regardless of valid payload when unauthenticated', async () => {
        const res = await post('/api/chat/pending-cross-speak')
            .send({ targetCode: 'VALID_CODE', text: 'valid message' });
        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
    });
});
