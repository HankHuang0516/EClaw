// Real HTTP/database contract with a deterministic local app-server fixture.
// Never uses a live account, subscription credential or public endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeStore, RuntimeWorker, enrollRuntime } from '../../codex-plugin/scripts/runtime.mjs';

const require = createRequire(import.meta.url);
const express = require('express');
const { newDb } = require('pg-mem');
const { createCodexPlugin } = require('../codex-plugin');

async function until(predicate) {
    for (let i = 0; i < 200; i++) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('Local contract timeout');
}

test('bundled helper enrolls, polls, approves and replies through the real backend contract', async t => {
    const root = await mkdtemp(join(await realpath(tmpdir()), 'eclaw-local-contract-'));
    const workspace = join(root, 'project');
    await mkdir(workspace, { mode: 0o700 });
    const store = new RuntimeStore({ dataDir: join(root, 'state'), lockDir: join(root, 'locks') });
    const database = newDb();
    database.public.registerFunction({ name: 'pg_try_advisory_lock', args: ['bigint'], returns: 'bool', implementation: () => true });
    database.public.registerFunction({ name: 'pg_advisory_unlock', args: ['bigint'], returns: 'bool', implementation: () => true });
    const { Pool } = database.adapters.createPg();
    const pool = new Pool();
    await pool.query('CREATE TABLE channel_accounts (id SERIAL PRIMARY KEY,device_id TEXT,channel_api_key TEXT,channel_api_secret TEXT,created_at BIGINT,updated_at BIGINT)');
    const devices = { owner: { deviceSecret: 'test-owner', entities: {} } };
    const account = { id: 1, device_id: 'owner', channel_api_key: 'test-channel' };
    const notices = [], routed = [], clients = [];
    let plugin, worker, run;
    class LocalAppServer extends EventEmitter {
        constructor(options) { super(); this.options = options; this.customer = !!options.configOverrides; clients.push(this); }
        async start() { return this; }
        async close() {}
        async capabilities() { return { restrictedReads: true }; }
        async request(method, params) {
            if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' }, requiresOpenaiAuth: true };
            if (method === 'thread/read' || method === 'thread/resume') return {
                thread: { id: params.threadId, cwd: this.options.cwd, modelProvider: 'openai', status: { type: 'notLoaded' } }, instructionSources: []
            };
            if (method === 'config/read') return { config: { mcp_servers: {}, plugins: {}, skills: { config: [] } } };
            if (method === 'skills/list') return { data: [{ cwd: this.options.cwd, skills: [], errors: [] }] };
            if (method === 'thread/start') return { thread: { id: 'customer-thread', cwd: this.options.cwd, modelProvider: 'openai' }, instructionSources: [] };
            if (method === 'turn/interrupt') return {};
            assert.equal(method, 'turn/start');
            this.active = { id: randomUUID(), threadId: params.threadId, input: params.input };
            const active = this.active;
            queueMicrotask(() => {
                if (this.customer) this.finish('Public hours: 9 to 5.');
                else this.emit('request', { id: 'approval-request', method: 'item/commandExecution/requestApproval',
                    params: { threadId: params.threadId, turnId: active.id, itemId: 'command', command: 'inspect project', cwd: workspace } });
            });
            return { turn: { id: active.id, status: 'inProgress' } };
        }
        respond(_id, result) { assert.equal(result.decision, 'accept'); this.finish('Owner response'); }
        reject() { assert.fail('unexpected local server request'); }
        finish(text) { this.emit('notification', { method: 'turn/completed', params: { threadId: this.active.threadId,
            turn: { id: this.active.id, status: 'completed', items: [{ id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text }] } } }); }
    }
    plugin = createCodexPlugin({ pool, devices, db: { getChannelAccountById: async id => (await pool.query('SELECT * FROM channel_accounts WHERE id=$1', [id])).rows[0] },
        oauth: { authenticateBearer: async () => ({ deviceId: 'owner', scopes: ['codex:read', 'codex:manage'] }) },
        invokeApi: async (path, body) => {
            if (path.endsWith('/provision-device')) return { success: true, id: 1 };
            if (path.endsWith('/bind')) {
                devices.owner.entities[0] = { name: body.name, isBound: true, channelAccountId: 1, publicCode: 'owner1', botSecret: 'test-bot', messageQueue: [] };
                return { success: true, entityId: 0 };
            }
            assert.equal(path, '/api/channel/message'); routed.push(body); return { success: true };
        }, sendOwnerNotice: async (_binding, message, card) => notices.push({ message, card }), saveData: async () => {}
    });
    await plugin.ready;
    const app = express(); app.use(express.json()); app.use('/api/codex/runtime', plugin.runtimeRouter);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    t.after(async () => {
        worker?.stop(); await run?.catch(() => {});
        await new Promise(resolve => server.close(resolve)); await pool.end(); await rm(root, { recursive: true, force: true });
    });
    const binding = await plugin.callTool({ deviceId: 'owner' }, 'create_codex_entity', {
        request_id: randomUUID(), name: 'My Codex', thread_id: 'owner-thread', workspace,
        permission_profile: 'workspace-write', customer_service_enabled: true, customer_knowledge: 'Hours: 9 to 5.'
    });
    const enrollment = await enrollRuntime({ bindingId: binding.id, threadId: 'owner-thread', workspace, store,
        apiBase: `http://127.0.0.1:${server.address().port}`, clientFactory: options => new LocalAppServer(options) });
    assert.ok(enrollment.enrollmentId); assert.equal(enrollment.runtimeToken, undefined);
    await plugin.callTool({ deviceId: 'owner' }, 'approve_runtime', { binding_id: binding.id, enrollment_id: enrollment.enrollmentId });
    devices.owner.entities[0].messageQueue.push({ text: 'Inspect project', codexOwner: true },
        { text: 'Your hours?', from: 'external', fromPublicCode: 'guest1' });
    worker = new RuntimeWorker({ bindingId: binding.id, store, clientFactory: options => new LocalAppServer(options),
        pollIntervalMs: 10, heartbeatIntervalMs: 20, approvalTimeoutMs: 3000, turnTimeoutMs: 5000 });
    run = worker.run(); run.catch(() => {});
    await until(() => notices.some(n => n.card));
    const card = notices.find(n => n.card).card;
    await assert.rejects(plugin.handleCardAction({ deviceId: 'owner', entityId: 0, askId: card.ask_id,
        actionId: 'accept', ownerAuthenticated: false }), { status: 403 });
    await plugin.handleCardAction({ deviceId: 'owner', entityId: 0, askId: card.ask_id, actionId: 'accept', ownerAuthenticated: true });
    await until(() => routed.length === 1 && notices.some(n => n.message === 'Owner response'));
    assert.deepEqual(routed[0].senderHint, { kind: 'entity', publicCode: 'guest1' });
    assert.deepEqual(routed[0].speakTo, ['guest1']);
    assert.equal(routed[0].message, 'Public hours: 9 to 5.');
    assert.equal(clients.filter(c => c.customer).length, 1);
    assert.equal(clients.find(c => c.customer).active.threadId, 'customer-thread');
    assert.ok(!JSON.stringify(clients.find(c => c.customer).active.input).includes('Inspect project'));
    await until(async () => (await plugin.store.pending(binding.id)).length === 0);
    worker.stop(); await run;
    assert.equal((await store.status(binding.id)).state, 'offline');
});
