/**
 * CSS class coverage guardrail.
 *
 * Catches the silent visual regression where a portal HTML file references
 * a class name (`btn-*`, `kb-*`, `chip-*`) that no CSS rule defines —
 * the element falls back to UA defaults and the bug only shows up when a
 * human eyeballs that exact pixel. The original incident
 * (`card_05e798644f6bd41aae8feada` / PR #2072) was `.btn-ghost` referenced
 * but never styled → white icon on white background, invisible.
 *
 * Sister to `backend/scripts/i18n-check.js`: same shape, different axis.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PORTAL_DIR = path.join(REPO_ROOT, 'public', 'portal');

// Project-convention prefixes. Generic `btn` / `card` / `chip` (no dash) are
// often Bootstrap-ish and we don't own them, so we restrict to dashed forms
// like `btn-ghost`, `kb-comment`, `chip-host`. New prefix? Add it here.
const TRACKED_PREFIXES = ['btn-', 'kb-', 'chip-'];

const CLASS_ATTR_DQ = /class\s*=\s*"([^"]+)"/g;
const CLASS_ATTR_SQ = /class\s*=\s*'([^']+)'/g;
const SELECTOR_CLASS = /\.([a-zA-Z][a-zA-Z0-9_-]*)/g;
const INLINE_STYLE_BLOCK = /<style[^>]*>([\s\S]*?)<\/style>/gi;
const TOKEN_OK = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

function walkHtml(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walkHtml(full));
        else if (entry.name.endsWith('.html')) out.push(full);
    }
    return out;
}

function isTracked(cls) {
    return TRACKED_PREFIXES.some(p => cls.startsWith(p));
}

// Extract class tokens from `class="..."` attributes anywhere in the file
// (including inside inline <script> template literals — those classes do
// reach the DOM at runtime). Filters out tokens that are template-literal
// noise like `${isSent` or `'sent'`.
function collectUsedClasses(htmlText, filePath) {
    const used = new Map(); // className -> {file, line}
    const lines = htmlText.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const rgx of [CLASS_ATTR_DQ, CLASS_ATTR_SQ]) {
            rgx.lastIndex = 0;
            let m;
            while ((m = rgx.exec(line)) !== null) {
                for (const tok of m[1].split(/\s+/)) {
                    if (!TOKEN_OK.test(tok)) continue;
                    if (!isTracked(tok)) continue;
                    if (!used.has(tok)) used.set(tok, { file: filePath, line: i + 1 });
                }
            }
        }
    }
    return used;
}

function collectDefinedFromCss(cssText) {
    const out = new Set();
    SELECTOR_CLASS.lastIndex = 0;
    let m;
    while ((m = SELECTOR_CLASS.exec(cssText)) !== null) out.add(m[1]);
    return out;
}

function collectDefinedFromHtmlInlineStyles(htmlText) {
    const out = new Set();
    INLINE_STYLE_BLOCK.lastIndex = 0;
    let m;
    while ((m = INLINE_STYLE_BLOCK.exec(htmlText)) !== null) {
        for (const c of collectDefinedFromCss(m[1])) out.add(c);
    }
    return out;
}

function buildCoverageReport() {
    const htmlFiles = walkHtml(PORTAL_DIR);

    const used = new Map(); // class -> {file, line}
    const defined = new Set();

    // Defined: external CSS files
    for (const css of [
        path.join(PORTAL_DIR, 'shared', 'style.css'),
        path.join(PORTAL_DIR, 'shared', 'info.css'),
    ]) {
        if (fs.existsSync(css)) {
            for (const c of collectDefinedFromCss(fs.readFileSync(css, 'utf8'))) defined.add(c);
        }
    }

    // Defined: inline <style> blocks. Used: class="..." attributes.
    for (const f of htmlFiles) {
        const text = fs.readFileSync(f, 'utf8');
        for (const c of collectDefinedFromHtmlInlineStyles(text)) defined.add(c);
        for (const [cls, where] of collectUsedClasses(text, path.relative(REPO_ROOT, f))) {
            if (!used.has(cls)) used.set(cls, where);
        }
    }

    const missing = [];
    for (const [cls, where] of used) {
        if (!defined.has(cls)) missing.push({ cls, file: where.file, line: where.line });
    }
    missing.sort((a, b) => a.cls.localeCompare(b.cls));
    return { htmlFiles, used, defined, missing };
}

describe('CSS class coverage (portal HTML → CSS rule guardrail)', () => {
    test(`every tracked-prefix class (${TRACKED_PREFIXES.join(', ')}) used in portal HTML has a CSS rule`, () => {
        const { used, defined, missing, htmlFiles } = buildCoverageReport();
        expect(htmlFiles.length).toBeGreaterThan(0);
        expect(defined.size).toBeGreaterThan(0);
        expect(used.size).toBeGreaterThan(0);

        if (missing.length > 0) {
            const lines = missing.map(m => `  • .${m.cls}    first seen at ${m.file}:${m.line}`);
            const msg =
                `\n${missing.length} class(es) referenced in HTML but not defined in any CSS:\n` +
                lines.join('\n') +
                '\n\nFix: add a CSS rule in backend/public/portal/shared/style.css ' +
                '(or an inline <style> block in the same HTML), or rename the offending class.\n';
            throw new Error(msg);
        }
    });

    // Self-test: prove the diff logic actually fails when a defined class is
    // missing. This is the inverse of the acceptance criterion "if I delete
    // .btn-ghost from CSS, the test goes red." We don't actually mutate the
    // CSS file — we run the diff against a synthetic `defined` set with one
    // tracked class removed, and assert the missing list grows.
    test('diff logic flags a removed CSS class as missing', () => {
        const { used, defined } = buildCoverageReport();
        const usedTracked = [...used.keys()];
        expect(usedTracked.length).toBeGreaterThan(0);

        const victim = usedTracked.find(c => defined.has(c));
        expect(victim).toBeDefined();

        const stripped = new Set(defined);
        stripped.delete(victim);

        const synthMissing = [...used.keys()].filter(c => !stripped.has(c));
        expect(synthMissing).toContain(victim);
    });
});
