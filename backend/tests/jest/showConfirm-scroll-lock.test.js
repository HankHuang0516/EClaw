/**
 * Static invariant test for the modal body scroll-lock fix.
 * Card: card_ba264f85559f28afaddefab3 (P1; found by destructive-modals daily E2E
 * card_c60bd4e0 — .eclaw-confirm-overlay open did not lock body scroll on mobile).
 *
 * jest.config.js uses testEnvironment: 'node', so (matching the sibling
 * showConfirm-danger-default-focus test) we lock the SOURCE surface: any edit
 * that drops the lock/unlock wiring silently regresses the fix. Runtime behaviour
 * (scrollTo is a no-op while a confirm is open, restored on close) is covered by
 * the cross-surface E2E + the destructive-modals daily E2E.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const apiJs = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'shared', 'api.js'),
    'utf8'
);

describe('modal body scroll-lock (showConfirm / showPrompt)', () => {
    test('defines a ref-counted lock helper that sets body overflow hidden', () => {
        expect(apiJs).toMatch(/function\s+_eclawLockBodyScroll\s*\(/);
        expect(apiJs).toMatch(/document\.body\.style\.overflow\s*=\s*['"]hidden['"]/);
        // ref count so stacked dialogs don't unlock prematurely
        expect(apiJs).toMatch(/_eclawScrollLockCount\s*\+\+/);
    });

    test('defines an unlock helper that restores the prior overflow on the last close', () => {
        expect(apiJs).toMatch(/function\s+_eclawUnlockBodyScroll\s*\(/);
        expect(apiJs).toMatch(/document\.body\.style\.overflow\s*=\s*_eclawPrevBodyOverflow/);
        expect(apiJs).toMatch(/_eclawScrollLockCount\s*--/);
    });

    test('showConfirm locks on open and unlocks in cleanup', () => {
        // lock call must appear, and the confirm cleanup (keydown _keyHandler) must unlock.
        expect(apiJs).toMatch(/_eclawLockBodyScroll\(\)/);
        expect(apiJs).toMatch(
            /removeEventListener\('keydown',\s*_keyHandler,\s*true\);\s*overlay\.remove\(\);\s*_eclawUnlockBodyScroll\(\)/
        );
    });

    test('showPrompt also unlocks in cleanup (same bug class fixed together)', () => {
        expect(apiJs).toMatch(
            /removeEventListener\('keydown',\s*_escHandler,\s*true\);\s*overlay\.remove\(\);\s*_eclawUnlockBodyScroll\(\)/
        );
    });

    test('lock count guards against negative underflow', () => {
        expect(apiJs).toMatch(/if\s*\(\s*_eclawScrollLockCount\s*===\s*0\s*\)\s*return/);
    });
});
