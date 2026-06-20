/**
 * Static invariant test for the destructive-confirm modal entrance animation.
 *
 * Card: card_e5c460fbe8cb77d711d4523b (P3) — pure-CSS mount entrance for the
 * shared `showConfirm` / `showPrompt` modal: a backdrop fade on
 * `.eclaw-confirm-overlay` + an opacity/scale rise on `.eclaw-confirm-dialog`,
 * BOTH gated behind `@media (prefers-reduced-motion: reduce)` → no animation.
 *
 * jest.config.js uses testEnvironment: 'node', so (matching the sibling
 * showConfirm-*.test.js files) these assertions grep the injected CSS in the
 * source rather than running a JSDOM render. A future edit that drops the
 * keyframes, the animation property, or the reduced-motion gate fails here.
 *
 * The two acceptance behaviours map to two source facts:
 *   1. animation present (≤200ms fade+scale)  → keyframes + `animation:` shorthand
 *   2. prefers-reduced-motion:reduce → instant → `@media (...) { animation: none }`
 */
'use strict';

const fs = require('fs');
const path = require('path');

const apiJs = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'shared', 'api.js'),
    'utf8'
);

// Isolate the injected <style> string so the reduced-motion assertions can't be
// satisfied by unrelated CSS elsewhere in the file.
const styleBlockMatch = apiJs.match(/_eclawEnsureDialogAnimStyle[\s\S]*?document\.head\.appendChild\(style\)/);

describe('showConfirm — entrance animation (card_e5c460fb)', () => {
    test('a one-time animation <style> injector exists and is idempotent', () => {
        // Guarded by a stable id so re-opening the modal does not append a 2nd
        // <style>; injector is a no-op when the node already exists.
        expect(apiJs).toMatch(/function\s+_eclawEnsureDialogAnimStyle\s*\(/);
        expect(apiJs).toMatch(/getElementById\(_ECLAW_DIALOG_ANIM_STYLE_ID\)/);
        expect(apiJs).toMatch(/_ECLAW_DIALOG_ANIM_STYLE_ID\s*=\s*['"]eclaw-confirm-anim-style['"]/);
    });

    test('injector is invoked before the overlay is mounted (both modals)', () => {
        // showConfirm + showPrompt both share .eclaw-confirm-* classes; the
        // call must precede appendChild so the keyframe runs on mount. Two
        // render sites → injector referenced at least twice.
        const calls = apiJs.match(/_eclawEnsureDialogAnimStyle\(\);\s*\n\s*document\.body\.appendChild\(overlay\)/g) || [];
        expect(calls.length).toBeGreaterThanOrEqual(2);
    });

    test('keyframes define a backdrop fade and an opacity+scale dialog rise', () => {
        expect(styleBlockMatch).not.toBeNull();
        const css = styleBlockMatch[0];
        // Overlay backdrop opacity fade.
        expect(css).toMatch(/@keyframes\s+eclawConfirmOverlayIn\s*\{[^}]*opacity:\s*0[^}]*\}/);
        // Dialog: opacity 0→1 AND transform scale(0.96)→1.
        expect(css).toMatch(/@keyframes\s+eclawConfirmDialogIn\s*\{[\s\S]*?opacity:\s*0;\s*transform:\s*scale\(0\.96\)/);
        expect(css).toMatch(/transform:\s*scale\(1\)/);
    });

    test('animation property is wired to the eclaw-confirm-* classes (≤200ms)', () => {
        const css = styleBlockMatch[0];
        // Overlay + dialog each get the keyframe via the `animation` shorthand.
        expect(css).toMatch(/\.eclaw-confirm-overlay\s*\{\s*animation:\s*eclawConfirmOverlayIn\s+160ms\s+ease-out/);
        expect(css).toMatch(/\.eclaw-confirm-dialog\s*\{\s*animation:\s*eclawConfirmDialogIn\s+160ms\s+ease-out/);
        // Duration must satisfy acceptance #1 (entrance ≤200ms).
        const durs = [...css.matchAll(/animation:[^;]*?(\d+)ms/g)].map((m) => Number(m[1]));
        expect(durs.length).toBeGreaterThanOrEqual(2);
        durs.forEach((d) => expect(d).toBeLessThanOrEqual(200));
    });

    test('prefers-reduced-motion:reduce disables BOTH animations (instant)', () => {
        // Acceptance #2: opt-out users get animation:none on overlay AND dialog.
        const css = styleBlockMatch[0];
        const rmMatch = css.match(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{([\s\S]*?)\}/);
        expect(rmMatch).not.toBeNull();
        const rmBody = rmMatch[1];
        expect(rmBody).toMatch(/\.eclaw-confirm-overlay/);
        expect(rmBody).toMatch(/\.eclaw-confirm-dialog/);
        expect(rmBody).toMatch(/animation:\s*none/);
    });

    test('a11y + dismiss contract untouched (no regression)', () => {
        // Cheap guard so this CSS-only card cannot have quietly dropped the
        // verified-good behaviours while editing the same function.
        expect(apiJs).toMatch(/role="alertdialog"/);
        expect(apiJs).toMatch(/aria-modal="true"/);
        expect(apiJs).toMatch(/if\s*\(\s*e\.key\s*===\s*['"]Escape['"]\s*\)\s*cleanup\(\s*false\s*\)/);
        expect(apiJs).toMatch(/btn-danger/);
    });
});
