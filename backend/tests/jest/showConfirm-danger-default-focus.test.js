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

    test('Enter on a destructive confirm does NOT commit', () => {
        // Enter handler must skip cleanup(true) when danger is set. The
        // previous unconditional `cleanup(true)` shipped destructive ops on
        // any keyboard-focused Enter, which violated the safety invariant.
        expect(apiJs).toMatch(/if\s*\(\s*e\.key\s*===\s*['"]Enter['"]\s*\)\s*cleanup\(\s*!danger/);
    });

    test('Esc still cancels regardless of danger flag', () => {
        // Esc behaviour is unchanged — danger-aware focus must not break
        // the universal Esc-dismisses contract.
        expect(apiJs).toMatch(/if\s*\(\s*e\.key\s*===\s*['"]Escape['"]\s*\)\s*cleanup\(\s*false\s*\)/);
    });

    test('non-danger confirm keeps Enter=confirm ergonomics', () => {
        // The fix must preserve the snappy OK-flow for non-destructive
        // dialogs — Enter should still resolve true when danger is falsy.
        // We assert via the same `cleanup(!danger ? true : false)` expression
        // — when danger is false, the inner ternary evaluates to true.
        const enterLine = apiJs.match(/e\.key\s*===\s*['"]Enter['"][^;]*;?/);
        expect(enterLine).not.toBeNull();
        expect(enterLine[0]).toMatch(/!danger\s*\?\s*true\s*:\s*false/);
    });
});
