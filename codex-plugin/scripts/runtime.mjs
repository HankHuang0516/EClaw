#!/usr/bin/env node
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, unlink, lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { AppServerClient, AppServerError } from './app-server-client.mjs';

// LOCAL, OPEN-SOURCE, ROUTING-ONLY integration. Built-in Codex account auth is
// for local/open-source applications, not hosted inference. Codex owns login;
// this helper never reads auth.json or extracts/forwards subscription tokens.
// A hosted/commercial inference service would need its own supported OAuth flow.

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = text => createHash('sha256').update(text).digest('hex');
const inside = (parent, child) => { const r = relative(parent, child); return !r || (r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r)); };

export class RuntimeError extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function safeErrorCode(error) {
  return error instanceof RuntimeError || error instanceof AppServerError ? error.code : 'runtime_error';
}
function requireText(value, code, max = 4096) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new RuntimeError(code);
  return value;
}
function bindingId(value) { if (!UUID.test(value ?? '')) throw new RuntimeError('invalid_binding'); return value.toLowerCase(); }
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function deferred() {
  let resolvePromise; const promise = new Promise(r => { resolvePromise = r; });
  return { promise, resolve: resolvePromise };
}

export function validateApiBase(value = 'https://eclawbot.com') {
  if (typeof value !== 'string' || !value.trim()) throw new RuntimeError('invalid_api_base');
  let url;
  try { url = new URL(value.includes('://') ? value : `https://${value}`); } catch { throw new RuntimeError('invalid_api_base'); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new RuntimeError('invalid_api_base');
  return url.origin;
}

// All runtime REST methods are injectable; no redirects may forward the bearer.
export class RuntimeApi {
  constructor({ apiBase, runtimeToken, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
    this.apiBase = validateApiBase(apiBase); this.runtimeToken = runtimeToken;
    this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs;
  }
  async request(method, endpoint, { body, query, signal } = {}) {
    const url = new URL(`/api/codex/runtime/${endpoint}`, this.apiBase);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, { method, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { 'Content-Type': 'application/json', ...(endpoint === 'enroll' ? {} : { Authorization: `Bearer ${this.runtimeToken}` }) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if ([401, 403].includes(response.status)) throw new RuntimeError('runtime_auth_refused');
      if (endpoint === 'enrollment' && response.status === 410) throw new RuntimeError('enrollment_expired');
      if (!response.ok) throw new RuntimeError('api_unavailable');
      // Bound untrusted responses without printing or keeping raw errors.
      let text = ''; const reader = response.body?.getReader();
      if (!reader) throw new RuntimeError('api_invalid_response');
      const decoder = new TextDecoder(); let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.length; if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new RuntimeError('api_invalid_response'); }
        text += decoder.decode(value, { stream: true });
      }
      let data; try { data = JSON.parse(text + decoder.decode()); } catch { throw new RuntimeError('api_invalid_response'); }
      if (data?.success !== true) throw new RuntimeError('api_refused');
      return data;
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(timeout.aborted ? 'api_timeout' : 'api_unavailable');
    }
  }
  enroll(body, options) { return this.request('POST', 'enroll', { ...options, body }); }
  enrollment(id, enrollmentId, options) { return this.request('GET', 'enrollment', { ...options, query: { bindingId: id, enrollmentId } }); }
  poll(id, options) { return this.request('GET', 'poll', { ...options, query: { bindingId: id, ...(options?.busy ? { busy: 'true' } : {}) } }); }
  reply(body, options) { return this.request('POST', 'reply', { ...options, body }); }
  approval(body, options) { return this.request('POST', 'approval', { ...options, body }); }
  ack(body, options) { return this.request('POST', 'ack', { ...options, body }); }
  heartbeat(body, options) { return this.request('POST', 'heartbeat', { ...options, body }); }
}

export class RuntimeStore {
  constructor({ dataDir = process.env.CODEX_PLUGIN_DATA || join(homedir(), '.codex/plugins/data/eclawbot'),
    lockDir = join(homedir(), '.codex/plugins/data/eclawbot/locks'), repoRoot = REPO } = {}) {
    this.dataDir = resolve(dataDir); this.lockDir = resolve(lockDir); this.repoRoot = resolve(repoRoot);
  }
  async directory(path, workspace) {
    // Reject symlink components before creating private files.
    let current = resolve(path);
    while (current !== dirname(current)) {
      try { if ((await lstat(current)).isSymbolicLink()) throw new RuntimeError('unsafe_data_directory'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      current = dirname(current);
    }
    // macOS /tmp and /var aliases are canonicalized by callers/tests.
    if (inside(this.repoRoot, resolve(path)) || (workspace && inside(workspace, resolve(path)))) throw new RuntimeError('unsafe_data_directory');
    await mkdir(path, { recursive: true, mode: 0o700 });
    const canonical = await realpath(path);
    if (inside(await realpath(this.repoRoot).catch(() => this.repoRoot), canonical) || (workspace && inside(workspace, canonical))) throw new RuntimeError('unsafe_data_directory');
    const mode = (await lstat(path)).mode & 0o777;
    if (mode & 0o077) throw new RuntimeError('unsafe_data_permissions');
    return canonical;
  }
  path(id) { return join(this.dataDir, `${bindingId(id)}.json`); }
  async load(id) {
    await this.directory(this.dataDir);
    try {
      const handle = await open(this.path(id), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 2 * 1024 * 1024) throw new RuntimeError('unsafe_state_file');
        const state = JSON.parse(await handle.readFile('utf8'));
        if (state.bindingId !== bindingId(id) || !isAbsolute(state.workspace ?? '') ||
          !state.threadId || !/^[0-9a-f]{64}$/.test(state.runtimeToken ?? '')) throw new RuntimeError('invalid_state');
        validateApiBase(state.apiBase);
        return state;
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError(error.code === 'ENOENT' ? 'not_enrolled' : 'invalid_state');
    }
  }
  async save(state) {
    await this.directory(this.dataDir, state.workspace);
    await this.writePrivate(this.path(state.bindingId), state);
  }
  async writePrivate(file, value) {
    const temp = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temp, file); }
    finally { await unlink(temp).catch(() => {}); }
  }
  async requestStop(id, runId) {
    if (!UUID.test(runId ?? '')) throw new RuntimeError('runtime_not_running');
    await this.directory(this.dataDir);
    await this.writePrivate(`${this.path(id)}.stop`, { runId });
  }
  async stopRequested(id, runId) {
    try {
      const handle = await open(`${this.path(id)}.stop`, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 256 || (stat.mode & 0o077)) return false;
        return JSON.parse(await handle.readFile('utf8')).runId === runId;
      } finally { await handle.close(); }
    } catch { return false; }
  }
  async lock(key) {
    await this.directory(this.lockDir);
    const file = join(this.lockDir, `${hash(key)}.lock`); const nonce = randomUUID();
    let handle;
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    try { handle = await open(file, flags, 0o600); }
    catch {
      // Serialize stale-lock reclamation. Never reclaim a live PID or an
      // unreadable lock. A racing fresh acquisition wins via O_EXCL.
      const reclaim = `${file}.reclaim`; let reclaimHandle;
      try {
        reclaimHandle = await open(reclaim, flags, 0o600);
        const previous = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        let record;
        try {
          const stat = await previous.stat();
          if (!stat.isFile() || stat.size > 256 || (stat.mode & 0o077)) throw new RuntimeError('runtime_locked');
          record = JSON.parse(await previous.readFile('utf8'));
        } finally { await previous.close(); }
        if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || alive(record.pid)) throw new RuntimeError('runtime_locked');
        await unlink(file); handle = await open(file, flags, 0o600);
      } catch { throw new RuntimeError('runtime_locked'); }
      finally { if (reclaimHandle) { await reclaimHandle.close(); await unlink(reclaim).catch(() => {}); } }
    }
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); }
    finally { await handle.close(); }
    return async () => {
      try { if (JSON.parse(await readFile(file, 'utf8')).nonce === nonce) await unlink(file); } catch { /* fail closed on replacement */ }
    };
  }
  async customerWorkspace(id, key, workspace) {
    const path = join(this.dataDir, 'customers', bindingId(id), hash(key), 'cwd');
    await this.directory(path, workspace);
    if ((await readdir(path)).length) throw new RuntimeError('customer_workspace_not_empty');
    return realpath(path);
  }
  async status(id) {
    const s = await this.load(id); const running = alive(s.pid);
    return { success: true, bindingId: s.bindingId, enrollmentId: s.enrollmentId ?? null,
      threadId: s.threadId, workspace: s.workspace, pid: running ? s.pid : null,
      state: running ? s.state : 'offline', online: running && ['online', 'busy'].includes(s.state),
      busy: running && s.state === 'busy', approved: s.approved === true,
      lastError: typeof s.lastError === 'string' && /^[a-z_]{1,63}$/.test(s.lastError) ? s.lastError : null };
  }
}

async function subscription(client) {
  const result = await client.request('account/read', { refreshToken: false });
  const account = result?.account;
  if (account?.type !== 'chatgpt' || result.requiresOpenaiAuth === false ||
    !['plus', 'pro', 'team', 'business', 'enterprise', 'edu', 'education', 'go'].includes(account.planType)) throw new RuntimeError('chatgpt_subscription_required');
}
function exactThread(result, state) {
  const t = result?.thread;
  if (t?.id !== state.threadId || typeof t.cwd !== 'string' || resolve(t.cwd) !== state.workspace) throw new RuntimeError('thread_mismatch');
  if (t.modelProvider && t.modelProvider !== 'openai') throw new RuntimeError('chatgpt_subscription_required');
  if (t.status?.type === 'active') throw new RuntimeError('thread_busy');
}
function validBinding(binding, state) {
  if (!binding || binding.id !== state.bindingId || binding.threadId !== state.threadId ||
    binding.workspace !== state.workspace || !['read-only', 'workspace-write'].includes(binding.permissionProfile) ||
    typeof binding.customerServiceEnabled !== 'boolean') throw new RuntimeError('binding_mismatch');
  for (const key of ['customerKnowledge', 'role', 'instructions', 'language']) {
    if (binding[key] !== undefined && binding[key] !== null && (typeof binding[key] !== 'string' || binding[key].length > 131072)) throw new RuntimeError('invalid_binding');
  }
  return binding;
}

export async function enrollRuntime({ bindingId: id, threadId = process.env.CODEX_THREAD_ID, workspace,
  apiBase = 'https://eclawbot.com', store = new RuntimeStore(), clientFactory = options => new AppServerClient(options),
  apiFactory = options => new RuntimeApi(options) }) {
  id = bindingId(id); requireText(threadId, 'thread_required', 256);
  if (!isAbsolute(workspace ?? '')) throw new RuntimeError('absolute_workspace_required');
  workspace = await realpath(workspace).catch(() => { throw new RuntimeError('workspace_missing'); });
  apiBase = validateApiBase(apiBase);
  const release = await store.lock(`binding:${id}`); let releaseThread; let client;
  try {
    let existing;
    try { existing = await store.load(id); }
    catch (error) { if (error.code !== 'not_enrolled') throw error; }
    if (existing && (existing.threadId !== threadId || existing.workspace !== workspace || existing.apiBase !== apiBase)) throw new RuntimeError('enrollment_mismatch');
    releaseThread = await store.lock(`thread:${threadId}`);
    client = clientFactory({ cwd: workspace }); await client.start(); await subscription(client);
    exactThread(await client.request('thread/read', { threadId, includeTurns: false }), { threadId, workspace });
    const publicResult = state => ({ success: true, enrollmentId: state.enrollmentId, bindingId: id, threadId, workspace });
    let expired = false;
    if (existing?.enrollmentId) {
      try {
        const checked = await apiFactory({ apiBase, runtimeToken: existing.runtimeToken }).enrollment(id, existing.enrollmentId);
        if (checked.approved === true) {
          validBinding(checked.binding, existing); existing.approved = true; existing.lastError = null; await store.save(existing);
          return publicResult(existing);
        }
        const expiry = typeof existing.expiresAt === 'number' ? existing.expiresAt : Date.parse(existing.expiresAt);
        expired = !Number.isFinite(expiry) || expiry <= Date.now();
        if (!expired) return publicResult(existing);
      } catch (error) {
        if (error.code !== 'enrollment_expired') throw error;
        expired = true;
      }
    }
    // Retry an uncertain first POST with the SAME saved token/hash. Explicitly
    // reenrolling an expired, unapproved attempt creates a fresh token, avoiding
    // the backend's idempotent lookup returning its old expired enrollment.
    const state = existing && !expired ? existing : { version: 1, bindingId: id, threadId, workspace, apiBase,
      completedIds: [], customers: {}, ...(existing ?? {}), runtimeToken: randomBytes(32).toString('hex'),
      state: 'offline', approved: false, pid: null, enrollmentId: null, lastError: null };
    await store.save(state);
    let api = apiFactory({ apiBase, runtimeToken: state.runtimeToken });
    try {
      let result = await api.enroll({ bindingId: id, tokenHash: hash(state.runtimeToken), threadId, workspace });
      requireText(result.enrollmentId, 'invalid_enrollment', 256);
      let expiresAt = typeof result.expiresAt === 'number' ? result.expiresAt : Date.parse(result.expiresAt);
      if (!Number.isFinite(expiresAt)) throw new RuntimeError('invalid_enrollment');
      if (expiresAt <= Date.now()) {
        // A lost first response has no saved enrollmentId. Its idempotent POST
        // may reveal an old expired attempt. Confirm it is unapproved before
        // rotating once; never invalidate a working approved credential.
        try {
          const checked = await api.enrollment(id, result.enrollmentId);
          if (checked.approved === true) { validBinding(checked.binding, state); state.approved = true; }
        } catch (error) { if (error.code !== 'enrollment_expired') throw error; }
        if (!state.approved) {
          state.runtimeToken = randomBytes(32).toString('hex'); state.enrollmentId = null; await store.save(state);
          api = apiFactory({ apiBase, runtimeToken: state.runtimeToken });
          result = await api.enroll({ bindingId: id, tokenHash: hash(state.runtimeToken), threadId, workspace });
          requireText(result.enrollmentId, 'invalid_enrollment', 256);
          expiresAt = typeof result.expiresAt === 'number' ? result.expiresAt : Date.parse(result.expiresAt);
          if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new RuntimeError('invalid_enrollment');
        }
      }
      state.enrollmentId = result.enrollmentId; state.expiresAt = result.expiresAt; state.lastError = null; await store.save(state);
      // Only public identifiers are returned/printed. Never spread responses.
      return publicResult(state);
    } catch (error) { state.lastError = safeErrorCode(error); await store.save(state); throw error; }
  } finally { await client?.close(); await releaseThread?.(); await release(); }
}

const APPROVALS = {
  'item/commandExecution/requestApproval': 'command',
  'item/fileChange/requestApproval': 'file',
  'item/permissions/requestApproval': 'permission',
  'item/tool/requestUserInput': 'user-input',
  'tool/requestUserInput': 'user-input',
  'mcpServer/elicitation/request': 'elicitation'
};
function denial(kind) {
  if (kind === 'permission') return { permissions: {}, scope: 'turn' };
  if (kind === 'user-input') return { answers: {} };
  if (kind === 'elicitation') return { action: 'decline', content: null };
  return { decision: 'decline' };
}
function ownerSandbox(profile, workspace) {
  // Installed v0.137 requires only readOnly.type (networkAccess is optional).
  // Owner reads retain the original project's context. The newer restricted
  // access extension is a mandatory, schema-probed CUSTOMER boundary below.
  return profile === 'read-only' ? { type: 'readOnly', networkAccess: false } :
    { type: 'workspaceWrite', writableRoots: [workspace], networkAccess: false, excludeSlashTmp: true, excludeTmpdirEnvVar: true };
}
function customerSandbox(cwd) {
  return { type: 'readOnly', networkAccess: false, access: { type: 'restricted', includePlatformDefaults: false, readableRoots: [cwd] } };
}
function fixedChoice(params) {
  if (!Array.isArray(params.questions) || params.questions.length !== 1) return null;
  const q = params.questions[0];
  if (!q || typeof q.id !== 'string' || !q.id.trim() || q.id.length > 128 ||
    typeof q.question !== 'string' || !q.question.trim() || q.question.length > 12000 ||
    q.isOther === true || q.isSecret === true || !Array.isArray(q.options) || !q.options.length || q.options.length > 8) return null;
  if (q.options.some(option => !option || typeof option.label !== 'string' || !option.label.trim() ||
    option.label.length > 200 || option.label.includes('\0') || option.isOther === true ||
    (option.description !== undefined && (typeof option.description !== 'string' || option.description.length > 4096)))) return null;
  const answers = Object.fromEntries(q.options.map((option, i) => [`choice_${i}`, { answers: { [q.id]: { answers: [option.label] } } }]));
  return { question: q, answers, buttons: q.options.map((option, i) => ({ id: `choice_${i}`, label: option.label })) };
}
function customerOverrides(config, skillPaths, cwd) {
  if (!config || typeof config !== 'object') throw new RuntimeError('customer_config_unavailable');
  const overrides = ['web_search="disabled"', 'project_doc_max_bytes=0', 'developer_instructions=""',
    'shell_environment_policy.inherit="none"', 'shell_environment_policy.set={}', 'notify=[]',
    `projects.${JSON.stringify(cwd)}.trust_level="untrusted"`];
  // Disable integrations before the separate child starts, including hooks and
  // computer/browser tools. Owner config and private thread remain untouched.
  for (const feature of ['apps', 'plugins', 'hooks', 'plugin_hooks', 'shell_tool', 'unified_exec', 'shell_snapshot',
    'multi_agent', 'multi_agent_v2', 'memories', 'goals', 'browser_use', 'browser_use_external', 'computer_use',
    'in_app_browser', 'image_generation', 'imagegenext', 'artifact', 'code_mode', 'code_mode_only',
    'js_repl', 'js_repl_tools_only', 'workspace_dependencies', 'skill_mcp_dependency_install', 'request_permissions_tool']) overrides.push(`features.${feature}=false`);
  for (const key of Object.keys(config.mcp_servers ?? {})) overrides.push(`mcp_servers.${JSON.stringify(key)}.enabled=false`, `mcp_servers.${JSON.stringify(key)}.required=false`);
  for (const key of Object.keys(config.plugins ?? {})) overrides.push(`plugins.${JSON.stringify(key)}.enabled=false`);
  const paths = new Set([...skillPaths, ...(config.skills?.config ?? []).map(s => s.path)].filter(p => typeof p === 'string'));
  const skills = [...paths].map(path => `{path=${JSON.stringify(path)},enabled=false}`);
  overrides.push(`skills.config=[${skills.join(',')}]`);
  return overrides;
}

// run() owns the lifecycle. API polling and heartbeat are independent of the
// sequential turn drain, so an owner can answer approvals while Codex waits.
export class RuntimeWorker {
  constructor({ bindingId: id, store = new RuntimeStore(), apiFactory = options => new RuntimeApi(options),
    clientFactory = options => new AppServerClient(options), pollIntervalMs = 2000, heartbeatIntervalMs = 20000,
    approvalTimeoutMs = 120000, turnTimeoutMs = 600000, signal } = {}) {
    this.id = bindingId(id); Object.assign(this, { store, apiFactory, clientFactory, pollIntervalMs, heartbeatIntervalMs, approvalTimeoutMs, turnTimeoutMs });
    this.controller = new AbortController(); this.signal = this.controller.signal;
    this.externalSignal = signal; this.externalStop = () => this.stop();
    if (signal?.aborted) this.stop(); else signal?.addEventListener('abort', this.externalStop, { once: true });
    this.abortedPromise = this.signal.aborted ? Promise.resolve(null) : new Promise(r => this.signal.addEventListener('abort', () => r(null), { once: true }));
    this.pending = new Map(); this.queue = []; this.queuedIds = new Set(); this.controlAck = new Set(); this.clients = new Set();
    this.customerClients = new Map(); this.completed = new Set(); this.saveChain = Promise.resolve();
  }
  stop() { this.controller.abort(); }
  fail(error) { this.fatal = error; this.stop(); }
  persist() {
    const snapshot = JSON.parse(JSON.stringify(this.state));
    this.saveChain = this.saveChain.then(() => this.store.save(snapshot)); return this.saveChain;
  }
  redact(value) {
    return JSON.parse(JSON.stringify(value).split(this.state.runtimeToken).join('[redacted]').split(hash(this.state.runtimeToken)).join('[redacted]'));
  }
  async pause(ms) { try { await delay(ms, undefined, { signal: this.signal }); } catch { /* stop */ } }
  attach(client) {
    this.clients.add(client);
    client.on('request', request => { this.serverRequest(client, request).catch(error => this.fail(error)); });
    client.on('notification', event => this.notification(client, event));
    client.on('failure', error => { if (!this.signal.aborted) this.fail(error); });
  }
  async run() {
    let releaseBinding; let releaseThread; let heartbeat;
    try {
      this.state = await this.store.load(this.id);
      if (!this.state.enrollmentId) throw new RuntimeError('enrollment_required');
      releaseBinding = await this.store.lock(`binding:${this.id}`);
      releaseThread = await this.store.lock(`thread:${this.state.threadId}`);
      this.state.pid = process.pid; this.state.runId = randomUUID(); this.state.state = 'starting';
      this.state.lastError = null; this.state.approved = false; await this.persist();
      this.api = this.apiFactory({ apiBase: this.state.apiBase, runtimeToken: this.state.runtimeToken });
      const enrollment = await this.api.enrollment(this.id, this.state.enrollmentId, { signal: this.signal });
      if (enrollment.approved !== true) throw new RuntimeError('enrollment_not_approved');
      this.binding = validBinding(enrollment.binding, this.state);
      this.ownerClient = this.clientFactory({ cwd: this.state.workspace }); this.attach(this.ownerClient);
      await this.ownerClient.start(); await subscription(this.ownerClient);
      exactThread(await this.ownerClient.request('thread/read', { threadId: this.state.threadId, includeTurns: false }), this.state);
      exactThread(await this.ownerClient.request('thread/resume', { threadId: this.state.threadId, cwd: this.state.workspace,
        approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: this.binding.permissionProfile, excludeTurns: true }), this.state);
      if (this.state.inFlight) throw new RuntimeError('turn_recovery_required');
      this.completed = new Set(this.state.completedIds ?? []);
      this.state.pid = process.pid; this.state.approved = true; this.state.state = 'online'; this.state.lastError = null; await this.persist();
      heartbeat = this.heartbeatLoop();
      while (!this.signal.aborted) {
        try {
          if (await this.store.stopRequested(this.id, this.state.runId)) { this.stop(); break; }
          const result = await this.api.poll(this.id, { signal: this.signal, busy: this.state.state === 'busy' });
          this.binding = validBinding(result.binding, this.state);
          if (!Array.isArray(result.messages) || result.messages.length > 500) throw new RuntimeError('invalid_messages');
          for (const message of result.messages) await this.receive(message);
          await this.flushControlAck();
          if (!this.draining && (this.queue.length || this.state.outbox)) {
            this.draining = this.drain().catch(error => this.fail(error)).finally(() => { this.draining = null; });
          }
          this.state.lastError = null;
        } catch (error) {
          if (this.signal.aborted) break;
          const code = safeErrorCode(error);
          this.state.lastError = code; await this.persist();
          if (!['api_unavailable', 'api_timeout', 'api_refused'].includes(code)) throw error;
        }
        await this.pause(this.pollIntervalMs);
      }
      if (this.fatal) throw this.fatal;
      return { success: true, bindingId: this.id, state: 'offline' };
    } catch (error) {
      if (this.state && releaseBinding) { this.state.lastError = safeErrorCode(error); }
      throw error;
    } finally {
      this.stop();
      for (const p of [...this.pending.values()]) this.resolveApproval(p, denial(p.kind));
      if (this.active?.turnId) await this.active.client.request('turn/interrupt', { threadId: this.active.threadId, turnId: this.active.turnId }, { timeoutMs: 2000 }).catch(() => {});
      await Promise.all([...this.clients].map(client => client.close()));
      await this.draining; await heartbeat;
      if (this.state && releaseBinding) {
        this.state.state = 'offline'; this.state.pid = null;
        await this.persist().catch(() => {});
        if (this.api) await this.api.heartbeat({ bindingId: this.id, state: 'offline', ...(this.state.lastError ? { lastError: this.state.lastError } : {}) }).catch(() => {});
      }
      await releaseThread?.(); await releaseBinding?.();
      this.externalSignal?.removeEventListener('abort', this.externalStop);
    }
  }
  async heartbeatLoop() {
    while (!this.signal.aborted) {
      try { await this.api.heartbeat({ bindingId: this.id, state: this.state.state,
        ...(this.state.lastError ? { lastError: this.state.lastError } : {}) }, { signal: this.signal }); }
      catch (error) { if (error.code === 'runtime_auth_refused') this.fail(error); }
      await this.pause(this.heartbeatIntervalMs);
    }
  }
  async receive(message) {
    if (!message || !UUID.test(message.id ?? '') || typeof message.owner !== 'boolean' ||
      typeof message.text !== 'string' || message.text.length > 131072) throw new RuntimeError('invalid_messages');
    for (const key of ['customerKey', 'ask_id', 'action_id']) {
      if (message[key] !== undefined) requireText(message[key], 'invalid_messages', key === 'senderHint' ? 1024 : 256);
    }
    if (message.senderHint !== undefined) {
      if (typeof message.senderHint === 'string') requireText(message.senderHint, 'invalid_messages', 1024);
      else if (!message.senderHint || message.senderHint.kind !== 'entity' ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(message.senderHint.publicCode ?? '') ||
        Object.keys(message.senderHint).some(key => !['kind', 'publicCode'].includes(key))) throw new RuntimeError('invalid_messages');
    }
    if (message.ask_id || message.action_id || message.answers !== undefined) {
      if (!this.completed.has(message.id)) {
        if (message.owner === true && this.control(message) === false) return;
        this.controlAck.add(message.id);
      }
      return;
    }
    if (this.completed.has(message.id) || this.queuedIds.has(message.id) || this.state.outbox?.messageId === message.id || this.state.inFlight?.messageId === message.id) return;
    if (this.queue.length < 256) { this.queue.push(message); this.queuedIds.add(message.id); }
  }
  remember(id) {
    this.completed.add(id); this.state.completedIds = [...this.completed].slice(-2048);
    this.completed = new Set(this.state.completedIds);
  }
  async flushControlAck() {
    if (!this.controlAck.size) return;
    const ids = [...this.controlAck];
    for (let i = 0; i < ids.length; i += 20) {
      const batch = ids.slice(i, i + 20);
      await this.api.ack({ bindingId: this.id, messageIds: batch }, { signal: this.signal });
      for (const id of batch) { this.controlAck.delete(id); this.remember(id); }
      await this.persist();
    }
  }
  control(message) {
    const p = this.pending.get(message.ask_id);
    if (!p || Date.now() >= p.deadline || p.active !== this.active || !this.active?.owner) return;
    // An owner can click before the approval POST completes. Leave the durable
    // action unfinished until publication is confirmed; do not lose the click.
    if (!p.delivered) return false;
    const action = message.action_id;
    if (action === 'decline' || action === 'cancel') { this.resolveApproval(p, denial(p.kind)); return; }
    if (!p.buttons.some(b => b.id === action)) return;
    if (p.kind === 'permission') {
      if (this.binding.permissionProfile === 'read-only' && p.params.permissions?.fileSystem?.write?.length) return;
      this.resolveApproval(p, { permissions: p.params.permissions, scope: 'turn' });
    } else if (p.kind === 'user-input') {
      // Only the authenticated owner's advertised choice action is meaningful.
      // The current remote card path cannot collect arbitrary answers/forms.
      const result = p.choice?.answers[action]; if (!result) return;
      this.resolveApproval(p, result);
    } else if (p.kind === 'elicitation') {
      if (p.params.mode !== 'url') return;
      this.resolveApproval(p, { action: 'accept', content: null });
    } else {
      if (this.binding.permissionProfile === 'read-only') return;
      this.resolveApproval(p, { decision: 'accept' });
    }
  }
  resolveApproval(p, result) {
    clearTimeout(p.timer); this.pending.delete(p.askId);
    try { p.client.respond(p.requestId, result); } catch { /* child already stopped */ }
  }
  async unsupportedInput(client, request, kind) {
    try {
      await this.api.approval({ bindingId: this.id, askId: randomUUID(), title: 'Input requires local Codex',
        body: 'Remote input supports one question with fixed choices. Multiple questions, free-text input, and forms cannot be answered by EClaw buttons. Answer this request in local Codex, then retry from EClaw.',
        kind, buttons: [{ id: 'decline', label: 'Dismiss' }] }, { signal: this.signal });
    } catch { /* Denial does not depend on delivery of the informational notice. */ }
    try { client.respond(request.id, denial(kind)); } catch { /* stopped */ }
  }
  async serverRequest(client, request) {
    const kind = APPROVALS[request.method]; const params = request.params ?? {};
    const active = this.active;
    if (active && !active.turnId) await Promise.race([active.ready.promise, this.aborted()]);
    if (!kind) { client.reject(request.id); return; }
    if (this.signal.aborted || !active?.owner || active.finished || this.active !== active || client !== active.client || params.threadId !== this.state.threadId ||
      (params.turnId !== active.turnId && !(kind === 'elicitation' && params.turnId == null)) || this.pending.size >= 20) {
      client.respond(request.id, denial(kind)); return;
    }
    if (this.binding.permissionProfile === 'read-only' && ['command', 'file'].includes(kind)) { client.respond(request.id, denial(kind)); return; }
    if (kind === 'permission' && (!params.permissions || typeof params.permissions !== 'object')) { client.respond(request.id, denial(kind)); return; }
    const choice = kind === 'user-input' ? fixedChoice(params) : null;
    if ((kind === 'user-input' && !choice) || (kind === 'elicitation' && params.mode !== 'url')) {
      await this.unsupportedInput(client, request, kind); return;
    }
    if (kind === 'elicitation' && (typeof params.url !== 'string' || !/^https?:\/\//.test(params.url))) { client.respond(request.id, denial(kind)); return; }
    const askId = randomUUID();
    const buttons = [...(choice ? choice.buttons : [{ id: 'accept', label: 'Approve once' }]), { id: 'decline', label: 'Decline' }, { id: 'cancel', label: 'Cancel' }];
    if (Array.isArray(params.availableDecisions) && ['command', 'file'].includes(kind) && !params.availableDecisions.includes('accept')) buttons.shift();
    const timeout = Number.isInteger(params.autoResolutionMs) && params.autoResolutionMs > 0 ? Math.min(params.autoResolutionMs, this.approvalTimeoutMs) : this.approvalTimeoutMs;
    const p = { askId, requestId: request.id, kind, params, client, active, buttons, choice, delivered: false, deadline: Date.now() + timeout };
    p.timer = setTimeout(() => this.resolveApproval(p, denial(kind)), timeout); this.pending.set(askId, p);
    const details = { reason: params.reason, command: params.command, cwd: params.cwd, grantRoot: params.grantRoot,
      permissions: params.permissions, message: params.message, url: params.url, requestedSchema: params.requestedSchema,
      changes: active.items.get(params.itemId)?.changes };
    let body = choice ? `${choice.question.question}\n\n${choice.question.options.map(option => `${option.label}${option.description ? `: ${option.description}` : ''}`).join('\n')}` : JSON.stringify(details);
    body = this.redact(body);
    if (body.length > 12000) body = `${body.slice(0, 11920)}\n[Truncated; review the full action in local Codex before approving.]`;
    try {
      await this.api.approval(this.redact({ bindingId: this.id, askId, title: `Codex ${kind} request`,
        body, kind, ...(params.questions ? { questions: params.questions } : {}), buttons }), { signal: this.signal });
      if (this.pending.has(askId)) p.delivered = true;
    } catch { if (this.pending.has(askId)) this.resolveApproval(p, denial(kind)); }
  }
  notification(client, { method, params = {} }) {
    if (method === 'account/updated' && params.authMode !== 'chatgpt') { this.fail(new RuntimeError('chatgpt_subscription_required')); return; }
    const a = this.active;
    if (!a || client !== a.client || params.threadId !== a.threadId) return;
    if (method === 'serverRequest/resolved') {
      for (const p of this.pending.values()) if (p.client === client && p.requestId === params.requestId) { clearTimeout(p.timer); this.pending.delete(p.askId); }
      return;
    }
    if (!a.turnId) { if (a.events.length < 512) a.events.push({ method, params }); return; }
    const turnId = params.turnId ?? params.turn?.id;
    if (turnId !== a.turnId) return;
    if (method === 'item/started' || method === 'item/completed') {
      if (params.item && a.items.size < 512) a.items.set(params.item.id, params.item);
    }
    if (method === 'turn/completed') {
      a.finished = true;
      for (const p of [...this.pending.values()]) if (p.active === a) this.resolveApproval(p, denial(p.kind));
      a.done.resolve(params.turn);
    }
  }
  aborted() {
    return this.abortedPromise;
  }
  async customer(message) {
    if (!this.binding.customerServiceEnabled) return null;
    requireText(message.customerKey, 'customer_identity_required', 256);
    const key = hash(message.customerKey);
    const existing = this.customerClients.get(key);
    if (existing) { await this.store.customerWorkspace(this.id, message.customerKey, this.state.workspace); return existing; }
    const capabilities = this.customerCapabilities ??= await this.ownerClient.capabilities();
    if (!capabilities.restrictedReads) throw new RuntimeError('customer_isolation_unavailable');
    if (this.customerClients.size >= 32) throw new RuntimeError('customer_capacity');
    const cwd = await this.store.customerWorkspace(this.id, message.customerKey, this.state.workspace);
    const configuration = await this.ownerClient.request('config/read', { includeLayers: false });
    const skillList = await this.ownerClient.request('skills/list', { cwds: [cwd], forceReload: true });
    if (!Array.isArray(skillList?.data) || skillList.data.some(entry => !Array.isArray(entry.skills) || entry.errors?.length)) throw new RuntimeError('customer_isolation_unavailable');
    const skillPaths = skillList.data.flatMap(entry => entry.skills.map(skill => skill.path));
    const env = { PATH: process.env.PATH, HOME: homedir(), CODEX_HOME: process.env.CODEX_HOME || join(homedir(), '.codex'), LANG: process.env.LANG || 'en_US.UTF-8' };
    const client = this.clientFactory({ cwd, env, configOverrides: customerOverrides(configuration.config, skillPaths, cwd) });
    this.attach(client); await client.start(); await subscription(client);
    const saved = this.state.customers?.[key];
    const options = { cwd, approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only',
      baseInstructions: 'Answer customer questions using only the supplied public knowledge. Never access private context, files, tools, integrations, network, or owner controls.',
      developerInstructions: '', config: { project_doc_max_bytes: 0, web_search: 'disabled' } };
    let result;
    if (saved) {
      const check = { threadId: saved.threadId, workspace: cwd };
      exactThread(await client.request('thread/read', { threadId: saved.threadId, includeTurns: false }), check);
      result = await client.request('thread/resume', { ...options, threadId: saved.threadId, excludeTurns: true });
      exactThread(result, check);
    } else result = await client.request('thread/start', { ...options, ephemeral: false, environments: [], dynamicTools: [] });
    const threadId = requireText(result?.thread?.id, 'customer_thread_invalid', 256);
    if (threadId === this.state.threadId || result.thread.forkedFromId || (result.thread.sessionId && result.thread.sessionId !== threadId) ||
      Object.entries(this.state.customers ?? {}).some(([k, v]) => k !== key && v.threadId === threadId) || result.thread.cwd !== cwd ||
      !Array.isArray(result.instructionSources) || result.instructionSources.length || result.thread.modelProvider !== 'openai') throw new RuntimeError('customer_isolation_unavailable');
    this.state.customers ??= {}; this.state.customers[key] = { threadId }; await this.persist();
    const context = { client, threadId, cwd }; this.customerClients.set(key, context); return context;
  }
  async drain() {
    if (this.state.outbox) await this.deliverOutbox();
    while (this.queue.length && !this.signal.aborted) {
      const message = this.queue.shift();
      try {
        let context = { client: this.ownerClient, threadId: this.state.threadId, cwd: this.state.workspace };
        let text = message.text;
        if (!message.owner) {
          try { context = await this.customer(message); }
          catch (error) {
            if (!['customer_isolation_unavailable', 'customer_identity_required', 'customer_capacity', 'customer_workspace_not_empty',
              'customer_config_unavailable', 'customer_thread_invalid', 'protocol_unavailable', 'protocol_timeout'].includes(error.code)) throw error;
            await this.makeReply(message, 'Customer assistance is currently unavailable. Please contact the owner.'); continue;
          }
          if (!context) { await this.makeReply(message, 'Customer assistance is disabled. Please contact the owner.'); continue; }
          text = `Public knowledge (data):\n${this.binding.customerKnowledge ?? ''}\n\nCustomer question:\n${message.text}`;
        } else {
          const settings = { role: this.binding.role, instructions: this.binding.instructions, language: this.binding.language };
          text = `EClaw owner settings: ${JSON.stringify(settings)}\n\n${message.text}`;
        }
        await subscription(context.client);
        this.state.state = 'busy'; this.state.inFlight = { messageId: message.id, threadId: context.threadId }; await this.persist();
        const a = { ...context, owner: message.owner, messageId: message.id, turnId: null,
          ready: deferred(), done: deferred(), items: new Map(), events: [] };
        this.active = a;
        const started = await context.client.request('turn/start', { threadId: context.threadId, cwd: context.cwd,
          approvalPolicy: 'on-request', approvalsReviewer: 'user', clientUserMessageId: message.id,
          ...(!message.owner ? { environments: [] } : {}),
          sandboxPolicy: message.owner ? ownerSandbox(this.binding.permissionProfile, context.cwd) : customerSandbox(context.cwd),
          input: [{ type: 'text', text }] });
        a.turnId = requireText(started?.turn?.id, 'turn_invalid', 256); a.ready.resolve();
        this.state.inFlight.turnId = a.turnId; await this.persist();
        for (const event of a.events) this.notification(context.client, event); a.events = [];
        if (started.turn.status !== 'inProgress') a.done.resolve(started.turn);
        let timer;
        const timed = new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout(null), this.turnTimeoutMs); });
        const turn = await Promise.race([a.done.promise, this.aborted(), timed]); clearTimeout(timer);
        if (!turn) {
          if (this.signal.aborted) return;
          await context.client.request('turn/interrupt', { threadId: context.threadId, turnId: a.turnId }, { timeoutMs: 2000 }).catch(() => {});
          throw new RuntimeError('turn_timeout');
        }
        const items = turn.items?.length ? turn.items : [...a.items.values()];
        const final = items.filter(item => item.type === 'agentMessage' && (!item.phase || item.phase === 'final_answer')).map(item => item.text).filter(t => typeof t === 'string').join('\n');
        await this.makeReply(message, turn.status === 'completed' ? (final || 'Codex completed the request without a text response.') : 'Codex could not complete the request. Please try again.');
        this.active = null; this.state.state = 'online'; await this.persist();
      } finally { this.queuedIds.delete(message.id); }
    }
  }
  async makeReply(message, text) {
    this.state.outbox = this.redact({ messageId: message.id, message: text, ...(message.senderHint ? { senderHint: message.senderHint } : {}) });
    this.state.outbox.message = this.state.outbox.message.slice(0, 30000);
    delete this.state.inFlight; await this.persist(); await this.deliverOutbox();
  }
  async deliverOutbox() {
    while (this.state.outbox && !this.signal.aborted) {
      const outbox = this.state.outbox;
      try {
        await this.api.reply({ bindingId: this.id, message: outbox.message, replyTo: outbox.messageId,
          ...(outbox.senderHint ? { senderHint: outbox.senderHint } : {}) }, { signal: this.signal });
        this.remember(outbox.messageId); delete this.state.outbox; await this.persist();
      } catch (error) {
        if (error.code === 'runtime_auth_refused') throw error;
        this.state.lastError = safeErrorCode(error); await this.persist(); await this.pause(this.pollIntervalMs);
      }
    }
  }
}

export function parseArgs(argv, env = process.env) {
  const result = { threadId: env.CODEX_THREAD_ID, apiBase: 'https://eclawbot.com' };
  const modes = new Set(['--enroll', '--run', '--status', '--start', '--stop']);
  const values = { '--binding': 'bindingId', '--thread': 'threadId', '--workspace': 'workspace', '--api-base': 'apiBase' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (modes.has(arg)) { if (result.mode) throw new RuntimeError('invalid_arguments'); result.mode = arg.slice(2); }
    else if (values[arg] && argv[i + 1] && !argv[i + 1].startsWith('--')) result[values[arg]] = argv[++i];
    else throw new RuntimeError('invalid_arguments');
  }
  bindingId(result.bindingId);
  if (!result.mode) throw new RuntimeError('invalid_arguments');
  if (result.mode !== 'enroll' && argv.some(arg => ['--thread', '--workspace', '--api-base'].includes(arg))) throw new RuntimeError('invalid_arguments');
  return result;
}
export async function runCli(argv = process.argv.slice(2), { store = new RuntimeStore(),
  stdout = process.stdout, clientFactory, apiFactory, spawnProcess = spawn } = {}) {
  const options = parseArgs(argv); let result;
  if (options.mode === 'enroll') result = await enrollRuntime({ ...options, store, clientFactory, apiFactory });
  else if (options.mode === 'status') result = await store.status(options.bindingId);
  else if (options.mode === 'stop') {
    const state = await store.load(options.bindingId);
    if (alive(state.pid)) {
      await store.requestStop(options.bindingId, state.runId);
      for (let i = 0; i < 200; i++) {
        await delay(100); const status = await store.status(options.bindingId);
        if (!status.pid || status.state === 'offline') { result = status; break; }
      }
      if (!result) throw new RuntimeError('runtime_stop_timeout');
    } else result = await store.status(options.bindingId);
  }
  else if (options.mode === 'start') {
    const state = await store.load(options.bindingId);
    if (!state.enrollmentId) throw new RuntimeError('enrollment_required');
    const release = await store.lock(`launch:${options.bindingId}`);
    let child;
    try {
      if (alive(state.pid)) throw new RuntimeError('runtime_locked');
      child = spawnProcess(process.execPath, [fileURLToPath(import.meta.url), '--run', '--binding', options.bindingId], {
        cwd: state.workspace, detached: true, stdio: 'ignore', env: { ...process.env, CODEX_PLUGIN_DATA: store.dataDir } });
      let spawnError = false; child.on('error', () => { spawnError = true; }); child.unref();
      for (let i = 0; i < 100; i++) {
        await delay(100); if (spawnError || !child.pid) throw new RuntimeError('background_start_failed');
        const status = await store.status(options.bindingId);
        if (status.pid === child.pid && status.online) { result = status; break; }
        if (!alive(child.pid)) throw new RuntimeError('background_start_failed');
      }
      if (!result) { child.kill('SIGTERM'); throw new RuntimeError('background_start_timeout'); }
    } catch (error) { child?.kill('SIGTERM'); throw error; }
    finally { await release(); }
  } else {
    const worker = new RuntimeWorker({ ...options, store, clientFactory, apiFactory });
    const stop = () => worker.stop(); process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try { result = await worker.run(); }
    finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  }
  stdout.write(`${JSON.stringify(result)}\n`); return result;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  runCli().catch(error => { process.stdout.write(`${JSON.stringify({ success: false, error: safeErrorCode(error) })}\n`); process.exitCode = 1; });
}
