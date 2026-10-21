'use strict';
const { spawn } = require('node:child_process');
const { mkdtemp, writeFile, rm, mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');

// Both lightweight mode and the capability ceiling are mandatory. Never expose
// coding tools, shared sessions, user HOME instructions or callback credentials
// to a mobile user's prompt. Pin the CLI version when installing the worker.
const CONFIG = {
    agents: { default: { persona: { enabled: false }, tools: [], builtinTools: [], skills: [],
        features: { mavis: false, delegation: false, webSearch: false } } },
    memory: { enabled: false, proactive: false }, hooks: { enabled: false },
    skillEvolve: { enabled: false }, sessionTitle: { enabled: false },
    beta: { mcodeTools: false, browserUseTooling: false },
};

function invocation(directory, dataDir, environment) {
    if (!path.isAbsolute(dataDir)) throw new Error('runtime_directory_required');
    const env = { HOME: environment.HOME, PATH: environment.PATH,
        TMPDIR: environment.TMPDIR || tmpdir(), MINIMAX_DATA_DIR: dataDir };
    return { args: ['exec', '--input', '-', '--input-format', 'text', '--cwd', directory,
        '--config', path.join(directory, 'config.json'), '--mode', 'lightweight',
        '--permission', 'off', '--timeout', '80s', '--max-steps', '1',
        '--output-format', 'json', '--system-prompt',
        '你是夢話夥伴，僅回覆使用者的夢境對話。不得使用工具、讀取檔案或執行指令。'], env };
}

function parseReply(stdout) {
    let result;
    try { result = JSON.parse(stdout); } catch { throw new Error('invalid_cli_result'); }
    if (result.schemaVersion !== 1 || result.type !== 'exec.result' || result.status !== 'succeeded' ||
        typeof result.output !== 'string' || !result.output.trim() || result.output.length > 2000) {
        throw new Error('inference_failed');
    }
    return result.output.trim();
}

async function infer(prompt, { executable = process.env.DREAM_BUDDY_MCODE_BIN,
    dataDir = process.env.DREAM_BUDDY_MCODE_DATA_DIR, spawnProcess = spawn } = {}) {
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 12000 ||
        !executable || !path.isAbsolute(executable)) throw new Error('invalid_inference_configuration');
    const directory = await mkdtemp(path.join(tmpdir(), 'dream-buddy-minimax-'));
    try {
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        await writeFile(path.join(directory, 'config.json'), JSON.stringify(CONFIG), { mode: 0o600 });
        const { args, env } = invocation(directory, dataDir, process.env);
        const stdout = await new Promise((resolve, reject) => {
            const child = spawnProcess(executable, args, { cwd: directory, env,
                shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
            let output = '', exceeded = false;
            const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
            child.stdout.on('data', chunk => {
                output += chunk.toString();
                if (Buffer.byteLength(output) > 1024 * 1024) { exceeded = true; child.kill('SIGKILL'); }
            });
            child.once('error', () => { clearTimeout(timer); reject(new Error('cli_unavailable')); });
            child.once('close', code => {
                clearTimeout(timer);
                if (code !== 0 || exceeded) reject(new Error('inference_failed'));
                else resolve(output);
            });
            child.stdin.on('error', () => {});
            child.stdin.end(prompt);
        });
        return parseReply(stdout);
    } finally { await rm(directory, { recursive: true, force: true }); }
}
module.exports = { infer, invocation, parseReply, CONFIG };
