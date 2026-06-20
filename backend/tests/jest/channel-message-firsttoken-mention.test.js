/**
 * /api/channel/message — first-token-only @-mention auto-promote rule
 *   card_488f05280caf518bba74144d
 *
 * BUG: Hank's casual web_chat messages with mid-body @-references like
 *   "this is broken, ask @xx for opinion"
 * were auto-promoted into `speakTo`, mis-routing the message into the
 * referenced entity's chat history and polluting their real-time context.
 *
 * FIX: Only auto-promote text @-mentions into `speakTo` when the mention is
 * the FIRST token of the message (after optional whitespace / emoji prefix).
 * Mid-body @-references no longer route, falling back to senderHint /
 * broadcast=false targeted at current chat context.
 *
 * Preserved behaviors:
 *   - `@all` broadcast detection works ANYWHERE (existing convention).
 *   - Explicit body.speakTo always wins regardless of mention position.
 *   - Mention at start still auto-promotes (the routing-intent path).
 */

require('./helpers/mock-setup');

const db = require('../../db');
const apiKey = 'eck_firsttoken_mention_test';
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
const pg = require('pg');
let app;

const post = (path) => request(app).post(path).set('Host', 'localhost');

let chatInserts = [];

beforeAll(() => {
    const originalPool = pg.Pool;
    pg.Pool = jest.fn().mockImplementation(() => ({
        query: jest.fn().mockImplementation(async (sql, params) => {
            const sqlStr = typeof sql === 'string' ? sql : (sql && sql.text) || '';
            if (/^\s*INSERT INTO chat_messages/i.test(sqlStr)) {
                chatInserts.push({
                    deviceId: params?.[0],
                    entityId: params?.[1],
                    text: params?.[2],
                    source: params?.[3],
                });
                return { rows: [{ id: `mock-${chatInserts.length}` }], rowCount: 1 };
            }
            return { rows: [], rowCount: 0 };
        }),
        connect: jest.fn().mockResolvedValue({ query: jest.fn().mockResolvedValue({ rows: [] }), release: jest.fn() }),
        end: jest.fn().mockResolvedValue(undefined),
    }));
    app = require('../../index');
    pg.Pool = originalPool;
});

afterAll(async () => {
    const { httpServer } = require('../../index');
    await new Promise(resolve => httpServer.close(resolve));
});

beforeEach(() => { chatInserts = []; });

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

describe('POST /api/channel/message — first-token mention rule (card_488f05)', () => {
    let deviceId, deviceSecret, botSecret2, entity1Code;

    beforeAll(async () => {
        deviceId = 'chmsg-firsttoken';
        deviceSecret = await registerDevice(deviceId);
        await bindEntity(deviceId, deviceSecret, 0);
        await post('/api/device/add-entity').send({ deviceId, deviceSecret });
        await bindEntity(deviceId, deviceSecret, 1);
        await post('/api/device/add-entity').send({ deviceId, deviceSecret });
        botSecret2 = await bindEntity(deviceId, deviceSecret, 2);

        const { devices } = require('../../index');
        entity1Code = devices[deviceId].entities[1].publicCode;
        expect(entity1Code).toBeTruthy();
    });

    it('mention at START → auto-promotes speakTo and delivers', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 2, botSecret: botSecret2,
            state: 'IDLE',
            message: `@#1 hello world`,
        });
        expect(res.status).toBe(200);
        expect(res.body.delivery?.results?.[0]?.entityId).toBe(1);
    });

    it('mention MID-body → NO auto-promote, no delivery row, mis-routing prevented', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 2, botSecret: botSecret2,
            state: 'IDLE',
            message: `hello @#1 mid-body reference`,
        });
        expect(res.status).toBe(200);
        // No delivery happened: there is no `delivery.results` array entry routing to entity 1.
        expect(res.body.delivery?.results?.[0]?.entityId).not.toBe(1);
    });

    it('multiple mentions MID-body → NO auto-promote', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 2, botSecret: botSecret2,
            state: 'IDLE',
            message: `hello @#1 and @#0 both mid-body`,
        });
        expect(res.status).toBe(200);
        expect(res.body.delivery?.results?.[0]?.entityId).not.toBe(1);
        expect(res.body.delivery?.results?.[0]?.entityId).not.toBe(0);
    });

    it('@all anywhere still triggers broadcast (existing convention preserved)', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 2, botSecret: botSecret2,
            state: 'IDLE',
            message: `hello @all heads up`,
        });
        expect(res.status).toBe(200);
        expect(res.body.delivery?.broadcast).toBe(true);
        expect(res.body.mentions?.hasAll).toBe(true);
    });

    it('explicit body.speakTo wins regardless of text position', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 2, botSecret: botSecret2,
            state: 'IDLE',
            message: `hello @#1 mid-body, but body has speakTo`,
            speakTo: [entity1Code],
        });
        expect(res.status).toBe(200);
        expect(res.body.delivery?.results?.[0]?.entityId).toBe(1);
    });

    it('publicCode form <@xxxxxx> at START → auto-promotes', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 2, botSecret: botSecret2,
            state: 'IDLE',
            message: `<@${entity1Code}> hi via publicCode`,
        });
        expect(res.status).toBe(200);
        expect(res.body.delivery?.results?.[0]?.entityId).toBe(1);
    });

    it('emoji prefix before mention still counts as start', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 2, botSecret: botSecret2,
            state: 'IDLE',
            message: `\u{1F44B} @#1 emoji-prefixed greeting`,
        });
        expect(res.status).toBe(200);
        expect(res.body.delivery?.results?.[0]?.entityId).toBe(1);
    });

    it('leading whitespace before mention still counts as start', async () => {
        const res = await post('/api/channel/message').send({
            channel_api_key: apiKey,
            deviceId, entityId: 2, botSecret: botSecret2,
            state: 'IDLE',
            message: `   @#1 leading spaces`,
        });
        expect(res.status).toBe(200);
        expect(res.body.delivery?.results?.[0]?.entityId).toBe(1);
    });
});

describe('messageStartsWithMention (unit)', () => {
    const { messageStartsWithMention } = require('../../channel-api');

    it('handles falsy / non-string inputs', () => {
        expect(messageStartsWithMention(null)).toBe(false);
        expect(messageStartsWithMention(undefined)).toBe(false);
        expect(messageStartsWithMention('')).toBe(false);
        expect(messageStartsWithMention(123)).toBe(false);
    });

    it('detects @-mention at start (bare / hash / publicCode / bracketed)', () => {
        expect(messageStartsWithMention('@#1 hi')).toBe(true);
        expect(messageStartsWithMention('@1 hi')).toBe(true);
        expect(messageStartsWithMention('@abcdef hi')).toBe(true);
        expect(messageStartsWithMention('<@abcdef> hi')).toBe(true);
        expect(messageStartsWithMention('<@1> hi')).toBe(true);
    });

    it('skips leading whitespace', () => {
        expect(messageStartsWithMention('  @#1 hi')).toBe(true);
        expect(messageStartsWithMention('\t@#1 hi')).toBe(true);
        expect(messageStartsWithMention('\n@#1 hi')).toBe(true);
    });

    it('skips a leading emoji prefix', () => {
        expect(messageStartsWithMention('\u{1F44B} @#1 hi')).toBe(true);
        expect(messageStartsWithMention('\u{1F389}@abcdef hi')).toBe(true);
    });

    it('returns false for mid-body @-mentions', () => {
        expect(messageStartsWithMention('hello @#1')).toBe(false);
        expect(messageStartsWithMention('ask @abcdef for opinion')).toBe(false);
        expect(messageStartsWithMention('this is broken, @#1 take a look')).toBe(false);
        expect(messageStartsWithMention('hello @#1 and @#2')).toBe(false);
    });

    it('returns false for plain text with no @', () => {
        expect(messageStartsWithMention('hello world')).toBe(false);
        expect(messageStartsWithMention('email me at user.com')).toBe(false);
    });
});
