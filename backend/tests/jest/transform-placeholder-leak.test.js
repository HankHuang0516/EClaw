/**
 * Transform placeholder-leak suppression tests (PR #2986 follow-up).
 *
 * The BIND_COMPLETE skill doc IMMEDIATE ACTION example uses
 * `<one-time-bind-ack-do-not-copy>` as a template placeholder. Bots have been
 * mis-copying it verbatim into real /api/transform calls, leaking template
 * text into chat / routing / hooks. Server now suppresses all propagation
 * when the message body equals that exact placeholder.
 *
 * Validates:
 * 1. entity.message is NOT updated to the placeholder
 * 2. Placeholder does NOT save to chat history
 * 3. Placeholder does NOT deliver via speakTo
 * 4. Regular messages still work after a placeholder hit (regression)
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const post = (path) => request(app).post(path).set('Host', 'localhost').set('Accept-Encoding', 'identity');
const get = (path) => request(app).get(path).set('Host', 'localhost').set('Accept-Encoding', 'identity');

async function bindEntity(deviceId, deviceSecret, entityId = 0) {
    if (entityId > 0) {
        await post('/api/device/add-entity').send({ deviceId, deviceSecret });
    }
    const regRes = await post('/api/device/register').send({ deviceId, deviceSecret, entityId });
    const code = regRes.body.bindingCode;
    if (!code) return undefined;
    const bindRes = await post('/api/bind').send({ code });
    return bindRes.body.botSecret;
}

async function getEntity(deviceId, deviceSecret, entityId) {
    const res = await get('/api/entities').query({ deviceId, deviceSecret });
    return (res.body.entities || []).find(e => e.entityId === entityId);
}

beforeAll(() => { app = require('../../index'); });
afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

describe('Transform placeholder-leak suppression', () => {
    const deviceId = 'placeholder-leak-test';
    const deviceSecret = `secret-${deviceId}`;
    const PLACEHOLDER = '<one-time-bind-ack-do-not-copy>';
    let botSecret0, peerCode;

    beforeAll(async () => {
        botSecret0 = await bindEntity(deviceId, deviceSecret, 0);
        await bindEntity(deviceId, deviceSecret, 1);
        const peer = await getEntity(deviceId, deviceSecret, 1);
        peerCode = peer.publicCode;
    });

    it('returns success but does NOT update entity.message to the placeholder', async () => {
        const before = await getEntity(deviceId, deviceSecret, 0);
        const baselineMessage = before.message;

        const res = await post('/api/transform').send({
            deviceId, entityId: 0, botSecret: botSecret0,
            message: PLACEHOLDER, state: 'IDLE'
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const after = await getEntity(deviceId, deviceSecret, 0);
        expect(after.message).not.toBe(PLACEHOLDER);
        expect(after.message).toBe(baselineMessage);
    });

    it('does NOT deliver the placeholder via speakTo', async () => {
        const res = await post('/api/transform').send({
            deviceId, entityId: 0, botSecret: botSecret0,
            message: PLACEHOLDER, state: 'IDLE',
            speakTo: [peerCode]
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        // delivery block is omitted when the placeholder guard skips the
        // speakTo/broadcast branch — no chat row, no peer fan-out.
        expect(res.body.delivery).toBeUndefined();
    });

    it('does NOT add the placeholder to chat history', async () => {
        await post('/api/transform').send({
            deviceId, entityId: 0, botSecret: botSecret0,
            message: PLACEHOLDER, state: 'IDLE'
        });

        const histRes = await get('/api/chat/history')
            .query({ deviceId, botSecret: botSecret0, entityId: 0, limit: 50 });

        const messages = histRes.body.messages || [];
        const leaked = messages.find(m => (m.text || m.message || '') === PLACEHOLDER);
        expect(leaked).toBeUndefined();
    });

    it('still saves and updates entity.message for a real reply after a placeholder hit', async () => {
        await post('/api/transform').send({
            deviceId, entityId: 0, botSecret: botSecret0,
            message: PLACEHOLDER, state: 'IDLE'
        });

        const real = 'real reply after placeholder';
        const res = await post('/api/transform').send({
            deviceId, entityId: 0, botSecret: botSecret0,
            message: real, state: 'IDLE'
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        const after = await getEntity(deviceId, deviceSecret, 0);
        expect(after.message).toBe(real);
    });
});
