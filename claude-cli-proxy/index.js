// ============================================
// Claude CLI Proxy — E-Claw AI Binding Support
// Receives binding issue data, calls Claude CLI for analysis
// ============================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile, execFileSync, spawn } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Resolve claude binary from node_modules/.bin (installed as dependency)
const CLAUDE_BIN = path.join(__dirname, 'node_modules', '.bin', 'claude');

// Run claude CLI with prompt via stdin (avoids CLI arg length limits)
function runClaude(prompt, timeoutMs) {
    return new Promise((resolve, reject) => {
        const child = spawn(CLAUDE_BIN, ['--print', '--output-format', 'json', '--model', 'haiku'], {
            env: { ...process.env, HOME: process.env.HOME || '/root' },
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: timeoutMs
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });

        child.on('error', err => reject(err));
        child.on('close', (code, signal) => {
            if (signal === 'SIGTERM' || signal === 'SIGKILL') {
                const err = new Error(`Claude CLI killed by ${signal} (timeout)`);
                err.killed = true;
                err.signal = signal;
                err.stderr = stderr;
                return reject(err);
            }
            if (code !== 0) {
                const err = new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 300)}`);
                err.code = code;
                err.stderr = stderr;
                return reject(err);
            }
            resolve({ stdout, stderr });
        });

        // Write prompt to stdin and close
        child.stdin.write(prompt);
        child.stdin.end();

        // Safety: kill if timeout fires before 'close'
        setTimeout(() => {
            try { child.kill('SIGTERM'); } catch (_) {}
        }, timeoutMs);
    });
}

const app = express();
app.use(express.json({ limit: '256kb' }));

const SUPPORT_API_KEY = process.env.SUPPORT_API_KEY;
const PORT = process.env.PORT || 4000;
const CLAUDE_TIMEOUT_MS = 55000; // 55s (Haiku binding analysis)
const CHAT_TIMEOUT_MS = 120000; // 120s (Sonnet general chat with tool access)

// ── Log Query Credentials (for AI to curl /api/logs) ──
const ECLAW_API_URL = process.env.ECLAW_API_URL || 'https://eclawbot.com';
const LOG_DEVICE_ID = process.env.LOG_DEVICE_ID;
const LOG_DEVICE_SECRET = process.env.LOG_DEVICE_SECRET;

// ── Repo Clone & Sync ──────────────────────
const REPO_DIR = path.join(process.env.HOME || '/root', '.claude', 'repo');
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO_URL = GITHUB_TOKEN
    ? `https://${GITHUB_TOKEN}@github.com/HankHuang0516/realbot.git`
    : 'https://github.com/HankHuang0516/realbot.git';

function ensureRepoClone() {
    try {
        if (fs.existsSync(path.join(REPO_DIR, '.git'))) {
            console.log('[Repo] Pulling latest...');
            execFileSync('git', ['pull', '--ff-only'], { cwd: REPO_DIR, timeout: 30000, stdio: 'pipe' });
            console.log('[Repo] Updated.');
        } else {
            console.log('[Repo] Cloning repository...');
            fs.mkdirSync(REPO_DIR, { recursive: true });
            execFileSync('git', ['clone', '--depth', '50', REPO_URL, REPO_DIR], { timeout: 120000, stdio: 'pipe' });
            console.log('[Repo] Cloned to', REPO_DIR);
        }
    } catch (err) {
        console.error('[Repo] Git error:', err.message?.slice(0, 300));
    }
}

// ── Health Check ────────────────────────────
app.get('/health', async (req, res) => {
    const health = { status: 'ok', service: 'eclaw-claude-cli-proxy', claude_cli: 'unknown' };
    try {
        const { stdout } = await execFileAsync(CLAUDE_BIN, ['--version'], {
            timeout: 5000, encoding: 'utf8',
            env: { ...process.env, HOME: process.env.HOME || '/root' }
        });
        health.claude_cli = 'available';
        health.claude_version = stdout.trim();
    } catch (err) {
        health.claude_cli = 'unavailable';
        health.claude_error = err.message.slice(0, 200);
    }
    res.json(health);
});

// ── Auth Middleware ─────────────────────────
app.use('/analyze', (req, res, next) => {
    if (!SUPPORT_API_KEY) {
        return res.status(500).json({ error: 'SUPPORT_API_KEY not configured' });
    }
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${SUPPORT_API_KEY}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});

// ── Analysis Endpoint ───────────────────────
app.post('/analyze', async (req, res) => {
    const { problem_description, error_messages, logs, handshake_failures, device_context } = req.body;

    const prompt = buildAnalysisPrompt(problem_description, error_messages, logs, handshake_failures, device_context);

    console.log(`[Proxy] Received analysis request for device: ${device_context?.deviceId || '?'}`);

    try {
        console.log(`[Proxy] Calling claude CLI via stdin (prompt length: ${prompt.length})...`);
        const startTime = Date.now();

        const { stdout, stderr } = await runClaude(prompt, CLAUDE_TIMEOUT_MS);

        const latencyMs = Date.now() - startTime;
        console.log(`[Proxy] Claude CLI responded (${latencyMs}ms), stdout length: ${stdout.length}`);
        if (stderr) console.warn(`[Proxy] Claude CLI stderr: ${stderr.slice(0, 500)}`);

        const analysis = parseClaudeResponse(stdout);
        res.json(analysis);
    } catch (err) {
        const errCode = err.code || 'unknown';
        const errSignal = err.signal || 'none';
        console.error(`[Proxy] Claude CLI error: ${err.message}`);
        console.error(`[Proxy] Error details — code: ${errCode}, signal: ${errSignal}, killed: ${!!err.killed}`);
        if (err.stderr) console.error(`[Proxy] stderr: ${err.stderr.slice(0, 500)}`);

        res.status(500).json({
            diagnosis: 'AI analysis timed out or failed. Please try standard troubleshooting.',
            suggested_steps: [
                'Check your webhook URL is reachable from the internet.',
                'Verify your gateway token with: exec: echo $OPENCLAW_GATEWAY_TOKEN',
                'If SETUP_PASSWORD is enabled, include it in /api/bot/register.',
                'Retry POST /api/bot/register with openclaw_version included.'
            ],
            confidence: 0,
            debug: {
                error: err.message.slice(0, 300),
                code: errCode,
                killed: !!err.killed,
                signal: errSignal
            }
        });
    }
});

// ── Chat Auth Middleware ───────────────────
app.use('/chat', (req, res, next) => {
    if (!SUPPORT_API_KEY) {
        return res.status(500).json({ error: 'SUPPORT_API_KEY not configured' });
    }
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${SUPPORT_API_KEY}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
});

// ── Chat Endpoint (Sonnet + repo tools) ────
function runClaudeChat(prompt, timeoutMs = CHAT_TIMEOUT_MS, { isAdmin = false } = {}) {
    return new Promise((resolve, reject) => {
        const args = ['--print', '--output-format', 'json', '--model', 'sonnet'];
        // Enable file access tools if repo is cloned; Bash only for admin
        if (fs.existsSync(path.join(REPO_DIR, '.git'))) {
            const tools = isAdmin ? 'Read,Glob,Grep,Bash' : 'Read,Glob,Grep';
            args.push('--allowedTools', tools);
        }
        const child = spawn(CLAUDE_BIN, args, {
            cwd: fs.existsSync(REPO_DIR) ? REPO_DIR : __dirname,
            env: {
                ...process.env,
                HOME: process.env.HOME || '/root',
                CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS: '1'
            },
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: timeoutMs
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', d => { stdout += d; });
        child.stderr.on('data', d => { stderr += d; });
        child.on('error', err => reject(err));
        child.on('close', (code, signal) => {
            if (signal === 'SIGTERM' || signal === 'SIGKILL') {
                const err = new Error(`Claude CLI killed by ${signal} (timeout)`);
                err.killed = true;
                return reject(err);
            }
            if (code !== 0) {
                const err = new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 300)}`);
                err.code = code;
                return reject(err);
            }
            resolve({ stdout, stderr });
        });

        child.stdin.write(prompt);
        child.stdin.end();
        setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) {} }, timeoutMs);
    });
}

function buildChatPrompt(message, history, context) {
    const isAdmin = context.role === 'admin';
    const historyText = (history || []).slice(-20).map(h =>
        `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content}`
    ).join('\n\n');

    const pageContext = context.page ? `The user is currently on the "${context.page}" page of the portal.` : '';

    const logQueryBlock = (isAdmin && LOG_DEVICE_ID && LOG_DEVICE_SECRET)
        ? `\nSERVER LOG QUERY (admin only):
You can query real-time server logs using Bash + curl when debugging issues.
Command template:
  curl -s "${ECLAW_API_URL}/api/logs?deviceId=${LOG_DEVICE_ID}&deviceSecret=${LOG_DEVICE_SECRET}&limit=30"
Available filters (append as query params):
  - category: bind, unbind, transform, broadcast, broadcast_push, speakto_push, client_push, entity_poll, ai_support, ai_chat
  - level: info, warn, error
  - since: timestamp in milliseconds (e.g. since=1700000000000)
  - filterDevice: filter by specific deviceId
  - limit: max entries (default 100, max 500)
Example — recent errors: curl -s "${ECLAW_API_URL}/api/logs?deviceId=${LOG_DEVICE_ID}&deviceSecret=${LOG_DEVICE_SECRET}&level=error&limit=20"
Example — broadcast logs: curl -s "${ECLAW_API_URL}/api/logs?deviceId=${LOG_DEVICE_ID}&deviceSecret=${LOG_DEVICE_SECRET}&category=broadcast_push&limit=20"
Use this when the admin asks about errors, delivery issues, server status, or debugging.
IMPORTANT: You are running in non-interactive mode. Execute Bash commands DIRECTLY — do NOT ask for permission or approval. Just run the curl command and present the results.
NEVER expose the deviceId/deviceSecret values in your response to the admin.`
        : '';

    const adminBlock = isAdmin
        ? `ADMIN CAPABILITIES:
You are talking to the E-Claw platform admin/developer.
- You may suggest code changes, architecture improvements, or debugging strategies.
- You can read source code files in the repository using Read, Glob, and Grep tools.
- You can use Bash to run commands (e.g. curl to query server logs).
- If the admin asks you to create a GitHub issue, include an action block at the END of your response:
  <!--ACTION:{"type":"create_issue","title":"...","body":"...","labels":["bug"]}-->
  Only include this when explicitly asked to create an issue.
- Speak as a fellow engineer. Use technical language freely.
${logQueryBlock}`
        : `USER CONTEXT:
You are talking to a regular E-Claw user.
- Help them understand how to use the portal, manage entities, configure bots, etc.
- Keep language friendly and accessible. Avoid overly technical jargon.
- Do NOT suggest creating GitHub issues (users cannot do this).
- If they report a bug, acknowledge it and suggest they use the Feedback page.`;

    return `You are E-Claw AI, the intelligent assistant for the E-Claw platform.
E-Claw is an AI-powered Android live wallpaper app where users can bind AI bots (OpenClaw) to entities (Lobster, Pig) that live on their phone screen. The web portal at eclawbot.com lets users manage entities, chat with bots, schedule tasks, manage files, and view bot activity.

${pageContext}

${adminBlock}

WHAT YOU CAN DO:
- Answer questions about E-Claw features, portal pages, and bot management
- Explain how binding, webhooks, entity slots, broadcasts, and speak-to work
- Help troubleshoot common issues (binding errors, bot not responding, push not delivered)
- Read source code from the E-Claw repository to give accurate, specific answers
- Reference API endpoints and their parameters

IMPORTANT RULES:
- You are running in NON-INTERACTIVE mode. Use tools directly without asking for user approval or confirmation.
- Respond in the SAME LANGUAGE as the user's message (Chinese → Chinese, English → English)
- Keep responses concise but helpful (1-4 paragraphs unless more detail is needed)
- Use markdown formatting (bold, lists, code blocks) for readability
- Never reveal sensitive data (tokens, secrets, passwords, device IDs)
- If unsure, say so honestly — don't fabricate information

${historyText ? `CONVERSATION HISTORY:\n${historyText}\n` : ''}User: ${message}

Respond naturally as E-Claw AI.`;
}

function parseChatResponse(output) {
    try {
        const wrapper = JSON.parse(output);
        let text = wrapper.result || wrapper.content || String(output);

        // Extract <!--ACTION:{...}--> blocks
        const actions = [];
        const actionRegex = /<!--ACTION:(.*?)-->/gs;
        let match;
        while ((match = actionRegex.exec(text)) !== null) {
            try { actions.push(JSON.parse(match[1])); } catch (_) {}
        }
        text = text.replace(/<!--ACTION:.*?-->/gs, '').trim();

        return {
            response: text || 'I received your message but had trouble generating a response.',
            actions: actions.length > 0 ? actions : undefined
        };
    } catch (_) {
        return { response: output.slice(0, 5000) };
    }
}

app.post('/chat', async (req, res) => {
    const { message, history, device_context } = req.body;

    if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'message is required' });
    }

    const prompt = buildChatPrompt(message, history || [], device_context || {});
    const role = device_context?.role || 'user';
    const page = device_context?.page || '?';

    console.log(`[Chat] Request from ${role} on page "${page}" (prompt: ${prompt.length} chars)`);

    const startTime = Date.now();
    try {
        const { stdout, stderr } = await runClaudeChat(prompt, CHAT_TIMEOUT_MS, { isAdmin: role === 'admin' });
        const latencyMs = Date.now() - startTime;
        console.log(`[Chat] Sonnet responded (${latencyMs}ms), stdout: ${stdout.length} chars`);
        if (stderr) console.warn(`[Chat] stderr: ${stderr.slice(0, 300)}`);

        const parsed = parseChatResponse(stdout);
        parsed.latency_ms = latencyMs;
        res.json(parsed);
    } catch (err) {
        const latencyMs = Date.now() - startTime;
        console.error(`[Chat] Error (${latencyMs}ms): ${err.message}`);
        res.status(500).json({
            response: 'Sorry, I was unable to process your request. Please try again in a moment.',
            latency_ms: latencyMs
        });
    }
});

// ── Prompt Builder (Binding Analysis) ──────
function buildAnalysisPrompt(problem, errors, logs, failures, context) {
    const isAdmin = context?.role === 'admin';
    const errorList = (errors || []).map(e => `- ${e}`).join('\n') || '(none provided)';

    const logList = (logs || []).slice(0, 20).map(l =>
        `[${l.level}] ${l.category}: ${l.message} (${l.created_at})`
    ).join('\n') || '(no recent logs)';

    const failureList = (failures || []).slice(0, 5).map(f =>
        `[${f.error_type}] ${f.error_message || 'no detail'} | URL: ${f.webhook_url || '?'} | source: ${f.source || '?'} (${f.created_at})`
    ).join('\n') || '(no recent failures)';

    const roleContext = isAdmin
        ? `ROLE: You are talking to the E-Claw ADMIN (the developer/owner of the platform).
The admin is testing, training, or debugging the AI support system directly.
- Do NOT assume the admin is an OpenClaw bot — they built this system.
- Speak to them as a fellow engineer. Use technical language freely.
- If they ask a question about the system, answer directly (don't suggest "exec:" commands for them).
- If they describe a hypothetical bot scenario, analyze it but clarify your reasoning.
- You may suggest code changes, architectural improvements, or config fixes.`
        : `ROLE: You are helping an OpenClaw BOT that encountered a binding/webhook issue.
The bot communicates via exec: commands (shell commands) and HTTP requests.
- Provide actionable steps with exact exec: commands the bot can run.
- Keep instructions simple — the bot follows step-by-step.`;

    return `You are an E-Claw backend support engineer.

${roleContext}

DEVICE: ${context?.deviceId || '?'} Entity ${context?.entityId ?? '?'}
TIMESTAMP: ${context?.timestamp || new Date().toISOString()}

PROBLEM DESCRIPTION:
${problem || '(not provided)'}

${isAdmin ? 'MESSAGES:' : 'ERROR MESSAGES FROM BOT:'}
${errorList}

RECENT SERVER LOGS (newest first):
${logList}

RECENT HANDSHAKE FAILURES:
${failureList}

KNOWN ERROR TYPES AND THEIR FIXES:
- localhost_rejected: webhook URL points to private IP -> use ZEABUR_WEB_URL env var
- http_401: wrong gateway token or setup_password -> re-read env vars with echo $OPENCLAW_GATEWAY_TOKEN
- tool_not_available: sessions_send blocked -> allow it in gateway config via openclaw CLI
- pairing_required: gateway disconnected -> restart gateway (ask user first)
- connection_failed: DNS/network error -> check URL is public and uses HTTPS
- expired_code: binding code expired after 5 min -> ask device owner for new code
- placeholder_token: token is a variable name, not actual value -> read real token from env

E-CLAW API REFERENCE:
- POST /api/bind { code, name? } — bind to entity
- POST /api/bot/register { deviceId, entityId, botSecret, webhook_url, token, session_key, openclaw_version?, setup_username?, setup_password? } — register webhook
- POST /api/transform { deviceId, entityId, botSecret, state, message } — update entity status

Respond in this EXACT JSON format (no markdown, no code fences, just raw JSON):
{
  "diagnosis": "Clear, concise explanation",
  "suggested_steps": ["Step 1...", "Step 2...", "Step 3..."],
  "confidence": 0.85
}

Rules:
- Be concise — max 3-5 steps
- Confidence: 0.0 to 1.0 based on how certain you are
- If you cannot determine the issue, say so and suggest general debugging steps`;
}

// ── Response Parser ─────────────────────────
function parseClaudeResponse(output) {
    try {
        // claude --output-format json wraps result in { result: "..." }
        const wrapper = JSON.parse(output);
        const text = wrapper.result || wrapper.content || output;

        // Try to parse the inner text as JSON
        if (typeof text === 'string') {
            // Extract JSON from potential markdown code fences
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                return {
                    diagnosis: parsed.diagnosis || 'Analysis complete.',
                    suggested_steps: Array.isArray(parsed.suggested_steps) ? parsed.suggested_steps : [],
                    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5
                };
            }
        }

        // If text is already an object with the right shape
        if (typeof text === 'object' && text.diagnosis) {
            return {
                diagnosis: text.diagnosis,
                suggested_steps: Array.isArray(text.suggested_steps) ? text.suggested_steps : [],
                confidence: typeof text.confidence === 'number' ? text.confidence : 0.5
            };
        }

        // Fallback: use raw text as diagnosis
        return {
            diagnosis: String(text).slice(0, 2000),
            suggested_steps: [],
            confidence: 0.3
        };
    } catch (err) {
        // If JSON parsing fails entirely, use raw output
        return {
            diagnosis: output.slice(0, 2000),
            suggested_steps: [],
            confidence: 0.3
        };
    }
}

// ── Warmup: Pre-start Claude CLI ────────────
let lastWarmupAt = 0;
const WARMUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

async function warmup() {
    const now = Date.now();
    if (now - lastWarmupAt < 60000) return; // Skip if warmed up less than 1 min ago
    lastWarmupAt = now;

    console.log('[Warmup] Pre-warming Claude CLI...');
    const startTime = Date.now();
    try {
        await runClaude('Reply with exactly: {"status":"warm"}', 15000);
        console.log(`[Warmup] Claude CLI warm (${Date.now() - startTime}ms)`);
    } catch (err) {
        console.warn(`[Warmup] Failed (${Date.now() - startTime}ms): ${err.message.slice(0, 200)}`);
    }
}

// Warmup trigger endpoint (called by E-Claw backend on handshake start)
app.post('/warmup', (req, res) => {
    warmup(); // Fire-and-forget, don't wait
    res.json({ status: 'warming' });
});

// ── Auto-restore .claude.json from backup ──
(function restoreClaudeConfig() {
    const configPath = path.join(process.env.HOME || '/root', '.claude.json');
    if (!fs.existsSync(configPath)) {
        const backupDir = path.join(process.env.HOME || '/root', '.claude', 'backups');
        try {
            const files = fs.readdirSync(backupDir).filter(f => f.startsWith('.claude.json.backup.')).sort();
            if (files.length > 0) {
                const latest = path.join(backupDir, files[files.length - 1]);
                fs.copyFileSync(latest, configPath);
                console.log(`[Startup] Restored ${configPath} from backup: ${files[files.length - 1]}`);
            }
        } catch (_) { /* no backup dir — first run, ignore */ }
    }
})();

// ── Start Server ────────────────────────────
app.listen(PORT, () => {
    console.log(`[Claude CLI Proxy] Listening on port ${PORT}`);
    if (!SUPPORT_API_KEY) {
        console.warn('[Claude CLI Proxy] WARNING: SUPPORT_API_KEY not set — all requests will be rejected');
    }

    // Clone/sync repo on startup (3s delay)
    setTimeout(ensureRepoClone, 3000);
    // Periodic git pull every 30 minutes
    setInterval(ensureRepoClone, 30 * 60 * 1000);

    // Warmup on startup (8s delay, after repo clone starts)
    setTimeout(warmup, 8000);
    // Periodic warmup every 5 minutes
    setInterval(warmup, WARMUP_INTERVAL_MS);
});
