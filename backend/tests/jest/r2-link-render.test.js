/**
 * R2 Link Render — unit tests for the client-side helper that strips raw
 * Cloudflare R2 presigned URLs out of chat message HTML.
 *
 * Covers the security contract (card_5c03553f1a0c56b9672dc7e6):
 *  - raw R2 anchors and img tags are replaced by attachment cards
 *  - access-key IDs and bearer tokens never appear in the output HTML
 *  - legacy/unparseable R2 URLs fall back to a muted chip (still usable)
 *  - non-R2 URLs pass through untouched
 */

const path = require('path');

describe('R2LinkRender', () => {
    let R2LinkRender;

    beforeAll(() => {
        // Module assigns to globalThis (no window in Node), so read it back.
        require(path.join(__dirname, '..', '..', 'public', 'shared', 'r2-link-render.js'));
        R2LinkRender = global.R2LinkRender;
    });

    const SAMPLE_URL = 'https://abc123.r2.cloudflarestorage.com/eclaw-files/files/dev-1/11111111-2222-3333-4444-555555555555/report.pdf' +
        '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=SECRET_ACCESS_KEY_ID%2F20260424%2Fauto%2Fs3%2Faws4_request' +
        '&X-Amz-Signature=deadbeef';

    describe('isR2Url', () => {
        test('matches r2.cloudflarestorage.com host', () => {
            expect(R2LinkRender.isR2Url(SAMPLE_URL)).toBe(true);
        });
        test('rejects non-R2 hosts', () => {
            expect(R2LinkRender.isR2Url('https://example.com/file.pdf')).toBe(false);
            expect(R2LinkRender.isR2Url('https://r2.cloudflarestorage.com.evil.com/x')).toBe(false);
        });
        test('rejects malformed input', () => {
            expect(R2LinkRender.isR2Url(null)).toBe(false);
            expect(R2LinkRender.isR2Url('')).toBe(false);
            expect(R2LinkRender.isR2Url('not a url')).toBe(false);
        });
    });

    describe('parseR2Url', () => {
        test('extracts fileId and filename', () => {
            const parsed = R2LinkRender.parseR2Url(SAMPLE_URL);
            expect(parsed).toEqual({
                fileId: '11111111-2222-3333-4444-555555555555',
                filename: 'report.pdf',
            });
        });
        test('decodes URL-encoded filenames', () => {
            const url = 'https://x.r2.cloudflarestorage.com/b/files/d/11111111-2222-3333-4444-555555555555/%E6%A8%99%E6%9C%AC.pdf?sig=1';
            const parsed = R2LinkRender.parseR2Url(url);
            expect(parsed.filename).toBe('標本.pdf');
        });
        test('rejects paths without fileId uuid', () => {
            const url = 'https://x.r2.cloudflarestorage.com/b/random/path/foo.pdf?sig=1';
            expect(R2LinkRender.parseR2Url(url)).toBe(null);
        });
        test('rejects non-r2 hosts', () => {
            expect(R2LinkRender.parseR2Url('https://example.com/files/d/11111111-2222-3333-4444-555555555555/f.pdf')).toBe(null);
        });
    });

    describe('replaceR2Links — security contract', () => {
        test('strips the entire query string (access key + signature) from anchor output', () => {
            const input = `<a href="${SAMPLE_URL}" target="_blank">${SAMPLE_URL}</a>`;
            const output = R2LinkRender.replaceR2Links(input);
            expect(output).not.toMatch(/X-Amz-Signature/);
            expect(output).not.toMatch(/X-Amz-Credential/);
            expect(output).not.toMatch(/SECRET_ACCESS_KEY_ID/);
            expect(output).not.toMatch(/r2\.cloudflarestorage\.com/);
        });

        test('replaces anchor with attachment card carrying fileId + filename', () => {
            const input = `<p>See this: <a href="${SAMPLE_URL}">file</a></p>`;
            const output = R2LinkRender.replaceR2Links(input);
            expect(output).toContain('r2-attachment-card');
            expect(output).toContain('data-file-id="11111111-2222-3333-4444-555555555555"');
            expect(output).toContain('report.pdf');
        });

        test('replaces img tag too (markdown image from bot)', () => {
            const imgUrl = SAMPLE_URL.replace('report.pdf', 'photo.jpg');
            const input = `<img src="${imgUrl}" alt="photo">`;
            const output = R2LinkRender.replaceR2Links(input);
            expect(output).toContain('r2-attachment-card');
            expect(output).toContain('photo.jpg');
            expect(output).not.toMatch(/cloudflarestorage\.com/);
            expect(output).not.toContain('<img');
        });

        test('inert mode renders card without click handlers (share-chat surface)', () => {
            const input = `<a href="${SAMPLE_URL}">x</a>`;
            const output = R2LinkRender.replaceR2Links(input, { interactive: false });
            expect(output).toContain('r2-inert');
            expect(output).not.toContain('previewAttachment');
            expect(output).not.toContain('downloadAttachment');
            expect(output).not.toMatch(/cloudflarestorage\.com/);
        });

        test('legacy R2 URL (no fileId) falls back to muted chip — still openable', () => {
            const legacy = 'https://x.r2.cloudflarestorage.com/bucket/random/foo.pdf?sig=abc';
            const input = `<a href="${legacy}">file</a>`;
            const output = R2LinkRender.replaceR2Links(input);
            expect(output).toContain('r2-legacy-chip');
            expect(output).toContain(legacy.replace(/&/g, '&amp;'));
        });

        test('non-R2 links pass through untouched', () => {
            const input = '<a href="https://example.com/report.pdf">report</a> and <p>text</p>';
            const output = R2LinkRender.replaceR2Links(input);
            expect(output).toBe(input);
        });

        test('handles null / empty / non-string input gracefully', () => {
            expect(R2LinkRender.replaceR2Links('')).toBe('');
            expect(R2LinkRender.replaceR2Links(null)).toBe(null);
            expect(R2LinkRender.replaceR2Links(undefined)).toBe(undefined);
        });

        test('card onclick handlers do not leak the original URL', () => {
            const input = `<a href="${SAMPLE_URL}">file</a>`;
            const output = R2LinkRender.replaceR2Links(input);
            expect(output).toContain('previewAttachment');
            expect(output).toContain('downloadAttachment');
            expect(output).not.toMatch(/X-Amz/);
        });
    });
});
