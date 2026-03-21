/**
 * Channel message cross-device routing tests (Jest + Supertest)
 *
 * Verifies that POST /api/channel/message:
 * 1. Consumes cross-device messages after auto-routing (no repeat forwarding)
 * 2. Supports explicit targetDeviceId for bot-controlled routing
 * 3. Does not route when no cross-device context exists
 */

require('./helpers/mock-setup');

const request = require('supertest');
let app;

const post = (path) => request(app).post(path).set('Host', 'localhost');

const CHANNEL_API_KEY = 'eck_test_channel_xroute';
const DEVICE_A = 'ch-xroute-device-a';
const DEVICE_B = 'ch-xroute-device-b';
let botSecretA;

beforeAll(async () => {
    // Mock channel account lookup
    const db = require('../../db');
    db.getChannelAccountByKey = jest.fn().mockImplementation(async (key) => {
        if (key === CHANNEL_API_KEY) return { id: 1, device_id: DEVICE_A, callback_url: 'http://localhost:9999/cb' };
        return null;
    });

    app = require('../../index');

    // Register device A
    await post('/api/device/register').send({ deviceId: DEVICE_A, deviceSecret: `secret-${DEVICE_A}`, entityId: 0 });
    const regA = await post('/api/device/register').send({ deviceId: DEVICE_A, deviceSecret: `secret-${DEVICE_A}`, entityId: 0 });
    const codeA = regA.body.bindingCode;
    if (codeA) {
        const bindRes = await post('/api/bind').send({ code: codeA });
        botSecretA = bindRes.body.botSecret;
    }

    // Register device B (sender)
    await post('/api/device/register').send({ deviceId: DEVICE_B, deviceSecret: `secret-${DEVICE_B}`, entityId: 0 });
    const regB = await post('/api/device/register').send({ deviceId: DEVICE_B, deviceSecret: `secret-${DEVICE_B}`, entityId: 0 });
    const codeB = regB.body.bindingCode;
    if (codeB) await post('/api/bind').send({ code: codeB });
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
    jest.resetModules();
});

function injectCrossDeviceMessage(entity, fromDeviceId, fromPublicCode) {
    if (!entity.messageQueue) entity.messageQueue = [];
    entity.messageQueue.push({
        text: `cross msg from ${fromDeviceId}`,
        from: `xdevice:${fromPublicCode || fromDeviceId}:🐢`,
        fromEntityId: 0,
        fromCharacter: '🐢',
        fromPublicCode: fromPublicCode || 'BCODE',
        fromDeviceId: fromDeviceId,
        timestamp: Date.now(),
        read: false,
        crossDevice: true
    });
}

// ════════════════════════════════════════════════════════════════
// Channel message cross-device auto-route + consumption
// ════════════════════════════════════════════════════════════════
describe('POST /api/channel/message — cross-device routing', () => {
    beforeEach(() => {
        const { devices } = require('../../index');
        const entity = devices[DEVICE_A]?.entities[0];
        if (entity) entity.messageQueue = [];
    });

    it('auto-routes first reply and consumes cross-device message', async () => {
        const { devices } = require('../../index');
        const entity = devices[DEVICE_A].entities[0];
        injectCrossDeviceMessage(entity, DEVICE_B, 'B_CODE');

        expect(entity.messageQueue.filter(m => m.crossDevice).length).toBe(1);

        // Bot replies via channel message
        const res = await post('/api/channel/message').send({
            channel_api_key: CHANNEL_API_KEY,
            deviceId: DEVICE_A,
            entityId: 0,
            botSecret: botSecretA,
            message: 'reply to cross-device'
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // Cross-device message should be consumed
        const crossRemaining = entity.messageQueue.filter(m => m.crossDevice);
        expect(crossRemaining.length).toBe(0);
    });

    it('second reply does NOT auto-route after consumption', async () => {
        const { devices } = require('../../index');
        const entity = devices[DEVICE_A].entities[0];
        injectCrossDeviceMessage(entity, DEVICE_B, 'B_CODE');

        // First reply — consumes
        await post('/api/channel/message').send({
            channel_api_key: CHANNEL_API_KEY,
            deviceId: DEVICE_A, entityId: 0, botSecret: botSecretA,
            message: 'first reply'
        });

        // Second reply — no cross-device message left, local only
        const res = await post('/api/channel/message').send({
            channel_api_key: CHANNEL_API_KEY,
            deviceId: DEVICE_A, entityId: 0, botSecret: botSecretA,
            message: 'second reply (should be local only)'
        });
        expect(res.status).toBe(200);
        expect(entity.messageQueue.filter(m => m.crossDevice).length).toBe(0);
    });

    it('consumes only the latest cross-device message when multiple queued', async () => {
        const { devices } = require('../../index');
        const entity = devices[DEVICE_A].entities[0];

        // Two cross-device messages from different senders
        entity.messageQueue.push({
            text: 'old msg', from: 'xdevice:OLD:🐢', fromEntityId: 0,
            fromPublicCode: 'OLD', fromDeviceId: 'old-device',
            timestamp: Date.now() - 5000, read: false, crossDevice: true
        });
        entity.messageQueue.push({
            text: 'new msg', from: 'xdevice:NEW:🐢', fromEntityId: 0,
            fromPublicCode: 'NEW', fromDeviceId: DEVICE_B,
            timestamp: Date.now(), read: false, crossDevice: true
        });

        const res = await post('/api/channel/message').send({
            channel_api_key: CHANNEL_API_KEY,
            deviceId: DEVICE_A, entityId: 0, botSecret: botSecretA,
            message: 'reply to newest'
        });
        expect(res.status).toBe(200);

        // Only the latest (NEW/DEVICE_B) should be consumed; OLD remains
        const crossRemaining = entity.messageQueue.filter(m => m.crossDevice);
        expect(crossRemaining.length).toBe(1);
        expect(crossRemaining[0].fromPublicCode).toBe('OLD');
    });

    it('routes to explicit targetDeviceId when provided', async () => {
        const { devices } = require('../../index');
        const entity = devices[DEVICE_A].entities[0];

        // Inject cross-device msg (should NOT be consumed when using explicit routing)
        injectCrossDeviceMessage(entity, DEVICE_B, 'B_CODE');

        const res = await post('/api/channel/message').send({
            channel_api_key: CHANNEL_API_KEY,
            deviceId: DEVICE_A, entityId: 0, botSecret: botSecretA,
            message: 'explicit route reply',
            targetDeviceId: DEVICE_B
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // Cross-device message should NOT be consumed (explicit routing is independent)
        const crossRemaining = entity.messageQueue.filter(m => m.crossDevice);
        expect(crossRemaining.length).toBe(1);
    });

    it('ignores targetDeviceId for nonexistent device (still succeeds)', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: CHANNEL_API_KEY,
            deviceId: DEVICE_A, entityId: 0, botSecret: botSecretA,
            message: 'route to ghost',
            targetDeviceId: 'nonexistent-device-xyz'
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('does not route when no cross-device message exists (local only)', async () => {
        const { devices } = require('../../index');
        const entity = devices[DEVICE_A].entities[0];
        entity.messageQueue = []; // No cross-device messages

        const res = await post('/api/channel/message').send({
            channel_api_key: CHANNEL_API_KEY,
            deviceId: DEVICE_A, entityId: 0, botSecret: botSecretA,
            message: 'purely local message'
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('state-only update without message does not trigger routing', async () => {
        const { devices } = require('../../index');
        const entity = devices[DEVICE_A].entities[0];
        injectCrossDeviceMessage(entity, DEVICE_B, 'B_CODE');

        // State-only, no message
        const res = await post('/api/channel/message').send({
            channel_api_key: CHANNEL_API_KEY,
            deviceId: DEVICE_A, entityId: 0, botSecret: botSecretA,
            state: 'BUSY'
        });
        expect(res.status).toBe(200);

        // Cross-device message should still be in queue (not consumed by state-only update)
        const crossRemaining = entity.messageQueue.filter(m => m.crossDevice);
        expect(crossRemaining.length).toBe(1);
    });

    it('handles owner-mode cross-device message (fromEntityId=-1)', async () => {
        const { devices } = require('../../index');
        const entity = devices[DEVICE_A].entities[0];
        entity.messageQueue.push({
            text: 'owner says hi',
            from: `xdevice:${DEVICE_B}:owner`,
            fromEntityId: -1,
            fromCharacter: null,
            fromPublicCode: null,
            fromDeviceId: DEVICE_B,
            timestamp: Date.now(),
            read: false,
            crossDevice: true
        });

        const res = await post('/api/channel/message').send({
            channel_api_key: CHANNEL_API_KEY,
            deviceId: DEVICE_A, entityId: 0, botSecret: botSecretA,
            message: 'reply to owner'
        });
        expect(res.status).toBe(200);

        // Should be consumed
        expect(entity.messageQueue.filter(m => m.crossDevice).length).toBe(0);
    });
});
