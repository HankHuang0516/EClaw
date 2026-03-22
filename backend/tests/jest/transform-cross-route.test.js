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

    it('consumes cross-device message after auto-routing (no repeat forwarding)', async () => {
        const { devices } = require('../../index');
        const targetEntity = devices[targetDeviceId].entities[0];
        targetEntity.messageQueue = [];
        targetEntity.messageQueue.push({
            text: 'cross msg',
            from: 'xdevice:SENDER_CODE:🐢',
            fromEntityId: 0,
            fromPublicCode: 'SENDER_CODE',
            fromDeviceId: senderDeviceId,
            timestamp: Date.now(),
            read: false,
            crossDevice: true
        });

        // First reply — should auto-route and consume
        const res1 = await post('/api/transform').send({
            deviceId: targetDeviceId, entityId: 0, botSecret: targetBotSecret,
            state: 'IDLE', message: 'first reply'
        });
        expect(res1.status).toBe(200);

        // Cross-device message should be consumed from queue
        const crossRemaining = targetEntity.messageQueue.filter(m => m.crossDevice);
        expect(crossRemaining.length).toBe(0);

        // Second reply — should NOT trigger auto-route (no cross-device message left)
        const res2 = await post('/api/transform').send({
            deviceId: targetDeviceId, entityId: 0, botSecret: targetBotSecret,
            state: 'IDLE', message: 'second reply (local only)'
        });
        expect(res2.status).toBe(200);
    });

    it('routes to explicit targetDeviceId when provided', async () => {
        const { devices } = require('../../index');
        const targetEntity = devices[targetDeviceId].entities[0];
        targetEntity.messageQueue = [];

        // Inject a cross-device message from senderDevice
        targetEntity.messageQueue.push({
            text: 'cross msg',
            from: 'xdevice:SENDER_CODE:🐢',
            fromEntityId: 0,
            fromPublicCode: 'SENDER_CODE',
            fromDeviceId: senderDeviceId,
            timestamp: Date.now(),
            read: false,
            crossDevice: true
        });

        // Reply with explicit targetDeviceId — should use explicit route, NOT auto-route
        const res = await post('/api/transform').send({
            deviceId: targetDeviceId, entityId: 0, botSecret: targetBotSecret,
            state: 'IDLE', message: 'explicit route reply',
            targetDeviceId: senderDeviceId
        });
        expect(res.status).toBe(200);

        // Cross-device message should NOT be consumed (explicit routing is independent)
        const crossRemaining = targetEntity.messageQueue.filter(m => m.crossDevice);
        expect(crossRemaining.length).toBe(1);
    });

    it('ignores targetDeviceId when device does not exist', async () => {
        const { devices } = require('../../index');
        const targetEntity = devices[targetDeviceId].entities[0];
        targetEntity.messageQueue = [];

        const res = await post('/api/transform').send({
            deviceId: targetDeviceId, entityId: 0, botSecret: targetBotSecret,
            state: 'IDLE', message: 'route to nonexistent',
            targetDeviceId: 'nonexistent-device-999'
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

    it('picks and consumes only the latest crossDevice message when multiple are queued', async () => {
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

        // Only the latest (SENDER_CODE) should be consumed; OLD_CODE remains
        const crossRemaining = targetEntity.messageQueue.filter(m => m.crossDevice);
        expect(crossRemaining.length).toBe(1);
        expect(crossRemaining[0].fromPublicCode).toBe('OLD_CODE');
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
// targetDeviceId === deviceId (same-device) — must NOT trigger cross-device routing
// ════════════════════════════════════════════════════════════════
describe('POST /api/transform — targetDeviceId equals deviceId (same-device)', () => {
    it('skips cross-device routing when targetDeviceId matches deviceId', async () => {
        const { devices } = require('../../index');
        const targetEntity = devices['xroute-target'].entities[0];
        // Inject a cross-device message — should be consumed via auto-route fallback
        targetEntity.messageQueue = [{
            text: 'cross msg',
            from: 'xdevice:SENDER_CODE:🐢',
            fromEntityId: 0,
            fromPublicCode: 'SENDER_CODE',
            fromDeviceId: 'xroute-sender',
            timestamp: Date.now(),
            read: false,
            crossDevice: true
        }];

        // Bot replies with targetDeviceId === deviceId (same-device curl template)
        const res = await post('/api/transform').send({
            deviceId: 'xroute-target',
            entityId: 0,
            botSecret: targetEntity.botSecret,
            targetDeviceId: 'xroute-target', // same as deviceId — should NOT trigger explicit routing
            state: 'IDLE',
            message: 'same-device reply'
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // The cross-device message should still be consumed by auto-route (not explicit route)
        const crossRemaining = targetEntity.messageQueue.filter(m => m.crossDevice);
        expect(crossRemaining.length).toBe(0);
    });

    it('does not double-save chat when targetDeviceId equals deviceId', async () => {
        const { devices } = require('../../index');
        const targetEntity = devices['xroute-target'].entities[0];
        targetEntity.messageQueue = [];

        // No cross-device messages — simple same-device reply with targetDeviceId === deviceId
        const res = await post('/api/transform').send({
            deviceId: 'xroute-target',
            entityId: 0,
            botSecret: targetEntity.botSecret,
            targetDeviceId: 'xroute-target',
            state: 'IDLE',
            message: 'normal reply with targetDeviceId'
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
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
