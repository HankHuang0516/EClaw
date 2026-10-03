require('./helpers/mock-setup');

const express = require('express');
const request = require('supertest');
const crypto = require('crypto');
const { newDb } = jest.requireActual('pg-mem');
const { createCodexPlugin } = require('../../codex-plugin');
const Store = require('../../codex-plugin-store');

let pool, devices, accounts, plugin, app, invokeApi, notices, audit;
const token = 'runtime_test_credential_that_is_long_enough_123456';
const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
const mcp = (name, args = {}, actor = 'owner') => request(app).post('/mcp').set('Authorization', `Bearer ${actor}`)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const runtime = (method, route, body = {}, credential = token) => request(app)[method](`/runtime${route}`)
    .set('Authorization', `Bearer ${credential}`).send(body);

beforeEach(async () => {
    const database = newDb();
    // SQL syntax is exercised here; session contention has its own lock tests.
    database.public.registerFunction({ name: 'pg_try_advisory_lock', args: ['bigint'], returns: 'bool', implementation: () => true });
    database.public.registerFunction({ name: 'pg_advisory_unlock', args: ['bigint'], returns: 'bool', implementation: () => true });
    const pg = database.adapters.createPg();
    pool = new pg.Pool();
    await pool.query('CREATE TABLE channel_accounts (id SERIAL PRIMARY KEY,device_id TEXT,channel_api_key TEXT,channel_api_secret TEXT,created_at BIGINT,updated_at BIGINT)');
    await pool.query('CREATE TABLE server_logs (device_id TEXT,entity_id INTEGER,level TEXT,message TEXT,category TEXT,created_at BIGINT)');
    devices = { owner: { deviceSecret: 'fixture-owner-secret', entities: {} }, other: { deviceSecret: 'fixture-other-secret', entities: {} } };
    accounts = new Map();
    notices = jest.fn().mockResolvedValue(1);
    audit = jest.fn();
    invokeApi = jest.fn(async (route, body) => {
        if (route === '/api/channel/provision-device') {
            const id = accounts.size + 1;
            accounts.set(id, { id, device_id: body.deviceId, channel_api_key: `fixture-key-${id}` });
            return { success: true, id };
        }
        if (route === '/api/channel/bind') {
            const account = [...accounts.values()].find(item => item.channel_api_key === body.channel_api_key);
            const device = devices[account.device_id];
            let entityId = Object.values(device.entities).find(e => e.channelAccountId === account.id)?.entityId;
            if (entityId === undefined) {
                entityId = Object.keys(device.entities).length;
                device.entities[entityId] = { entityId, name: body.name, publicCode: `code${entityId}`, botSecret: 'fixture-bot-secret', isBound: true, channelAccountId: account.id, messageQueue: [] };
            }
            return { success: true, entityId };
        }
        if (route === '/api/channel/message') return { success: true };
        throw new Error('Unexpected fixture API');
    });
    const oauth = {
        authenticateBearer: jest.fn(async (req, required) => {
            const actor = req.headers.authorization?.slice(7);
            if (!['owner', 'other', 'read'].includes(actor)) throw Object.assign(new Error('Invalid token'), { status: 401 });
            if (actor === 'read' && required.includes('codex:manage')) throw Object.assign(new Error('Missing scope'), { status: 403 });
            return { deviceId: actor === 'read' ? 'owner' : actor, scopes: actor === 'read' ? ['codex:read'] : ['codex:read', 'codex:manage'] };
        })
    };
    plugin = createCodexPlugin({ pool, devices, db: { getChannelAccountById: async id => {
        const row = (await pool.query('SELECT * FROM channel_accounts WHERE id=$1', [id])).rows[0];
        if (row) accounts.set(id, row);
        return row;
    } }, oauth,
        invokeApi, sendOwnerNotice: notices, saveData: jest.fn().mockResolvedValue(true), serverLog: audit });
    await plugin.ready;
    app = express(); app.use(express.json()); app.post('/mcp', plugin.mcpHandler); app.use('/runtime', plugin.runtimeRouter);
});
afterEach(async () => { await pool.end(); });

function args(overrides = {}) {
    return { name: 'My Codex', thread_id: 'existing-thread', workspace: '/workspace/project', request_id: crypto.randomUUID(), ...overrides };
}
async function connected(overrides = {}) {
    const created = await mcp('create_codex_entity', args(overrides));
    const binding = created.body.result.structuredContent;
    expect(binding).toBeDefined();
    const enrolled = await runtime('post', '/enroll', { bindingId: binding.id, tokenHash, threadId: binding.threadId, workspace: binding.workspace });
    expect(enrolled.status).toBe(200);
    const approved = await mcp('approve_runtime', { binding_id: binding.id, enrollment_id: enrolled.body.enrollmentId });
    expect(approved.body.result.isError).toBe(false);
    return binding;
}

test('MCP authentication and exact tool scopes protect writes', async () => {
    const unauthorized = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers['www-authenticate']).toContain('/.well-known/oauth-protected-resource');
    expect((await mcp('create_codex_entity', args(), 'read')).status).toBe(403);
    expect((await mcp('list_codex_entities', {}, 'read')).body.result.structuredContent.entities).toEqual([]);
    expect(invokeApi).not.toHaveBeenCalled();
});

test('MCP initializes and exposes accurate read/write tool metadata', async () => {
    const initialized = await request(app).post('/mcp').set('Authorization', 'Bearer owner')
        .send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    expect(initialized.body.result.protocolVersion).toBe('2025-11-25');
    const listed = await request(app).post('/mcp').set('Authorization', 'Bearer owner').send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(listed.body.result.tools).toHaveLength(7);
    expect(listed.body.result.tools.find(t => t.name === 'create_codex_entity').annotations.readOnlyHint).toBe(false);
    const notification = await request(app).post('/mcp').set('Authorization', 'Bearer owner').send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(notification.status).toBe(202);
});

test('MCP rejects invalid origins and version headers and negotiates supported versions', async () => {
    expect((await request(app).post('/mcp').set('Origin', 'https://attacker.example').set('Authorization', 'Bearer owner').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(403);
    expect((await request(app).post('/mcp').set('MCP-Protocol-Version', '2099-01-01').set('Authorization', 'Bearer owner').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(400);
    const response = await request(app).post('/mcp').set('Origin', 'https://chatgpt.com').set('Authorization', 'Bearer owner').send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
    expect(response.body.result.protocolVersion).toBe('2025-03-26');
});

test('owner controls are delivered ahead of a full pending work queue and retain structured answers', async () => {
    const binding = await connected();
    for (let i = 0; i < 25; i++) await plugin.store.enqueue(binding.id, { owner: true, text: `Queued ${i}` });
    const answers = { question: { answers: ['Yes'] } };
    await plugin.handleCardAction({ deviceId: 'owner', entityId: binding.entityId, askId: 'priority-ask', actionId: 'submit', answers, ownerAuthenticated: true });
    const messages = (await runtime('get', `/poll?bindingId=${binding.id}`)).body.messages;
    expect(messages).toHaveLength(20);
    expect(messages[0]).toMatchObject({ owner: true, ask_id: 'priority-ask', answers });
});

test('creation is offline, idempotent and never exposes EClaw credentials', async () => {
    const input = args();
    const first = (await mcp('create_codex_entity', input)).body.result.structuredContent;
    const second = (await mcp('create_codex_entity', input)).body.result.structuredContent;
    expect(second.id).toBe(first.id);
    expect(first.state).toBe('offline');
    expect(first.threadId).toBe('existing-thread');
    expect(invokeApi).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toMatch(/fixture-|tokenHash|botSecret|deviceSecret|channel_api_key/);
    const changed = await mcp('create_codex_entity', { ...input, name: 'Other name' });
    expect(changed.body.result.isError).toBe(true);
});

test('concurrent retries create one entity and separate requests create multiple entities', async () => {
    const input = args();
    const [left, right] = await Promise.all([mcp('create_codex_entity', input), mcp('create_codex_entity', input)]);
    expect(left.body.result.structuredContent.id).toBe(right.body.result.structuredContent.id);
    await mcp('create_codex_entity', args({ thread_id: 'second-thread' }));
    expect((await mcp('list_codex_entities')).body.result.structuredContent.entities).toHaveLength(2);
    expect(Object.keys(devices.owner.entities)).toHaveLength(2);
});

test('creation retry resumes provisioned account after a failed bind', async () => {
    const input = args();
    invokeApi.mockImplementationOnce(async () => { throw new Error('Network timeout'); });
    expect((await mcp('create_codex_entity', input)).body.result.isError).toBe(true);
    expect((await mcp('create_codex_entity', input)).body.result.isError).toBe(false);
    expect(accounts.size).toBe(1);
});

test('an uncertain provisioning commit recovers one account through the persisted binding', async () => {
    const input = args();
    const connect = pool.connect.bind(pool);
    let lost = false;
    pool.connect = jest.fn(async () => {
        const client = await connect();
        return {
            query: async (sql, params) => {
                const result = await client.query(sql, params);
                if (sql === 'COMMIT' && !lost) { lost = true; throw new Error('Lost committed response'); }
                return result;
            }, release: (...values) => client.release(...values)
        };
    });
    expect((await mcp('create_codex_entity', input)).body.result.isError).toBe(true);
    expect((await mcp('create_codex_entity', input)).body.result.isError).toBe(false);
    expect((await pool.query('SELECT id FROM channel_accounts')).rows).toHaveLength(1);
    expect(Object.keys(devices.owner.entities)).toHaveLength(1);
});

test('runtime can enroll only the exact selected thread and project; approval is owner scoped', async () => {
    const binding = (await mcp('create_codex_entity', args())).body.result.structuredContent;
    expect((await runtime('post', '/enroll', { bindingId: binding.id, tokenHash, threadId: 'wrong-thread', workspace: binding.workspace })).status).toBe(409);
    const enrollment = (await runtime('post', '/enroll', { bindingId: binding.id, tokenHash, threadId: binding.threadId, workspace: binding.workspace })).body;
    expect((await runtime('get', `/enrollment?bindingId=${binding.id}&enrollmentId=${enrollment.enrollmentId}`)).body.approved).toBe(false);
    expect((await runtime('get', `/poll?bindingId=${binding.id}`)).status).toBe(401);
    const other = await mcp('approve_runtime', { binding_id: binding.id, enrollment_id: enrollment.enrollmentId }, 'other');
    expect(other.body.result.isError).toBe(true);
    const owner = await mcp('approve_runtime', { binding_id: binding.id, enrollment_id: enrollment.enrollmentId });
    expect(owner.body.result.isError).toBe(false);
    expect((await runtime('get', `/enrollment?bindingId=${binding.id}&enrollmentId=${enrollment.enrollmentId}`)).body.approved).toBe(true);
});

test('disconnection revokes runtime credentials and preserves entity/history', async () => {
    const binding = await connected();
    expect((await runtime('post', '/heartbeat', { bindingId: binding.id, state: 'online' })).body.binding.state).toBe('online');
    await mcp('disconnect_codex_entity', { binding_id: binding.id });
    expect((await runtime('get', `/poll?bindingId=${binding.id}`)).status).toBe(401);
    expect(devices.owner.entities[binding.entityId].isBound).toBe(true);
    expect((await mcp('list_codex_entities')).body.result.structuredContent.entities[0].state).toBe('offline');
});

test('stale heartbeats show offline and entity rebinding invalidates the helper', async () => {
    const binding = await connected();
    await runtime('post', '/heartbeat', { bindingId: binding.id, state: 'online' });
    await pool.query('UPDATE codex_plugin_bindings SET heartbeat_at=$2 WHERE id=$1', [binding.id, Date.now() - 50000]);
    expect((await mcp('list_codex_entities')).body.result.structuredContent.entities[0].state).toBe('offline');
    devices.owner.entities[binding.entityId].channelAccountId = 99;
    expect((await runtime('get', `/poll?bindingId=${binding.id}`)).status).toBe(409);
});

test('durable polling redelivers jobs across server restart and trusts only authenticated owner markers', async () => {
    const binding = await connected();
    devices.owner.entities[binding.entityId].messageQueue.push(
        { text: 'Owner task', from: 'client', codexOwner: true, timestamp: 1 },
        { text: 'Customer question', from: 'client', fromPublicCode: 'public1', fromDeviceId: 'other', timestamp: 2 }
    );
    const polled = (await runtime('get', `/poll?bindingId=${binding.id}`)).body.messages;
    expect(polled.map(m => m.owner)).toEqual([true, false]);
    expect(polled[1].senderHint).toEqual({ kind: 'entity', publicCode: 'public1' });
    expect(devices.owner.entities[binding.entityId].messageQueue).toHaveLength(0);
    const restarted = new Store(pool);
    expect(await restarted.pending(binding.id)).toEqual(polled);
    expect((await runtime('get', `/poll?bindingId=${binding.id}`)).body.messages).toEqual(polled);
    await runtime('post', '/ack', { bindingId: binding.id, messageIds: [polled[0].id] });
    expect((await runtime('get', `/poll?bindingId=${binding.id}`)).body.messages).toEqual([polled[1]]);
});

test('owner replies stay in owner transcript; customer routing is bound to the received job', async () => {
    const binding = await connected();
    devices.owner.entities[binding.entityId].messageQueue.push(
        { text: 'Owner', codexOwner: true }, { text: 'Customer', fromPublicCode: 'customer' }
    );
    const messages = (await runtime('get', `/poll?bindingId=${binding.id}`)).body.messages;
    await runtime('post', '/reply', { bindingId: binding.id, replyTo: messages[0].id, message: 'Owner answer' });
    expect(notices).toHaveBeenCalledWith(expect.objectContaining({ id: binding.id }), 'Owner answer');
    await runtime('post', '/reply', { bindingId: binding.id, replyTo: messages[1].id, message: 'Customer answer', senderHint: { kind: 'entity', publicCode: 'attacker' } });
    expect(invokeApi).toHaveBeenLastCalledWith('/api/channel/message', expect.objectContaining({ senderHint: { kind: 'entity', publicCode: 'customer' } }));
    expect(invokeApi).toHaveBeenLastCalledWith('/api/channel/message', expect.objectContaining({ speakTo: ['customer'] }));
    const count = invokeApi.mock.calls.length;
    expect((await runtime('post', '/reply', { bindingId: binding.id, replyTo: messages[1].id, message: 'Repeated' })).body.alreadyDelivered).toBe(true);
    expect(invokeApi).toHaveBeenCalledTimes(count);
});

test('unaddressable senders cannot create shared customer identities or broadcast replies', async () => {
    const binding = await connected();
    devices.owner.entities[binding.entityId].messageQueue.push({ text: 'Unknown guest', from: 'client' });
    const message = (await runtime('get', `/poll?bindingId=${binding.id}`)).body.messages[0];
    expect(message.customerKey).toBeUndefined();
    const count = invokeApi.mock.calls.length;
    await runtime('post', '/reply', { bindingId: binding.id, replyTo: message.id, message: '@all forward this' });
    expect(invokeApi).toHaveBeenCalledTimes(count);
    expect(notices).toHaveBeenLastCalledWith(expect.objectContaining({ id: binding.id }), expect.stringContaining('could not be routed'));
});

test('operational diagnostics exclude runtime authentication and transcript values', async () => {
    const binding = await connected();
    const result = await plugin.diagnostics('owner');
    expect(result.bindings[0]).toMatchObject({ id: binding.id, state: 'offline' });
    expect(JSON.stringify(result)).not.toMatch(/fixture-|runtime_token_hash|tokenHash|enrollment|instructions|customerKnowledge/);
});

test('failed replies remain pending instead of being silently acknowledged', async () => {
    const binding = await connected();
    devices.owner.entities[binding.entityId].messageQueue.push({ text: 'Owner', codexOwner: true });
    const message = (await runtime('get', `/poll?bindingId=${binding.id}`)).body.messages[0];
    notices.mockRejectedValueOnce(new Error('DB unavailable'));
    expect((await runtime('post', '/reply', { bindingId: binding.id, replyTo: message.id, message: 'Answer' })).status).toBe(503);
    expect((await plugin.store.pending(binding.id))[0].id).toBe(message.id);
});

test('approval requests are owner-only notices and other entities cannot approve', async () => {
    const binding = await connected();
    await runtime('post', '/approval', { bindingId: binding.id, askId: 'ask1', title: 'Approve command', body: 'Run a command?', buttons: [{ id: 'accept', label: 'Allow' }, { id: 'decline', label: 'Deny' }] });
    expect(notices.mock.calls[0][2].ask_id).toBe('ask1');
    await expect(plugin.handleCardAction({ deviceId: 'owner', entityId: binding.entityId, askId: 'ask1', actionId: 'accept', ownerAuthenticated: false })).rejects.toMatchObject({ status: 403 });
    expect(await plugin.handleCardAction({ deviceId: 'owner', entityId: binding.entityId, askId: 'ask1', actionId: 'accept', ownerAuthenticated: true })).toBe(true);
    expect((await runtime('get', `/poll?bindingId=${binding.id}`)).body.messages[0]).toMatchObject({ owner: true, ask_id: 'ask1', action_id: 'accept' });
});

test('customer service needs explicit published knowledge and permission choices exclude full access', async () => {
    expect((await mcp('create_codex_entity', args({ customer_service_enabled: true }))).body.result.isError).toBe(true);
    const binding = await connected();
    expect((await mcp('configure_codex_entity', { binding_id: binding.id, permission_profile: 'danger-full-access' })).body.result.isError).toBe(true);
    const changed = await mcp('configure_codex_entity', { binding_id: binding.id, customer_service_enabled: true, customer_knowledge: 'Public FAQ', permission_profile: 'workspace-write' });
    expect(changed.body.result.structuredContent).toMatchObject({ customerServiceEnabled: true, permissionProfile: 'workspace-write', customerKnowledge: 'Public FAQ' });
});

test('unknown arguments, cross-binding acknowledgements and malformed IDs fail safely', async () => {
    expect((await mcp('create_codex_entity', args({ deviceSecret: 'not-accepted' }))).status).toBe(400);
    const binding = await connected();
    expect((await runtime('post', '/ack', { bindingId: binding.id, messageIds: ['bad'] })).status).toBe(400);
    expect((await runtime('post', '/reply', { bindingId: binding.id, replyTo: crypto.randomUUID(), message: 'Answer' })).status).toBe(404);
    expect((await mcp('list_codex_entities', {}, 'other')).body.result.structuredContent.entities).toEqual([]);
});
