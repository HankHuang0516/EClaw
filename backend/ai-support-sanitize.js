// ── AI Support proxy-response sanitizer ─────────────────────────────
// Extracted from ai-support.js so it is unit-testable (card_747b9500).
//
// Two failure classes are caught here before a proxy answer reaches a user:
//  1. Raw CLI session JSON leaking through as the "answer" (pre-existing).
//  2. Plain-text upstream auth/API errors leaking through verbatim, e.g.
//     "Failed to authenticate. API Error: 401 Invalid authentication credentials"
//     (2026-07-02 incident: claude-cli-proxy OAuth credential expired and the
//     CLI's error text was served to portal users as a normal chat reply).

const UNAVAILABLE_MESSAGE = 'Sorry, the AI assistant is temporarily unavailable. Please try again shortly.';

// Upstream error shapes that must never be shown to a user verbatim.
// Kept deliberately narrow: matches CLI/provider auth+API error phrasing,
// not ordinary sentences that merely mention "authentication" in prose.
const UPSTREAM_ERROR_PATTERNS = [
    /failed to authenticate\b/i,                       // Claude CLI auth failure prefix
    /\bAPI Error:\s*\d{3}\b/i,                         // "API Error: 401 ..." / any HTTP code
    /invalid authentication credentials/i,             // credentials-file 401 message
    /invalid bearer token/i,                           // env-token 401 message
    /invalid x-api-key/i,                              // API-key 401 message
    /oauth token (?:has )?(?:expired|been revoked)/i,  // OAuth session expiry
    /\bauthentication_error\b/i,                       // Anthropic error type literal
    /please run \/login\b/i,                           // CLI re-login instruction
];

function isUpstreamErrorText(text) {
    if (!text || typeof text !== 'string') return false;
    return UPSTREAM_ERROR_PATTERNS.some((re) => re.test(text));
}

function sanitizeProxyResponse(responseText, opts = {}) {
    if (!responseText || typeof responseText !== 'string') {
        return responseText || 'Sorry, I could not generate a response. Please try again.';
    }

    // Proxy explicitly flagged the run as an error — never surface raw text.
    if (opts.isError === true) {
        console.warn('[AI Chat] Proxy flagged is_error, sanitizing response');
        return UNAVAILABLE_MESSAGE;
    }

    const trimmed = responseText.trim();
    // Detect raw JSON session results
    if (trimmed.startsWith('{') && trimmed.includes('"type"')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed.type === 'result' || parsed.subtype || parsed.session_id) {
                console.warn(`[AI Chat] Raw session JSON detected (subtype: ${parsed.subtype}), sanitizing`);
                if (parsed.result_text) {
                    return parsed.result_text;
                } else if (parsed.subtype === 'error_max_turns') {
                    return 'Sorry, this question was too complex for me to fully analyze. Could you try asking a more specific question?';
                } else if (parsed.subtype === 'error_tool_execution') {
                    return 'I encountered an error while looking into your issue. Please try again.';
                } else {
                    return 'Sorry, I was unable to process your request. Please try rephrasing your question.';
                }
            }
        } catch (_) {
            // Not valid JSON, leave as-is
        }
    }

    // Plain-text upstream auth/API error leaking through as the "answer"
    if (isUpstreamErrorText(trimmed)) {
        console.error(`[AI Chat] Upstream error text sanitized (never shown to user): ${trimmed.slice(0, 120)}`);
        return UNAVAILABLE_MESSAGE;
    }

    return responseText;
}

module.exports = { sanitizeProxyResponse, isUpstreamErrorText, UNAVAILABLE_MESSAGE };
