/**
 * /api/channel/message — [Routing] audit log (card_488f05)
 *
 * Verifies the structured audit log emitted at the speakTo/broadcast delivery
 * point in backend/channel-api.js. This log lets us reproduce the speakTo
 * mis-routing bug (filed as card_488f05280caf518bba74144d) by grepping
 * production logs for the chosenPath that won for each /channel/message call.
 *
 * Scope: observability ONLY. This PR does NOT change routing precedence;
 * the existing test files (channel-message-mention-autorouter.test.js +
 * channel-message-sender-hint.test.js) still own the precedence contract.
 */

require('./helpers/mock-setup');

const db = require('../../db');
const apiKey = 'eck_routing_audit_log_test';
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

function captureRoutingLogs(spy) {
    return spy.mock.calls
        .map(args => (args && args[0]) || '')
        .filter(s => typeof s === 'string' && s.startsWith('[Routing] '));
}

describe('POST /api/channel/message — [Routing] audit log (card_488f05)', () => {
    let deviceId, deviceSecret, botSecret2, entity0Code, entity1Code;
    let logSpy;

    beforeAll(async () => {
        // Long deviceId so we can verify the 8-char privacy mask
        deviceId = 'audit-routing-device-xyz-very-long';
        deviceSecret = await registerDevice(deviceId);
        await bindEntity(deviceId, deviceSecret, 0);
        await post('/api/device/add-entity').send({ deviceId, deviceSecret });
        await bindEntity(deviceId, deviceSecret, 1);
        await post('/api/device/add-entity').send({ deviceId, deviceSecret });
        botSecret2 = await bindEntity(deviceId, deviceSecret, 2);

        const { devices } = require('../../index');
        entity0Code = devices[deviceId].entities[0].publicCode;
        entity1Code = devices[deviceId].entities[1].publicCode;
        expect(entity0Code).toBeTruthy();
        expect(entity1Code).toBeTruthy();
    });

    beforeEach(() => {
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
    });

    it('chosenPath=explicit-speakTo when body provides speakTo', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 2, botSecret: botSecret2,
            state: 'IDLE',
            message: 'hello entity 1 via explicit speakTo',
            speakTo: [entity1Code],
        });
        expect(res.status).toBe(200);

        const logs = captureRoutingLogs(logSpy);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain('chosenPath=explicit-speakTo');
        expect(logs[0]).toContain(`entity=2`);
        expect(logs[0]).toContain(`finalRecipients=${entity1Code}`);
        // Privacy mask: only first 8 chars of deviceId leak
        expect(logs[0]).toContain(`device=${deviceId.slice(0, 8)} `);
        expect(logs[0]).not.toContain(deviceId);
    });

    it('chosenPath=text-mention when @#N fills speakTo (no explicit body)', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 2, botSecret: botSecret2,
            state: 'IDLE',
            message: '@#1 hi from text mention',
        });
        expect(res.status).toBe(200);

        const logs = captureRoutingLogs(logSpy);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain('chosenPath=text-mention');
        expect(logs[0]).toContain('textMentions=1');
        expect(logs[0]).toContain('req.speakTo=null');
        expect(logs[0]).toContain('req.broadcast=false');
        expect(logs[0]).toContain(`finalRecipients=${entity1Code}`);
    });

    it('chosenPath=broadcast when body provides broadcast=true', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 2, botSecret: botSecret2,
            state: 'IDLE',
            message: 'broadcast to everyone',
            broadcast: true,
        });
        expect(res.status).toBe(200);

        const logs = captureRoutingLogs(logSpy);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain('chosenPath=broadcast');
        expect(logs[0]).toContain('req.broadcast=true');
        expect(logs[0]).toContain('finalRecipients=broadcast');
    });

    it('chosenPath=senderHint-fallback when only senderHint resolves the target', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 2, botSecret: botSecret2,
            state: 'IDLE',
            message: 'reply with no @ or speakTo, senderHint only',
            senderHint: { kind: 'entity', entityId: 0, publicCode: entity0Code },
        });
        expect(res.status).toBe(200);

        const logs = captureRoutingLogs(logSpy);
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain('chosenPath=senderHint-fallback');
        expect(logs[0]).toContain('senderHint=entity');
        expect(logs[0]).toContain('textMentions=0');
        expect(logs[0]).toContain(`finalRecipients=${entity0Code}`);
    });
});
