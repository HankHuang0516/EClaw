/**
 * Cross-speak channel push parity regression tests (Jest + Supertest)
 *
 * Regression: entity/cross-speak, client/cross-speak, and PendingFlush callback
 * previously only pushed via webhook (pushToBot), missing channel-bound entities
 * (pushToChannelCallback). This test verifies the channel push path is now used
 * when the target entity has bindingType === 'channel'.
 *
 * Tests:
 *   POST /api/entity/cross-speak  → channel-bound target gets channel push
 *   POST /api/client/cross-speak  → channel-bound target gets channel push
 *   Response payload includes mode: "channel" for channel-bound targets
 */

require('./helpers/mock-setup');

// Add cross-device-settings getSettings (not in shared mock-setup)
const crossDeviceSettings = require('../../entity-cross-device-settings');
crossDeviceSettings.getSettings = jest.fn().mockResolvedValue({
    pre_inject: '',
    forbidden_words: [],
    rate_limit_seconds: 0,
    blacklist: [],
    whitelist_enabled: false,
    whitelist: [],
    reject_message: '',
    allowed_media: ['text', 'photo', 'voice', 'video', 'file']
});

// Add channel-api db functions needed
const db = require('../../db');
db.getChannelAccountByKey = jest.fn().mockResolvedValue(null);
db.getChannelAccountsByDevice = jest.fn().mockResolvedValue([]);
db.createChannelAccount = jest.fn().mockResolvedValue({ id: 1, channel_api_key: 'eck_test', channel_api_secret: 'ecs_test' });
db.getChannelAccountById = jest.fn().mockResolvedValue(null);
db.deleteChannelAccount = jest.fn().mockResolvedValue(true);
db.updateChannelCallback = jest.fn().mockResolvedValue(true);
db.updateChannelE2eeCapable = jest.fn().mockResolvedValue(true);
db.clearChannelCallback = jest.fn().mockResolvedValue(true);
db.getChannelAccountByDevice = jest.fn().mockResolvedValue(null);

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

/** Bind entity 0 and return botSecret */
async function bindEntity(deviceId, deviceSecret) {
    const regRes = await post('/api/device/register')
        .send({ deviceId, deviceSecret, entityId: 0 });
    const code = regRes.body.bindingCode;
    if (!code) return undefined;
    const bindRes = await post('/api/bind').send({ code });
    return bindRes.body.botSecret;
}

/** Access in-memory devices map to set bindingType/channelAccountId on an entity */
function getDevicesMap() {
    const indexModule = require('../../index');
    return indexModule.devices;
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
// POST /api/entity/cross-speak — channel-bound target
// ════════════════════════════════════════════════════════════════
describe('POST /api/entity/cross-speak — channel push parity', () => {
    let senderBotSecret;
    let targetPublicCode;

    beforeAll(async () => {
        // Set up sender device + entity
        const senderSecret = await registerDevice('chan-cs-sender');
        senderBotSecret = await bindEntity('chan-cs-sender', senderSecret);

        // Set up target device + entity
        const targetSecret = await registerDevice('chan-cs-target');
        await bindEntity('chan-cs-target', targetSecret);

        // Get target entity's publicCode
        const statusRes = await request(app)
            .get('/api/entities?deviceId=chan-cs-target')
            .set('Host', 'localhost');
        const entities = statusRes.body.entities || statusRes.body;
        const targetEntity = Array.isArray(entities)
            ? entities.find(e => e.entityId === 0)
            : entities[0] || entities['0'];
        targetPublicCode = targetEntity?.publicCode;
    });

    afterEach(() => {
        // Restore target entity state to prevent cross-test pollution
        const devicesMap = getDevicesMap();
        if (devicesMap && devicesMap['chan-cs-target']) {
            const e = devicesMap['chan-cs-target'].entities[0];
            e.bindingType = undefined;
            e.channelAccountId = undefined;
            e.webhook = null;
        }
    });

    it('returns mode: "channel" when target is channel-bound', async () => {
        const devicesMap = getDevicesMap();
        if (!devicesMap || !devicesMap['chan-cs-target']) return;
        const targetEntity = devicesMap['chan-cs-target'].entities[0];
        targetEntity.bindingType = 'channel';
        targetEntity.channelAccountId = 99;

        const res = await post('/api/entity/cross-speak').send({
            deviceId: 'chan-cs-sender',
            fromEntityId: 0,
            botSecret: senderBotSecret,
            targetCode: targetPublicCode,
            text: 'channel push test'
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.mode).toBe('channel');
        expect(res.body.pushed).toBe('pending');
    });

    it('returns mode: "push" when target has webhook (not channel)', async () => {
        const devicesMap = getDevicesMap();
        if (!devicesMap || !devicesMap['chan-cs-target']) return;

        devicesMap['chan-cs-target'].entities[0].webhook = { url: 'https://example.com/hook', type: 'openclaw' };

        const res = await post('/api/entity/cross-speak').send({
            deviceId: 'chan-cs-sender',
            fromEntityId: 0,
            botSecret: senderBotSecret,
            targetCode: targetPublicCode,
            text: 'webhook push test'
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.mode).toBe('push');
        expect(res.body.pushed).toBe('pending');
    });

    it('returns mode: "polling" when target has no webhook and no channel', async () => {
        const devicesMap = getDevicesMap();
        if (!devicesMap || !devicesMap['chan-cs-target']) return;

        const res = await post('/api/entity/cross-speak').send({
            deviceId: 'chan-cs-sender',
            fromEntityId: 0,
            botSecret: senderBotSecret,
            targetCode: targetPublicCode,
            text: 'polling test'
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.mode).toBe('polling');
        expect(res.body.pushed).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════════
// POST /api/client/cross-speak — channel-bound target
// ════════════════════════════════════════════════════════════════
describe('POST /api/client/cross-speak — channel push parity', () => {
    let senderBotSecret;
    let targetPublicCode;

    beforeAll(async () => {
        // Set up sender device + entity
        const senderSecret = await registerDevice('chan-cc-sender');
        senderBotSecret = await bindEntity('chan-cc-sender', senderSecret);

        // Set up target device + entity
        const targetSecret = await registerDevice('chan-cc-target');
        await bindEntity('chan-cc-target', targetSecret);

        // Get target entity's publicCode
        const statusRes = await request(app)
            .get('/api/entities?deviceId=chan-cc-target')
            .set('Host', 'localhost');
        const entities = statusRes.body.entities || statusRes.body;
        const targetEntity = Array.isArray(entities)
            ? entities.find(e => e.entityId === 0)
            : entities[0] || entities['0'];
        targetPublicCode = targetEntity?.publicCode;
    });

    afterEach(() => {
        const devicesMap = getDevicesMap();
        if (devicesMap && devicesMap['chan-cc-target']) {
            const e = devicesMap['chan-cc-target'].entities[0];
            e.bindingType = undefined;
            e.channelAccountId = undefined;
            e.webhook = null;
        }
    });

    it('returns channel mode when target is channel-bound', async () => {
        const devicesMap = getDevicesMap();
        if (!devicesMap || !devicesMap['chan-cc-target']) return;

        const targetEntity = devicesMap['chan-cc-target'].entities[0];
        targetEntity.bindingType = 'channel';
        targetEntity.channelAccountId = 99;

        const res = await post('/api/client/cross-speak').send({
            deviceId: 'chan-cc-sender',
            deviceSecret: 'secret-chan-cc-sender',
            fromEntityId: 0,
            targetCode: targetPublicCode,
            text: 'channel push from client'
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.pushed).toBe('pending');
        expect(res.body._debug).toBeDefined();
        expect(res.body._debug.isChannelBound).toBe(true);
    });

    it('returns channel mode for owner mode (fromEntityId=-1) to channel-bound target', async () => {
        const devicesMap = getDevicesMap();
        if (!devicesMap || !devicesMap['chan-cc-target']) return;

        const targetEntity = devicesMap['chan-cc-target'].entities[0];
        targetEntity.bindingType = 'channel';
        targetEntity.channelAccountId = 99;

        const res = await post('/api/client/cross-speak').send({
            deviceId: 'chan-cc-sender',
            deviceSecret: 'secret-chan-cc-sender',
            fromEntityId: -1,
            targetCode: targetPublicCode,
            text: 'owner channel push'
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.pushed).toBe('pending');
        expect(res.body._debug.isChannelBound).toBe(true);
        expect(res.body._debug.isOwnerMode).toBe(true);
    });

    it('returns polling mode when target has no webhook and no channel', async () => {
        const devicesMap = getDevicesMap();
        if (!devicesMap || !devicesMap['chan-cc-target']) return;

        const res = await post('/api/client/cross-speak').send({
            deviceId: 'chan-cc-sender',
            deviceSecret: 'secret-chan-cc-sender',
            fromEntityId: 0,
            targetCode: targetPublicCode,
            text: 'polling fallback test'
        });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.pushed).toBe(false);
        expect(res.body._debug.isChannelBound).toBeFalsy();
        expect(res.body._debug.hasWebhook).toBe(false);
    });
});
