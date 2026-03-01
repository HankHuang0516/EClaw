// ============================================
// Claude CLI Proxy — E-Claw AI Binding Support
// Receives binding issue data, calls Claude CLI for analysis
// Uses stream-json for full visibility into tool calls & thinking
// ============================================
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, execFileSync, spawn } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Resolve claude binary from node_modules/.bin (installed as dependency)
const CLAUDE_BIN = path.join(__dirname, 'node_modules', '.bin', 'claude');

// ── Concurrency Queue ─────────────────────────
// Claude CLI (Sonnet) is heavyweight — limit concurrent processes
const MAX_CONCURRENT = 2;   // max simultaneous Claude CLI processes
const MAX_QUEUE = 8;        // max waiting requests before rejecting
let activeCount = 0;
const waitQueue = [];       // { resolve, reject, timer }

function acquireSlot(timeoutMs = 120000) {
    if (activeCount < MAX_CONCURRENT) {
        activeCount++;
        console.log(`[Queue] Slot acquired (active: ${activeCount}/${MAX_CONCURRENT}, queued: ${waitQueue.length})`);
        return Promise.resolve();
    }
    if (waitQueue.length >= MAX_QUEUE) {
        console.warn(`[Queue] FULL — rejecting request (active: ${activeCount}, queued: ${waitQueue.length})`);
        const err = new Error('QUEUE_FULL');
        err.queueFull = true;
        return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
        const entry = { resolve, reject, timer: null };
        entry.timer = setTimeout(() => {
            const idx = waitQueue.indexOf(entry);
            if (idx !== -1) waitQueue.splice(idx, 1);
            const err = new Error('QUEUE_TIMEOUT');
            err.queueTimeout = true;
            reject(err);
        }, timeoutMs);
        waitQueue.push(entry);
        console.log(`[Queue] Request queued (active: ${activeCount}/${MAX_CONCURRENT}, queued: ${waitQueue.length})`);
    });
}

function releaseSlot() {
    if (waitQueue.length > 0) {
        const next = waitQueue.shift();
        clearTimeout(next.timer);
        console.log(`[Queue] Slot passed to queued request (active: ${activeCount}/${MAX_CONCURRENT}, queued: ${waitQueue.length})`);
        next.resolve();
    } else {
        activeCount--;
        console.log(`[Queue] Slot released (active: ${activeCount}/${MAX_CONCURRENT})`);
    }
}

// ── Session Store (in-memory ring buffer) ─────
const MAX_SESSIONS = 50;
const SESSION_TTL_MS = 3600000; // 1 hour
const sessionStore = []; // newest first

function createSession(type, promptPreview) {
    const session = {
        id: crypto.randomUUID(),
        startedAt: Date.now(),
        completedAt: null,
        type, // 'chat' | 'analyze'
        status: 'running',
        prompt: (promptPreview || '').slice(0, 200),
        response: null,
        events: [],
        turns: 0,
        cost_usd: 0,
        model: null,
        error: null
    };
    sessionStore.unshift(session);
    // Trim to max size
    while (sessionStore.length > MAX_SESSIONS) sessionStore.pop();
    return session;
}

function finalizeSession(session) {
    session.completedAt = Date.now();
    // Clean up expired sessions
    const cutoff = Date.now() - SESSION_TTL_MS;
    while (sessionStore.length > 0 && sessionStore[sessionStore.length - 1].startedAt < cutoff) {
        sessionStore.pop();
    }
}

// ── Stream-JSON Runner (unified for chat & analyze) ──
// Uses --output-format stream-json for full event visibility.
// Falls back to single-JSON parsing if stream-json produces no NDJSON lines.
// Always resolves (never rejects) — caller checks events/status.
function runClaudeStream(prompt, extraArgs, timeoutMs, { cwd, env } = {}) {
    return new Promise((resolve) => {
        const args = ['--verbose', '--print', '--output-format', 'stream-json', ...extraArgs];

        const child = spawn(CLAUDE_BIN, args, {
            cwd: cwd || __dirname,
            env: env || { ...process.env, HOME: process.env.HOME || '/root' },
            stdio: ['pipe', 'pipe', 'pipe']
        });

        const events = [];
        let rawStdout = '';  // keep full raw stdout for fallback
        let buffer = '';
        let stderr = '';
        let killed = false;

        child.stdout.on('data', chunk => {
            const str = chunk.toString();
            rawStdout += str;
            buffer += str;
            const lines = buffer.split('\n');
            buffer = lines.pop(); // keep incomplete last line
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const event = JSON.parse(line);
                    event._ts = Date.now();
                    events.push(event);
                    logStreamEvent(event);
                } catch (_) {
                    // Not valid JSON line, skip
                }
            }
        });

        child.stderr.on('data', d => { stderr += d; });

        child.on('error', err => {
            resolve({ events, rawStdout, stderr, code: -1, signal: null, killed: false, error: err.message });
        });

        child.on('close', (code, signal) => {
            // Parse remaining buffer
            if (buffer.trim()) {
                try {
                    const event = JSON.parse(buffer.trim());
                    event._ts = Date.now();
                    events.push(event);
                    logStreamEvent(event);
                } catch (_) {}
            }

            console.log(`[Stream] close — code: ${code}, signal: ${signal}, events: ${events.length}, stdout: ${rawStdout.length} chars, stderr: ${stderr.length} chars`);

            // Fallback: if no events parsed but stdout has content, try single-JSON parse
            if (events.length === 0 && rawStdout.trim()) {
                console.warn(`[Stream] No NDJSON events parsed, attempting single-JSON fallback...`);
                try {
                    const parsed = JSON.parse(rawStdout.trim());
                    // Wrap single JSON result as a "result" event
                    const fallbackEvent = {
                        _ts: Date.now(),
                        _fallback: true,
                        type: parsed.type || 'result',
                        subtype: parsed.subtype || (parsed.result ? 'success' : 'unknown'),
                        result: parsed.result || parsed.content || '',
                        session_id: parsed.session_id,
                        num_turns: parsed.num_turns,
                        total_cost_usd: parsed.total_cost_usd,
                        duration_ms: parsed.duration_ms,
                        modelUsage: parsed.modelUsage,
                        is_error: parsed.is_error
                    };
                    events.push(fallbackEvent);
                    console.log(`[Stream] Fallback parsed — type: ${fallbackEvent.type}, subtype: ${fallbackEvent.subtype}, result: ${(fallbackEvent.result || '').length} chars`);
                } catch (e) {
                    // Not JSON either — treat raw stdout as plain text response
                    console.warn(`[Stream] Fallback JSON parse failed, treating stdout as plain text (${rawStdout.length} chars)`);
                    events.push({
                        _ts: Date.now(),
                        _fallback: true,
                        type: 'result',
                        subtype: 'success',
                        result: rawStdout.trim()
                    });
                }
            }

            resolve({
                events,
                rawStdout,
                stderr,
                code,
                signal,
                killed,
                timedOut: killed
            });
        });

        // Write prompt to stdin and close
        child.stdin.write(prompt);
        child.stdin.end();

        // Timeout: kill process
        setTimeout(() => {
            killed = true;
            try { child.kill('SIGTERM'); } catch (_) {}
        }, timeoutMs);
    });
}

// Log each stream event to console for real-time monitoring
function logStreamEvent(event) {
    const type = event.type;
    if (type === 'system') {
        console.log(`[Stream] init — session: ${event.session_id || '?'}, tools: ${(event.tools || []).length}`);
    } else if (type === 'assistant') {
        const content = event.message?.content || [];
        for (const block of content) {
            if (block.type === 'text') {
                console.log(`[Stream] text (${block.text.length} chars): ${block.text.slice(0, 100)}${block.text.length > 100 ? '...' : ''}`);
            } else if (block.type === 'tool_use') {
                const inputStr = JSON.stringify(block.input || {}).slice(0, 120);
                console.log(`[Stream] tool_use: ${block.name} — ${inputStr}`);
            }
        }
    } else if (type === 'tool_result') {
        const contentLen = typeof event.content === 'string' ? event.content.length : JSON.stringify(event.content || '').length;
        console.log(`[Stream] tool_result (${contentLen} chars)`);
    } else if (type === 'result') {
        console.log(`[Stream] result — subtype: ${event.subtype}, turns: ${event.num_turns}, cost: $${event.total_cost_usd?.toFixed(4) || '?'}`);
    }
}

// ── Parse Stream Events ──────────────────────
function parseStreamEvents(events) {
    const resultEvent = events.filter(e => e.type === 'result').pop();

    // Collect all assistant text blocks
    const textParts = [];
    for (const e of events) {
        if (e.type === 'assistant' && e.message?.content) {
            for (const block of e.message.content) {
                if (block.type === 'text') textParts.push(block.text);
            }
        }
    }

    // Prefer result.result for the final response text; fall back to concatenated text blocks
    let responseText = resultEvent?.result || '';
    if (!responseText && textParts.length > 0) {
        responseText = textParts.join('\n');
    }

    const status = resultEvent?.subtype || 'unknown';

    return {
        responseText,
        status,        // 'success', 'error_max_turns', 'error_tool_execution', etc.
        turns: resultEvent?.num_turns || 0,
        cost_usd: resultEvent?.total_cost_usd || 0,
        model: Object.keys(resultEvent?.modelUsage || {})[0] || 'unknown',
        sessionId: resultEvent?.session_id || null
    };
}

// Summarize events for storage (avoid storing huge tool_result content)
function summarizeEvent(event) {
    const summary = { ts: event._ts || Date.now(), type: event.type };

    if (event.type === 'system') {
        summary.session_id = event.session_id;
        summary.tools = event.tools;
    } else if (event.type === 'assistant' && event.message?.content) {
        summary.content = event.message.content.map(c => {
            if (c.type === 'text') {
                return { type: 'text', length: c.text.length, preview: c.text.slice(0, 300) };
            }
            if (c.type === 'tool_use') {
                return { type: 'tool_use', tool: c.name, id: c.id, input_preview: JSON.stringify(c.input || {}).slice(0, 200) };
            }
            return { type: c.type };
        });
    } else if (event.type === 'tool_result') {
        const content = typeof event.content === 'string' ? event.content : JSON.stringify(event.content || '');
        summary.tool_use_id = event.tool_use_id;
        summary.content_length = content.length;
        summary.preview = content.slice(0, 300);
        summary.is_error = event.is_error || false;
    } else if (event.type === 'result') {
        summary.subtype = event.subtype;
        summary.num_turns = event.num_turns;
        summary.cost_usd = event.total_cost_usd;
        summary.duration_ms = event.duration_ms;
        summary.model_usage = event.modelUsage;
    }

    return summary;
}

// Extract <!--ACTION:{...}--> blocks from text
function extractActions(text) {
    const actions = [];
    const actionRegex = /<!--ACTION:(.*?)-->/gs;
    let match;
    while ((match = actionRegex.exec(text)) !== null) {
        try { actions.push(JSON.parse(match[1])); } catch (_) {}
    }
    const cleanText = text.replace(/<!--ACTION:.*?-->/gs, '').trim();
    return { cleanText, actions };
}

// ── App Setup ────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));

const SUPPORT_API_KEY = process.env.SUPPORT_API_KEY;
const PORT = process.env.PORT || 4000;
const CLAUDE_TIMEOUT_MS = 55000; // 55s (Haiku binding analysis)
const CHAT_TIMEOUT_MS = 180000; // 180s (Sonnet general chat with tool access)

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

// ── Queue Status ─────────────────────────────
app.get('/queue-status', (req, res) => {
    res.json({ active: activeCount, max_concurrent: MAX_CONCURRENT, queued: waitQueue.length, max_queue: MAX_QUEUE });
});

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
function requireAuth(req, res, next) {
    if (!SUPPORT_API_KEY) {
        return res.status(500).json({ error: 'SUPPORT_API_KEY not configured' });
    }
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${SUPPORT_API_KEY}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

app.use('/analyze', requireAuth);
app.use('/chat', requireAuth);
app.use('/sessions', requireAuth);

// ── Analysis Endpoint ───────────────────────
app.post('/analyze', async (req, res) => {
    const { problem_description, error_messages, logs, handshake_failures, device_context } = req.body;

    const prompt = buildAnalysisPrompt(problem_description, error_messages, logs, handshake_failures, device_context);

    console.log(`[Analyze] Request for device: ${device_context?.deviceId || '?'}`);

    // Acquire concurrency slot
    try {
        await acquireSlot(CLAUDE_TIMEOUT_MS);
    } catch (qErr) {
        if (qErr.queueFull) {
            return res.status(503).json({ error: 'busy', message: 'AI is busy. Please try again shortly.', retry_after: 15 });
        }
        return res.status(503).json({ error: 'queue_timeout', message: 'AI queue timeout. Please try again.', retry_after: 10 });
    }

    const session = createSession('analyze', `Device: ${device_context?.deviceId || '?'} — ${(problem_description || '').slice(0, 150)}`);

    try {
        console.log(`[Analyze] Calling Claude CLI (prompt: ${prompt.length} chars)...`);
        const startTime = Date.now();

        const { events, stderr, timedOut } = await runClaudeStream(
            prompt,
            ['--model', 'haiku'],
            CLAUDE_TIMEOUT_MS
        );

        const latencyMs = Date.now() - startTime;
        const parsed = parseStreamEvents(events);

        // Populate session
        session.events = events.map(summarizeEvent);
        session.turns = parsed.turns;
        session.cost_usd = parsed.cost_usd;
        session.model = parsed.model;
        session.response = parsed.responseText?.slice(0, 500);

        if (timedOut) {
            session.status = 'timeout';
            session.error = 'Claude CLI timed out';
            finalizeSession(session);
            console.error(`[Analyze] Timeout (${latencyMs}ms)`);
            return res.status(500).json({
                diagnosis: 'AI analysis timed out. Please try standard troubleshooting.',
                suggested_steps: [
                    'Check your webhook URL is reachable from the internet.',
                    'Verify your gateway token with: exec: echo $OPENCLAW_GATEWAY_TOKEN',
                    'If SETUP_PASSWORD is enabled, include it in /api/bot/register.',
                    'Retry POST /api/bot/register with openclaw_version included.'
                ],
                confidence: 0,
                session_id: session.id,
                debug: { reason: 'timeout', latency_ms: latencyMs }
            });
        }

        session.status = parsed.status === 'success' ? 'success' : parsed.status;
        finalizeSession(session);

        console.log(`[Analyze] Done (${latencyMs}ms, status: ${parsed.status}, turns: ${parsed.turns})`);
        if (stderr) console.warn(`[Analyze] stderr: ${stderr.slice(0, 300)}`);

        // Parse the response text as JSON diagnosis
        const analysis = parseAnalysisText(parsed.responseText);
        analysis.session_id = session.id;
        analysis.latency_ms = latencyMs;
        res.json(analysis);
    } catch (err) {
        session.status = 'error';
        session.error = err.message;
        finalizeSession(session);

        console.error(`[Analyze] Error: ${err.message}`);
        res.status(500).json({
            diagnosis: 'AI analysis failed. Please try standard troubleshooting.',
            suggested_steps: [],
            confidence: 0,
            session_id: session.id,
            debug: { error: err.message.slice(0, 300) }
        });
    } finally {
        releaseSlot();
    }
});

// ── Chat Endpoint (Sonnet + repo tools) ────
app.post('/chat', async (req, res) => {
    const { message, history, images, device_context } = req.body;

    if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'message is required' });
    }

    // Acquire concurrency slot (queue if busy)
    try {
        await acquireSlot(CHAT_TIMEOUT_MS);
    } catch (qErr) {
        if (qErr.queueFull) {
            return res.status(503).json({ error: 'busy', message: 'AI is busy handling other requests. Please try again shortly.', retry_after: 15 });
        }
        return res.status(503).json({ error: 'queue_timeout', message: 'AI queue timeout. Please try again.', retry_after: 10 });
    }

    // Save images to temp files so Claude can Read them
    const imagePaths = [];
    if (images && Array.isArray(images)) {
        for (let i = 0; i < Math.min(images.length, 3); i++) {
            const img = images[i];
            if (!img.data || !img.mimeType) continue;
            const ext = img.mimeType === 'image/png' ? 'png' : 'jpg';
            const tmpPath = `/tmp/eclaw_chat_img_${Date.now()}_${i}.${ext}`;
            try {
                fs.writeFileSync(tmpPath, Buffer.from(img.data, 'base64'));
                imagePaths.push(tmpPath);
            } catch (err) {
                console.error(`[Chat] Failed to write temp image: ${err.message}`);
            }
        }
    }

    const prompt = buildChatPrompt(message, history || [], device_context || {}, imagePaths);
    const role = device_context?.role || 'user';
    const page = device_context?.page || '?';
    const isAdmin = role === 'admin';
    const hasImages = imagePaths.length > 0;

    console.log(`[Chat] Request from ${role} on page "${page}" (prompt: ${prompt.length} chars, images: ${imagePaths.length})`);

    const session = createSession('chat', `${role}@${page}: ${message.slice(0, 150)}`);

    const startTime = Date.now();
    try {
        // Build Claude CLI args
        const cliArgs = ['--model', 'sonnet', '--max-turns', '6'];
        const tools = [];
        if (fs.existsSync(path.join(REPO_DIR, '.git'))) {
            tools.push('Read', 'Glob', 'Grep');
        } else if (hasImages) {
            tools.push('Read');
        }
        tools.push('Bash');
        if (tools.length > 0) {
            cliArgs.push('--allowedTools', tools.join(','));
        }

        const { events, stderr, timedOut } = await runClaudeStream(
            prompt,
            cliArgs,
            CHAT_TIMEOUT_MS,
            {
                cwd: fs.existsSync(REPO_DIR) ? REPO_DIR : __dirname,
                env: {
                    ...process.env,
                    HOME: process.env.HOME || '/root',
                    CLAUDE_DANGEROUSLY_SKIP_PERMISSIONS: '1'
                }
            }
        );

        const latencyMs = Date.now() - startTime;
        const parsed = parseStreamEvents(events);

        // Populate session
        session.events = events.map(summarizeEvent);
        session.turns = parsed.turns;
        session.cost_usd = parsed.cost_usd;
        session.model = parsed.model;

        if (timedOut) {
            session.status = 'timeout';
            session.error = 'Claude CLI timed out';
            // Use any partial response we got
            const partialText = parsed.responseText || 'Sorry, I was unable to process your request in time. Please try again.';
            session.response = partialText.slice(0, 500);
            finalizeSession(session);

            console.error(`[Chat] Timeout (${latencyMs}ms), partial response: ${partialText.length} chars`);
            return res.json({
                response: partialText,
                status: 'timeout',
                session_id: session.id,
                latency_ms: latencyMs
            });
        }

        if (parsed.status === 'error_max_turns') {
            session.status = 'error_max_turns';
            const partialText = parsed.responseText || 'Sorry, this question was too complex for me to fully analyze. Could you try asking a more specific question?';
            session.response = partialText.slice(0, 500);
            finalizeSession(session);

            console.warn(`[Chat] Max turns reached (${parsed.turns} turns, ${latencyMs}ms), partial response: ${partialText.length} chars`);
            const { cleanText, actions } = extractActions(partialText);
            return res.json({
                response: cleanText,
                actions: actions.length > 0 ? actions : undefined,
                status: 'max_turns',
                session_id: session.id,
                latency_ms: latencyMs
            });
        }

        session.status = parsed.status === 'success' ? 'success' : parsed.status;
        session.response = parsed.responseText?.slice(0, 500);
        finalizeSession(session);

        console.log(`[Chat] Done (${latencyMs}ms, status: ${parsed.status}, turns: ${parsed.turns})`);
        if (stderr) console.warn(`[Chat] stderr: ${stderr.slice(0, 300)}`);

        // Extract actions and clean response
        const { cleanText, actions } = extractActions(parsed.responseText || '');
        const responseText = cleanText || 'I received your message but had trouble generating a response.';

        res.json({
            response: responseText,
            actions: actions.length > 0 ? actions : undefined,
            session_id: session.id,
            latency_ms: latencyMs
        });
    } catch (err) {
        const latencyMs = Date.now() - startTime;
        session.status = 'error';
        session.error = err.message;
        finalizeSession(session);

        console.error(`[Chat] Error (${latencyMs}ms): ${err.message}`);
        res.status(500).json({
            response: 'Sorry, I was unable to process your request. Please try again in a moment.',
            session_id: session.id,
            latency_ms: latencyMs
        });
    } finally {
        releaseSlot();
        // Clean up temp image files
        for (const p of imagePaths) {
            try { fs.unlinkSync(p); } catch (_) {}
        }
    }
});

// ── Session Query Endpoints ─────────────────
app.get('/sessions', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const status = req.query.status; // optional filter
    const since = parseInt(req.query.since) || 0;

    let filtered = sessionStore;

    if (status) {
        filtered = filtered.filter(s => s.status === status);
    }
    if (since > 0) {
        filtered = filtered.filter(s => s.startedAt >= since);
    }

    // Return list without full events (summary only)
    const result = filtered.slice(0, limit).map(s => ({
        id: s.id,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        type: s.type,
        status: s.status,
        prompt: s.prompt,
        response: s.response,
        turns: s.turns,
        cost_usd: s.cost_usd,
        model: s.model,
        error: s.error,
        event_count: s.events.length,
        duration_ms: s.completedAt ? s.completedAt - s.startedAt : null
    }));

    res.json({ sessions: result, total: filtered.length });
});

app.get('/sessions/:id', (req, res) => {
    const session = sessionStore.find(s => s.id === req.params.id);
    if (!session) {
        return res.status(404).json({ error: 'Session not found' });
    }
    // Return full session including all events
    res.json(session);
});

// ── Prompt Builder (Chat) ──────────────────
function buildChatPrompt(message, history, context, imagePaths = []) {
    const isAdmin = context.role === 'admin';

    // Truncate history: keep last 10 messages, each capped at 500 chars
    const MAX_HISTORY_MSGS = 10;
    const MAX_MSG_CHARS = 500;
    const historyText = (history || []).slice(-MAX_HISTORY_MSGS).map(h => {
        const content = h.content && h.content.length > MAX_MSG_CHARS
            ? h.content.slice(0, MAX_MSG_CHARS) + '...[truncated]'
            : (h.content || '');
        return `${h.role === 'user' ? 'User' : 'Assistant'}: ${content}`;
    }).join('\n\n');

    const pageContext = context.page ? `The user is currently on the "${context.page}" page of the portal.` : '';

    // Only include log query instructions when user is debugging (or admin)
    const debugKeywords = /error|debug|log|fail|broken|issue|bug|crash|問題|錯誤|失敗|壞|不行|卡住/i;
    const needsLogQuery = isAdmin || debugKeywords.test(message);

    const logQueryBlock = (needsLogQuery && LOG_DEVICE_ID && LOG_DEVICE_SECRET)
        ? (isAdmin
            ? `\nLOG QUERY: curl -s "${ECLAW_API_URL}/api/logs?deviceId=${LOG_DEVICE_ID}&deviceSecret=${LOG_DEVICE_SECRET}&limit=30"
Filters: category (bind,unbind,transform,broadcast,broadcast_push,speakto_push,client_push,entity_poll,push_error,handshake,system), level (info,warn,error), since (ms), filterDevice, limit (max 500).
Execute Bash commands DIRECTLY. NEVER expose credentials in response.`
            : `\nLOG QUERY (user device ${context.deviceId || '?'}): curl -s "${ECLAW_API_URL}/api/logs?deviceId=${LOG_DEVICE_ID}&deviceSecret=${LOG_DEVICE_SECRET}&filterDevice=${context.deviceId}&limit=30"
Filters: category (bind,unbind,transform,broadcast,broadcast_push,speakto_push,client_push,entity_poll), level (info,warn,error), since (ms).
Execute Bash commands DIRECTLY. NEVER expose credentials in response.`)
        : '';

    const adminBlock = isAdmin
        ? `ADMIN CAPABILITIES:
You are talking to the E-Claw platform admin/developer.
- Suggest code changes, architecture improvements, or debugging strategies.
- Use Read, Glob, Grep tools to read source code; Bash for curl/commands.
- On request, create GitHub issues via: <!--ACTION:{"type":"create_issue","title":"...","body":"...","labels":["bug"]}-->
- Speak as a fellow engineer.${logQueryBlock}`
        : `USER CONTEXT:
You are talking to a regular E-Claw user (Device ID: ${context.deviceId || 'unknown'}).
- Help them use the portal, manage entities, configure bots. Keep language friendly.
- When user reports a bug or suggests a feature, proactively create a GitHub issue: <!--ACTION:{"type":"create_issue","title":"[Bug/Feature] ...","body":"...","labels":["bug"]}-->
  Tell user you've recorded their feedback.${logQueryBlock}`;

    return `You are E-Claw AI, assistant for the E-Claw platform — an AI-powered Android live wallpaper app where users bind AI bots (OpenClaw) to entities (Lobster, Pig) on their phone. Web portal: eclawbot.com.
${pageContext}

${adminBlock}

RULES:
- NON-INTERACTIVE mode: use tools directly, no permission prompts.
- Respond in the SAME LANGUAGE as the user (Chinese → Chinese, English → English).
- Concise (1-4 paragraphs). Use markdown. Never reveal secrets/tokens/device IDs.

${imagePaths.length > 0 ? `USER ATTACHED ${imagePaths.length} IMAGE(S):
Use Read tool to view: ${imagePaths.map((p, i) => `${p}`).join(', ')}
` : ''}${historyText ? `CONVERSATION HISTORY:\n${historyText}\n` : ''}User: ${message}

Respond naturally as E-Claw AI.`;
}

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

// ── Analysis Text Parser ────────────────────
// Extracts JSON diagnosis from Claude's text response
function parseAnalysisText(text) {
    if (!text) {
        return { diagnosis: 'No response from AI.', suggested_steps: [], confidence: 0 };
    }

    try {
        // Try to parse as JSON directly
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                diagnosis: parsed.diagnosis || 'Analysis complete.',
                suggested_steps: Array.isArray(parsed.suggested_steps) ? parsed.suggested_steps : [],
                confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5
            };
        }
    } catch (_) {}

    // Fallback: use raw text as diagnosis
    return {
        diagnosis: text.slice(0, 2000),
        suggested_steps: [],
        confidence: 0.3
    };
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
        const { events } = await runClaudeStream(
            'Reply with exactly: {"status":"warm"}',
            ['--model', 'haiku'],
            15000
        );
        const resultEvent = events.find(e => e.type === 'result');
        const status = resultEvent?.subtype || 'unknown';
        console.log(`[Warmup] Claude CLI warm (${Date.now() - startTime}ms, status: ${status})`);
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
