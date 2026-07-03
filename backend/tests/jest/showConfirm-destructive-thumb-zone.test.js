/**
 * Static invariant test — destructive-confirm thumb-zone guard.
 *
 * Card: card_3267470a (P3) — on phone viewports the shared `showConfirm(danger)`
 * actions stack full-width vertically, putting the LAST DOM button (the
 * destructive Confirm) at the very bottom = the easiest single-thumb target,
 * directly under Cancel → mis-tap-delete risk.
 *
 * Fix (CSS-only, visual reorder): danger dialogs get an `eclaw-confirm-danger`
 * marker class, and the injected <style> flips ONLY the visual order on phone
 * width via `flex-direction: column-reverse` so the safe Cancel sits in the
 * bottom thumb zone and the destructive button is above it. DOM order is
 * untouched, so tab order / focus trap / safe-default-focus (Cancel) / Esc are
 * all preserved. Scoped to `.eclaw-confirm-danger` + `max-width:480px`, so
 * non-danger dialogs and desktop (side-by-side row) are unaffected.
 *
 * jest.config.js is testEnvironment:'node' → grep the source like the sibling
 * showConfirm-*.test.js files.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const apiJs = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'shared', 'api.js'),
    'utf8'
);

const styleBlock = (apiJs.match(/_eclawEnsureDialogAnimStyle[\s\S]*?document\.head\.appendChild\(style\)/) || [''])[0];

describe('showConfirm — destructive thumb-zone guard (card_3267470a)', () => {
    test('danger dialogs carry an eclaw-confirm-danger marker class; non-danger do not', () => {
        // Marker is appended to the dialog className ONLY when danger is true.
        expect(apiJs).toMatch(/eclaw-confirm-dialog\$\{danger\s*\?\s*['"] eclaw-confirm-danger['"]\s*:\s*['"]['"]\}/);
    });

    test('injected CSS reorders ONLY danger dialogs on phone width (column-reverse)', () => {
        expect(styleBlock).not.toBe('');
        // A phone-width media query.
        expect(styleBlock).toMatch(/@media\s*\(\s*max-width:\s*480px\s*\)/);
        // The reorder rule is scoped to the danger marker + the actions row.
        expect(styleBlock).toMatch(
            /\.eclaw-confirm-dialog\.eclaw-confirm-danger\s+\.dialog-actions\s*\{[^}]*flex-direction:\s*column-reverse/
        );
    });

    test('the reorder is scoped — it never targets non-danger or desktop', () => {
        // Extract the phone media block and assert the reorder rule inside it is
        // gated by .eclaw-confirm-danger (not a bare .dialog-actions that would
        // hit every dialog).
        const mq = styleBlock.match(/@media\s*\(\s*max-width:\s*480px\s*\)\s*\{([\s\S]*?)\}\s*`/);
        expect(mq).not.toBeNull();
        const body = mq[1];
        expect(body).toMatch(/column-reverse/);
        // Every column-reverse rule in the block must be qualified by the danger class.
        const reverseRules = body.match(/[^}]*column-reverse[^}]*\{?/g) || [];
        // Simpler + robust: there is no column-reverse selector that omits the danger marker.
        expect(body).not.toMatch(/(^|[},])\s*\.dialog-actions\s*\{[^}]*column-reverse/);
        expect(body).toMatch(/\.eclaw-confirm-danger\s+\.dialog-actions/);
    });

    test('CSS-only: DOM/tab order unchanged — Cancel button still precedes Confirm in markup', () => {
        // The whole point: reorder is VISUAL. In the DOM, cancel must still be
        // authored before ok so tab order + focus trap logic (Cancel first
        // tabbable, OK last) keep working.
        const cancelIdx = apiJs.indexOf('eclaw-confirm-cancel');
        const okIdx = apiJs.indexOf('eclaw-confirm-ok');
        expect(cancelIdx).toBeGreaterThan(-1);
        expect(okIdx).toBeGreaterThan(-1);
        expect(cancelIdx).toBeLessThan(okIdx);
    });

    test('a11y contract untouched (no regression): safe-default-focus stays on Cancel for danger', () => {
        // danger → focus the cancel button (unchanged by the CSS fix).
        expect(apiJs).toMatch(/const\s+safeBtnSel\s*=\s*danger\s*\?\s*['"]\.eclaw-confirm-cancel['"]/);
        expect(apiJs).toMatch(/role="alertdialog"/);
        expect(apiJs).toMatch(/if\s*\(\s*e\.key\s*===\s*['"]Escape['"]\s*\)\s*cleanup\(\s*false\s*\)/);
        expect(apiJs).toMatch(/btn-danger/);
    });
});
