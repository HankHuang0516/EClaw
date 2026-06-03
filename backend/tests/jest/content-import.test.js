/**
 * Tests for backend/public/shared/content-import.js — the URL / portal /
 * AX-tree dispatcher used by the hover-click toolbar.
 *
 * Spec: docs/specs/a-hover-click-dom-interaction.md §4
 * Card: card_af967715a0ab1724da98dcc2 (Test/P2)
 *
 * Pure-function coverage (isAllowedPublicUrl) only; the dispatcher itself
 * needs a browser DOM and gets exercised in the Playwright E2E suite.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CONTENT_IMPORT_PATH = path.join(
    __dirname, '..', '..', 'public', 'shared', 'content-import.js'
);

function loadContentImport() {
    const fakeWindow = { location: { origin: 'https://eclawbot.com' } };
    global.window = fakeWindow;
    delete require.cache[require.resolve(CONTENT_IMPORT_PATH)];
    require(CONTENT_IMPORT_PATH);
    return fakeWindow.EClawContentImport;
}

describe('content-import — allowlist (deny-on-miss per #6 review Q3)', () => {
    const C = loadContentImport();

    test('eclawbot.com is allowed (with and without subdomain)', () => {
        expect(C.isAllowedPublicUrl('https://eclawbot.com/portal/chat.html')).toBe(true);
        expect(C.isAllowedPublicUrl('http://eclawbot.com/')).toBe(true);
        expect(C.isAllowedPublicUrl('https://api.eclawbot.com/v1')).toBe(true);
    });

    test('example.com fixture is allowed for the v1 demo', () => {
        // Explicit fixture entry. If this ever gets removed, the v1 demo
        // page tests should be updated in lockstep.
        expect(C.isAllowedPublicUrl('https://example.com/anything')).toBe(true);
    });

    test('arbitrary public hosts denied by default', () => {
        expect(C.isAllowedPublicUrl('https://evil.example.org/')).toBe(false);
        expect(C.isAllowedPublicUrl('https://malicious-site.com/redirect')).toBe(false);
        expect(C.isAllowedPublicUrl('https://attacker.eclawbot.com.fake.com/')).toBe(false);
    });

    test('SSRF-class private / loopback addresses blocked client-side', () => {
        expect(C.isAllowedPublicUrl('http://localhost:3000/')).toBe(false);
        expect(C.isAllowedPublicUrl('http://127.0.0.1/admin')).toBe(false);
        expect(C.isAllowedPublicUrl('http://10.0.0.5/internal')).toBe(false);
        expect(C.isAllowedPublicUrl('http://192.168.1.1/router')).toBe(false);
        expect(C.isAllowedPublicUrl('http://172.16.0.1/')).toBe(false);
        expect(C.isAllowedPublicUrl('http://172.20.0.1/')).toBe(false);
        expect(C.isAllowedPublicUrl('http://172.31.255.255/')).toBe(false);
    });

    test('non-http(s) schemes blocked', () => {
        expect(C.isAllowedPublicUrl('file:///etc/passwd')).toBe(false);
        expect(C.isAllowedPublicUrl('javascript:alert(1)')).toBe(false);
        expect(C.isAllowedPublicUrl('data:text/html,<script>')).toBe(false);
        expect(C.isAllowedPublicUrl('ftp://eclawbot.com/')).toBe(false);
    });

    test('malformed URLs do not throw and return false', () => {
        expect(C.isAllowedPublicUrl('not-a-url')).toBe(false);
        expect(C.isAllowedPublicUrl('')).toBe(false);
        expect(C.isAllowedPublicUrl(undefined)).toBe(false);
        expect(C.isAllowedPublicUrl(null)).toBe(false);
    });
});

describe('content-import — static invariants', () => {
    const src = fs.readFileSync(CONTENT_IMPORT_PATH, 'utf8');

    test('AX-tree adapter is stubbed v1 with not-supported error', () => {
        expect(src).toMatch(/spec\.kind\s*===\s*['"]ax['"]/);
        expect(src).toMatch(/import_unsupported_ax_v1/);
    });

    test('CORS proxy path is wired for cross-origin allowed URLs', () => {
        expect(src).toMatch(/\/api\/import\/proxy\?url=/);
    });

    test('iframe sandbox attribute is set (defence in depth)', () => {
        expect(src).toMatch(/setAttribute\(\s*['"]sandbox['"]/);
    });

    test('private IP / localhost / file:// allowlist guards exist', () => {
        expect(src).toMatch(/localhost/);
        // String literal comparison (no backslashes in source for these)
        expect(src).toMatch(/'127\.0\.0\.1'/);
        // Regex char-class style (backslashes in source for these)
        expect(src).toMatch(/192\\\.168/);
        expect(src).toMatch(/\^10\\\./);
    });
});
