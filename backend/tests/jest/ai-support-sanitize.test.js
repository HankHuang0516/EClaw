/**
 * AI Support — proxy response sanitizer (card_747b9500)
 *
 * Regression: 2026-07-02 the claude-cli-proxy's OAuth credential expired and
 * the CLI's raw error text — "Failed to authenticate. API Error: 401 Invalid
 * authentication credentials" — was served to portal users as a normal AI
 * customer-support reply. These tests FAIL on the pre-fix sanitizer (which
 * only intercepted raw session JSON) and PASS with ai-support-sanitize.js.
 */

const {
    sanitizeProxyResponse,
    isUpstreamErrorText,
    UNAVAILABLE_MESSAGE,
} = require('../../ai-support-sanitize');

describe('sanitizeProxyResponse — upstream auth/API error passthrough (the 2026-07-02 incident)', () => {
    const incidentLiteral = 'Failed to authenticate. API Error: 401 Invalid authentication credentials';

    test('the exact incident string is replaced with the friendly unavailable message', () => {
        expect(sanitizeProxyResponse(incidentLiteral)).toBe(UNAVAILABLE_MESSAGE);
    });

    test.each([
        ['env-token variant', 'Failed to authenticate. API Error: 401 Invalid bearer token'],
        ['api-key variant', 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'],
        ['oauth expiry variant', 'OAuth token has expired. Please run /login to re-authenticate.'],
        ['bare api error with other status', 'API Error: 529 Overloaded'],
    ])('%s never reaches the user verbatim', (_label, raw) => {
        expect(sanitizeProxyResponse(raw)).toBe(UNAVAILABLE_MESSAGE);
    });

    test('is_error flag from the proxy sanitizes regardless of text', () => {
        expect(sanitizeProxyResponse('anything at all', { isError: true })).toBe(UNAVAILABLE_MESSAGE);
    });

    test('ordinary prose mentioning authentication is NOT sanitized', () => {
        const benign = 'To fix webhook authentication, re-read your gateway token and retry the register call.';
        expect(sanitizeProxyResponse(benign)).toBe(benign);
    });

    test('a normal helpful answer passes through untouched', () => {
        const answer = 'Your device is bound correctly. Try restarting the app and the wallpaper will reload.';
        expect(sanitizeProxyResponse(answer)).toBe(answer);
    });
});

describe('sanitizeProxyResponse — pre-existing raw session JSON behavior is preserved', () => {
    test('result_text is extracted from raw session JSON', () => {
        const raw = JSON.stringify({ type: 'result', subtype: 'success', result_text: 'Here is the answer.' });
        expect(sanitizeProxyResponse(raw)).toBe('Here is the answer.');
    });

    test('error_max_turns maps to the too-complex message', () => {
        const raw = JSON.stringify({ type: 'result', subtype: 'error_max_turns' });
        expect(sanitizeProxyResponse(raw)).toMatch(/too complex/i);
    });

    test('error_tool_execution maps to the retry message', () => {
        const raw = JSON.stringify({ type: 'result', subtype: 'error_tool_execution' });
        expect(sanitizeProxyResponse(raw)).toMatch(/try again/i);
    });

    test('empty/null input yields the could-not-generate fallback', () => {
        expect(sanitizeProxyResponse('')).toMatch(/could not generate/i);
        expect(sanitizeProxyResponse(null)).toMatch(/could not generate/i);
    });
});

describe('isUpstreamErrorText', () => {
    test('detects all incident-class strings', () => {
        expect(isUpstreamErrorText('Failed to authenticate. API Error: 401 Invalid authentication credentials')).toBe(true);
        expect(isUpstreamErrorText('failed to authenticate')).toBe(true);
        expect(isUpstreamErrorText('API Error: 401 Invalid bearer token')).toBe(true);
    });

    test('does not flag normal answers', () => {
        expect(isUpstreamErrorText('Everything looks healthy — 7/7 endpoints returned 200.')).toBe(false);
        expect(isUpstreamErrorText('')).toBe(false);
        expect(isUpstreamErrorText(null)).toBe(false);
    });
});
