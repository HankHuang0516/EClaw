/**
 * /api/transform — routing diagnostics + heartbeat (Platform-P1 delivery confirmation)
 *
 * Covers the acceptance criteria from the Platform-P1 card:
 *   1. speakTo without matching @-mention → MENTION_MISSING_FOR_speakTo warning
 *   2. speakTo to dead-daemon entity → recipientLastSeen + stale flag in routing
 *   3. POST /api/entity/heartbeat updates last_seen and GET /api/entity/status reflects it
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const post = (path) => request(app).post(path).set('Host', 'localhost');
const get = (path) => request(app).get(path).set('Host', 'localhost');

async function registerDevice(id) {
    const secret = `secret-${id}`;
    await post('/api/device/register').send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    return secret;
}

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

describe('POST /api/transform — routing diagnostics', () => {
    let deviceId, deviceSecret, botSecret0, botSecret1, entity1PublicCode;

    beforeAll(async () => {
        deviceId = 'rd-device';
        deviceSecret = await registerDevice(deviceId);
        botSecret0 = await bindEntity(deviceId, deviceSecret, 0);

        const addRes = await post('/api/device/add-entity').send({ deviceId, deviceSecret });
        expect(addRes.status).toBe(200);

        botSecret1 = await bindEntity(deviceId, deviceSecret, 1);
        expect(botSecret1).toBeTruthy();

        const { devices } = require('../../index');
        entity1PublicCode = devices[deviceId].entities[1].publicCode;
        expect(entity1PublicCode).toBeTruthy();
    });

    it('speakTo without matching @-mention → warning MENTION_MISSING_FOR_speakTo:<id>', async () => {
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 0,
            botSecret: botSecret0,
            state: 'IDLE',
            message: 'forward this without a mention token',
            speakTo: [entity1PublicCode]
        });

        expect(res.status).toBe(200);
        expect(res.body.routing.resolvedVia).toBe('speakTo');
        expect(res.body.routing.routedTo).toHaveLength(1);
        expect(res.body.routing.routedTo[0]).toMatchObject({
            kind: 'entity',
            entityId: 1,
            publicCode: entity1PublicCode
        });
        expect(res.body.routing.warnings).toContain('MENTION_MISSING_FOR_speakTo:1');
    });

    it('speakTo with matching @#N in body → no MENTION_MISSING warning', async () => {
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 0,
            botSecret: botSecret0,
            state: 'IDLE',
            message: '@#1 please ack',
            speakTo: [entity1PublicCode]
        });

        expect(res.status).toBe(200);
        expect(res.body.routing.warnings.filter(w => /^MENTION_MISSING_FOR_speakTo:/.test(w))).toEqual([]);
    });

    it('routing to entity without heartbeat → stale=true and recipientLastSeen=null', async () => {
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 0,
            botSecret: botSecret0,
            state: 'IDLE',
            message: '@#1 ping',
            speakTo: [entity1PublicCode]
        });

        expect(res.status).toBe(200);
        expect(res.body.routing.routedTo).toHaveLength(1);
        expect(res.body.routing.stale).toBe(true);
        expect(res.body.routing.recipientLastSeen).toBeNull();
    });

    it('routing to entity with fresh heartbeat → stale=false and recipientLastSeen=ISO', async () => {
        const hbRes = await post('/api/entity/heartbeat').send({
            deviceId,
            entityId: 1,
            botSecret: botSecret1
        });
        expect(hbRes.status).toBe(200);
        expect(hbRes.body.lastSeen).toBeTruthy();

        const res = await post('/api/transform').send({
            deviceId,
            entityId: 0,
            botSecret: botSecret0,
            state: 'IDLE',
            message: '@#1 ping again',
            speakTo: [entity1PublicCode]
        });

        expect(res.status).toBe(200);
        expect(res.body.routing.stale).toBe(false);
        expect(res.body.routing.recipientLastSeen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
});

describe('POST /api/entity/heartbeat — last_seen tracking', () => {
    let deviceId, deviceSecret, botSecret0;

    beforeAll(async () => {
        deviceId = 'hb-device';
        deviceSecret = await registerDevice(deviceId);
        botSecret0 = await bindEntity(deviceId, deviceSecret, 0);
        expect(botSecret0).toBeTruthy();
    });

    it('updates lastSeen and returns daemonConnected=true with botSecret auth', async () => {
        const before = new Date().toISOString();
        const res = await post('/api/entity/heartbeat').send({
            deviceId,
            entityId: 0,
            botSecret: botSecret0
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.entityId).toBe(0);
        expect(res.body.daemonConnected).toBe(true);
        expect(res.body.stale).toBe(false);
        expect(res.body.lastSeen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(res.body.lastSeen >= before).toBe(true);
    });

    it('GET /api/entity/status reflects the recorded heartbeat (botSecret-authed)', async () => {
        await post('/api/entity/heartbeat').send({
            deviceId,
            entityId: 0,
            botSecret: botSecret0
        });

        const res = await get(`/api/entity/status?deviceId=${deviceId}&entityId=0&botSecret=${botSecret0}`);
        expect(res.status).toBe(200);
        expect(res.body.entityId).toBe(0);
        expect(res.body.daemonConnected).toBe(true);
        expect(res.body.stale).toBe(false);
        expect(res.body.lastSeen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('GET /api/entity/status accepts deviceSecret as fallback to botSecret', async () => {
        const res = await get(`/api/entity/status?deviceId=${deviceId}&entityId=0&deviceSecret=${deviceSecret}`);
        expect(res.status).toBe(200);
        expect(res.body.entityId).toBe(0);
    });

    it('GET /api/entity/status rejects unauthenticated read (no creds → 403)', async () => {
        const res = await get(`/api/entity/status?deviceId=${deviceId}&entityId=0`);
        expect(res.status).toBe(403);
        expect(res.body.daemonConnected).toBeUndefined();
        expect(res.body.lastSeen).toBeUndefined();
    });

    it('GET /api/entity/status rejects wrong botSecret', async () => {
        const res = await get(`/api/entity/status?deviceId=${deviceId}&entityId=0&botSecret=wrong-secret`);
        expect(res.status).toBe(403);
        expect(res.body.daemonConnected).toBeUndefined();
    });

    it('accepts deviceSecret auth as fallback to botSecret', async () => {
        const res = await post('/api/entity/heartbeat').send({
            deviceId,
            entityId: 0,
            deviceSecret
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('rejects heartbeat with invalid credentials', async () => {
        const res = await post('/api/entity/heartbeat').send({
            deviceId,
            entityId: 0,
            botSecret: 'wrong-secret'
        });

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
    });

    it('rejects heartbeat for unbound entityId', async () => {
        const res = await post('/api/entity/heartbeat').send({
            deviceId,
            entityId: 99,
            botSecret: botSecret0
        });

        expect(res.status).toBe(400);
    });
});
