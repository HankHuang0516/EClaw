/**
 * /api/transform — first-token-only @-mention auto-promote guard (card_2ee0afbb defect 2)
 *
 * The /api/channel seam already restricts auto-promoting an in-text @-mention to
 * `speakTo` to messages whose FIRST non-whitespace/non-emoji token IS the
 * mention (channel-api.js, via messageStartsWithMention). /api/transform was
 * MISSING that guard, so a message that merely CONTAINED a mention mid-body
 * ("this is broken, ask @#1 to take a look") hijacked routing and delivered the
 * reply into the referenced entity's chat history.
 *
 * Failure path exercised: with the guard removed, the mid-text case below
 * resolves via 'mention' and routes to entity 1 (the bug). With the guard, it
 * resolves to nothing. A genuine LEADING mention must still route.
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

describe('POST /api/transform — first-token-only @-mention guard', () => {
    let deviceId, deviceSecret, botSecret0, entity1PublicCode;

    beforeAll(async () => {
        deviceId = 'ft-device';
        deviceSecret = await registerDevice(deviceId);
        botSecret0 = await bindEntity(deviceId, deviceSecret, 0);

        const addRes = await post('/api/device/add-entity').send({ deviceId, deviceSecret });
        expect(addRes.status).toBe(200);

        await bindEntity(deviceId, deviceSecret, 1);

        const { devices } = require('../../index');
        entity1PublicCode = devices[deviceId].entities[1].publicCode;
        expect(entity1PublicCode).toBeTruthy();
    });

    it('a MID-TEXT @#N mention is NOT auto-promoted to speakTo (the defect)', async () => {
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 0,
            botSecret: botSecret0,
            state: 'IDLE',
            message: 'this is broken, ask @#1 to take a look'
        });

        expect(res.status).toBe(200);
        // Pre-fix this resolved via 'mention' and routed to entity 1.
        expect(res.body.routing.resolvedVia).toBeNull();
        expect(res.body.routing.routedTo).toHaveLength(0);
    });

    it('a MID-TEXT bare @publicCode mention is NOT auto-promoted either', async () => {
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 0,
            botSecret: botSecret0,
            state: 'IDLE',
            message: `please review the PR, then ping @${entity1PublicCode} for the ack`
        });

        expect(res.status).toBe(200);
        expect(res.body.routing.resolvedVia).toBeNull();
        expect(res.body.routing.routedTo).toHaveLength(0);
    });

    it('a LEADING @#N mention STILL auto-promotes to speakTo (legit routing preserved)', async () => {
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 0,
            botSecret: botSecret0,
            state: 'IDLE',
            message: '@#1 please ack this'
        });

        expect(res.status).toBe(200);
        expect(res.body.routing.resolvedVia).toBe('mention');
        expect(res.body.routing.routedTo).toHaveLength(1);
        expect(res.body.routing.routedTo[0]).toMatchObject({
            kind: 'entity',
            entityId: 1,
            publicCode: entity1PublicCode
        });
    });

    it('a LEADING bare @publicCode mention STILL auto-promotes to speakTo', async () => {
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 0,
            botSecret: botSecret0,
            state: 'IDLE',
            message: `@${entity1PublicCode} please ack this`
        });

        expect(res.status).toBe(200);
        expect(res.body.routing.resolvedVia).toBe('mention');
        expect(res.body.routing.routedTo).toHaveLength(1);
        expect(res.body.routing.routedTo[0]).toMatchObject({
            kind: 'entity',
            entityId: 1,
            publicCode: entity1PublicCode
        });
    });

    it('a leading emoji before the @mention still counts as first-token (parity with /api/channel)', async () => {
        const res = await post('/api/transform').send({
            deviceId,
            entityId: 0,
            botSecret: botSecret0,
            state: 'IDLE',
            message: `\u{1F44B} @${entity1PublicCode} ack please`
        });

        expect(res.status).toBe(200);
        expect(res.body.routing.resolvedVia).toBe('mention');
        expect(res.body.routing.routedTo).toHaveLength(1);
    });
});
