/**
 * /api/transform — senderHint resolution (issue #2285)
 *
 * Verifies that channel bridges can pass `senderHint: { kind, entityId?, publicCode? }`
 * to delegate routing decisions to the server, instead of each bridge
 * implementing its own decideReplyRouting logic. Precedence:
 *   1. explicit speakTo / broadcast  (highest)
 *   2. in-text @-mention tokens
 *   3. senderHint                    (lowest)
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const post = (path) => request(app).post(path).set('Host', 'localhost');

async function registerDevice(id) {
    const secret = `secret-${id}`;
    await post('/api/device/register').send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    return secret;
}

async function bindEntity(deviceId, deviceSecret) {
    const regRes = await post('/api/device/register')
        .send({ deviceId, deviceSecret, entityId: 0 });
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

describe('POST /api/transform — senderHint', () => {
    let deviceId, deviceSecret, botSecret0, botSecret1, entity1PublicCode;

    beforeAll(async () => {
        deviceId = 'sh-device';
        deviceSecret = await registerDevice(deviceId);
        botSecret0 = await bindEntity(deviceId, deviceSecret);
        expect(botSecret0).toBeTruthy();

        // Add a second entity (entityId: 1) so we have a routing target
        const { devices } = require('../../index');
        const addRes = await post('/api/device/add-entity')
            .send({ deviceId, deviceSecret });
        expect(addRes.status).toBe(200);

        // Bind entity 1 by registering and getting binding code
        const regRes2 = await post('/api/device/register')
            .send({ deviceId, deviceSecret, entityId: 1 });
        const code2 = regRes2.body.bindingCode;
        const bindRes2 = await post('/api/bind').send({ code: code2 });
        botSecret1 = bindRes2.body.botSecret;
        expect(botSecret1).toBeTruthy();

        entity1PublicCode = devices[deviceId].entities[1].publicCode;
        expect(entity1PublicCode).toBeTruthy();
    });

    it('resolves senderHint kind=entity with publicCode → fills speakTo', async () => {
        // Bot 1 replies, hinting that the inbound came from entity 0 (publicCode)
        const { devices } = require('../../index');
        const entity0Code = devices[deviceId].entities[0].publicCode;

        const res = await post('/api/transform').send({
            deviceId, entityId: 1, botSecret: botSecret1,
            state: 'IDLE',
            message: 'reply to whoever pinged me',
            senderHint: { kind: 'entity', entityId: 0, publicCode: entity0Code }
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.senderHintResolution).toBeDefined();
        expect(res.body.senderHintResolution.applied).toBe('speakTo');
        expect(res.body.senderHintResolution.publicCode).toBe(entity0Code);
    });

    it('resolves senderHint kind=entity with entityId only (publicCode missing) → fills speakTo', async () => {
        const { devices } = require('../../index');
        const entity0Code = devices[deviceId].entities[0].publicCode;

        const res = await post('/api/transform').send({
            deviceId, entityId: 1, botSecret: botSecret1,
            state: 'IDLE',
            message: 'reply',
            senderHint: { kind: 'entity', entityId: 0 } // no publicCode
        });

        expect(res.status).toBe(200);
        expect(res.body.senderHintResolution.applied).toBe('speakTo');
        expect(res.body.senderHintResolution.publicCode).toBe(entity0Code);
    });

    it('senderHint kind=broadcast → sets broadcast=true', async () => {
        const res = await post('/api/transform').send({
            deviceId, entityId: 1, botSecret: botSecret1,
            state: 'IDLE',
            message: 'announcement',
            senderHint: { kind: 'broadcast' }
        });

        expect(res.status).toBe(200);
        expect(res.body.senderHintResolution.applied).toBe('broadcast');
    });

    it('senderHint kind=user → no routing (status update)', async () => {
        const res = await post('/api/transform').send({
            deviceId, entityId: 1, botSecret: botSecret1,
            state: 'IDLE',
            message: 'thanks for the message!',
            senderHint: { kind: 'user' }
        });

        expect(res.status).toBe(200);
        expect(res.body.senderHintResolution.applied).toBe('none');
        expect(res.body.delivery).toBeUndefined();
    });

    it('explicit speakTo wins over senderHint (precedence)', async () => {
        const { devices } = require('../../index');
        const entity0Code = devices[deviceId].entities[0].publicCode;

        const res = await post('/api/transform').send({
            deviceId, entityId: 1, botSecret: botSecret1,
            state: 'IDLE',
            message: 'reply',
            speakTo: [entity0Code], // explicit
            senderHint: { kind: 'broadcast' } // would otherwise broadcast
        });

        expect(res.status).toBe(200);
        // Explicit speakTo won → no broadcast was applied
        expect(res.body.senderHintResolution.applied).toBe('none');
        expect(res.body.senderHintResolution.reason).toBe('explicit_or_mention_won');
    });

    it('in-text @-mention wins over senderHint (precedence)', async () => {
        const res = await post('/api/transform').send({
            deviceId, entityId: 1, botSecret: botSecret1,
            state: 'IDLE',
            message: '@#0 here is your reply',
            senderHint: { kind: 'broadcast' }
        });

        expect(res.status).toBe(200);
        expect(res.body.senderHintResolution.applied).toBe('none');
        expect(res.body.senderHintResolution.reason).toBe('explicit_or_mention_won');
    });

    it('senderHint kind=entity with unresolvable publicCode → applied:none with reason', async () => {
        const res = await post('/api/transform').send({
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
        const res = await post('/api/transform').send({
            deviceId, entityId: 1, botSecret: botSecret1,
            state: 'IDLE',
            message: 'reply',
            senderHint: 'entity'
        });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/senderHint/);
    });

    it('rejects unknown senderHint.kind', async () => {
        const res = await post('/api/transform').send({
            deviceId, entityId: 1, botSecret: botSecret1,
            state: 'IDLE',
            message: 'reply',
            senderHint: { kind: 'invalid_kind' }
        });

        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/senderHint\.kind/);
    });

    it('omitted senderHint → no senderHintResolution in response (backward compat)', async () => {
        const res = await post('/api/transform').send({
            deviceId, entityId: 1, botSecret: botSecret1,
            state: 'IDLE',
            message: 'reply, no hint'
        });

        expect(res.status).toBe(200);
        expect(res.body.senderHintResolution).toBeUndefined();
    });
});
