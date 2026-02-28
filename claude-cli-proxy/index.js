// ============================================
// Claude CLI Proxy — E-Claw AI Binding Support
// Receives binding issue data, calls Claude CLI for analysis
// ============================================
const express = require('express');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const app = express();
app.use(express.json({ limit: '256kb' }));

const SUPPORT_API_KEY = process.env.SUPPORT_API_KEY;
const PORT = process.env.PORT || 4000;
const CLAUDE_TIMEOUT_MS = 25000; // 25s (leave 5s buffer for HTTP)

// ── Health Check ────────────────────────────
app.get('/health', async (req, res) => {
    const health = { status: 'ok', service: 'eclaw-claude-cli-proxy', claude_cli: 'unknown' };
    try {
        const { stdout } = await execFileAsync('claude', ['--version'], {
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
        // Check if claude CLI is available
        console.log('[Proxy] Calling claude CLI...');
        const startTime = Date.now();

        const { stdout, stderr } = await execFileAsync('claude', ['-p', prompt, '--output-format', 'json'], {
            timeout: CLAUDE_TIMEOUT_MS,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
            env: { ...process.env, HOME: process.env.HOME || '/root' }
        });

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

// ── Prompt Builder ──────────────────────────
function buildAnalysisPrompt(problem, errors, logs, failures, context) {
    const errorList = (errors || []).map(e => `- ${e}`).join('\n') || '(none provided)';

    const logList = (logs || []).slice(0, 20).map(l =>
        `[${l.level}] ${l.category}: ${l.message} (${l.created_at})`
    ).join('\n') || '(no recent logs)';

    const failureList = (failures || []).slice(0, 5).map(f =>
        `[${f.error_type}] ${f.error_message || 'no detail'} | URL: ${f.webhook_url || '?'} | source: ${f.source || '?'} (${f.created_at})`
    ).join('\n') || '(no recent failures)';

    return `You are an E-Claw backend support engineer. Analyze this binding/webhook issue and provide a diagnosis.

DEVICE: ${context?.deviceId || '?'} Entity ${context?.entityId ?? '?'}
TIMESTAMP: ${context?.timestamp || new Date().toISOString()}

PROBLEM DESCRIPTION:
${problem || '(not provided)'}

ERROR MESSAGES FROM BOT:
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
  "diagnosis": "Clear, concise explanation of what is wrong and why",
  "suggested_steps": ["Step 1: exact action with exec: commands where applicable", "Step 2: ...", "Step 3: ..."],
  "confidence": 0.85
}

Rules:
- Include exact exec: commands the bot can run (e.g., exec: echo $OPENCLAW_GATEWAY_TOKEN)
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

// ── Start Server ────────────────────────────
app.listen(PORT, () => {
    console.log(`[Claude CLI Proxy] Listening on port ${PORT}`);
    if (!SUPPORT_API_KEY) {
        console.warn('[Claude CLI Proxy] WARNING: SUPPORT_API_KEY not set — all requests will be rejected');
    }
});
