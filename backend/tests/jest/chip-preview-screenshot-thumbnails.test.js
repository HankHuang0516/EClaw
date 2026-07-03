/**
 * Task-card CHIP popover — screenshot / attachment thumbnail block (regression).
 *
 * Regression (owner Hank): 「任務子卡的 chip 往下滑要能顯示該卡的截圖欄位以及縮圖，
 * 很久以前這個功能還在，不知為何突然消失，需要避免此問題再次發生」= the task
 * sub-card CHIP popover, when scrolled/expanded, must show that card's
 * screenshot/attachment field + thumbnails. The chip fetches GET
 * /api/mission/card/:id (payload carries `card.files[]`), and the full kanban
 * modal already renders those images as a thumbnail grid + lightbox — but the
 * chip popover (autolink-chip-preview.js buildContentHtml) shipped WITHOUT the
 * block, so scrolling the chip never revealed the screenshots. This test pins
 * the restored block so it can never silently vanish again.
 *
 * We EXECUTE the private `buildScreenshotBlockHtml()` (extracted from
 * autolink-chip-preview.js via the brace-count + `new Function` harness the
 * sibling chat-action-request-independent-resolve.test.js uses) since the
 * module IIFE has no export for it.
 *
 * FAIL-ON-OLD: the pre-fix source has no `buildScreenshotBlockHtml` function
 * and its `buildContentHtml` render string never references
 * `chip-popover-thumbs` — so `extractFunction('buildScreenshotBlockHtml')`
 * throws (test 0) and the source-text assertion (last test) fails on old code.
 * Both PASS after the fix.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CHIP_SRC = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'shared', 'autolink-chip-preview.js'),
    'utf8'
);

// Brace-count extractor (same shape as chat-action-request-independent-resolve.test.js).
function extractFunction(src, name) {
    const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g');
    const m = re.exec(src);
    if (!m) throw new Error(`function ${name} not found in autolink-chip-preview.js`);
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    return src.slice(m.index, i);
}

// Build a runnable copy of buildScreenshotBlockHtml with its two collaborators
// (escapeHtml, t) supplied. escapeHtml mirrors the module's textContent-based
// implementation without needing a DOM.
function makeBuilder() {
    const escapeHtml = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const t = (key, fallback) => fallback; // exercise the i18n fallback path
    const body = extractFunction(CHIP_SRC, 'buildScreenshotBlockHtml');
    const factory = new Function('escapeHtml', 't', `${body}\n return buildScreenshotBlockHtml;`);
    return factory(escapeHtml, t);
}

const IMG = (over) => Object.assign({
    fileId: 'f_1', filename: 'shot.png', url: 'https://cdn.example/shot.png?sig=abc', mimeType: 'image/png',
}, over || {});

describe('chip popover screenshot-thumbnail block', () => {
    // Built lazily inside each test so that on PRE-FIX code (where
    // buildScreenshotBlockHtml is absent) each test reports a clean failure
    // instead of the whole suite erroring at load time.
    let buildScreenshotBlockHtml;
    beforeAll(() => { buildScreenshotBlockHtml = makeBuilder(); });

    test('renders a thumbnail grid for image files on the card', () => {
        const html = buildScreenshotBlockHtml({ files: [IMG(), IMG({ fileId: 'f_2', filename: 'two.jpg', url: 'https://cdn.example/two.jpg', mimeType: 'image/jpeg' })] });
        expect(html).toMatch(/chip-popover-shots/);
        expect(html).toMatch(/chip-popover-thumbs/);
        // one <img> per image file, wrapped in a clickable enlarge anchor
        expect((html.match(/<img /g) || []).length).toBe(2);
        expect(html).toMatch(/class="chip-popover-thumb"/);
        expect(html).toMatch(/data-action="thumb"/);
        expect(html).toContain('https://cdn.example/shot.png?sig=abc');
        expect(html).toContain('https://cdn.example/two.jpg');
        // count badge reflects the number of screenshots
        expect(html).toMatch(/chip-popover-shots-count">2</);
        expect(html).toMatch(/help-icon chip-popover-shots-help/);
        expect(html).toMatch(/data-help-content-key="chip_popover_screenshots_help"/);
        expect(html).toMatch(/aria-label="Screenshot field help"/);
    });

    test('renders nothing when the card has no image files', () => {
        expect(buildScreenshotBlockHtml({ files: [] })).toBe('');
        expect(buildScreenshotBlockHtml({})).toBe('');
        expect(buildScreenshotBlockHtml({ files: null })).toBe('');
        // non-image attachments (pdf/log) are excluded — only screenshots show
        const pdfOnly = buildScreenshotBlockHtml({ files: [{ fileId: 'p', filename: 'a.pdf', url: 'https://x/a.pdf', mimeType: 'application/pdf' }] });
        expect(pdfOnly).toBe('');
    });

    test('mixes image + non-image: only images render as thumbnails', () => {
        const html = buildScreenshotBlockHtml({ files: [
            IMG(),
            { fileId: 'l', filename: 'run.log', url: 'https://x/run.log', mimeType: 'text/plain' },
        ] });
        expect((html.match(/<img /g) || []).length).toBe(1);
    });

    test('supports the snake_case mime_type field shape too', () => {
        const html = buildScreenshotBlockHtml({ files: [{ fileId: 'f', filename: 'legacy.png', url: 'https://x/legacy.png', mime_type: 'image/png' }] });
        expect(html).toMatch(/chip-popover-thumbs/);
        expect((html.match(/<img /g) || []).length).toBe(1);
    });

    test('XSS-safe: malicious filename/url are HTML-escaped (no live injection)', () => {
        const html = buildScreenshotBlockHtml({ files: [IMG({
            filename: '"><img src=x onerror=alert(1)>evil',
            url: 'https://cdn/x.png"><script>alert(2)</script>',
        })] });
        // The injected markup must be neutralised: no live <script> tag, no
        // attribute break-out (all payload <, >, " are entity-encoded so the
        // browser never re-parses them as markup). The literal text
        // "onerror=alert(1)" may remain as inert, fully-escaped attribute text.
        expect(html).not.toContain('<script>');
        expect(html).not.toContain('><img src=x onerror'); // no attribute break-out
        expect(html).toContain('&lt;script&gt;');          // payload angle brackets encoded
        expect(html).toContain('&quot;');                  // payload quotes encoded
        // Every emitted tag is one of ours (div/span/a/img) — no injected tag.
        const tags = (html.match(/<([a-zA-Z][a-zA-Z0-9]*)/g) || []).map(s => s.slice(1).toLowerCase());
        expect(tags.every(tg => ['div', 'span', 'a', 'img', 'svg', 'circle', 'path', 'line'].includes(tg))).toBe(true);
    });

    test('skips files that lack a usable url', () => {
        const html = buildScreenshotBlockHtml({ files: [IMG({ url: '' }), IMG({ url: null })] });
        expect(html).toBe('');
    });
});

describe('chip popover render wiring (source-text guard)', () => {
    test('buildContentHtml injects the screenshot block into the popover body', () => {
        // This guard FAILS on the pre-fix source: buildContentHtml never
        // referenced the screenshot block, so removing/omitting it recurs.
        const body = extractFunction(CHIP_SRC, 'buildContentHtml');
        expect(body).toMatch(/buildScreenshotBlockHtml\(/);
        expect(body).toMatch(/screenshotsHtml/);
    });

    test('thumbnail click is wired to enlarge (data-action="thumb" handled)', () => {
        expect(CHIP_SRC).toMatch(/action === 'thumb'/);
        // prefers a host-page lightbox, falls back to native <a target=_blank>
        expect(CHIP_SRC).toMatch(/window\.openLightbox/);
    });

    test('renders the ? spec-tooltip help icon instead of leaving the affordance as a TODO', () => {
        const body = extractFunction(CHIP_SRC, 'buildScreenshotBlockHtml');
        expect(body).toMatch(/chip-popover-shots-help/);
        expect(body).toMatch(/data-help-content-key="chip_popover_screenshots_help"/);
        expect(body).not.toMatch(/TODO\(#6\)/);
    });
});
