'use strict';
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { infer, invocation, parseReply, CONFIG } = require('../../workers/dream-buddy-minimax/runner');
const { configuration, run } = require('../../workers/dream-buddy-minimax/poller');

test('untrusted mobile text has no coding tools or shared session; child never inherits callback/other secrets', () => {
    const call = invocation('/tmp/dream-job', '/tmp/dream-runtime', {
        HOME: '/tmp/owner', PATH: '/bin', DREAM_BUDDY_WORKER_TOKEN: 'private', OTHER_API_KEY: 'private',
    });
    expect(call.args).toEqual(expect.arrayContaining(['--mode', 'lightweight', '--permission', 'off', '--max-steps', '1']));
    expect(call.args).not.toContain('--continue');
    expect(call.args).not.toContain('--session');
    expect(call.env.DREAM_BUDDY_WORKER_TOKEN).toBeUndefined();
    expect(call.env.OTHER_API_KEY).toBeUndefined();
    expect(CONFIG.agents.default.tools).toEqual([]);
    expect(CONFIG.agents.default.builtinTools).toEqual([]);
    expect(CONFIG.agents.default.features.delegation).toBe(false);
    expect(CONFIG.memory.enabled).toBe(false);
});
test('only the documented successful final text is delivered, never reasoning/errors/tool output', () => {
    const good = { type: 'exec.result', schemaVersion: 1, status: 'succeeded', output: '雲朵在睡覺嗎？' };
    expect(parseReply(JSON.stringify(good))).toBe(good.output);
    for (const value of [{ ...good, status: 'failed', error: { message: 'private' } },
        { ...good, output: ' ' }, { ...good, output: {} }, { ...good, output: 'x'.repeat(2001) },
        { ...good, type: 'tool.result' }]) expect(() => parseReply(JSON.stringify(value))).toThrow();
    expect(() => parseReply('private stderr')).toThrow('invalid_cli_result');
});
test('prompt uses stdin without shell expansion and temporary workspace is removed after success', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dream-worker-test-'));
    let directory;
    const prompt = '$(touch /do-not-run) `a` 夢境';
    try {
        const spawnProcess = jest.fn((_executable, args, options) => {
            directory = options.cwd;
            expect(options.shell).toBe(false);
            expect(args.join(' ')).not.toContain(prompt);
            const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
            let received = '';
            child.stdin.on('data', data => { received += data.toString(); });
            child.stdin.on('finish', () => {
                expect(received).toBe(prompt);
                child.stdout.emit('data', Buffer.from(JSON.stringify({ schemaVersion: 1,
                    type: 'exec.result', status: 'succeeded', output: 'reply' })));
                child.emit('close', 0);
            });
            return child;
        });
        expect(await infer(prompt, { executable: '/test/mcode', dataDir, spawnProcess })).toBe('reply');
        await expect(fs.stat(directory)).rejects.toHaveProperty('code', 'ENOENT');
    } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
});
test('gateway requires HTTPS, rejects URL credentials and does not reuse Wishlist credentials', () => {
    const token = 'd'.repeat(48);
    expect(configuration({ DREAM_BUDDY_WORKER_TOKEN: token }).base).toBe('https://eclawbot.com/api/app-bot/inference');
    for (const url of ['http://localhost', 'https://user:secret@example.com/', 'https://example.com/other', 'https://example.com/?secret=x']) {
        expect(() => configuration({ DREAM_BUDDY_WORKER_TOKEN: token, DREAM_BUDDY_GATEWAY_URL: url })).toThrow();
    }
    expect(() => configuration({ WISHLIST_MINIMAX_CALLBACK_TOKEN: token })).toThrow('worker_credential_required');
});
test('failed actual text readiness check never announces a healthy worker', async () => {
    const fetchRequest = jest.fn();
    await expect(run({ env: { DREAM_BUDDY_WORKER_TOKEN: 't'.repeat(48) }, fetchRequest,
        inferReply: async () => { throw new Error('login_required'); } })).rejects.toThrow('login_required');
    expect(fetchRequest).not.toHaveBeenCalled();
});
test('lost callback response resends the same result without another inference', async () => {
    const controller = new AbortController();
    const bodies = [];
    let callbacks = 0;
    const inferReply = jest.fn().mockResolvedValueOnce('ready').mockResolvedValueOnce('a dream reply');
    const fetchRequest = async (url, options) => {
        if (url.endsWith('/next')) return { ok: true, status: 200, json: async () => ({
            jobId: '12b861c8-6fb3-4c98-a691-96e3bc36539a', leaseToken: 'l'.repeat(48), prompt: 'synthetic prompt',
        }) };
        if (url.endsWith('/result')) {
            bodies.push(JSON.parse(options.body));
            if (++callbacks === 1) throw new Error('lost acknowledgement');
            controller.abort();
        }
        return { ok: true, status: 200, json: async () => ({ success: true }) };
    };
    await run({ env: { DREAM_BUDDY_WORKER_TOKEN: 't'.repeat(48) }, fetchRequest, inferReply, signal: controller.signal });
    expect(inferReply).toHaveBeenCalledTimes(2); // readiness + one job
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0].reply).toBe('a dream reply');
});
