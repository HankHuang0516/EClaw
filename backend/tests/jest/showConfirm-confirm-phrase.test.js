/**
 * Static invariant test for the typed-confirmation gate (`confirmPhrase`).
 *
 * Card: card_5abe811101b43db8b0b6c3c9 (Phase 2 finding from the destructive-modals
 * daily E2E, card_2844665909ba97173d71545b) — the most irreversible action in the
 * product (account deletion) previously had no second-confirm modal / typed gate,
 * while 38 trivial deletes used showConfirm({danger}). This adds a shared
 * `confirmPhrase` capability and wires account deletion through it.
 *
 * jest.config.js uses testEnvironment: 'node', so — like the sibling showConfirm
 * static tests — we lock the source surface: any edit that drops the disabled-until-
 * typed gate or the account-deletion wiring silently regresses the safety invariant.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const apiJs = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'shared', 'api.js'),
    'utf8'
);
const deleteAccountHtml = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'delete-account.html'),
    'utf8'
);

describe('showConfirm — typed-confirmation gate (confirmPhrase)', () => {
    test('showConfirm accepts a confirmPhrase option', () => {
        expect(apiJs).toMatch(/function showConfirm\(\{[^}]*confirmPhrase[^}]*\}\s*=\s*\{\}\s*\)/);
    });

    test('needsPhrase is true only for a non-empty trimmed phrase', () => {
        expect(apiJs).toMatch(/needsPhrase\s*=\s*typeof confirmPhrase === ['"]string['"]\s*&&\s*confirmPhrase\.trim\(\)\.length\s*>\s*0/);
    });

    test('Confirm button renders disabled when a phrase gate is present', () => {
        // The OK button must start disabled so a single tap can never commit while the
        // typed phrase is still empty/incorrect.
        expect(apiJs).toMatch(/needsPhrase\s*\?\s*['"] disabled aria-disabled="true"['"]/);
    });

    test('Confirm enables only when the trimmed input exactly matches the phrase', () => {
        expect(apiJs).toMatch(/phraseMatches\s*=\s*\(\)\s*=>\s*!needsPhrase\s*\|\|\s*\(phraseInput\s*&&\s*phraseInput\.value\.trim\(\)\s*===\s*phrase\)/);
        // and the enable/disable is re-synced on every input event
        expect(apiJs).toMatch(/phraseInput\.addEventListener\(\s*['"]input['"]/);
        expect(apiJs).toMatch(/okBtn\.disabled\s*=\s*!phraseMatches\(\)/);
    });

    test('the click handler refuses to commit while OK is disabled', () => {
        expect(apiJs).toMatch(/okBtn\.addEventListener\(\s*['"]click['"][\s\S]{0,40}if\s*\(\s*!okBtn\.disabled\s*\)\s*cleanup\(\s*true\s*\)/);
    });

    test('Enter inside the phrase input commits only when the phrase matches', () => {
        expect(apiJs).toMatch(/document\.activeElement\s*===\s*phraseInput[\s\S]{0,400}if\s*\(phraseMatches\(\)\)\s*cleanup\(\s*true\s*\)/);
    });

    test('account deletion is wired through the typed-confirm gate (confirmPhrase: DELETE)', () => {
        expect(deleteAccountHtml).toMatch(/showConfirm\(\{[\s\S]{0,220}confirmPhrase:\s*['"]DELETE['"]/);
        // and it aborts the DELETE when the gate is not confirmed
        expect(deleteAccountHtml).toMatch(/if\s*\(\s*!confirmed\s*\)\s*return\s*;/);
    });
});
