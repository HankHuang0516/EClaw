/**
 * Regression coverage for public Info-page regressions reported 2026-05-04:
 * 1. /portal/roadmap.html must remain publicly viewable when /api/auth/me returns 401.
 * 2. /portal/info.html release-note descriptions must render Markdown links safely.
 * 3. Temporary debug endpoint remains available while the production bug is verified.
 */

const fs = require('fs');
const path = require('path');

const PORTAL_DIR = path.resolve(__dirname, '../../public/portal');
const ROADMAP_HTML = path.join(PORTAL_DIR, 'roadmap.html');
const INFO_HTML = path.join(PORTAL_DIR, 'info.html');
const INFO_JS = path.join(PORTAL_DIR, 'shared/info.js');
const MARKDOWN_RENDER_JS = path.join(PORTAL_DIR, 'shared/markdown-render.js');
const INDEX_JS = path.resolve(__dirname, '../../index.js');

function freshMarkdownRenderer({ marked, DOMPurify } = {}) {
    const previousMarked = global.marked;
    const previousDOMPurify = global.DOMPurify;
    delete require.cache[require.resolve(MARKDOWN_RENDER_JS)];
    delete global.renderSafeMarkdownInline;

    if (marked === undefined) delete global.marked;
    else global.marked = marked;

    if (DOMPurify === undefined) delete global.DOMPurify;
    else global.DOMPurify = DOMPurify;

    const mod = require(MARKDOWN_RENDER_JS);

    global.marked = previousMarked;
    global.DOMPurify = previousDOMPurify;
    return mod;
}

describe('roadmap public page auth gate', () => {
    test('roadmap.html probes /api/auth/me without triggering api.js 401 redirect', () => {
        const source = fs.readFileSync(ROADMAP_HTML, 'utf8');
        const pattern = /apiCall\(\s*['"]GET['"]\s*,\s*['"]\/api\/auth\/me['"]\s*,\s*null\s*,\s*\{[^}]*skip401Redirect\s*:\s*true[^}]*\}\s*\)/;
        expect(source).toMatch(pattern);
    });

    test('roadmap.html remains a public page with public nav available', () => {
        const source = fs.readFileSync(ROADMAP_HTML, 'utf8');
        expect(source).toMatch(/shared\/public-nav\.js/);
        expect(source).toMatch(/renderPublicNav/);
    });
});

describe('release notes Markdown rendering', () => {
    test('info.html loads marked, DOMPurify, then the local safe Markdown renderer before info.js', () => {
        const source = fs.readFileSync(INFO_HTML, 'utf8');
        const markedIdx = source.indexOf('marked/marked.min.js');
        const purifyIdx = source.indexOf('dompurify/dist/purify.min.js');
        const rendererIdx = source.indexOf('shared/markdown-render.js');
        const infoIdx = source.indexOf('shared/info.js');

        expect(markedIdx).toBeGreaterThan(-1);
        expect(purifyIdx).toBeGreaterThan(markedIdx);
        expect(rendererIdx).toBeGreaterThan(purifyIdx);
        expect(infoIdx).toBeGreaterThan(rendererIdx);
    });

    test('release-note descriptions call renderSafeMarkdownInline instead of escHtml-only output', () => {
        const source = fs.readFileSync(INFO_JS, 'utf8');
        expect(source).toMatch(/renderSafeMarkdownInline\(ch\.description\)/);
        expect(source).toMatch(/descriptionHtml/);
        expect(source).not.toMatch(/<\/strong>\s*\$\{escHtml\(ch\.description\)\}/);
    });

    test('fallback renderer converts issue Markdown links into safe anchors', () => {
        const { renderSafeMarkdownInline } = freshMarkdownRenderer();
        const html = renderSafeMarkdownInline('Fixes [#504](https://github.com/HankHuang0516/EClaw/issues/504)');

        expect(html).toContain('<a href="https://github.com/HankHuang0516/EClaw/issues/504"');
        expect(html).toContain('target="_blank"');
        expect(html).toContain('rel="noopener noreferrer"');
        expect(html).not.toContain('[#504](');
    });

    test('fallback renderer converts bare parenthesized URLs into safe anchors', () => {
        const { renderSafeMarkdownInline } = freshMarkdownRenderer();
        const html = renderSafeMarkdownInline('(https://github.com/HankHuang0516/EClaw/issues/504)');

        expect(html).toContain('(<a href="https://github.com/HankHuang0516/EClaw/issues/504"');
        expect(html).not.toContain('(https://github.com/HankHuang0516/EClaw/issues/504)');
    });

    test('marked + DOMPurify path is used when CDN libraries are present', () => {
        const marked = { parseInline: jest.fn(() => '<a href="https://example.com">link</a><script>x</script>') };
        const DOMPurify = { sanitize: jest.fn((html) => html.replace(/<script>.*?<\/script>/g, '')) };
        const { renderSafeMarkdownInline } = freshMarkdownRenderer();
        const previousMarked = global.marked;
        const previousDOMPurify = global.DOMPurify;
        try {
            global.marked = marked;
            global.DOMPurify = DOMPurify;

            const html = renderSafeMarkdownInline('[link](https://example.com)');

            expect(marked.parseInline).toHaveBeenCalled();
            expect(DOMPurify.sanitize).toHaveBeenCalled();
            expect(html).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer">link</a>');
            expect(html).not.toContain('<script>');
        } finally {
            global.marked = previousMarked;
            global.DOMPurify = previousDOMPurify;
        }
    });
});

describe('info-public-pages debug endpoint registration', () => {
    test('backend exposes an authenticated temporary debug endpoint for the info public-page bugs', () => {
        const source = fs.readFileSync(INDEX_JS, 'utf8');
        expect(source).toMatch(/app\.get\(['"]\/api\/debug\/info-public-pages['"]/);
        expect(source).toMatch(/authProbeUsesSkip401Redirect/);
        expect(source).toMatch(/releaseRendererCallsMarkdownHelper/);
        expect(source).toMatch(/fallbackHandlesMarkdownLinks/);
    });
});
