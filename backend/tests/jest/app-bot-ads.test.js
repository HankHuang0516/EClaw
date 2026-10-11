'use strict';
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const createRouter = require('../../app-bot-ads');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const loadKeys = async () => new Map([['1', publicKey]]);
const signed = (content) => content + '&signature=' +
    crypto.sign('sha256', Buffer.from(content), privateKey).toString('base64url') + '&key_id=1';

test('verifies exact signed bytes and rejects tampering', async () => {
    const raw = signed('ad_unit=6438262242&reward_amount=6');
    expect((await createRouter.verifyQuery(raw, loadKeys)).get('reward_amount')).toBe('6');
    await expect(createRouter.verifyQuery(raw.replace('reward_amount=6', 'reward_amount=60'), loadKeys)).rejects.toThrow();
});
test('rejects duplicated signature parameters and unknown keys', async () => {
    await expect(createRouter.verifyQuery(signed('ad_unit=1&ad_unit=2'), loadKeys)).rejects.toThrow();
    await expect(createRouter.verifyQuery(signed('ad_unit=1').replace('key_id=1', 'key_id=2'), loadKeys)).rejects.toThrow();
});
test('rejects unsigned callback without accessing database', async () => {
    const getPool = jest.fn();
    const app = express();
    app.use('/ads', createRouter({ getDevices: () => ({}), getPool, loadKeys }));
    expect((await request(app).get('/ads/ssv?reward_amount=6')).status).toBe(400);
    expect(getPool).not.toHaveBeenCalled();
});
test('auth is required for quota and ad sessions; startup is fail-closed', async () => {
    const app = express();
    app.use(express.json());
    app.use('/ads', createRouter({ getDevices: () => ({ dev: { deviceSecret: 'secret' } }), getPool: () => null }));
    expect((await request(app).post('/ads/sessions').send({ platform: 'ios' })).status).toBe(403);
    expect((await request(app).get('/ads/quota?deviceId=dev').set('X-Device-Secret', 'wrong')).status).toBe(403);
    const cold = express();
    cold.use('/ads', createRouter({ getDevices: () => ({}), getPool: () => null, isReady: () => false }));
    expect((await request(cold).get('/ads/quota')).status).toBe(503);
});
test('authenticates by header; database outage never returns invented quota', async () => {
    const app = express();
    app.use('/ads', createRouter({ getDevices: () => ({ dev: { deviceSecret: 'secret' } }), getPool: () => null }));
    expect((await request(app).get('/ads/quota?deviceId=dev').set('X-Device-Secret', 'secret')).status).toBe(503);
});
test('Google test units and mismatched rewards are never credited', async () => {
    const getPool = jest.fn();
    const app = express();
    app.use('/ads', createRouter({ getDevices: () => ({}), getPool, loadKeys }));
    const base = 'ad_unit=5224354917&reward_amount=6&reward_item=messages&timestamp=' + Date.now() + '&transaction_id=txn';
    expect((await request(app).get('/ads/ssv?' + signed(base))).status).toBe(400);
    expect((await request(app).get('/ads/ssv?' + signed(base.replace('5224354917', '6438262242').replace('reward_amount=6', 'reward_amount=60')))).status).toBe(400);
    expect(getPool).not.toHaveBeenCalled();
});
test('genuine signed URL probes with no app challenge cannot credit rewards', async () => {
    const getPool = jest.fn();
    const app = express();
    app.use('/ads', createRouter({ getDevices: () => ({}), getPool, loadKeys }));
    const callback = signed('ad_unit=6438262242&reward_amount=6&reward_item=messages&timestamp=' + Date.now() + '&transaction_id=probe');
    const result = await request(app).get('/ads/ssv?' + callback);
    expect(result.status).toBe(200);
    expect(result.body.credited).toBe(false);
    expect(getPool).not.toHaveBeenCalled();
});

test('reward diagnostics are unavailable in production and Railway environments', async () => {
    const previousNode = process.env.NODE_ENV;
    const previousRailway = process.env.RAILWAY_ENVIRONMENT;
    const getPool = jest.fn();
    const app = express();
    app.use('/debug', createRouter({ getDevices: () => ({}), getPool }).diagnostics);
    try {
        process.env.NODE_ENV = 'production';
        expect((await request(app).get('/debug')).status).toBe(404);
        process.env.NODE_ENV = 'test';
        process.env.RAILWAY_ENVIRONMENT = 'debug';
        expect((await request(app).get('/debug')).status).toBe(404);
        expect(getPool).not.toHaveBeenCalled();
    } finally {
        if (previousNode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNode;
        if (previousRailway === undefined) delete process.env.RAILWAY_ENVIRONMENT; else process.env.RAILWAY_ENVIRONMENT = previousRailway;
    }
});
test('reward diagnostics require owner credentials and fail closed on database outage', async () => {
    const app = express();
    app.use('/debug', createRouter({ getDevices: () => ({ dev: { deviceSecret: 'secret' } }), getPool: () => null }).diagnostics);
    expect((await request(app).get('/debug?deviceId=dev')).status).toBe(403);
    expect((await request(app).get('/debug?deviceId=dev').set('X-Device-Secret', 'secret')).status).toBe(503);
});


test('AI reports require owner auth, reject invalid input, and never acknowledge database outages', async () => {
    const getPool = jest.fn(() => null);
    const app = express(); app.use(express.json());
    app.use('/ads', createRouter({ getDevices: () => ({ dev: { deviceSecret: 'secret' } }), getPool }));
    const report = { messageId: crypto.randomUUID(), reason: 'offensive' };
    expect((await request(app).post('/ads/reports').send(report)).status).toBe(403);
    expect((await request(app).post('/ads/reports?deviceId=dev').set('X-Device-Secret', 'secret')
        .send({ ...report, messageId: 'not-a-server-message' })).status).toBe(400);
    expect((await request(app).post('/ads/reports?deviceId=dev').set('X-Device-Secret', 'secret')
        .send({ ...report, reason: 'unrecognized' })).status).toBe(400);
    expect(getPool).not.toHaveBeenCalled();
    const response = await request(app).post('/ads/reports?deviceId=dev').set('X-Device-Secret', 'secret').send(report);
    expect(response.status).toBe(503); expect(response.body.success).toBe(false);
});


test('SSV rejection diagnostics reveal only bounded reason codes and never callback data', async () => {
    const getPool = jest.fn(); const logRejected = jest.fn();
    const app = express();
    app.use('/ads', createRouter({ getDevices: () => ({}), getPool, loadKeys, logRejected }));
    const secret = 'sensitive-device-reference';
    expect((await request(app).get('/ads/ssv?user_id=' + secret)).status).toBe(400);
    expect(logRejected).toHaveBeenLastCalledWith('missing_signature');
    const unknown = signed('ad_unit=6438262242&custom_data=' + secret).replace('key_id=1', 'key_id=2');
    expect((await request(app).get('/ads/ssv?' + unknown)).status).toBe(400);
    expect(logRejected).toHaveBeenLastCalledWith('unknown_key');
    const failing = express();
    failing.use('/ads', createRouter({ getDevices: () => ({}), getPool,
        loadKeys: async () => { throw new Error(secret); }, logRejected }));
    expect((await request(failing).get('/ads/ssv?' + signed('ad_unit=6438262242'))).status).toBe(400);
    expect(logRejected).toHaveBeenLastCalledWith('verification_failed');
    expect(JSON.stringify(logRejected.mock.calls)).not.toContain(secret);
    expect(getPool).not.toHaveBeenCalled();
});
