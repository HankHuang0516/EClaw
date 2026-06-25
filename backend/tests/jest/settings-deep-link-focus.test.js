/**
 * settings-deep-link.js — APP entry-button focus map.
 *
 * The Android/iOS APP opens settings.html with `?focus=<key>` (e.g.
 * ?focus=channel-api or ?focus=kanban-nudge) so a single button jumps the
 * user to the right card without scrolling past unrelated sections.
 *
 * Regression guard: PR #2294 / commit 7ac88746 introduced an inline
 * `function applyDeepLinkFocus()` in settings.html that shadowed
 * window.applyDeepLinkFocus from this file (function declarations hoist
 * into local scope), silently breaking both APP entry buttons. The
 * companion test in settings-prompt-policy-dashboard.test.js asserts the
 * shadow is gone — this test pins the FOCUS_MAP keys themselves so a
 * future rename on either end (APP query-string vs. settings-deep-link.js)
 * still surfaces here.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DEEP_LINK_JS = path.resolve(__dirname, '../../public/shared/settings-deep-link.js');

function loadDeepLink(url) {
    const src = fs.readFileSync(DEEP_LINK_JS, 'utf8');
    const sandbox = {
        window: { location: new URL(url) },
        document: {
            getElementById: () => null,
            querySelectorAll: () => [],
            body: { setAttribute: () => {} },
        },
    };
    sandbox.window.document = sandbox.document;
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return sandbox.window;
}

describe('settings-deep-link FOCUS_MAP — APP entry buttons', () => {
    test('exposes channel-api, kanban-nudge, and action request keys', () => {
        const w = loadDeepLink('https://example.com/portal/settings.html');
        expect(Array.isArray(w.SETTINGS_DEEP_LINK_KEYS)).toBe(true);
        expect(w.SETTINGS_DEEP_LINK_KEYS).toEqual(
            expect.arrayContaining(['channel-api', 'kanban-nudge', 'action_requests', 'action-requests'])
        );
    });

    test('applyDeepLinkFocus is exported on window', () => {
        const w = loadDeepLink('https://example.com/portal/settings.html');
        expect(typeof w.applyDeepLinkFocus).toBe('function');
    });

    test('applyDeepLinkFocus returns false when key is missing', () => {
        const w = loadDeepLink('https://example.com/portal/settings.html');
        expect(w.applyDeepLinkFocus()).toBe(false);
    });

    test('applyDeepLinkFocus returns false for unknown key (graceful fallback)', () => {
        const w = loadDeepLink('https://example.com/portal/settings.html?focus=does-not-exist');
        expect(w.applyDeepLinkFocus()).toBe(false);
    });
});
