/**
 * WCAG 2.1 AA contrast invariant for the shared destructive-confirm button.
 *
 * Card: card_a2234cc7
 *
 * `.btn-danger` is the fill behind every irreversible delete/unbind in the
 * portal — the single most safety-critical control. Its white label must
 * keep a contrast ratio of >= 4.5:1 against the button background (WCAG 2.1
 * AA, normal text). The old fill #e53e3e was 4.13:1 and failed.
 *
 * This test reads the *actual* background hex out of style.css and computes
 * the WCAG relative-luminance contrast ratio itself (no hardcoded pass), so
 * it FAILS at #e53e3e (4.13) and PASSES at the darkened #c53030 (5.47).
 *
 * jest.config.js uses testEnvironment: 'node', so we parse the source rather
 * than render it — same static-invariant style as showConfirm-a11y-attrs.test.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const cssPath = path.join(
    __dirname, '..', '..', 'public', 'portal', 'shared', 'style.css'
);
const css = fs.readFileSync(cssPath, 'utf8');

// --- WCAG relative luminance + contrast ratio (self-checking, not hardcoded) ---
// https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
// https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
function channelToLinear(c8) {
    const c = c8 / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) throw new Error(`not a 6-digit hex color: ${hex}`);
    const n = m[1];
    const r = parseInt(n.slice(0, 2), 16);
    const g = parseInt(n.slice(2, 4), 16);
    const b = parseInt(n.slice(4, 6), 16);
    return 0.2126 * channelToLinear(r)
         + 0.7152 * channelToLinear(g)
         + 0.0722 * channelToLinear(b);
}

function contrastRatio(hexA, hexB) {
    const la = relativeLuminance(hexA);
    const lb = relativeLuminance(hexB);
    const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
}

// Pull the `.btn-danger { ... background: #rrggbb ... }` fill out of the CSS.
// We target the scoped destructive-button block (the effective, last-wins rule
// with an explicit `color: #fff` label), not the --danger accent token.
function extractBtnDangerBackground(source) {
    // Match every `.btn-danger { ... }` block (no pseudo-class), take the last
    // one — that is the rule that wins the cascade and is actually rendered.
    const blockRe = /\.btn-danger\s*\{([^}]*)\}/g;
    let match;
    let lastHex = null;
    while ((match = blockRe.exec(source)) !== null) {
        const body = match[1];
        const bg = /background(?:-color)?\s*:\s*(#[0-9a-fA-F]{6})/.exec(body);
        if (bg) lastHex = bg[1];
    }
    return lastHex;
}

describe('.btn-danger — WCAG 2.1 AA contrast', () => {
    test('the WCAG math is correct (sanity anchors: known ratios)', () => {
        // Black on white is the canonical 21:1; white on white is 1:1.
        expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
        expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
        // The OLD failing color must compute to ~4.13 — proves the math would
        // have caught the regression rather than just passing the new color.
        expect(contrastRatio('#ffffff', '#e53e3e')).toBeCloseTo(4.13, 1);
        expect(contrastRatio('#ffffff', '#e53e3e')).toBeLessThan(4.5);
    });

    test('button background is defined in style.css', () => {
        const bg = extractBtnDangerBackground(css);
        expect(bg).toMatch(/^#[0-9a-fA-F]{6}$/);
    });

    test('white label on the button background reaches >= 4.5:1', () => {
        const bg = extractBtnDangerBackground(css);
        const ratio = contrastRatio('#ffffff', bg);
        // Fails at #e53e3e (4.13), passes at #c53030 (5.47).
        expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    test('hover state also stays >= 4.5:1', () => {
        const hover = /\.btn-danger:hover\s*\{[^}]*background(?:-color)?\s*:\s*(#[0-9a-fA-F]{6})/.exec(css);
        expect(hover).not.toBeNull();
        expect(contrastRatio('#ffffff', hover[1])).toBeGreaterThanOrEqual(4.5);
    });

    test('active state (if present) also stays >= 4.5:1', () => {
        const active = /\.btn-danger:active\s*\{[^}]*background(?:-color)?\s*:\s*(#[0-9a-fA-F]{6})/.exec(css);
        if (active) {
            expect(contrastRatio('#ffffff', active[1])).toBeGreaterThanOrEqual(4.5);
        }
    });
});
