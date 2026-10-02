require('./helpers/mock-setup');

const request = require('supertest');
let app;
const deviceId = 'codex-route-owner';
const deviceSecret = 'fixture-owner-credential';
const get = path => request(app).get(path).set('Host', 'localhost');
const post = path => request(app).post(path).set('Host', 'localhost');

beforeAll(async () => {
    app = require('../../index');
    await new Promise(resolve => setImmediate(resolve));
    app.devices[deviceId] = { deviceSecret, entities: { 0: {
        ...app._createDefaultEntity(0), isBound: true, name: 'Codex', botSecret: 'fixture-bot',
        bindingType: 'channel', channelAccountId: 1
    } } };
});
afterAll(async () => {
    delete app.devices[deviceId];
    await new Promise(resolve => app.httpServer.close(resolve));
});

test('root discovery names the exact MCP audience and HTTPS authorization issuer', async () => {
    const resource = await get('/.well-known/oauth-protected-resource');
    const issuer = await get('/.well-known/oauth-authorization-server');
    expect(resource.status).toBe(200);
    expect(resource.body.resource).toBe('https://eclawbot.com/mcp');
    expect(resource.body.authorization_servers).toEqual([issuer.body.issuer]);
    expect(issuer.body.code_challenge_methods_supported).toEqual(['S256']);
});

test('MCP route challenges anonymous requests and forbids unsupported GET transport', async () => {
    const response = await post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toContain('oauth-protected-resource');
    expect((await get('/mcp')).status).toBe(405);
});

test('help discovery covers OAuth, MCP, every runtime route and development diagnostics', async () => {
    const response = await get('/api/help').query({ deviceId, entityId: 0, botSecret: 'fixture-bot', intent: 'codex 外掛' });
    expect(response.status).toBe(200);
    expect(response.body.matched_category).toBe('codex_plugin');
    for (const endpoint of ['register', 'authorize', 'token', 'revoke']) expect(response.body.curl_examples).toContain(`/api/codex/oauth/${endpoint}`);
    for (const endpoint of ['enroll', 'enrollment', 'poll', 'reply', 'ack', 'heartbeat', 'approval']) expect(response.body.curl_examples).toContain(`/api/codex/runtime/${endpoint}`);
    expect(response.body.curl_examples).toContain('/api/debug/codex-plugin');
});

test('owner speak stamps an authenticated marker independently of the supplied source', async () => {
    const response = await post('/api/client/speak').send({ deviceId, deviceSecret, entityId: 0, text: 'Owner operation', source: 'external-customer' });
    expect(response.status).toBe(200);
    expect(app.devices[deviceId].entities[0].messageQueue.find(m => m.text === 'Owner operation')).toMatchObject({ codexOwner: true });
    const denied = await post('/api/client/speak').send({ deviceId, deviceSecret: 'wrong', entityId: 0, text: 'Forged owner', source: 'client', codexOwner: true });
    expect(denied.status).toBe(403);
    expect(app.devices[deviceId].entities[0].messageQueue.some(m => m.text === 'Forged owner')).toBe(false);
});

test('diagnostics require the owner and remain hidden in production', async () => {
    expect((await get('/api/debug/codex-plugin').query({ deviceId })).status).toBe(403);
    expect((await get('/api/debug/codex-plugin').query({ deviceId, deviceSecret, limit: 'invalid' })).status).toBe(400);
    const response = await get('/api/debug/codex-plugin').query({ deviceId, deviceSecret });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, bindings: [], events: [] });
    const previous = process.env.NODE_ENV;
    try {
        process.env.NODE_ENV = 'production';
        expect((await get('/api/debug/codex-plugin').query({ deviceId, deviceSecret })).status).toBe(404);
    } finally { process.env.NODE_ENV = previous; }
});
