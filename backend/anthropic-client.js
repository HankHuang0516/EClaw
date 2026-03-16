// ============================================
// Anthropic Messages API — Direct Client (v2: tool_use)
// Replaces CLAUDE_CLI_PROXY_URL when ANTHROPIC_API_KEY is set
// Priority: ANTHROPIC_API_KEY > CLAUDE_CLI_PROXY_URL > fallback
// ============================================

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 2048;
const TIMEOUT_MS = 120000; // 120s
const MAX_TOOL_STEPS = 15; // Max agentic loop iterations
const CONVERGENCE_STEP = 14; // Force conclusion at this step

// ── System Prompts ──────────────────────────

const CHAT_SYSTEM_PROMPT = `You are the customer support assistant for E-Claw (Claw Live Wallpaper), an Android live wallpaper app where AI bots control animated characters on the user's phone screen.

Key product knowledge:
- Each device supports up to 4 entity slots (0-3), each independently bindable to an AI bot
- Bots bind via a 5-minute binding code, then register a webhook for real-time push notifications
- Bots reply by calling POST /api/transform with their deviceId, entityId, and botSecret
- Entity types: LOBSTER (slots 0,2) and PIG (slots 1,3)
- The app has: Chat, Mission Control dashboard, File Manager, Schedule, Settings, Contacts
- Common issues: expired binding codes, webhook registration failures, SETUP_PASSWORD blocking auth
- Web portal at eclawbot.com provides admin features and the same chat interface

Your behavior:
- Be concise, friendly, and helpful
- When troubleshooting, ask for specific error messages
- For binding issues, guide users through the binding flow step by step
- For feature questions, explain clearly with examples
- If you don't know something, say so honestly
- Respond in the same language the user writes in (Chinese or English)
- Do NOT fabricate API endpoints or features that don't exist

GitHub Issue Management (CRITICAL):
You have TWO GitHub tools: create_github_issue and close_github_issue.
- create_github_issue: use when a user reports a bug or suggests a feature
- close_github_issue: use when a user EXPLICITLY asks to close a specific issue by number
IMPORTANT: You DO have permission to close GitHub issues using the close_github_issue tool.
NEVER say you cannot close GitHub issues. When asked to close an issue, ALWAYS call the close_github_issue tool immediately.`;

const ANALYZE_SYSTEM_PROMPT = `You are a diagnostic engine for E-Claw (Claw Live Wallpaper) binding and webhook issues.

Analyze the provided error messages, server logs, and handshake failures to produce a diagnosis.

Your response MUST be valid JSON with this structure:
{
  "diagnosis": "Clear explanation of the root cause",
  "suggested_steps": ["Step 1: ...", "Step 2: ...", "Step 3: ..."],
  "confidence": 0.8
}

Common issues:
- expired_code: Binding codes expire after 5 minutes
- localhost_rejected: Bot's webhook URL contains localhost (must be public URL)
- http_401: SETUP_PASSWORD is set but bot didn't provide setup_username/setup_password
- tool_not_available: Gateway doesn't allow the sessions_send tool
- pairing_required: Gateway requires re-pairing after restart
- connection_failed: Webhook URL is unreachable from the server

Provide actionable, specific fix instructions with exact API calls or commands.`;

// ── Tool Definitions ────────────────────────

const GITHUB_TOOLS = [
    {
        name: 'create_github_issue',
        description: 'Create a new GitHub issue for bug reports or feature requests. Use when a user reports a problem or suggests a feature.',
        input_schema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Issue title (concise, descriptive)' },
                body: { type: 'string', description: 'Issue body with reproduction steps, expected behavior, etc.' },
                labels: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Labels for the issue (e.g. "bug", "enhancement", "ux")'
                }
            },
            required: ['title', 'body']
        }
    },
    {
        name: 'close_github_issue',
        description: 'Close an existing GitHub issue. Use when a user explicitly asks to close a specific issue by number.',
        input_schema: {
            type: 'object',
            properties: {
                issue_number: { type: 'integer', description: 'The GitHub issue number to close' },
                comment: { type: 'string', description: 'Optional comment explaining why the issue is being closed' }
            },
            required: ['issue_number']
        }
    }
];

// ── Helpers ─────────────────────────────────

/**
 * Convert internal history to Anthropic Messages API format.
 * Ensures strict user/assistant alternation (Anthropic requirement).
 */
function convertHistory(history) {
    if (!Array.isArray(history) || history.length === 0) return [];

    const result = [];
    for (const msg of history) {
        const role = msg.role === 'user' ? 'user' : 'assistant';
        const content = typeof msg.content === 'string' ? msg.content : String(msg.content || '');
        if (!content.trim()) continue;

        // Merge consecutive same-role messages
        if (result.length > 0 && result[result.length - 1].role === role) {
            result[result.length - 1].content += '\n' + content;
        } else {
            result.push({ role, content });
        }
    }

    // Anthropic requires first message to be 'user'
    while (result.length > 0 && result[0].role !== 'user') {
        result.shift();
    }

    return result;
}

/**
 * Convert images to Anthropic vision format.
 * Input:  [{ data: base64, mimeType: "image/jpeg" }]
 * Output: [{ type: "image", source: { type: "base64", media_type, data } }]
 */
function convertImages(images) {
    if (!Array.isArray(images)) return [];
    return images
        .filter(img => img && img.data && img.mimeType)
        .slice(0, 3)
        .map(img => ({
            type: 'image',
            source: {
                type: 'base64',
                media_type: img.mimeType,
                data: img.data
            }
        }));
}

/**
 * Build the user message content (text + optional images).
 */
function buildUserContent(message, images) {
    const imageBlocks = convertImages(images);
    if (imageBlocks.length === 0) return message;

    // Multi-part content: images first, then text
    return [
        ...imageBlocks,
        { type: 'text', text: message }
    ];
}

/**
 * Call Anthropic Messages API (with optional tool use).
 */
async function callAnthropic(systemPrompt, messages, tools) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

    const body = {
        model: ANTHROPIC_MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages
    };
    if (tools && tools.length > 0) {
        console.log(`[Anthropic] Sending ${tools.length} tool(s): ${tools.map(t => t.name).join(', ')}`);
        body.tools = tools;
    }

    const response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': ANTHROPIC_VERSION
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });

    if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`Anthropic API ${response.status}: ${errBody.slice(0, 300)}`);
    }

    return response.json();
}

/**
 * Extract text response and tool use calls from Anthropic response.
 */
function parseResponse(result) {
    console.log(`[Anthropic] Response stop_reason=${result.stop_reason}, content_blocks=${(result.content || []).length}, types=${(result.content || []).map(b => b.type).join(',')}`);
    let responseText = '';
    const actions = [];

    for (const block of (result.content || [])) {
        if (block.type === 'text') {
            responseText += block.text;
        } else if (block.type === 'tool_use') {
            if (block.name === 'create_github_issue') {
                actions.push({
                    type: 'create_issue',
                    title: block.input.title,
                    body: block.input.body,
                    labels: block.input.labels || ['bug']
                });
            } else if (block.name === 'close_github_issue') {
                actions.push({
                    type: 'close_issue',
                    issue_number: block.input.issue_number,
                    comment: block.input.comment
                });
            }
        }
    }

    return {
        response: responseText || 'Action executed.',
        actions: actions.length > 0 ? actions : null
    };
}

// ── Diagnostics Formatter ────────────────────

/**
 * Format device diagnostics into a human-readable block for the system prompt.
 * Covers: platform/version, entity slot states, recent errors (24h), recent
 * key activity (1h), and handshake failures (1h).
 */
function formatDiagnostics(diag) {
    if (!diag) return null;
    const parts = [];

    // Platform + version
    if (diag.platform || diag.appVersion) {
        const ver = diag.appVersion ? ` (v${diag.appVersion})` : '';
        parts.push(`Platform: ${diag.platform || 'unknown'}${ver}`);
    }

    // Entity slot states
    if (diag.entityStates?.length > 0) {
        const lines = diag.entityStates.map(e => {
            if (e.bound) {
                const webhook = e.hasWebhook ? '[webhook registered]' : '[no webhook]';
                return `  Slot ${e.slot} (${e.type}): bound as "${e.name}" ${webhook}`;
            }
            return `  Slot ${e.slot} (${e.type}): unbound`;
        });
        parts.push('Entity slots:\n' + lines.join('\n'));
    }

    // Recent errors — 24h
    if (diag.recentErrors?.length > 0) {
        const lines = diag.recentErrors.map(e => {
            const ts = new Date(e.created_at).toISOString().slice(0, 16).replace('T', ' ');
            const meta = e.metadata ? ' — ' + JSON.stringify(e.metadata).slice(0, 100) : '';
            return `  [${ts}][${e.category}] slot_${e.entity_id ?? '-'}: ${e.message}${meta}`;
        });
        parts.push('Recent errors (24h):\n' + lines.join('\n'));
    }

    // Recent key activity — 1h (bind/unbind/push/transform)
    if (diag.recentActivity?.length > 0) {
        const lines = diag.recentActivity.map(e => {
            const ts = new Date(e.created_at).toISOString().slice(0, 16).replace('T', ' ');
            return `  [${ts}][${e.level}][${e.category}] slot_${e.entity_id ?? '-'}: ${e.message}`;
        });
        parts.push('Recent activity (1h):\n' + lines.join('\n'));
    }

    // Handshake failures — 1h
    if (diag.handshakeFailures?.length > 0) {
        const lines = diag.handshakeFailures.map(f => {
            const ts = new Date(f.created_at).toISOString().slice(0, 16).replace('T', ' ');
            return `  [${ts}] ${f.error_type}: ${f.error_message || '(no detail)'}`;
        });
        parts.push('Handshake failures (1h):\n' + lines.join('\n'));
    }

    return parts.length > 0 ? parts.join('\n\n') : null;
}

// ── Exported Functions ──────────────────────

/**
 * Universal chat — matches proxy /chat interface.
 * @param {Object} opts
 * @param {string} opts.message - Current user message
 * @param {Array}  opts.history - Conversation history [{role, content}]
 * @param {Array}  [opts.images] - Optional images [{data, mimeType}]
 * @param {Object} [opts.deviceContext] - {deviceId, page, role, email}
 * @param {Object} [opts.deviceDiagnostics] - Full device diagnostic snapshot from fetchDeviceContext()
 * @returns {Promise<{response: string, actions: Array|null}>}
 */
async function chatWithClaude({ message, history, images, deviceContext, deviceDiagnostics }) {
    // Build context-enriched system prompt
    let system = CHAT_SYSTEM_PROMPT;
    if (deviceContext) {
        const ctx = [];
        if (deviceContext.deviceId) ctx.push(`Device: ${deviceContext.deviceId}`);
        if (deviceContext.page) ctx.push(`Page: ${deviceContext.page}`);
        if (deviceContext.role) ctx.push(`User role: ${deviceContext.role}`);
        if (ctx.length > 0) {
            system += `\n\nCurrent session context:\n${ctx.join('\n')}`;
        }
    }

    // Append device diagnostics (errors, activity, entity states)
    const diagText = formatDiagnostics(deviceDiagnostics);
    if (diagText) {
        system += `\n\nDevice diagnostics snapshot:\n${diagText}`;
    }

    // Build messages array
    const messages = convertHistory(history || []);
    const userContent = buildUserContent(message, images);
    messages.push({ role: 'user', content: userContent });

    // Agentic tool-use loop: keep calling API until we get a final text response
    let allActions = [];
    for (let step = 1; step <= MAX_TOOL_STEPS; step++) {
        // At convergence step, inject forced conclusion instruction
        let stepSystem = system;
        if (step >= CONVERGENCE_STEP) {
            stepSystem += '\n\nIMPORTANT: You are running low on analysis steps. You MUST provide your final answer NOW. Summarize your findings and give a conclusion based on what you have so far. Do NOT call any more tools.';
        }

        const result = await callAnthropic(stepSystem, messages, step >= CONVERGENCE_STEP ? [] : GITHUB_TOOLS);
        const parsed = parseResponse(result);

        // Collect any tool actions
        if (parsed.actions) {
            allActions.push(...parsed.actions);
        }

        // If the model didn't request tool use, we're done
        if (result.stop_reason !== 'tool_use') {
            return {
                response: parsed.response,
                actions: allActions.length > 0 ? allActions : null
            };
        }

        // Model requested tool use — append assistant response and tool results to messages
        messages.push({ role: 'assistant', content: result.content });

        // Build tool results for each tool_use block
        const toolResults = [];
        for (const block of (result.content || [])) {
            if (block.type === 'tool_use') {
                // We don't execute tools server-side in the loop — just acknowledge them.
                // Actual execution (GitHub actions) happens after the loop via the actions array.
                toolResults.push({
                    type: 'tool_result',
                    tool_use_id: block.id,
                    content: 'Tool call acknowledged. The action will be executed after your response.'
                });
            }
        }
        if (toolResults.length > 0) {
            messages.push({ role: 'user', content: toolResults });
        }

        console.log(`[Anthropic] Tool-use loop step ${step}/${MAX_TOOL_STEPS}, actions so far: ${allActions.length}`);
    }

    // Exceeded max steps — return whatever we have with a warning
    console.warn(`[Anthropic] Reached max tool steps (${MAX_TOOL_STEPS}), forcing response`);
    return {
        response: allActions.length > 0
            ? 'I\'ve completed the requested actions. Due to complexity limits, I may not have fully addressed all aspects of your question.'
            : 'I apologize — your question required more analysis than I could complete. Here\'s what I gathered so far: please try asking a more specific question for better results.',
        actions: allActions.length > 0 ? allActions : null
    };
}

/**
 * Binding analysis — matches proxy /analyze interface.
 * @param {Object} opts
 * @param {string} opts.problemDescription
 * @param {Array}  opts.errorMessages
 * @param {Array}  opts.logs - Recent server log rows
 * @param {Array}  opts.handshakeFailures
 * @param {Object} opts.deviceContext
 * @returns {Promise<{diagnosis: string, suggested_steps: string[], confidence: number}>}
 */
async function analyzeWithClaude({ problemDescription, errorMessages, logs, handshakeFailures, deviceContext }) {
    const userMessage = [
        `Problem: ${problemDescription || 'Unknown'}`,
        '',
        `Error messages:\n${(errorMessages || []).join('\n') || 'None'}`,
        '',
        `Recent server logs (last 30):\n${JSON.stringify((logs || []).slice(0, 30), null, 2)}`,
        '',
        `Handshake failures (last 10):\n${JSON.stringify((handshakeFailures || []).slice(0, 10), null, 2)}`,
        '',
        `Device context: ${JSON.stringify(deviceContext || {})}`,
        '',
        'Analyze the above and return your diagnosis as JSON.'
    ].join('\n');

    const result = await callAnthropic(ANALYZE_SYSTEM_PROMPT, [
        { role: 'user', content: userMessage }
    ]);

    const text = result.content?.[0]?.text || '';

    // Try to parse JSON from response
    try {
        // Handle markdown code blocks
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                diagnosis: parsed.diagnosis || 'Analysis complete.',
                suggested_steps: Array.isArray(parsed.suggested_steps) ? parsed.suggested_steps : [],
                confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7
            };
        }
    } catch (_) {}

    // Fallback: return raw text as diagnosis
    return {
        diagnosis: text || 'Unable to analyze the issue.',
        suggested_steps: [],
        confidence: 0.5
    };
}

module.exports = { chatWithClaude, analyzeWithClaude, formatDiagnostics };
