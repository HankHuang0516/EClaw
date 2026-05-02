/**
 * /api/channel/message — senderHint resolution (Phase 3a of issue #2285)
 *
 * Mirrors the senderHint contract from /api/transform onto the channel-bridge
 * endpoint so codex / hermes / openclaw bridges can delegate routing to the
 * server without each one reimplementing decideReplyRouting.
 */

require('./helpers/mock-setup');

const db = require('../../db');
const apiKey = 'eck_sender_hint_test';
const account = { id: 1, channel_api_key: apiKey, channel_api_secret: 'ecs_test', deviceId: null, entityId: null };
db.getChannelAccountByKey = jest.fn().mockImplementation(async (key) => key === apiKey ? account : null);
db.getChannelAccountsByDevice = jest.fn().mockResolvedValue([]);
db.createChannelAccount = jest.fn().mockResolvedValue(account);
db.getChannelAccountById = jest.fn().mockResolvedValue(null);
db.deleteChannelAccount = jest.fn().mockResolvedValue(true);
db.updateChannelCallback = jest.fn().mockResolvedValue(true);
db.updateChannelE2eeCapable = jest.fn().mockResolvedValue(true);
db.clearChannelCallback = jest.fn().mockResolvedValue(true);
db.getChannelAccountByDevice = jest.fn().mockResolvedValue(null);

const request = require('supertest');
let app;

const post = (path) => request(app).post(path).set('Host', 'localhost');

async function registerDevice(id) {
    const secret = `secret-${id}`;
    await post('/api/device/register').send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    return secret;
}

async function bindEntity(deviceId, deviceSecret, entityId = 0) {
    const regRes = await post('/api/device/register').send({ deviceId, deviceSecret, entityId });
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
});

describe('POST /api/channel/message — senderHint', () => {
    let deviceId, deviceSecret, botSecret1, entity0Code;

    beforeAll(async () => {
        deviceId = 'chmsg-sh-device';
        deviceSecret = await registerDevice(deviceId);
        await bindEntity(deviceId, deviceSecret, 0);
        await post('/api/device/add-entity').send({ deviceId, deviceSecret });
        botSecret1 = await bindEntity(deviceId, deviceSecret, 1);

        const { devices } = require('../../index');
        entity0Code = devices[deviceId].entities[0].publicCode;
        expect(botSecret1).toBeTruthy();
        expect(entity0Code).toBeTruthy();
    });

    it('resolves senderHint kind=entity with publicCode → fills speakTo', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 1, botSecret: botSecret1,
            state: 'IDLE',
            message: 'reply via channel',
            senderHint: { kind: 'entity', entityId: 0, publicCode: entity0Code }
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.senderHintResolution).toEqual({
            kind: 'entity',
            applied: 'speakTo',
            publicCode: entity0Code
        });
    });

    it('resolves senderHint kind=entity with entityId only → fills speakTo via local lookup', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 1, botSecret: botSecret1,
            state: 'IDLE',
            message: 'reply',
            senderHint: { kind: 'entity', entityId: 0 }
        });
        expect(res.status).toBe(200);
        expect(res.body.senderHintResolution.applied).toBe('speakTo');
        expect(res.body.senderHintResolution.publicCode).toBe(entity0Code);
    });

    it('senderHint kind=broadcast → sets broadcast=true', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 1, botSecret: botSecret1,
            state: 'IDLE',
            message: 'announcement',
            senderHint: { kind: 'broadcast' }
        });
        expect(res.status).toBe(200);
        expect(res.body.senderHintResolution.applied).toBe('broadcast');
    });

    it('senderHint kind=user → no routing (status update)', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 1, botSecret: botSecret1,
            state: 'IDLE',
            message: 'thanks!',
            senderHint: { kind: 'user' }
        });
        expect(res.status).toBe(200);
        expect(res.body.senderHintResolution.applied).toBe('none');
    });

    it('explicit speakTo wins over senderHint', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 1, botSecret: botSecret1,
            state: 'IDLE',
            message: 'reply',
            speakTo: [entity0Code],
            senderHint: { kind: 'broadcast' }
        });
        expect(res.status).toBe(200);
        expect(res.body.senderHintResolution.applied).toBe('none');
        expect(res.body.senderHintResolution.reason).toBe('explicit_won');
    });

    it('senderHint with unresolvable publicCode → applied:none with reason', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 1, botSecret: botSecret1,
            state: 'IDLE',
            message: 'reply',
            senderHint: { kind: 'entity', publicCode: 'doesnotexist', entityId: 999 }
        });
        expect(res.status).toBe(200);
        expect(res.body.senderHintResolution.applied).toBe('none');
        expect(res.body.senderHintResolution.reason).toBe('unresolved_sender');
    });

    it('rejects malformed senderHint (non-object)', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 1, botSecret: botSecret1,
            state: 'IDLE', message: 'x',
            senderHint: 'entity'
        });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/senderHint/);
    });

    it('rejects unknown senderHint.kind', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 1, botSecret: botSecret1,
            state: 'IDLE', message: 'x',
            senderHint: { kind: 'invalid_kind' }
        });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/senderHint\.kind/);
    });

    it('omitted senderHint → no senderHintResolution in response (backward compat)', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 1, botSecret: botSecret1,
            state: 'IDLE',
            message: 'no hint'
        });
        expect(res.status).toBe(200);
        expect(res.body.senderHintResolution).toBeUndefined();
    });
});
