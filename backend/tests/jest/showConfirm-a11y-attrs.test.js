/**
 * Static invariant test for the destructive-confirm ARIA + focus-trap fix.
 *
 * Card: card_52ae49385e30e692075efb13 (P2, Phase 2 finding from the
 * destructive-modals daily E2E parent card_d7824a8f6ab6b3f20bad73aa).
 *
 * jest.config.js uses testEnvironment: 'node' so the assertions grep the
 * source rather than running a JSDOM render. Future edits that drop any
 * of the ARIA contract or focus-trap helper silently break the safety
 * invariant; this file fails the suite when that happens.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const apiJs = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'shared', 'api.js'),
    'utf8'
);

describe('showConfirm — ARIA dialog + focus trap', () => {
    test('dialog renders role="alertdialog"', () => {
        // role=alertdialog (not just dialog) because destructive confirms
        // need the stronger AT semantic. WAI-ARIA APG dialog-modal pattern.
        expect(apiJs).toMatch(/role="alertdialog"/);
    });

    test('dialog renders aria-modal="true"', () => {
        // aria-modal=true so assistive tech blocks interaction with content
        // behind the overlay.
        expect(apiJs).toMatch(/aria-modal="true"/);
    });

    test('dialog wires aria-labelledby to a generated title id', () => {
        // Auto-generated id on .dialog-title + aria-labelledby on the
        // dialog so screen readers announce the dialog name (the title)
        // when it appears.
        expect(apiJs).toMatch(/aria-labelledby="\$\{titleId\}"/);
        expect(apiJs).toMatch(/id="\$\{titleId\}"/);
        expect(apiJs).toMatch(/eclaw-confirm-title-\$\{\+\+_eclawDialogId\}/);
    });

    test('title-less variant falls back to aria-label using message text', () => {
        // When the caller omits `title`, we cannot use aria-labelledby — fall
        // back to aria-label on the dialog itself using the escaped message.
        expect(apiJs).toMatch(/aria-label="\$\{_escAttr\(message\)\}"/);
    });

    test('focus trap wraps Tab and Shift+Tab between Cancel and OK', () => {
        // Tab from OK wraps to Cancel; Shift+Tab from Cancel wraps to OK.
        // Without this, Tab leaks to background elements behind the modal
        // and Hank could activate a destructive control on the page below.
        expect(apiJs).toMatch(/e\.key\s*===\s*['"]Tab['"]/);
        expect(apiJs).toMatch(/e\.shiftKey\s*&&\s*active\s*===\s*cancel/);
        expect(apiJs).toMatch(/!e\.shiftKey\s*&&\s*active\s*===\s*ok/);
        expect(apiJs).toMatch(/e\.preventDefault\(\);\s*ok\.focus\(\)/);
        expect(apiJs).toMatch(/e\.preventDefault\(\);\s*cancel\.focus\(\)/);
    });

    test('Esc still cancels regardless of the new ARIA wiring', () => {
        // Universal dismiss contract preserved.
        expect(apiJs).toMatch(/if\s*\(\s*e\.key\s*===\s*['"]Escape['"]\s*\)\s*cleanup\(\s*false\s*\)/);
    });

    test('module-level counter exists so each open dialog gets a unique id', () => {
        // Avoids id collisions when multiple confirms could be open back-to-back
        // (or the dialog is opened, dismissed, opened again in quick succession).
        expect(apiJs).toMatch(/let\s+_eclawDialogId\s*=\s*0/);
    });
});
