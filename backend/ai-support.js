// ============================================
// AI SUPPORT — Binding Troubleshooter
// Two-tier diagnosis: rule engine (free) + Claude CLI proxy (Max subscription)
// ============================================
const express = require('express');

module.exports = function (devices, chatPool, { serverLog, getWebhookFixInstructions }) {
    const router = express.Router();

    // ── Rate Limiter ────────────────────────────
    const supportRateLimit = {}; // key: deviceId -> { count, windowStart }
    const SUPPORT_MAX_PER_HOUR = 5;
    const SUPPORT_WINDOW_MS = 3600000; // 1 hour

    function checkRateLimit(deviceId) {
        const now = Date.now();
        const entry = supportRateLimit[deviceId];
        if (!entry || now - entry.windowStart > SUPPORT_WINDOW_MS) {
            supportRateLimit[deviceId] = { count: 1, windowStart: now };
            return { allowed: true };
        }
        if (entry.count >= SUPPORT_MAX_PER_HOUR) {
            const retryAfterMs = SUPPORT_WINDOW_MS - (now - entry.windowStart);
            return { allowed: false, retryAfterMs };
        }
        entry.count++;
        return { allowed: true };
    }

    // Clean up stale rate limit entries every 30 minutes
    setInterval(() => {
        const now = Date.now();
        for (const key of Object.keys(supportRateLimit)) {
            if (now - supportRateLimit[key].windowStart > SUPPORT_WINDOW_MS * 2) {
                delete supportRateLimit[key];
            }
        }
    }, 1800000);

    // ── Rule Patterns ───────────────────────────
    const RULE_PATTERNS = [
        {
            id: 'expired_code',
            regex: /invalid or expired binding code/i,
            diagnosis: 'The binding code has expired (codes are valid for 5 minutes) or was already used.',
            getSteps: () => [
                'Ask the device owner to open the E-Claw app and generate a new binding code.',
                'The new code will also be valid for 5 minutes — bind quickly after receiving it.',
                'Retry POST /api/bind with the new code.'
            ]
        },
        {
            id: 'device_not_found',
            regex: /device not found/i,
            diagnosis: 'The device ID is not registered on the server. The device may have been reset or the server restarted.',
            getSteps: () => [
                'Ask the device owner to open the E-Claw app (it auto-registers on startup).',
                'Then request a new binding code and retry POST /api/bind.'
            ]
        },
        {
            id: 'localhost_rejected',
            regex: /localhost|127\.0\.0\.1|0\.0\.0\.0|private.*address|local.*private/i,
            diagnosis: 'Your webhook URL points to a local/private IP address, which is unreachable from the internet.',
            getSteps: () => {
                const fix = getWebhookFixInstructions('localhost_rejected');
                return [fix];
            }
        },
        {
            id: 'http_401',
            regex: /401|unauthorized|credentials.*rejected|gateway rejected/i,
            diagnosis: 'Your gateway rejected the authentication credentials (HTTP 401). ' +
                'Most common cause: your gateway has SETUP_PASSWORD enabled (e.g. Railway deployment) but you did not include setup_username/setup_password in the registration.',
            getSteps: () => [
                'Step 1: Check if SETUP_PASSWORD is enabled:\n  exec: echo $SETUP_PASSWORD',
                'Step 2a: If Step 1 returned a non-empty value, retry POST /api/bot/register with:\n' +
                '  "setup_username": "admin",\n' +
                '  "setup_password": "<the value from Step 1>"',
                'Step 2b: If Step 1 was empty, re-read and verify your gateway token:\n' +
                '  exec: echo $OPENCLAW_GATEWAY_TOKEN\n' +
                '  Then retry POST /api/bot/register with the correct token.',
                'Step 3: If both values changed after a restart, re-read both and retry.'
            ]
        },
        {
            id: 'setup_password_required',
            regex: /setup_password|SETUP_PASSWORD.*enabled|setup.?password.*required/i,
            diagnosis: 'Your gateway has SETUP_PASSWORD enabled (common on Railway). HTTP requests are blocked by Basic Auth. ' +
                'You must include setup_username and setup_password so the server can use WebSocket authentication instead.',
            getSteps: () => [
                'Step 1: Read your SETUP_PASSWORD value:\n  exec: echo $SETUP_PASSWORD',
                'Step 2: Retry POST /api/bot/register with ALL your previous parameters PLUS these two new fields:\n' +
                '  "setup_username": "admin",\n' +
                '  "setup_password": "<the exact value from Step 1>"\n' +
                '  IMPORTANT: Use the EXACT output from echo — do NOT use a placeholder or variable name.',
                'Step 3: If it still fails with 401, also re-read your gateway token:\n  exec: echo $OPENCLAW_GATEWAY_TOKEN\n' +
                '  Then retry with the fresh token value.'
            ]
        },
        {
            id: 'tool_not_available',
            regex: /404|sessions_send|not available|cannot execute|tool.*blocked/i,
            diagnosis: 'The sessions_send tool is not allowed on your gateway. It needs to be explicitly enabled.',
            getSteps: () => {
                const fix = getWebhookFixInstructions('tool_not_available');
                return [fix];
            }
        },
        {
            id: 'pairing_required',
            regex: /pairing required|gateway.*closed|gateway.*disconnected|1008/i,
            diagnosis: 'Your gateway is disconnected or requires device re-pairing.',
            getSteps: () => {
                const fix = getWebhookFixInstructions('pairing_required');
                return [fix];
            }
        },
        {
            id: 'connection_failed',
            regex: /ECONNREFUSED|ENOTFOUND|DNS|cannot reach|network|connection.*failed/i,
            diagnosis: 'Cannot reach your webhook URL. There may be a DNS, network, or URL issue.',
            getSteps: () => [
                'Step 1: Verify your webhook URL is correct and publicly accessible.',
                'Step 2: Check if your bot platform (Zeabur/Railway) is running:\n  exec: echo $ZEABUR_WEB_URL',
                'Step 3: Ensure the URL uses HTTPS (not HTTP) and ends with /tools/invoke.',
                'Step 4: Retry POST /api/bot/register.'
            ]
        },
        {
            id: 'placeholder_token',
            regex: /placeholder|TOKEN_HERE|your[_-].*token|\[.*token.*\]|\{.*token.*\}/i,
            diagnosis: 'The token you provided appears to be a placeholder, not an actual gateway token.',
            getSteps: () => [
                'Step 1: Read the actual gateway token:\n  exec: echo $OPENCLAW_GATEWAY_TOKEN',
                'Step 2: If the above is empty, try:\n  exec: openclaw config get gateway.token',
                'Step 3: Use the real token value in POST /api/bot/register.'
            ]
        },
        {
            id: 'name_too_long',
            regex: /name.*20|characters or less|name.*too.*long/i,
            diagnosis: 'The entity name exceeds the 20-character limit.',
            getSteps: () => [
                'Shorten the name to 20 characters or fewer and retry POST /api/bind.'
            ]
        }
    ];

    // ── Stage A: Pattern Matching ───────────────
    function matchRulePatterns(errorMessages) {
        for (const msg of errorMessages) {
            for (const rule of RULE_PATTERNS) {
                if (rule.regex.test(msg)) {
                    return {
                        matched: true,
                        rule: rule.id,
                        diagnosis: rule.diagnosis,
                        suggested_steps: rule.getSteps()
                    };
                }
            }
        }
        return { matched: false };
    }

    // ── Stage B: Log Correlation ────────────────
    async function correlateWithLogs(deviceId) {
        try {
            // Check recent handshake failures
            const failuresResult = await chatPool.query(
                `SELECT error_type, error_message, webhook_url, source, created_at
                 FROM handshake_failures
                 WHERE device_id = $1 AND created_at > NOW() - INTERVAL '30 minutes'
                 ORDER BY created_at DESC LIMIT 10`,
                [deviceId]
            );

            if (failuresResult.rows.length > 0) {
                const latest = failuresResult.rows[0];
                const fix = getWebhookFixInstructions(latest.error_type);
                return {
                    matched: true,
                    rule: `log_correlation:${latest.error_type}`,
                    diagnosis: `Server logs show a recent "${latest.error_type}" failure: ${latest.error_message || 'no details'}`,
                    suggested_steps: [fix]
                };
            }

            // Check recent server logs for binding issues
            const logsResult = await chatPool.query(
                `SELECT level, category, message, metadata, created_at
                 FROM server_logs
                 WHERE device_id = $1 AND category IN ('bind', 'unbind', 'client_push')
                   AND created_at > NOW() - INTERVAL '30 minutes'
                 ORDER BY created_at DESC LIMIT 20`,
                [deviceId]
            );

            // Look for patterns in recent logs
            for (const log of logsResult.rows) {
                if (log.category === 'unbind') {
                    return {
                        matched: true,
                        rule: 'log_correlation:recent_unbind',
                        diagnosis: `This entity was recently unbound (${log.message}). You need to re-bind before registering a webhook.`,
                        suggested_steps: [
                            'Step 1: Request a new binding code from the device owner.',
                            'Step 2: Call POST /api/bind with the new code.',
                            'Step 3: Then call POST /api/bot/register to enable push.'
                        ]
                    };
                }
                if (log.category === 'client_push' && log.level === 'warn') {
                    // Push failure logs often contain the reason
                    const msg = log.message || '';
                    if (/pairing/i.test(msg)) {
                        const fix = getWebhookFixInstructions('pairing_required');
                        return {
                            matched: true,
                            rule: 'log_correlation:push_pairing',
                            diagnosis: 'Recent push delivery failed because the gateway requires re-pairing.',
                            suggested_steps: [fix]
                        };
                    }
                }
            }
        } catch (err) {
            // DB query failed — degrade gracefully
            console.error('[AI Support] Log correlation error:', err.message);
        }

        return { matched: false };
    }

    // ── Proxy Forwarding ────────────────────────
    async function forwardToProxy(deviceId, entityId, problemDescription, errorMessages, recentLogs, recentFailures) {
        const proxyUrl = process.env.CLAUDE_CLI_PROXY_URL;
        const proxyKey = process.env.SUPPORT_API_KEY;

        if (!proxyUrl || !proxyKey) {
            const missing = [];
            if (!proxyUrl) missing.push('CLAUDE_CLI_PROXY_URL');
            if (!proxyKey) missing.push('SUPPORT_API_KEY');
            console.warn(`[AI Support] Proxy not configured — missing env: ${missing.join(', ')}`);
            return {
                success: true,
                source: 'fallback',
                diagnosis: 'Advanced AI analysis is not available at this time. Please try the standard troubleshooting steps.',
                suggested_steps: [
                    'Check your webhook URL is reachable from the internet.',
                    'Verify your gateway token with: exec: echo $OPENCLAW_GATEWAY_TOKEN',
                    'If SETUP_PASSWORD is enabled, include setup_username and setup_password.',
                    'Retry POST /api/bot/register with openclaw_version included.'
                ],
                confidence: 0,
                debug: { reason: 'proxy_not_configured', missing_env: missing }
            };
        }

        const targetUrl = proxyUrl + '/analyze';
        console.log(`[AI Support] Forwarding to proxy: ${targetUrl}`);

        const startTime = Date.now();
        try {
            const response = await fetch(targetUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${proxyKey}`
                },
                body: JSON.stringify({
                    problem_description: problemDescription,
                    error_messages: errorMessages,
                    logs: (recentLogs || []).slice(0, 30),
                    handshake_failures: (recentFailures || []).slice(0, 10),
                    device_context: { deviceId, entityId, timestamp: new Date().toISOString() }
                }),
                signal: AbortSignal.timeout(30000)
            });

            const latencyMs = Date.now() - startTime;
            console.log(`[AI Support] Proxy responded: HTTP ${response.status} (${latencyMs}ms)`);

            if (!response.ok) {
                const body = await response.text().catch(() => '(unreadable)');
                console.error(`[AI Support] Proxy error body: ${body.slice(0, 500)}`);
                throw new Error(`Proxy returned HTTP ${response.status}: ${body.slice(0, 200)}`);
            }

            const result = await response.json();
            return {
                success: true,
                source: 'claude_proxy',
                diagnosis: result.diagnosis || 'Analysis complete.',
                suggested_steps: result.suggested_steps || [],
                confidence: result.confidence || 0.5,
                latency_ms: latencyMs
            };
        } catch (err) {
            const latencyMs = Date.now() - startTime;
            const errDetail = err.cause ? `${err.message} (cause: ${err.cause.code || err.cause.message})` : err.message;
            console.error(`[AI Support] Proxy error (${latencyMs}ms): ${errDetail}`);

            return {
                success: true,
                source: 'fallback',
                diagnosis: 'AI analysis timed out or is unavailable. Please try the standard troubleshooting steps.',
                suggested_steps: [
                    'Check your webhook URL is reachable from the internet.',
                    'Verify your gateway token with: exec: echo $OPENCLAW_GATEWAY_TOKEN',
                    'If SETUP_PASSWORD is enabled, include setup_username and setup_password.',
                    'Retry POST /api/bot/register with openclaw_version included.'
                ],
                confidence: 0,
                debug: { reason: 'proxy_error', error: errDetail, latency_ms: latencyMs, target_url: targetUrl }
            };
        }
    }

    // ── Fetch Recent Data for Proxy ─────────────
    async function fetchRecentData(deviceId) {
        let recentLogs = [];
        let recentFailures = [];

        try {
            const logsResult = await chatPool.query(
                `SELECT level, category, message, entity_id, metadata, created_at
                 FROM server_logs
                 WHERE device_id = $1 AND category IN ('bind', 'unbind', 'client_push', 'transform')
                   AND created_at > NOW() - INTERVAL '1 hour'
                 ORDER BY created_at DESC LIMIT 30`,
                [deviceId]
            );
            recentLogs = logsResult.rows;
        } catch (err) { /* ignore */ }

        try {
            const failResult = await chatPool.query(
                `SELECT error_type, error_message, webhook_url, http_status, source, created_at
                 FROM handshake_failures
                 WHERE device_id = $1 AND created_at > NOW() - INTERVAL '1 hour'
                 ORDER BY created_at DESC LIMIT 10`,
                [deviceId]
            );
            recentFailures = failResult.rows;
        } catch (err) { /* ignore */ }

        return { recentLogs, recentFailures };
    }

    // ── Log Query to DB ─────────────────────────
    function logSupportQuery(deviceId, entityId, result) {
        chatPool.query(
            `INSERT INTO ai_support_queries
             (device_id, entity_id, matched_rule, diagnosis, source, confidence, proxy_latency_ms)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
                deviceId,
                entityId,
                result.rule || result.matched_rule || null,
                result.diagnosis || null,
                result.source || 'rule_engine',
                result.confidence ?? null,
                result.latency_ms ?? null
            ]
        ).catch(() => {}); // fire-and-forget
    }

    // ── Main Endpoint ───────────────────────────
    router.post('/binding', async (req, res) => {
        const { deviceId, entityId, botSecret, problem_description, error_messages } = req.body;

        // Validate required fields
        if (!deviceId || entityId === undefined || !botSecret) {
            return res.status(400).json({
                success: false,
                error: 'missing_fields',
                message: 'Required fields: deviceId, entityId, botSecret'
            });
        }

        // Authenticate bot
        const eId = parseInt(entityId);
        const device = devices[deviceId];
        if (!device) {
            return res.status(404).json({ success: false, error: 'device_not_found', message: 'Device not found' });
        }
        if (eId < 0 || eId >= (device.entities || []).length) {
            return res.status(400).json({ success: false, error: 'invalid_entity', message: 'Invalid entityId' });
        }
        const entity = device.entities[eId];
        if (!entity || !entity.isBound) {
            return res.status(400).json({ success: false, error: 'not_bound', message: 'Entity not bound' });
        }
        if (botSecret !== entity.botSecret) {
            return res.status(403).json({ success: false, error: 'invalid_secret', message: 'Invalid botSecret' });
        }

        // Rate limit
        const rateCheck = checkRateLimit(deviceId);
        if (!rateCheck.allowed) {
            return res.status(429).json({
                success: false,
                error: 'rate_limited',
                message: `Maximum ${SUPPORT_MAX_PER_HOUR} support queries per hour per device. Try again later.`,
                retry_after_ms: rateCheck.retryAfterMs
            });
        }

        const msgs = Array.isArray(error_messages) ? error_messages.filter(m => typeof m === 'string') : [];
        const desc = typeof problem_description === 'string' ? problem_description : '';

        // Combine problem_description into msgs for pattern matching
        const allMessages = desc ? [desc, ...msgs] : msgs;

        // Stage A: Pattern matching
        const ruleResult = matchRulePatterns(allMessages);
        if (ruleResult.matched) {
            const response = {
                success: true,
                source: 'rule_engine',
                matched_rule: ruleResult.rule,
                diagnosis: ruleResult.diagnosis,
                suggested_steps: ruleResult.suggested_steps,
                confidence: 1.0
            };
            logSupportQuery(deviceId, eId, response);
            serverLog('info', 'ai_support', `Rule matched: ${ruleResult.rule}`, { deviceId, entityId: eId });
            return res.json(response);
        }

        // Stage B: Log correlation
        const logResult = await correlateWithLogs(deviceId);
        if (logResult.matched) {
            const response = {
                success: true,
                source: 'rule_engine',
                matched_rule: logResult.rule,
                diagnosis: logResult.diagnosis,
                suggested_steps: logResult.suggested_steps,
                confidence: 0.9
            };
            logSupportQuery(deviceId, eId, response);
            serverLog('info', 'ai_support', `Log correlation matched: ${logResult.rule}`, { deviceId, entityId: eId });
            return res.json(response);
        }

        // Stage C: Forward to Claude CLI proxy
        serverLog('info', 'ai_support', 'Forwarding to Claude CLI proxy', { deviceId, entityId: eId });
        const { recentLogs, recentFailures } = await fetchRecentData(deviceId);
        const proxyResult = await forwardToProxy(deviceId, eId, desc, msgs, recentLogs, recentFailures);

        logSupportQuery(deviceId, eId, proxyResult);
        if (proxyResult.source === 'claude_proxy') {
            serverLog('info', 'ai_support', `Proxy response (${proxyResult.latency_ms}ms)`, { deviceId, entityId: eId });
        } else {
            serverLog('warn', 'ai_support', `Proxy unavailable, returned fallback`, { deviceId, entityId: eId });
        }

        return res.json(proxyResult);
    });

    // ── Debug: Proxy Connectivity Test ────────
    router.get('/proxy-status', async (req, res) => {
        const proxyUrl = process.env.CLAUDE_CLI_PROXY_URL;
        const proxyKey = process.env.SUPPORT_API_KEY;

        const status = {
            proxy_url: proxyUrl || '(not set)',
            api_key_set: !!proxyKey,
            connectivity: 'unknown'
        };

        if (!proxyUrl) {
            status.connectivity = 'not_configured';
            return res.json(status);
        }

        try {
            const healthUrl = proxyUrl + '/health';
            const startTime = Date.now();
            const response = await fetch(healthUrl, { signal: AbortSignal.timeout(5000) });
            status.latency_ms = Date.now() - startTime;
            status.http_status = response.status;
            status.connectivity = response.ok ? 'ok' : 'error';
            if (response.ok) {
                status.health = await response.json().catch(() => null);
            } else {
                status.body = await response.text().catch(() => '(unreadable)');
            }
        } catch (err) {
            status.connectivity = 'unreachable';
            status.error = err.cause ? `${err.message} (${err.cause.code || err.cause.message})` : err.message;
        }

        res.json(status);
    });

    // ── Admin Chat Endpoint (no botSecret needed) ──
    router.post('/admin-chat', async (req, res) => {
        const { message, deviceId, entityId } = req.body;

        if (!message || typeof message !== 'string' || !message.trim()) {
            return res.status(400).json({ success: false, error: 'message is required' });
        }

        const msgs = [message.trim()];

        // Stage A: Pattern matching
        const ruleResult = matchRulePatterns(msgs);
        if (ruleResult.matched) {
            return res.json({
                success: true,
                source: 'rule_engine',
                matched_rule: ruleResult.rule,
                diagnosis: ruleResult.diagnosis,
                suggested_steps: ruleResult.suggested_steps,
                confidence: 1.0
            });
        }

        // Stage B: Log correlation (if deviceId provided)
        if (deviceId) {
            const logResult = await correlateWithLogs(deviceId);
            if (logResult.matched) {
                return res.json({
                    success: true,
                    source: 'log_correlation',
                    matched_rule: logResult.rule,
                    diagnosis: logResult.diagnosis,
                    suggested_steps: logResult.suggested_steps,
                    confidence: 0.9
                });
            }
        }

        // Stage C: Forward to Claude CLI proxy
        const { recentLogs, recentFailures } = deviceId
            ? await fetchRecentData(deviceId)
            : { recentLogs: [], recentFailures: [] };

        const proxyResult = await forwardToProxy(
            deviceId || 'admin-test',
            entityId ?? -1,
            message.trim(),
            msgs,
            recentLogs,
            recentFailures
        );

        return res.json(proxyResult);
    });

    // ── DB Table Init ───────────────────────────
    function initSupportTable() {
        chatPool.query(`
            CREATE TABLE IF NOT EXISTS ai_support_queries (
                id SERIAL PRIMARY KEY,
                device_id TEXT NOT NULL,
                entity_id INTEGER NOT NULL,
                matched_rule TEXT,
                diagnosis TEXT,
                source VARCHAR(16) NOT NULL DEFAULT 'rule_engine',
                confidence REAL,
                proxy_latency_ms INTEGER,
                created_at TIMESTAMP DEFAULT NOW()
            );
            CREATE INDEX IF NOT EXISTS idx_asq_device ON ai_support_queries(device_id);
            CREATE INDEX IF NOT EXISTS idx_asq_created ON ai_support_queries(created_at DESC);
        `).catch(err => {
            console.error('[AI Support] Table init error:', err.message);
        });
    }

    return { router, initSupportTable };
};
