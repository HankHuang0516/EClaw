require('./helpers/mock-setup');
jest.mock('../../dream-buddy-inference', () => jest.fn(() => ({
    router: require('express').Router(), diagnostics: require('express').Router(),
    submit: jest.fn((_req, res) => res.json({ success: true, jobId: 'test-job', quotaRemaining: 7 })),
})));
const request = require('supertest');
const app = require('../../index');
const createInference = require('../../dream-buddy-inference');
const inference = createInference.mock.results[0].value;
const db = require('../../db');
const originalProvider = process.env.DREAM_BUDDY_AI_PROVIDER;
const body = { appId: 'dream-buddy', personaId: 'dream-buddy', deviceId: 'local-routing-test',
    deviceSecret: 'test-routing-secret', message: '夢境', operationId: 'd5c2f8ea-264d-44b5-9ae2-2a313bcd8035' };
let dispatch;
beforeEach(() => {
    process.env.DREAM_BUDDY_AI_PROVIDER = 'local-minimax';
    app.devices[body.deviceId] = { deviceSecret: body.deviceSecret, entities: {} };
    inference.submit.mockClear();
    dispatch = jest.spyOn(app, '_dispatchAppBotMessage').mockResolvedValue({ pushed: true });
    db.getAppBotQuota = jest.fn().mockResolvedValue(null);
    db.incrementAppBotQuotaUsage = jest.fn().mockResolvedValue(true);
});
afterEach(() => dispatch.mockRestore());
afterAll(() => {
    if (originalProvider === undefined) delete process.env.DREAM_BUDDY_AI_PROVIDER;
    else process.env.DREAM_BUDDY_AI_PROVIDER = originalProvider;
    delete app.devices[body.deviceId];
});
test('local Dream Buddy reaches queue without an official binding and never invokes official dispatch', async () => {
    const result = await request(app).post('/api/app-bot/chat').send(body);
    expect(result.status).toBe(200);
    expect(inference.submit).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    expect(db.incrementAppBotQuotaUsage).not.toHaveBeenCalled();
});
test('authentication, persona and length validation precede the local queue', async () => {
    for (const [changes, status] of [[{ deviceSecret: 'wrong' }, 403],
        [{ personaId: 'unknown' }, 403], [{ message: 'x'.repeat(2001) }, 400]]) {
        expect((await request(app).post('/api/app-bot/chat').send({ ...body, ...changes })).status).toBe(status);
    }
    expect(inference.submit).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
});
test('another app keeps official bot validation while Dream Buddy local mode is active', async () => {
    const result = await request(app).post('/api/app-bot/chat').send({ ...body, appId: 'nighthollow', personaId: 'default' });
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('bot_not_bound');
    expect(inference.submit).not.toHaveBeenCalled();
});
test('an unknown configured provider fails closed instead of silently dispatching an official bot', async () => {
    process.env.DREAM_BUDDY_AI_PROVIDER = 'typo';
    const result = await request(app).post('/api/app-bot/chat').send(body);
    expect(result.status).toBe(503);
    expect(inference.submit).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
});
test('the legacy marked Dream Buddy speak contract reaches the same queue without official delivery', async () => {
    app.devices[body.deviceId].entities[0] = { appVersion: 'dream-buddy-1.0.0' };
    const legacy = { deviceId: body.deviceId, deviceSecret: body.deviceSecret,
        entityId: 0, text: 'legacy dream test', source: 'client' };
    expect((await request(app).post('/api/client/speak').send(legacy)).status).toBe(200);
    expect(inference.submit).toHaveBeenCalledTimes(1);
    expect(inference.submit.mock.calls[0][0].body).toMatchObject({ appId: 'dream-buddy', message: legacy.text });
    expect(dispatch).not.toHaveBeenCalled();
});
test('legacy auth and text-only boundaries precede the queue', async () => {
    app.devices[body.deviceId].entities[0] = { appVersion: 'dream-buddy-1.0.0' };
    const legacy = { deviceId: body.deviceId, deviceSecret: body.deviceSecret,
        entityId: 0, text: 'legacy invalid test', source: 'client' };
    expect((await request(app).post('/api/client/speak').send({ ...legacy, deviceSecret: 'wrong' })).status).toBe(403);
    expect((await request(app).post('/api/client/speak').send({ ...legacy, text: 'x'.repeat(2001) })).status).toBe(400);
    expect((await request(app).post('/api/client/speak').send({ ...legacy, mediaType: 'image', mediaUrl: 'https://example.invalid/image' })).status).toBe(400);
    expect(inference.submit).not.toHaveBeenCalled();
});
test('legacy requests from unmarked devices cannot accidentally enter Dream Buddy inference', async () => {
    app.devices[body.deviceId].entities[0] = { appVersion: '1.2.0', isBound: false };
    await request(app).post('/api/client/speak').send({ deviceId: body.deviceId, deviceSecret: body.deviceSecret,
        entityId: 0, text: 'unrelated device test', source: 'client' });
    expect(inference.submit).not.toHaveBeenCalled();
});
