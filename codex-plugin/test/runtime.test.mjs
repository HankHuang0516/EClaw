import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { AppServerClient, AppServerError, inspectProtocol } from '../scripts/app-server-client.mjs';
import { RuntimeApi, RuntimeError, RuntimeStore, RuntimeWorker, enrollRuntime, runCli, parseArgs, validateApiBase, safeErrorCode } from '../scripts/runtime.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const SECOND_ID = '22222222-2222-4222-8222-222222222222';
const job = (text, extra = {}) => ({ id: randomUUID(), text, owner: true, timestamp: new Date().toISOString(), ...extra });
async function until(predicate, timeout = 2500) {
  const start = Date.now();
  while (!(await predicate())) { if (Date.now() - start > timeout) throw new Error('test_wait_timeout'); await delay(3); }
}

class FakeApi {
  constructor(binding) {
    this.binding = binding; this.jobs = []; this.replies = []; this.approvals = []; this.acks = [];
    this.heartbeats = []; this.completed = new Set(); this.approved = true; this.pollCount = 0;
  }
  async enroll(body) { this.enrollBody = body; return { success: true, enrollmentId: 'enrollment-public', expiresAt: Date.now() + 60000, runtimeToken: 'SERVER_VALUE_MUST_NOT_ESCAPE' }; }
  async enrollment() { return { success: true, approved: this.approved, binding: this.binding }; }
  async poll() { this.pollCount++; if (this.pollError) throw this.pollError; return { success: true, binding: this.binding, messages: this.jobs.filter(m => !this.completed.has(m.id)) }; }
  async reply(body) {
    this.replyAttempts = (this.replyAttempts ?? 0) + 1;
    if (this.replyFailures-- > 0) throw new RuntimeError('api_unavailable');
    this.replies.push(body); this.completed.add(body.replyTo); return { success: true };
  }
  async approval(body) { if (this.approvalFailure) throw new RuntimeError('api_unavailable'); this.approvals.push(body); return { success: true }; }
  async ack(body) { if (this.ackFailures-- > 0) throw new RuntimeError('api_unavailable'); this.acks.push(body); body.messageIds.forEach(id => this.completed.add(id)); return { success: true }; }
  async heartbeat(body) { this.heartbeats.push(body); return { success: true }; }
}

class FakeApp extends EventEmitter {
  constructor(fixture, options) {
    super(); this.fixture = fixture; this.options = options; this.calls = []; this.turns = []; this.responses = [];
    this.customer = !!options.configOverrides; this.threadId = this.customer ? `customer-${fixture.clients.length}` : 'owner-thread';
    this.requests = new Map(); this.rejects = [];
  }
  async start() { this.started = true; return this; }
  async close() { this.closed = true; }
  async capabilities() { return { restrictedReads: this.fixture.restrictedReads !== false }; }
  async request(method, params) {
    this.calls.push({ method, params });
    const f = this.fixture;
    if (method === 'account/read') return { account: f.account ?? { type: 'chatgpt', planType: 'pro', email: 'PRIVATE_ACCOUNT' }, requiresOpenaiAuth: true };
    if (method === 'thread/read') {
      if (f.readError) throw new AppServerError('app_server_refused');
      return { thread: { id: f.readId ?? params.threadId, cwd: f.readCwd ?? this.options.cwd, modelProvider: 'openai', status: { type: 'notLoaded' } } };
    }
    if (method === 'thread/resume') {
      if (f.resumeError) throw new AppServerError('app_server_refused');
      this.threadId = params.threadId;
      return { thread: { id: f.resumeId ?? params.threadId, cwd: f.resumeCwd ?? this.options.cwd, modelProvider: 'openai' }, instructionSources: [] };
    }
    if (method === 'config/read') return { config: { mcp_servers: { private_mcp: { enabled: true } }, plugins: { 'private@plugin': { enabled: true } }, features: { apps: true }, skills: { config: [] } } };
    if (method === 'skills/list') return { data: [{ cwd: params.cwds[0], skills: [{ path: '/private/skill/SKILL.md' }], errors: [] }] };
    if (method === 'thread/start') return { thread: { id: f.customerThreadId ?? this.threadId, cwd: this.options.cwd, modelProvider: 'openai', sessionId: this.threadId }, instructionSources: f.customerInstructionSources ?? [] };
    if (method === 'turn/start') {
      const turn = { id: randomUUID(), status: 'inProgress' }; this.turns.push({ ...params, turnId: turn.id });
      queueMicrotask(() => {
        if (f.onTurn) f.onTurn(this, turn, params);
        else this.finish(turn, params.threadId, this.customer ? 'public response' : 'owner response');
      });
      return { turn };
    }
    if (method === 'turn/interrupt') { this.interrupted = true; return {}; }
    throw new Error('unexpected_fake_method');
  }
  finish(turn, threadId, text, status = 'completed') {
    this.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id: turn.id, status, items: [{ id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text }] } } });
  }
  ask(method, turn, params = {}) {
    const id = randomUUID(); const request = { id, method, params: { threadId: this.threadId, turnId: turn.id, itemId: 'item', ...params } };
    this.requests.set(id, request); this.emit('request', request); return id;
  }
  respond(id, result) { this.responses.push({ id, result }); this.emit('response', { id, result }); }
  reject(id) { this.rejects.push(id); }
}

async function fixture(t, { seed = true, id = ID, threadId = 'owner-thread' } = {}) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'eclaw-runtime-test-'));
  const workspace = join(root, 'project'); await mkdir(workspace, { mode: 0o700 });
  const store = new RuntimeStore({ dataDir: join(root, 'data'), lockDir: join(root, 'locks') });
  const binding = { id, entityId: 'entity', threadId, workspace, permissionProfile: 'workspace-write', customerServiceEnabled: false,
    customerKnowledge: 'PUBLIC_FACT', role: 'PRIVATE_ROLE', instructions: 'PRIVATE_INSTRUCTIONS', language: 'en' };
  const f = { root, workspace, store, binding, clients: [], api: new FakeApi(binding) };
  f.clientFactory = options => { const client = new FakeApp(f, options); f.clients.push(client); return client; };
  f.apiFactory = options => { f.apiOptions = options; return f.api; };
  f.state = { version: 1, bindingId: id, threadId, workspace, apiBase: 'https://eclawbot.com', runtimeToken: randomBytes(32).toString('hex'),
    enrollmentId: 'enrollment-public', state: 'offline', approved: false, pid: null, lastError: null, completedIds: [], customers: {} };
  if (seed) await store.save(f.state);
  f.launch = async extra => {
    f.worker = new RuntimeWorker({ bindingId: id, store, apiFactory: f.apiFactory, clientFactory: f.clientFactory,
      pollIntervalMs: 5, heartbeatIntervalMs: 5, approvalTimeoutMs: 120, turnTimeoutMs: 1000, ...extra });
    f.running = f.worker.run(); f.running.catch(() => {});
    await until(async () => (await store.status(id)).online || f.worker.fatal);
  };
  f.stop = async () => { f.worker?.stop(); if (f.running) await f.running.catch(() => {}); };
  t.after(async () => { await f.stop(); await rm(root, { recursive: true, force: true }); });
  return f;
}

test('enrollment stores only a SHA256 hash remotely, local token is 0600, stdout is allowlisted', async t => {
  const f = await fixture(t, { seed: false }); let stdout = '';
  const result = await runCli(['--enroll', '--binding', ID, '--thread', 'owner-thread', '--workspace', f.workspace], {
    store: f.store, clientFactory: f.clientFactory, apiFactory: f.apiFactory, stdout: { write: text => { stdout += text; } } });
  const state = await f.store.load(ID);
  assert.equal((await stat(f.store.path(ID))).mode & 0o777, 0o600);
  assert.equal((await stat(f.store.dataDir)).mode & 0o777, 0o700);
  assert.equal(f.api.enrollBody.tokenHash, createHash('sha256').update(state.runtimeToken).digest('hex'));
  assert.deepEqual(Object.keys(f.api.enrollBody).sort(), ['bindingId', 'threadId', 'tokenHash', 'workspace']);
  assert.deepEqual(Object.keys(result).sort(), ['bindingId', 'enrollmentId', 'success', 'threadId', 'workspace']);
  for (const secret of [state.runtimeToken, f.api.enrollBody.tokenHash, 'PRIVATE_ACCOUNT', 'SERVER_VALUE_MUST_NOT_ESCAPE']) assert.ok(!stdout.includes(secret));
  assert.deepEqual(f.clients[0].calls.find(c => c.method === 'thread/read').params, { threadId: 'owner-thread', includeTurns: false });
  assert.ok(f.clients[0].closed);
});

test('failed initial enrollment retries saved token/hash; approved enrollment retries stay idempotent', async t => {
  const f = await fixture(t, { seed: false }); const original = f.api.enroll.bind(f.api); let fail = true;
  f.api.enroll = async body => { if (fail) { fail = false; f.firstHash = body.tokenHash; throw new RuntimeError('api_unavailable'); } return original(body); };
  const options = { bindingId: ID, threadId: 'owner-thread', workspace: f.workspace, store: f.store, clientFactory: f.clientFactory, apiFactory: f.apiFactory };
  await assert.rejects(enrollRuntime(options), { code: 'api_unavailable' });
  const failed = await f.store.load(ID); assert.equal(failed.lastError, 'api_unavailable'); assert.equal(failed.enrollmentId, null);
  const result = await enrollRuntime(options); const repaired = await f.store.load(ID);
  assert.equal(repaired.runtimeToken, failed.runtimeToken); assert.equal(f.api.enrollBody.tokenHash, f.firstHash); assert.equal(repaired.lastError, null);
  repaired.expiresAt = Date.now() - 1000; await f.store.save(repaired);
  assert.deepEqual(await enrollRuntime(options), result); assert.equal((await f.store.load(ID)).runtimeToken, repaired.runtimeToken);
});

test('expired unapproved enrollment rotates locally; pending retries preserve IDs and target changes refuse', async t => {
  const f = await fixture(t); f.api.approved = false; f.state.expiresAt = Date.now() + 60000; await f.store.save(f.state);
  const options = { bindingId: ID, threadId: 'owner-thread', workspace: f.workspace, store: f.store, clientFactory: f.clientFactory, apiFactory: f.apiFactory };
  await enrollRuntime(options); assert.equal(f.api.enrollBody, undefined);
  f.state.expiresAt = Date.now() - 1000; await f.store.save(f.state);
  f.api.enrollment = async () => { throw new RuntimeError('enrollment_expired'); };
  await enrollRuntime(options); assert.notEqual((await f.store.load(ID)).runtimeToken, f.state.runtimeToken);
  await assert.rejects(enrollRuntime({ ...options, workspace: f.root }), { code: 'enrollment_mismatch' });
});

test('lost enrollment response later reveals expired hash: check approval, rotate once and preserve recovery state', async t => {
  const f = await fixture(t); f.state.enrollmentId = null; f.state.inFlight = { messageId: randomUUID(), threadId: 'owner-thread' }; await f.store.save(f.state);
  const original = f.api.enroll.bind(f.api); let attempts = 0;
  f.api.enroll = async body => { const response = await original(body); if (++attempts === 1) response.expiresAt = Date.now() - 1000; return response; };
  f.api.enrollment = async () => { throw new RuntimeError('enrollment_expired'); };
  await enrollRuntime({ bindingId: ID, threadId: 'owner-thread', workspace: f.workspace, store: f.store, clientFactory: f.clientFactory, apiFactory: f.apiFactory });
  const repaired = await f.store.load(ID); assert.equal(attempts, 2); assert.notEqual(repaired.runtimeToken, f.state.runtimeToken);
  assert.deepEqual(repaired.inFlight, f.state.inFlight);
});

for (const account of [null, { type: 'apiKey' }, { type: 'amazonBedrock' }, { type: 'chatgpt', planType: 'free' }, { type: 'chatgpt', planType: null }]) {
  test(`subscription-only enrollment refuses ${account?.type ?? 'missing'} ${account?.planType ?? ''}`, async t => {
    const f = await fixture(t, { seed: false }); f.account = account ?? { type: 'missing' };
    await assert.rejects(enrollRuntime({ bindingId: ID, threadId: 'owner-thread', workspace: f.workspace, store: f.store, clientFactory: f.clientFactory, apiFactory: f.apiFactory }), { code: 'chatgpt_subscription_required' });
    assert.equal(f.api.enrollBody, undefined); assert.ok(f.clients[0].closed);
  });
}

test('exact resume preserves owner context/config, serial turns deduplicate durable jobs and finish through replyTo', async t => {
  const f = await fixture(t); const first = job('first'), second = job('second'); f.api.jobs.push(first, second, first);
  let active = 0, peak = 0;
  f.onTurn = (client, turn, params) => { active++; peak = Math.max(peak, active); setTimeout(() => { active--; client.finish(turn, params.threadId, params.input[0].text); }, 20); };
  await f.launch(); await until(() => f.api.replies.length === 2); await f.stop();
  const client = f.clients[0]; const resume = client.calls.find(c => c.method === 'thread/resume').params;
  assert.deepEqual(resume, { threadId: 'owner-thread', cwd: f.workspace, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write', excludeTurns: true });
  assert.equal(client.calls.filter(c => c.method === 'thread/start' || c.method === 'thread/fork' || c.method.includes('archive')).length, 0);
  assert.equal(peak, 1); assert.equal(client.turns.length, 2);
  assert.ok(client.turns.every(turn => turn.threadId === 'owner-thread' && turn.cwd === f.workspace && turn.approvalPolicy === 'on-request'));
  assert.deepEqual(f.api.replies.map(r => r.replyTo), [first.id, second.id]); assert.equal(f.api.acks.length, 0);
  assert.ok(f.api.pollCount > 2); assert.ok(f.api.heartbeats.some(h => h.state === 'busy'));
  assert.equal(f.api.heartbeats.at(-1).state, 'offline');
});

for (const variant of ['readError', 'readId', 'readCwd', 'resumeError', 'resumeId', 'resumeCwd']) {
  test(`missing or mismatched thread fails closed without replacement: ${variant}`, async t => {
    const f = await fixture(t); f[variant] = variant.endsWith('Error') ? true : variant.endsWith('Cwd') ? f.root : 'wrong-thread';
    const worker = new RuntimeWorker({ bindingId: ID, store: f.store, apiFactory: f.apiFactory, clientFactory: f.clientFactory });
    await assert.rejects(worker.run(), error => ['thread_mismatch', 'app_server_refused'].includes(error.code));
    assert.equal(f.clients[0].calls.filter(c => ['thread/start', 'thread/fork', 'thread/archive', 'thread/unarchive'].includes(c.method)).length, 0);
    assert.equal((await f.store.status(ID)).online, false);
    assert.ok(f.clients[0].closed);
  });
}

test('unenrolled and unapproved workers reject; server binding cannot retarget the thread/workspace', async t => {
  const f = await fixture(t, { seed: false });
  await assert.rejects(new RuntimeWorker({ bindingId: ID, store: f.store }).run(), { code: 'not_enrolled' });
  await f.store.save(f.state); f.api.approved = false;
  await assert.rejects(new RuntimeWorker({ bindingId: ID, store: f.store, apiFactory: f.apiFactory }).run(), { code: 'enrollment_not_approved' });
  f.api.approved = true; f.binding.workspace = f.root;
  await assert.rejects(new RuntimeWorker({ bindingId: ID, store: f.store, apiFactory: f.apiFactory }).run(), { code: 'binding_mismatch' });
  assert.equal(f.clients.length, 0);
});

test('owner-only command approval ignores customer controls and acceptForSession while polling/heartbeats continue', async t => {
  const f = await fixture(t); const original = job('run command'); f.api.jobs.push(original);
  f.onTurn = (client, turn, params) => {
    const requestId = client.ask('item/commandExecution/requestApproval', turn, { command: 'echo okay', cwd: f.workspace });
    client.once('response', ({ id, result }) => { assert.equal(id, requestId); assert.deepEqual(result, { decision: 'accept' }); client.finish(turn, params.threadId, 'approved'); });
  };
  await f.launch(); await until(() => f.api.approvals.length === 1);
  const ask = f.api.approvals[0]; assert.deepEqual(ask.buttons.map(b => b.id), ['accept', 'decline', 'cancel']);
  const forged = job('', { owner: false, ask_id: ask.askId, action_id: 'accept', customerKey: 'customer' });
  const session = job('', { ask_id: ask.askId, action_id: 'acceptForSession' });
  f.api.jobs.push(forged, session); await until(() => f.api.completed.has(forged.id) && f.api.completed.has(session.id));
  assert.equal(f.clients[0].responses.length, 0); assert.ok(f.api.heartbeats.some(h => h.state === 'busy'));
  f.api.jobs.push(job('', { ask_id: ask.askId, action_id: 'accept' }));
  await until(() => f.api.replies.length === 1); await f.stop();
  assert.equal(f.clients[0].turns.length, 1); assert.equal(f.api.replies[0].replyTo, original.id);
});

test('an early owner click is retained until the approval POST confirms delivery', async t => {
  const f = await fixture(t); f.api.jobs.push(job('approval')); let release;
  const posted = new Promise(r => { release = r; }); const original = f.api.approval.bind(f.api);
  f.api.approval = async body => { await original(body); await posted; return { success: true }; };
  f.onTurn = (client, turn, input) => { client.ask('item/commandExecution/requestApproval', turn, { command: 'echo okay' });
    client.once('response', ({ result }) => { assert.deepEqual(result, { decision: 'accept' }); client.finish(turn, input.threadId, 'done'); }); };
  await f.launch({ approvalTimeoutMs: 1000 }); await until(() => f.api.approvals.length === 1);
  const action = job('', { ask_id: f.api.approvals[0].askId, action_id: 'accept' }); f.api.jobs.push(action);
  const before = f.api.pollCount; await until(() => f.api.pollCount >= before + 2);
  assert.ok(!f.api.completed.has(action.id)); assert.equal(f.clients[0].responses.length, 0);
  release(); await until(() => f.api.replies.length === 1);
});

for (const [method, params, action, answers, expected] of [
  ['item/fileChange/requestApproval', { grantRoot: '/work' }, 'accept', undefined, { decision: 'accept' }],
  ['item/permissions/requestApproval', { permissions: { network: { enabled: true }, fileSystem: { read: ['/public'] } } }, 'accept', undefined, { permissions: { network: { enabled: true }, fileSystem: { read: ['/public'] } }, scope: 'turn' }],
  ['item/tool/requestUserInput', { questions: [{ id: 'choice', question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }] }, 'choice_0', { choice: ['UNTRUSTED_OVERRIDE'] }, { answers: { choice: { answers: ['A'] } } }],
  ['mcpServer/elicitation/request', { mode: 'url', message: 'Confirm', url: 'https://example.test/login', elicitationId: 'public' }, 'accept', undefined, { action: 'accept', content: null }]
]) {
  test(`owner approval protocol response: ${method} ${params.mode ?? ''}`, async t => {
    const f = await fixture(t); f.api.jobs.push(job('request'));
    f.onTurn = (client, turn, input) => { client.ask(method, turn, params); client.once('response', ({ result }) => { assert.deepEqual(result, expected); client.finish(turn, input.threadId, 'done'); }); };
    await f.launch(); await until(() => f.api.approvals.length === 1);
    f.api.jobs.push(job('', { ask_id: f.api.approvals[0].askId, action_id: action, ...(answers ? { answers } : {}) }));
    await until(() => f.api.replies.length === 1);
  });
}

for (const [method, params, expected] of [
  ['item/tool/requestUserInput', { questions: [{ id: 'q', question: 'Free text' }] }, { answers: {} }],
  ['item/tool/requestUserInput', { questions: [{ id: 'q1', question: 'First', options: [{ label: 'A' }] }, { id: 'q2', question: 'Second', options: [{ label: 'B' }] }] }, { answers: {} }],
  ['item/tool/requestUserInput', { questions: [{ id: 'q', question: 'Other', isOther: true, options: [{ label: 'A' }] }] }, { answers: {} }],
  ['mcpServer/elicitation/request', { mode: 'form', requestedSchema: { type: 'object' }, message: 'Input form' }, { action: 'decline', content: null }]
]) {
  test(`unsupported remote input denies with actionable owner-only notice: ${params.mode ?? params.questions[0].question}`, async t => {
    const f = await fixture(t); f.api.jobs.push(job('input'));
    f.onTurn = (client, turn, input) => { client.ask(method, turn, params); client.once('response', ({ result }) => { assert.deepEqual(result, expected); client.finish(turn, input.threadId, 'use local Codex'); }); };
    await f.launch(); await until(() => f.api.replies.length === 1);
    assert.equal(f.api.approvals.length, 1); assert.deepEqual(f.api.approvals[0].buttons, [{ id: 'decline', label: 'Dismiss' }]);
    assert.ok(f.api.approvals[0].body.includes('local Codex'));
  });
}

test('approval timeout and publication failure deny; unknown/unscoped requests fail closed', async t => {
  for (const publishFailure of [false, true]) {
    const f = await fixture(t); f.api.approvalFailure = publishFailure; f.api.jobs.push(job('approval'));
    f.onTurn = (client, turn, input) => {
      client.ask('future/executeDangerousTool', turn);
      client.ask('item/fileChange/requestApproval', turn, { threadId: 'different-thread' });
      client.ask('item/commandExecution/requestApproval', turn, { command: 'echo okay' });
      let count = 0;
      client.on('response', ({ result }) => { assert.deepEqual(result, { decision: 'decline' }); if (++count === 2) client.finish(turn, input.threadId, 'declined'); });
    };
    await f.launch({ approvalTimeoutMs: 25 }); await until(() => f.api.replies.length === 1); await f.stop();
    assert.equal(f.clients[0].rejects.length, 1); assert.equal(f.clients[0].responses.length, 2);
  }
});

test('read-only profile denies command/file escalation and grants no filesystem write permissions', async t => {
  const f = await fixture(t); f.binding.permissionProfile = 'read-only'; f.api.jobs.push(job('approval'));
  f.onTurn = (client, turn, input) => {
    client.ask('item/commandExecution/requestApproval', turn, { command: 'write secret' });
    client.ask('item/fileChange/requestApproval', turn);
    client.ask('item/permissions/requestApproval', turn, { permissions: { fileSystem: { write: [f.workspace] } } });
    let count = 0; client.on('response', () => { if (++count === 3) client.finish(turn, input.threadId, 'denied'); });
  };
  await f.launch({ approvalTimeoutMs: 35 }); await until(() => f.api.approvals.length === 1);
  f.api.jobs.push(job('', { ask_id: f.api.approvals[0].askId, action_id: 'accept' }));
  await until(() => f.api.replies.length === 1);
  assert.deepEqual(f.clients[0].responses.at(-1).result, { permissions: {}, scope: 'turn' });
  assert.equal(f.clients[0].turns[0].sandboxPolicy.type, 'readOnly');
});

test('customers use distinct threads and empty cwd, no owner/private config/context/control, public knowledge only', async t => {
  const f = await fixture(t); f.binding.customerServiceEnabled = true;
  const customer1 = job('public question', { owner: false, customerKey: 'c1', senderHint: 'customer-route' });
  const customer2 = job('other question', { owner: false, customerKey: 'c2' });
  f.api.jobs.push(job('private work'), customer1, customer2, job('next c1', { owner: false, customerKey: 'c1' }));
  f.onTurn = (client, turn, params) => {
    if (client.customer) {
      const id = client.ask('item/permissions/requestApproval', turn, { permissions: { network: { enabled: true } } });
      client.once('response', result => { assert.equal(result.id, id); assert.deepEqual(result.result, { permissions: {}, scope: 'turn' }); client.finish(turn, params.threadId, 'public response'); });
    } else client.finish(turn, params.threadId, 'private output');
  };
  await f.launch(); await until(() => f.api.replies.length === 4); await f.stop();
  assert.equal(f.clients.length, 3); assert.equal(f.clients[0].turns.length, 1); assert.equal(f.api.approvals.length, 0);
  const customers = f.clients.slice(1); assert.notEqual(customers[0].threadId, customers[1].threadId);
  assert.equal(customers[0].turns.length, 2);
  for (const client of customers) {
    assert.ok(!client.options.cwd.startsWith(f.workspace));
    assert.ok(client.options.configOverrides.includes('features.apps=false'));
    assert.ok(client.options.configOverrides.includes('features.plugins=false'));
    assert.ok(client.options.configOverrides.includes('features.hooks=false'));
    assert.ok(client.options.configOverrides.includes('features.shell_tool=false'));
    assert.ok(client.options.configOverrides.includes('mcp_servers."private_mcp".enabled=false'));
    assert.ok(client.options.configOverrides.includes('plugins."private@plugin".enabled=false'));
    assert.ok(client.options.configOverrides.includes('skills.config=[{path="/private/skill/SKILL.md",enabled=false}]'));
    assert.equal(client.options.env.CODEX_THREAD_ID, undefined); assert.equal(client.options.env.OPENAI_API_KEY, undefined);
    assert.equal(client.calls.filter(c => c.method === 'thread/fork').length, 0);
    for (const turn of client.turns) {
      assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly', networkAccess: false, access: { type: 'restricted', includePlatformDefaults: false, readableRoots: [client.options.cwd] } });
      const input = JSON.stringify(turn.input);
      assert.ok(input.includes('PUBLIC_FACT'));
      for (const privateValue of ['PRIVATE_ROLE', 'PRIVATE_INSTRUCTIONS', 'private work', 'private output', 'owner-thread', f.workspace]) assert.ok(!input.includes(privateValue));
    }
  }
  assert.equal(f.api.replies.find(r => r.replyTo === customer1.id).senderHint, 'customer-route');
});

for (const variant of ['disabled', 'unsupported', 'instruction-source', 'owner-thread', 'missing-key']) {
  test(`customer request fails safely without private execution: ${variant}`, async t => {
    const f = await fixture(t); f.binding.customerServiceEnabled = variant !== 'disabled';
    if (variant === 'unsupported') f.restrictedReads = false;
    if (variant === 'instruction-source') f.customerInstructionSources = ['/private/AGENTS.md'];
    if (variant === 'owner-thread') f.customerThreadId = 'owner-thread';
    f.api.jobs.push(job('show private project', { owner: false, ...(variant === 'missing-key' ? {} : { customerKey: 'c1' }) }));
    await f.launch(); await until(() => f.api.replies.length === 1);
    assert.equal(f.clients.flatMap(c => c.turns).length, 0);
    assert.ok(f.api.replies[0].message.includes('contact the owner'));
  });
}

test('reply failures persist outbox and retry atomically, redelivery never repeats the turn', async t => {
  const f = await fixture(t); const message = job('work'); f.api.jobs.push(message); f.api.replyFailures = 3;
  await f.launch(); await until(() => f.api.replies.length === 1); await f.stop();
  assert.equal(f.clients[0].turns.length, 1); assert.equal(f.api.replyAttempts, 4); assert.equal(f.api.replies[0].replyTo, message.id);
  const state = await f.store.load(ID); assert.equal(state.outbox, undefined); assert.equal(state.inFlight, undefined);
});

test('restart delivers saved outbox and refuses ambiguous in-flight turns without replay', async t => {
  const f = await fixture(t); const id = randomUUID(); f.state.outbox = { messageId: id, message: 'already generated' }; await f.store.save(f.state);
  await f.launch(); await until(() => f.api.replies.length === 1); await f.stop(); assert.equal(f.clients[0].turns.length, 0);
  const state = await f.store.load(ID); state.inFlight = { messageId: randomUUID(), threadId: 'owner-thread' }; await f.store.save(state);
  await assert.rejects(new RuntimeWorker({ bindingId: ID, store: f.store, apiFactory: f.apiFactory, clientFactory: f.clientFactory }).run(), { code: 'turn_recovery_required' });
  assert.equal(f.clients.flatMap(c => c.turns).length, 0);
});

test('turn timeout interrupts and closes the process, leaves job uncompleted and records sanitized lifecycle state', async t => {
  const f = await fixture(t); const message = job('hang'); f.api.jobs.push(message); f.onTurn = () => {};
  await f.launch({ turnTimeoutMs: 25 }); await assert.rejects(f.running, { code: 'turn_timeout' });
  assert.ok(f.clients[0].interrupted); assert.ok(f.clients[0].closed); assert.ok(!f.api.completed.has(message.id));
  const status = await f.store.status(ID); assert.equal(status.online, false); assert.equal(status.lastError, 'turn_timeout');
  assert.equal(f.api.heartbeats.at(-1).state, 'offline');
});

test('API transient failures recover; authentication loss fails closed and never leaks errors', async t => {
  const f = await fixture(t); await f.launch(); f.api.pollError = new RuntimeError('api_unavailable');
  await until(async () => (await f.store.status(ID)).lastError === 'api_unavailable');
  f.api.pollError = null; f.api.jobs.push(job('after reconnect')); await until(() => f.api.replies.length === 1);
  f.clients[0].emit('notification', { method: 'account/updated', params: { authMode: 'apikey', apiKey: 'NEVER_PRINT' } });
  await assert.rejects(f.running, { code: 'chatgpt_subscription_required' });
  assert.ok(!JSON.stringify(await f.store.status(ID)).includes('NEVER_PRINT'));
});

test('same-thread concurrent local bindings are locked; stopping releases locks and permits restart', async t => {
  const f = await fixture(t); await f.launch();
  const second = { ...f.state, bindingId: SECOND_ID }; await f.store.save(second);
  await assert.rejects(new RuntimeWorker({ bindingId: SECOND_ID, store: f.store }).run(), { code: 'runtime_locked' });
  await f.stop(); await f.launch(); await f.stop();
  assert.equal((await f.store.status(ID)).state, 'offline');
});

test('CLI --stop uses a private per-run stop request, waits for graceful offline; --status is sanitized', async t => {
  const f = await fixture(t); await f.launch(); let stdout = '';
  const stopped = await runCli(['--stop', '--binding', ID], { store: f.store, stdout: { write: value => { stdout += value; } } });
  assert.equal(stopped.online, false); await f.running;
  const status = await runCli(['--status', '--binding', ID], { store: f.store, stdout: { write: value => { stdout += value; } } });
  assert.equal(status.busy, false); assert.ok(!stdout.includes(f.state.runtimeToken)); assert.ok(!stdout.includes('customers'));
  assert.equal((await stat(`${f.store.path(ID)}.stop`)).mode & 0o777, 0o600);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`foreground CLI ${signal} interrupts active work and posts offline without logging content`, async t => {
    const f = await fixture(t); f.api.jobs.push(job('PRIVATE_WORK')); f.onTurn = () => {}; let stdout = '';
    f.stop = async () => { process.emit(signal); if (f.running) await f.running.catch(() => {}); };
    const before = process.listenerCount(signal);
    f.running = runCli(['--run', '--binding', ID], { store: f.store, apiFactory: f.apiFactory, clientFactory: f.clientFactory, stdout: { write: s => { stdout += s; } } });
    f.running.catch(() => {});
    await until(() => f.clients[0]?.turns.length === 1); process.emit(signal); await f.running;
    assert.equal(process.listenerCount(signal), before); assert.ok(f.clients[0].interrupted); assert.ok(f.clients[0].closed);
    assert.equal(f.api.heartbeats.at(-1).state, 'offline'); assert.ok(!stdout.includes('PRIVATE_WORK')); assert.ok(!stdout.includes(f.state.runtimeToken));
  });
}

test('CLI --start detaches node --run with no logs and returns safe online flags', async t => {
  const f = await fixture(t); let options; let args; let launched;
  const spawnProcess = (command, childArgs, childOptions) => {
    assert.equal(command, process.execPath); args = childArgs; options = childOptions;
    const child = new EventEmitter(); child.pid = process.pid; child.unref = () => {}; child.kill = () => {};
    launched = f.launch(); return child;
  };
  let stdout = '';
  const status = await runCli(['--start', '--binding', ID], { store: f.store, spawnProcess, stdout: { write: s => { stdout += s; } } });
  await launched;
  assert.ok(status.online); assert.equal(options.detached, true); assert.equal(options.stdio, 'ignore');
  assert.deepEqual(args.slice(1), ['--run', '--binding', ID]); assert.ok(!stdout.includes(f.state.runtimeToken));
});

test('CLI validation/default thread and private state path guards', async t => {
  const f = await fixture(t);
  assert.equal(parseArgs(['--enroll', '--binding', ID, '--workspace', f.workspace], { CODEX_THREAD_ID: 'active-thread' }).threadId, 'active-thread');
  for (const argv of [['--run'], ['--run', '--binding', '../escape'], ['--run', '--status', '--binding', ID], ['--run', '--binding', ID, '--thread', 'other'], ['--bogus', '--binding', ID]]) assert.throws(() => parseArgs(argv), RuntimeError);
  await assert.rejects(enrollRuntime({ bindingId: ID, workspace: f.workspace, threadId: null, store: f.store }), { code: 'thread_required' });
  const unsafe = new RuntimeStore({ dataDir: join(f.workspace, 'credentials'), lockDir: f.store.lockDir });
  await assert.rejects(unsafe.save(f.state), { code: 'unsafe_data_directory' });
  const alias = join(f.root, 'alias'); await symlink(f.store.dataDir, alias);
  await assert.rejects(new RuntimeStore({ dataDir: alias, lockDir: f.store.lockDir }).load(ID), { code: 'unsafe_data_directory' });
});

test('RuntimeApi is outbound backend-only, enroll has no bearer, other endpoints authenticate and reject redirects/raw errors', async t => {
  const requests = []; const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, auth: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ success: true, approved: true }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => server.close(r)));
  const token = randomBytes(32).toString('hex'); const api = new RuntimeApi({ apiBase: `http://127.0.0.1:${server.address().port}`, runtimeToken: token });
  await api.enroll({ bindingId: ID, tokenHash: 'HASH', threadId: 'owner-thread', workspace: '/public' });
  await api.enrollment(ID, 'enrollment'); await api.poll(ID); await api.reply({ bindingId: ID, message: 'reply', replyTo: randomUUID() });
  await api.approval({ bindingId: ID, askId: randomUUID() }); await api.ack({ bindingId: ID, messageIds: [randomUUID()] }); await api.heartbeat({ bindingId: ID, state: 'online' });
  assert.equal(requests[0].auth, undefined); assert.ok(requests.slice(1).every(r => r.auth === `Bearer ${token}`));
  assert.ok(requests.every(r => r.url.startsWith('/api/codex/runtime/') && !r.url.includes(token) && !r.body.includes(token)));
  assert.equal(validateApiBase('eclawbot.com'), 'https://eclawbot.com');
  for (const base of ['http://example.com', 'http://localhost.evil.test', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com/?token=secret']) assert.throws(() => validateApiBase(base), { code: 'invalid_api_base' });
  for (const response of [new Response('RAW_SECRET', { status: 403 }), new Response('RAW_SECRET', { status: 500 }), new Response('{"success":false,"error":"RAW_SECRET"}'), new Response('RAW_SECRET')]) {
    const denied = new RuntimeApi({ apiBase: 'https://eclawbot.com', runtimeToken: token, fetchImpl: async (_, opts) => { assert.equal(opts.redirect, 'error'); return response; } });
    await assert.rejects(denied.poll(ID), error => !error.message.includes('RAW_SECRET'));
  }
});

test('HTTP timeouts and oversized responses fail with machine codes, never raw body or transport errors', async () => {
  const hanging = new RuntimeApi({ apiBase: 'https://eclawbot.com', runtimeToken: 'fixture', timeoutMs: 10,
    fetchImpl: (_url, { signal }) => new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('PRIVATE_TRANSPORT')), 1000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('PRIVATE_TRANSPORT')); }, { once: true }); }) });
  await assert.rejects(hanging.poll(ID), { code: 'api_timeout' });
  const oversized = new RuntimeApi({ apiBase: 'https://eclawbot.com', runtimeToken: 'fixture', fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) });
  await assert.rejects(oversized.poll(ID), { code: 'api_invalid_response' });
});

class FakeChild extends EventEmitter {
  constructor(onMessage) {
    super(); this.stdin = new PassThrough(); this.stdout = new PassThrough(); this.stderr = new PassThrough(); this.exitCode = null;
    let buffer = ''; this.stdin.on('data', chunk => { buffer += chunk; let end; while ((end = buffer.indexOf('\n')) >= 0) { const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); onMessage(message, this); } });
  }
  send(value) { this.stdout.write(`${JSON.stringify(value)}\n`); }
  kill(signal) { this.signalCode = signal; queueMicrotask(() => this.emit('exit', null, signal)); }
}

test('stdio app-server initialization, unknown requests, fragmented JSON and safe RPC failures', async () => {
  const sent = []; let child; let args;
  const client = new AppServerClient({ cwd: '/project', requestTimeoutMs: 30, spawnProcess: (_, a) => {
    args = a; child = new FakeChild((message, c) => { sent.push(message); if (message.method === 'initialize') c.send({ id: message.id, result: { userAgent: 'test' } });
      if (message.method === 'fail') c.send({ id: message.id, error: { message: 'PRIVATE_TOKEN', data: 'SECRET' } }); }); return child;
  } });
  await client.start(); assert.ok(args.includes('stdio://')); assert.ok(args.includes('forced_login_method="chatgpt"'));
  assert.deepEqual(sent.slice(0, 2).map(m => m.method), ['initialize', 'initialized']);
  const notification = new Promise(r => client.once('notification', r));
  child.stdout.write('{"method":"thread/'); child.stdout.write('started","params":{}}\n');
  assert.equal((await notification).method, 'thread/started');
  child.send({ id: 'server-id', method: 'unknown/request', params: { secret: 'SECRET' } });
  assert.equal(sent.at(-1).error.code, -32601); assert.ok(!JSON.stringify(sent.at(-1)).includes('SECRET'));
  await assert.rejects(client.request('fail'), { code: 'app_server_refused' });
  await assert.rejects(client.request('hang'), { code: 'app_server_timeout' });
  child.stderr.write('PRIVATE_STDERR'); await client.close(); assert.ok(client.closed);
});

test('malformed app-server stdout or process exit rejects pending requests with sanitized errors', async () => {
  for (const malformed of [true, false]) {
    let child;
    const client = new AppServerClient({ spawnProcess: () => { child = new FakeChild((message, c) => { if (message.method === 'initialize') c.send({ id: message.id, result: {} }); }); return child; } });
    await client.start(); const promise = client.request('hang');
    if (malformed) child.stdout.write('PRIVATE_RAW_STDIO\n'); else child.emit('exit', 1);
    await assert.rejects(promise, error => ['app_server_protocol', 'app_server_exited'].includes(error.code));
    assert.ok(client.closed); await client.close();
  }
});

test('protocol capability detection uses the installed schema and refuses missing restricted reads', async () => {
  for (const restrictedReads of [false, true]) {
    let output;
    const result = await inspectProtocol({ spawnProcess: (_command, args) => {
      output = args[args.indexOf('--out') + 1]; const child = new EventEmitter(); child.kill = () => {};
      const schema = { definitions: { SandboxPolicy: { oneOf: [{ properties: { type: { enum: ['readOnly'] },
        ...(restrictedReads ? { access: { $ref: '#/definitions/ReadOnlyAccess' } } : {}) } }] }, ReadOnlyAccess: { properties: { readableRoots: {} } } } };
      writeFile(join(output, 'TurnStartParams.json'), JSON.stringify(schema)).then(() => child.emit('exit', 0)); return child;
    } });
    assert.equal(result.restrictedReads, restrictedReads);
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
  assert.equal(safeErrorCode(new Error('SECRET')), 'runtime_error');
});

test('acknowledgments batch at backend limit 20 and retry without generating control turns', async t => {
  const f = await fixture(t); f.api.ackFailures = 1;
  f.api.jobs.push(...Array.from({ length: 45 }, () => job('', { ask_id: randomUUID(), action_id: 'accept' })));
  await f.launch(); await until(() => f.api.completed.size === 45); await f.stop();
  assert.deepEqual(f.api.acks.map(a => a.messageIds.length), [20, 20, 5]); assert.equal(f.clients[0].turns.length, 0);
});

test('known runtime credentials redact before payload truncation; local status never exposes outbox content', async t => {
  const f = await fixture(t); f.api.jobs.push(job('redaction'));
  f.onTurn = (client, turn, params) => client.finish(turn, params.threadId, `${'x'.repeat(29990)}${f.state.runtimeToken}`);
  await f.launch(); await until(() => f.api.replies.length === 1); await f.stop();
  assert.equal(f.api.replies[0].message.length, 30000);
  assert.ok(!f.api.replies[0].message.includes(f.state.runtimeToken.slice(0, 10)));
  const state = await f.store.load(ID); state.outbox = { message: 'PRIVATE_OUTPUT', messageId: randomUUID() }; state.lastError = state.runtimeToken; await f.store.save(state);
  const status = await f.store.status(ID); assert.equal(status.lastError, null); assert.ok(!JSON.stringify(status).includes('PRIVATE_OUTPUT'));
});

test('stale locks recover only when PID is dead; ambiguous/malformed locks fail closed', async t => {
  const f = await fixture(t); const key = 'stale-test'; await f.store.directory(f.store.lockDir);
  const file = join(f.store.lockDir, `${createHash('sha256').update(key).digest('hex')}.lock`);
  await writeFile(file, JSON.stringify({ pid: 2147483647, nonce: 'old' }), { mode: 0o600 });
  const release = await f.store.lock(key); await release();
  await writeFile(file, '{malformed', { mode: 0o600 });
  await assert.rejects(f.store.lock(key), { code: 'runtime_locked' });
});

test('real parent REST router + store integrates numeric enrollment, entity senderHint, bounded approval/reply and durable jobs', async t => {
  // Runtime shipping code remains builtin-only. This contract test reuses the
  // parent's existing express/pg-mem dev dependencies, never installs packages.
  const backendRequire = createRequire(new URL('../../backend/codex-plugin.js', import.meta.url));
  const express = backendRequire('express');
  const { newDb } = backendRequire('pg-mem');
  const { createCodexPlugin } = backendRequire('./codex-plugin.js');
  const database = newDb();
  database.public.registerFunction({ name: 'pg_try_advisory_lock', args: ['bigint'], returns: 'bool', implementation: () => true });
  database.public.registerFunction({ name: 'pg_advisory_unlock', args: ['bigint'], returns: 'bool', implementation: () => true });
  const pg = database.adapters.createPg(); const pool = new pg.Pool();
  await pool.query('CREATE TABLE channel_accounts (id SERIAL PRIMARY KEY,device_id TEXT,channel_api_key TEXT,channel_api_secret TEXT,created_at BIGINT,updated_at BIGINT)');
  const f = await fixture(t, { seed: false });
  const devices = { owner: { deviceSecret: 'fixture-owner-secret', entities: {} } };
  const accounts = new Map(); const ownerNotices = []; const customerReplies = [];
  let failedCustomerReply = false;
  const invokeApi = async (route, body) => {
    if (route === '/api/channel/provision-device') { accounts.set(1, { id: 1, device_id: 'owner', channel_api_key: 'fixture-channel-key' }); return { success: true, id: 1 }; }
    if (route === '/api/channel/bind') { devices.owner.entities[0] = { entityId: 0, name: body.name, isBound: true, channelAccountId: 1, publicCode: 'PUBLIC', botSecret: 'fixture-bot-secret', messageQueue: [] }; return { success: true, entityId: 0 }; }
    if (route === '/api/channel/message') {
      if (!failedCustomerReply) { failedCustomerReply = true; throw new Error('fixture transport failure'); }
      customerReplies.push(body); return { success: true };
    }
    throw new Error('unexpected integration endpoint');
  };
  const plugin = createCodexPlugin({ pool, devices, db: { getChannelAccountById: async id => (await pool.query('SELECT * FROM channel_accounts WHERE id=$1', [id])).rows[0] }, oauth: {}, invokeApi,
    sendOwnerNotice: async (_binding, message, details) => { ownerNotices.push({ message, details }); }, saveData: async () => true });
  await plugin.ready;
  const binding = await plugin.callTool({ deviceId: 'owner' }, 'create_codex_entity', { name: 'Integration', thread_id: 'owner-thread', workspace: f.workspace,
    request_id: randomUUID(), permission_profile: 'workspace-write', customer_service_enabled: true, customer_knowledge: 'PUBLIC_FACT' });
  const app = express(); app.use(express.json()); app.use('/api/codex/runtime', plugin.runtimeRouter);
  const server = createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { await f.stop(); await new Promise(r => server.close(r)); await pool.end(); });
  const apiBase = `http://127.0.0.1:${server.address().port}`;
  const enrollment = await enrollRuntime({ bindingId: binding.id, threadId: 'owner-thread', workspace: f.workspace, apiBase, store: f.store, clientFactory: f.clientFactory });
  assert.ok(typeof (await f.store.load(binding.id)).expiresAt === 'number');
  await plugin.callTool({ deviceId: 'owner' }, 'approve_runtime', { binding_id: binding.id, enrollment_id: enrollment.enrollmentId });
  const entity = devices.owner.entities[0]; const ownerId = randomUUID(), customerId = randomUUID();
  entity.messageQueue.push({ codexOwner: true, text: 'owner task', codexDeliveryId: ownerId }, { fromPublicCode: 'ABCDEF', text: 'public question', codexDeliveryId: customerId });
  f.onTurn = (client, turn, params) => {
    if (client.customer) client.finish(turn, params.threadId, 'public answer');
    else {
      client.ask('item/commandExecution/requestApproval', turn, { command: 'x'.repeat(18000), cwd: f.workspace });
      client.once('response', ({ result }) => { assert.deepEqual(result, { decision: 'accept' }); client.finish(turn, params.threadId, 'r'.repeat(40000)); });
    }
  };
  f.worker = new RuntimeWorker({ bindingId: binding.id, store: f.store, clientFactory: f.clientFactory, pollIntervalMs: 5, heartbeatIntervalMs: 5, approvalTimeoutMs: 1500 });
  f.running = f.worker.run(); f.running.catch(() => {});
  await until(() => ownerNotices.some(n => n.details?.ask_id), 4000);
  const approval = ownerNotices.find(n => n.details?.ask_id);
  assert.ok(approval.message.length <= 12000);
  await assert.rejects(plugin.handleCardAction({ deviceId: 'owner', entityId: 0, askId: approval.details.ask_id, actionId: 'accept', ownerAuthenticated: false }), { status: 403 });
  await plugin.handleCardAction({ deviceId: 'owner', entityId: 0, askId: approval.details.ask_id, actionId: 'accept', ownerAuthenticated: true });
  await until(() => customerReplies.length === 1, 4000);
  assert.deepEqual(customerReplies[0].senderHint, { kind: 'entity', publicCode: 'ABCDEF' });
  assert.ok(ownerNotices.some(n => !n.details && n.message.length === 30000));
  const ownerJob = await plugin.store.job(ownerId, binding.id), customerJob = await plugin.store.job(customerId, binding.id);
  assert.ok(ownerJob.completed_at); assert.ok(customerJob.completed_at);
  assert.equal(f.clients.filter(c => c.customer).flatMap(c => c.turns).length, 1);
  assert.equal((await plugin.store.pending(binding.id)).length, 0);
  // The real UI/card handler forwards action IDs only. A fixed choice is
  // sufficient; arbitrary answers are neither required nor trusted.
  const choiceId = randomUUID(); entity.messageQueue.push({ codexOwner: true, text: 'choice task', codexDeliveryId: choiceId });
  f.onTurn = (client, turn, params) => {
    client.ask('item/tool/requestUserInput', turn, { questions: [{ id: 'color', question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }] }] });
    client.once('response', ({ result }) => { assert.deepEqual(result, { answers: { color: { answers: ['Blue'] } } }); client.finish(turn, params.threadId, 'choice answered'); });
  };
  await until(() => ownerNotices.some(n => n.details?.buttons?.some(b => b.id === 'choice_1')), 4000);
  const question = ownerNotices.find(n => n.details?.buttons?.some(b => b.id === 'choice_1'));
  assert.ok(question.message.includes('Which color?'));
  await plugin.handleCardAction({ deviceId: 'owner', entityId: 0, askId: question.details.ask_id, actionId: 'choice_1', ownerAuthenticated: true });
  await until(async () => !!(await plugin.store.job(choiceId, binding.id)).completed_at, 4000);
  await f.stop();
});

test('local routing-only auth boundary never calls login/export or hosted inference APIs', async t => {
  const f = await fixture(t); f.api.jobs.push(job('help')); await f.launch(); await until(() => f.api.replies.length === 1); await f.stop();
  const methods = f.clients.flatMap(c => c.calls.map(call => call.method));
  assert.ok(methods.includes('account/read'));
  assert.ok(!methods.some(method => /login|logout|authTokens|refresh|export/.test(method)));
  assert.deepEqual(Object.keys(f.apiOptions).sort(), ['apiBase', 'runtimeToken']);
  assert.equal(f.apiOptions.apiBase, 'https://eclawbot.com');
  const source = await readFile(new URL('../scripts/runtime.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('LOCAL, OPEN-SOURCE, ROUTING-ONLY'));
  assert.ok(!/readFile\([^\n]*auth\.json|api\.openai\.com|ACCESS_TOKEN|account\/login/.test(source));
});
