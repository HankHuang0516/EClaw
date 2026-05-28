/**
 * Official borrow binding reuse tests.
 *
 * Path B hardening: a repeated bind-free call for an already valid persistent
 * official binding must be idempotent. It should not auto-unbind, handshake,
 * regenerate credentials, or resend BIND_COMPLETE.
 */

require('./helpers/mock-setup');

const request = require('supertest');
const db = require('../../db');
const gatekeeper = require('../../gatekeeper');

let app;

const get = (path) => request(app).get(path).set('Host', 'localhost').set('Accept-Encoding', 'identity');
const post = (path) => request(app).post(path).set('Host', 'localhost').set('Accept-Encoding', 'identity');

beforeAll(() => {
    app = require('../../index');
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

function clearMap(map) {
    for (const key of Object.keys(map)) delete map[key];
}

function seedValidFreeBinding({ ageMs = 60 * 1000, botId = 'free-reuse-bot' } = {}) {
    const deviceId = 'reuse-device';
    const deviceSecret = 'reuse-secret';
    const now = Date.now();
    const sessionKey = 'default:org:reuse-device:entity:0';
    const webhookUrl = 'https://gateway.example/tools/invoke';
    const token = 'gateway-token';
    const publicCode = 'abc123';

    const entity = {
        ...app._createDefaultEntity(0),
        entityId: 0,
        isBound: true,
        botSecret: 'entity-bot-secret',
        publicCode,
        name: '免費版',
        state: 'IDLE',
        message: 'Connected!',
        rebindCount: 4,
        lastRebindAt: now - ageMs,
        lastUpdated: now - ageMs,
        webhook: {
            url: webhookUrl,
            token,
            sessionKey,
            registeredAt: now - ageMs,
        },
    };

    app.devices[deviceId] = {
        deviceId,
        deviceSecret,
        createdAt: now - ageMs,
        nextEntityId: 1,
        entities: { 0: entity },
    };
    app._publicCodeIndex[publicCode] = { deviceId, entityId: 0 };

    app._officialBorrowTest.officialBots[botId] = {
        bot_id: botId,
        bot_type: 'free',
        webhook_url: webhookUrl,
        token,
        status: 'assigned',
        session_key_template: 'default',
    };

    const binding = {
        bot_id: botId,
        device_id: deviceId,
        entity_id: 0,
        session_key: sessionKey,
        bound_at: now - ageMs,
        subscription_verified_at: now - ageMs,
    };
    app._officialBorrowTest.officialBindingsCache[
        app._officialBorrowTest.getBindingCacheKey(deviceId, 0)
    ] = binding;

    return { deviceId, deviceSecret, botId, binding, entity };
}

beforeEach(() => {
    clearMap(app.devices);
    clearMap(app._publicCodeIndex);
    clearMap(app._officialBorrowTest.officialBots);
    clearMap(app._officialBorrowTest.officialBindingsCache);
    gatekeeper.isDeviceBlocked.mockReturnValue(false);
    gatekeeper.hasAgreedToTOS.mockReturnValue(true);
    db.getOfficialBinding.mockImplementation(async (deviceId, entityId) => {
        return app._officialBorrowTest.officialBindingsCache[
            app._officialBorrowTest.getBindingCacheKey(deviceId, entityId)
        ] || null;
    });
});

describe('official borrow free binding reuse', () => {
    it('reports a valid persistent free binding as reusable', async () => {
        const { deviceId, deviceSecret, botId } = seedValidFreeBinding();

        const res = await get('/api/official-borrow/binding-status')
            .query({ deviceId, deviceSecret, entityId: 0, botType: 'free', botId });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.bound).toBe(true);
        expect(res.body.valid).toBe(true);
        expect(res.body.reusable).toBe(true);
        expect(res.body.reason).toBe('valid');
        expect(res.body.recommendation).toBe('reuse_existing_binding');
        expect(res.body.skipBindFree).toBe(true);
        expect(res.body.ttlMs).toBe(app._officialBorrowTest.OFFICIAL_FREE_BINDING_REUSE_TTL_MS);
        expect(res.body.remainingMs).toBeGreaterThan(0);
    });

    it('makes repeated bind-free idempotent while the binding TTL is valid', async () => {
        const { deviceId, deviceSecret, botId } = seedValidFreeBinding();
        const before = app.devices[deviceId].entities[0];

        const res = await post('/api/official-borrow/bind-free')
            .send({ deviceId, deviceSecret, entityId: 0, botId });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.reusedExistingBinding).toBe(true);
        expect(res.body.idempotent).toBe(true);
        expect(res.body.bindingStatus.valid).toBe(true);

        const after = app.devices[deviceId].entities[0];
        expect(after.botSecret).toBe(before.botSecret);
        expect(after.rebindCount).toBe(before.rebindCount);
        expect(after.lastRebindAt).toBe(before.lastRebindAt);
        expect(after.webhook.registeredAt).toBe(before.webhook.registeredAt);
        expect(after.publicCode).toBe(before.publicCode);
    });

    it('marks the binding non-reusable when the reuse TTL has expired', async () => {
        const ttl = app._officialBorrowTest.OFFICIAL_FREE_BINDING_REUSE_TTL_MS;
        const { deviceId, deviceSecret, botId } = seedValidFreeBinding({ ageMs: ttl + 1000 });

        const res = await get('/api/official-borrow/binding-status')
            .query({ deviceId, deviceSecret, entityId: 0, botType: 'free', botId });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.bound).toBe(true);
        expect(res.body.valid).toBe(false);
        expect(res.body.reusable).toBe(false);
        expect(res.body.reason).toBe('binding_reuse_ttl_expired');
        expect(res.body.recommendation).toBe('bind_required');
        expect(res.body.skipBindFree).toBe(false);
        expect(res.body.remainingMs).toBe(0);
    });
});
