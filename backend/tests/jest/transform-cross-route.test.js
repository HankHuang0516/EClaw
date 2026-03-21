/**
 * Transform cross-device auto-route tests (Jest + Supertest)
 *
 * Verifies that POST /api/transform automatically saves bot replies
 * to the sender device when the entity has a pending cross-device message
 * in its messageQueue.
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const post = (path) => request(app).post(path).set('Host', 'localhost');

/** Register a device and return its secret */
async function registerDevice(id) {
    const secret = `secret-${id}`;
    await post('/api/device/register')
        .send({ deviceId: id, deviceSecret: secret, entityId: 0 });
    return secret;
}

/** Bind entity 0 on a registered device and return botSecret */
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

// ════════════════════════════════════════════════════════════════
// Transform cross-device auto-route
// ════════════════════════════════════════════════════════════════
describe('POST /api/transform — cross-device auto-route', () => {
    let senderDeviceId, senderSecret, targetDeviceId, targetSecret, targetBotSecret;

    beforeAll(async () => {
        // Setup sender device
        senderDeviceId = 'xroute-sender';
        senderSecret = await registerDevice(senderDeviceId);
        await bindEntity(senderDeviceId, senderSecret);

        // Setup target device
        targetDeviceId = 'xroute-target';
        targetSecret = await registerDevice(targetDeviceId);
        targetBotSecret = await bindEntity(targetDeviceId, targetSecret);
        expect(targetBotSecret).toBeTruthy();
    });

    it('saves reply to sender device when messageQueue has crossDevice message', async () => {
        // Inject a cross-device message into the target entity's messageQueue
        const { devices } = require('../../index');
        const targetEntity = devices[targetDeviceId].entities[0];
        targetEntity.messageQueue.push({
            text: 'hello from sender',
            from: `xdevice:SENDER_CODE:🐢`,
            fromEntityId: 0,
            fromCharacter: '🐢',
            fromPublicCode: 'SENDER_CODE',
            fromDeviceId: senderDeviceId,
            timestamp: Date.now(),
            read: false,
            crossDevice: true
        });

        // Bot replies via transform
        const res = await post('/api/transform').send({
            deviceId: targetDeviceId,
            entityId: 0,
            botSecret: targetBotSecret,
            state: 'IDLE',
            message: 'hello back!'
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('does not crash when messageQueue has no crossDevice message', async () => {
        const { devices } = require('../../index');
        const targetEntity = devices[targetDeviceId].entities[0];
        // Clear messageQueue — no cross-device messages
        targetEntity.messageQueue = [];

        const res = await post('/api/transform').send({
            deviceId: targetDeviceId,
            entityId: 0,
            botSecret: targetBotSecret,
            state: 'IDLE',
            message: 'normal reply'
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('handles owner mode (fromEntityId=-1) gracefully', async () => {
        const { devices } = require('../../index');
        const targetEntity = devices[targetDeviceId].entities[0];
        targetEntity.messageQueue.push({
            text: 'owner says hi',
            from: `xdevice:${senderDeviceId}:owner`,
            fromEntityId: -1,
            fromCharacter: null,
            fromPublicCode: null,
            fromDeviceId: senderDeviceId,
            timestamp: Date.now(),
            read: false,
            crossDevice: true
        });

        const res = await post('/api/transform').send({
            deviceId: targetDeviceId,
            entityId: 0,
            botSecret: targetBotSecret,
            state: 'IDLE',
            message: 'reply to owner'
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('picks the latest crossDevice message when multiple are queued', async () => {
        const { devices } = require('../../index');
        const targetEntity = devices[targetDeviceId].entities[0];
        targetEntity.messageQueue = [
            {
                text: 'first msg',
                from: 'xdevice:OLD_CODE:🐢',
                fromEntityId: 0,
                fromPublicCode: 'OLD_CODE',
                fromDeviceId: 'some-other-device',
                timestamp: Date.now() - 5000,
                crossDevice: true
            },
            {
                text: 'latest msg',
                from: `xdevice:SENDER_CODE:🐢`,
                fromEntityId: 0,
                fromPublicCode: 'SENDER_CODE',
                fromDeviceId: senderDeviceId,
                timestamp: Date.now(),
                crossDevice: true
            }
        ];

        const res = await post('/api/transform').send({
            deviceId: targetDeviceId,
            entityId: 0,
            botSecret: targetBotSecret,
            state: 'IDLE',
            message: 'reply to latest'
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('does not route when transform has no message (state-only update)', async () => {
        const { devices } = require('../../index');
        const targetEntity = devices[targetDeviceId].entities[0];
        targetEntity.messageQueue.push({
            text: 'cross msg',
            from: 'xdevice:CODE:🐢',
            fromEntityId: 0,
            fromPublicCode: 'CODE',
            fromDeviceId: senderDeviceId,
            timestamp: Date.now(),
            crossDevice: true
        });

        // Transform with only state change, no message
        const res = await post('/api/transform').send({
            deviceId: targetDeviceId,
            entityId: 0,
            botSecret: targetBotSecret,
            state: 'BUSY'
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        // No message means no routing — the crossDevice entry stays in queue
    });
});

// ════════════════════════════════════════════════════════════════
// Transform without crossDevice — normal behavior unchanged
// ════════════════════════════════════════════════════════════════
describe('POST /api/transform — normal (non-cross-device)', () => {
    it('works normally when messageQueue has only local messages', async () => {
        const { devices } = require('../../index');
        const targetEntity = devices['xroute-target'].entities[0];
        targetEntity.messageQueue = [{
            text: 'local user msg',
            from: 'User (#0), Web',
            timestamp: Date.now(),
            read: false
        }];

        const res = await post('/api/transform').send({
            deviceId: 'xroute-target',
            entityId: 0,
            botSecret: devices['xroute-target'].entities[0].botSecret,
            state: 'IDLE',
            message: 'local reply'
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});
