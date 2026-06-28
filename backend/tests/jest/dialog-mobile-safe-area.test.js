/**
 * Regression guard for the mobile destructive-confirm bottom-sheet safe-area inset.
 *
 * Card: card_9eaab012ab5c5eb71489be62 (destructive-modals daily E2E Phase-2 finding,
 * parent card_d6eb7b8892b6380bb37d0931).
 *
 * The shared showConfirm() dialog becomes a bottom-sheet on mobile
 * (`@media (max-width: 768px)`, `.dialog-overlay{align-items:flex-end}`), so its
 * bottommost element — the destructive primary action — sits flush against the
 * screen bottom. Without `env(safe-area-inset-bottom)` padding it overlaps the
 * iPhone home-indicator / Android gesture bar on notched devices. Playwright's
 * 0px-inset headless viewport cannot catch this, so this static CSS guard keeps
 * the fix from silently regressing.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const cssPath = path.join(__dirname, '..', '..', 'public', 'portal', 'shared', 'style.css');
const css = fs.readFileSync(cssPath, 'utf8');

// The mobile bottom-sheet rules live right after this stable marker comment.
const MARKER = '/* Dialog — mobile bottom-sheet */';

describe('mobile destructive bottom-sheet — safe-area-inset-bottom guard', () => {
    test('the mobile bottom-sheet section exists', () => {
        expect(css).toContain(MARKER);
    });

    test('the mobile .dialog rule pads its bottom by the safe-area inset', () => {
        const seg = css.split(MARKER)[1] || '';
        const dialogRule = (seg.match(/\.dialog\s*\{[^}]*\}/) || [''])[0];
        expect(dialogRule).not.toBe('');
        // floor at the normal 16px, grow to the device safe-area inset
        expect(dialogRule).toMatch(/padding-bottom:\s*max\(\s*16px\s*,\s*env\(safe-area-inset-bottom\)\s*\)/);
    });
});
