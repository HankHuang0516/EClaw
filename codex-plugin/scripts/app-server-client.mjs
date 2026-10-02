import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class AppServerError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Inspect the *installed* binary, not a version number or remote documentation.
// Older servers silently ignore unknown sandbox fields: never infer support.
export async function inspectProtocol({ codexPath = 'codex', spawnProcess = spawn, timeoutMs = 10000 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'eclaw-protocol-'));
  try {
    await new Promise((resolve, reject) => {
      const child = spawnProcess(codexPath, ['app-server', 'generate-json-schema', '--experimental', '--out', dir], { stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new AppServerError('protocol_timeout')); }, timeoutMs);
      child.once('error', () => { clearTimeout(timer); reject(new AppServerError('protocol_unavailable')); });
      child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new AppServerError('protocol_unavailable')); });
    });
    async function find(path) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) { const hit = await find(file); if (hit) return hit; }
        else if (entry.name === 'TurnStartParams.json') return file;
      }
    }
    const file = await find(dir);
    if (!file) return { restrictedReads: false };
    const schema = JSON.parse(await readFile(file, 'utf8'));
    const branches = schema.definitions?.SandboxPolicy?.oneOf ?? [];
    const read = branches.find(b => b.properties?.type?.enum?.includes('readOnly'));
    const access = read?.properties?.access;
    const refs = JSON.stringify(access ?? {});
    const definition = schema.definitions?.ReadOnlyAccess;
    return { restrictedReads: !!access && (refs.includes('restricted') ||
      (refs.includes('ReadOnlyAccess') && JSON.stringify(definition).includes('readableRoots'))) };
  } catch { throw new AppServerError('protocol_unavailable'); }
  finally { await rm(dir, { recursive: true, force: true }); }
}

// Events: notification({method, params}), request({id, method, params}),
// failure(AppServerError). stdout/stderr and remote errors are never logged.
export class AppServerClient extends EventEmitter {
  constructor({ codexPath = 'codex', cwd, env = process.env, spawnProcess = spawn,
    configOverrides = [], requestTimeoutMs = 30000, protocolInspector = inspectProtocol } = {}) {
    super();
    Object.assign(this, { codexPath, cwd, env, spawnProcess, configOverrides, requestTimeoutMs, protocolInspector });
    this.pending = new Map(); this.serverRequests = new Set(); this.nextId = 0;
    this.closed = false; this.buffer = '';
  }

  async start() {
    if (this.child || this.closed) throw new AppServerError('app_server_closed');
    const args = ['app-server', '--listen', 'stdio://', '-c', 'forced_login_method="chatgpt"'];
    for (const override of this.configOverrides) args.push('-c', override);
    try { this.child = this.spawnProcess(this.codexPath, args, { cwd: this.cwd, env: this.env, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { throw new AppServerError('app_server_unavailable'); }
    this.child.stderr.resume();
    this.child.on('error', () => this.fail('app_server_unavailable'));
    this.child.on('exit', () => this.fail('app_server_exited'));
    this.child.stdin.on('error', () => this.fail('app_server_io'));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.receive(chunk));
    await this.request('initialize', { clientInfo: { name: 'eclawbot_local_runtime', title: 'EClawbot local runtime', version: '1.0.0' }, capabilities: { experimentalApi: true } });
    this.notify('initialized');
    return this;
  }

  capabilities() { return this.protocolInspector({ codexPath: this.codexPath, spawnProcess: this.spawnProcess }); }

  write(value) {
    if (this.closed || !this.child?.stdin.writable) throw new AppServerError('app_server_closed');
    try { this.child.stdin.write(`${JSON.stringify(value)}\n`); }
    catch { throw new AppServerError('app_server_io'); }
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AppServerError('app_server_timeout')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method, params = {}) { this.write({ method, params }); }
  respond(id, result) { if (this.serverRequests.delete(id)) this.write({ id, result }); }
  reject(id) {
    if (this.serverRequests.delete(id)) this.write({ id, error: { code: -32601, message: 'Request not supported by this runtime' } });
  }

  receive(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 4 * 1024 * 1024) { this.fail('app_server_protocol'); return; }
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { this.fail('app_server_protocol'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { this.fail('app_server_protocol'); return; }
      if (typeof message.method === 'string') {
        if (message.id !== undefined) {
          if (!['string', 'number'].includes(typeof message.id) || this.serverRequests.has(message.id) || this.serverRequests.size >= 100) { this.fail('app_server_protocol'); return; }
          this.serverRequests.add(message.id);
          if (this.listenerCount('request')) this.emit('request', message);
          else this.reject(message.id);
        } else this.emit('notification', message);
      } else {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer); this.pending.delete(message.id);
        message.error ? pending.reject(new AppServerError('app_server_refused')) : pending.resolve(message.result);
      }
    }
  }

  fail(code) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new AppServerError(code)); }
    this.pending.clear(); this.serverRequests.clear();
    this.child?.kill('SIGTERM');
    this.emit('failure', new AppServerError(code));
  }

  async close() {
    if (!this.closed) this.fail('app_server_closed');
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
