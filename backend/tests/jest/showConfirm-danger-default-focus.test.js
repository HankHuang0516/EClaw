/**
 * Static invariant test for the destructive-confirm safe-default-focus fix.
 *
 * Card: card_31cbbcd885097364f19cbd40 (P0, Phase 2 finding from the
 * destructive-modals daily E2E parent card_d7824a8f6ab6b3f20bad73aa).
 *
 * jest.config.js uses testEnvironment: 'node' so a true JSDOM behaviour
 * assertion is not possible without adding a test-only dep. Instead we
 * lock the surface here: any future edit that removes the danger-aware
 * focus selector or the Enter-while-danger short-circuit silently
 * regresses the safety invariant.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const apiJs = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'shared', 'api.js'),
    'utf8'
);

describe('showConfirm — destructive-modal safe default focus', () => {
    test('focuses Cancel button when danger=true', () => {
        // The selector must branch on `danger` so a stray Enter / Space on
        // an automatically-focused element does not commit the destructive
        // action. See card_31cbbcd885097364f19cbd40 and Material Design /
        // Apple HIG guidance for destructive confirms.
        expect(apiJs).toMatch(
            /danger\s*\?\s*['"]\.eclaw-confirm-cancel['"]\s*:\s*['"]\.eclaw-confirm-ok['"]/
        );
    });

    test('Enter on a destructive confirm commits ONLY when Confirm is focused (stray Enter cancels)', () => {
        // WAI-ARIA APG: a focused button reacts to Enter and Space identically.
        // Danger Enter falls through to the Confirm button's native activation
        // ONLY when it is the active element; when focus is on Cancel or the
        // safe default, a stray Enter still resolves false. The danger branch
        // must therefore guard cleanup(false) on the "not the OK button" check
        // and must NOT unconditionally cleanup(true). Behaviour verified live
        // via Playwright (Enter@Confirm->true, Enter@Cancel->false, Space@Confirm->true);
        // card_d2506588cee92488f50cbe5e.
        expect(apiJs).toMatch(
            /document\.activeElement\s*!==\s*overlay\.querySelector\(\s*['"]\.eclaw-confirm-ok['"]\s*\)[\s\S]{0,80}cleanup\(\s*false\s*\)/
        );
    });

    test('Esc still cancels regardless of danger flag', () => {
        // Esc behaviour is unchanged — danger-aware focus must not break
        // the universal Esc-dismisses contract.
        expect(apiJs).toMatch(/if\s*\(\s*e\.key\s*===\s*['"]Escape['"]\s*\)\s*cleanup\(\s*false\s*\)/);
    });

    test('non-danger confirm keeps Enter=confirm ergonomics', () => {
        // Non-destructive dialogs keep the snappy OK-flow: Enter resolves true.
        expect(apiJs).toMatch(/if\s*\(\s*!danger\s*\)\s*\{\s*cleanup\(\s*true\s*\)\s*;?\s*\}/);
    });
});
