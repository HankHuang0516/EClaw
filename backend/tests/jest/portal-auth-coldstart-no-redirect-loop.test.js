/**
 * Portal auth — backend cold-start / rate-limit must NOT redirect-loop.
 *
 * Incident 2026-06-27 (Hank: "儀表板目前崩潰loop"): after a Railway redeploy the
 * backend returns 503 "Server starting up" (and 429 under the dashboard's load
 * fan-out) for ~30-60s. shared/auth.js `checkAuth()` treated that thrown error
 * as an AUTH failure and did `window.location.href = 'index.html'`. The login
 * page re-runs checkAuth, hits the same 503, redirects to itself again → an
 * infinite redirect/reload CRASH LOOP on every portal page.
 *
 * Fix: checkAuth treats 503/429/502/504 + "starting up"/non-JSON bodies as
 * TRANSIENT (keep session, show reconnect overlay, no redirect), and never
 * redirects from index.html itself. Only a genuine 401 redirects.
 *
 * This is the regression gate Hank asked for ("以後漏掉的缺口都要有testcase或
 * git ci test"): it exercises the FAILURE path (mock 503/429) the mock-200
 * vision-checks never reached. Loads api.js + auth.js into a vm sandbox and
 * runs checkAuth() against mocked responses (jest.config testEnvironment:node).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const API_JS = path.resolve(__dirname, '../../public/portal/shared/api.js');
const AUTH_JS = path.resolve(__dirname, '../../public/portal/shared/auth.js');

function makeSandbox({ status, body = {}, contentType = 'application/json', pathname = '/portal/dashboard.html' } = {}) {
    const fakeResponse = {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: () => contentType },
        json: async () => body,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
    const hrefSetter = jest.fn();
    const locationTarget = { origin: 'http://localhost:8787', pathname, search: '' };
    const locationProxy = new Proxy(locationTarget, {
        set(obj, prop, val) {
            if (prop === 'href') hrefSetter(val);
            obj[prop] = val;
            return true;
        },
    });
    const overlayShow = jest.fn();
    const sandbox = {
        window: { location: locationProxy, __reconnectOverlay: { show: overlayShow } },
        document: {
            cookie: '',
            getElementById: () => null,
            createElement: () => ({ appendChild() {}, remove() {}, addEventListener() {}, querySelector: () => ({ focus() {}, addEventListener() {}, select() {} }), querySelectorAll: () => [], textContent: '', innerHTML: '', style: {} }),
            body: { appendChild() {} },
        },
        localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
        navigator: { onLine: true },
        fetch: jest.fn().mockResolvedValue(fakeResponse),
        console: { log() {}, warn() {}, error() {} },
        setTimeout: (fn) => { /* do not actually schedule */ return { unref() {} }; },
        clearTimeout: () => {},
        Date,
    };
    sandbox.window.location = locationProxy;
    sandbox.location = locationProxy;
    return { sandbox, hrefSetter, overlayShow };
}

function load(sandbox) {
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(API_JS, 'utf8'), sandbox);
    vm.runInContext(fs.readFileSync(AUTH_JS, 'utf8'), sandbox);
}

describe('checkAuth cold-start / rate-limit does NOT redirect-loop', () => {
    test('503 "Server starting up" ⇒ keep session, show reconnect overlay, NO redirect', async () => {
        const { sandbox, hrefSetter, overlayShow } = makeSandbox({
            status: 503,
            body: { success: false, error: 'Server starting up — please retry in a few seconds' },
            pathname: '/portal/dashboard.html',
        });
        load(sandbox);
        const user = await sandbox.checkAuth();
        expect(user).toBeNull();
        expect(hrefSetter).not.toHaveBeenCalled();   // <-- the loop is gone
        expect(overlayShow).toHaveBeenCalled();
    });

    test('429 rate-limit (dashboard fan-out) ⇒ NO redirect', async () => {
        const { sandbox, hrefSetter, overlayShow } = makeSandbox({
            status: 429,
            body: { error: 'Too many requests' },
            pathname: '/portal/dashboard.html',
        });
        load(sandbox);
        await sandbox.checkAuth();
        expect(hrefSetter).not.toHaveBeenCalled();
        expect(overlayShow).toHaveBeenCalled();
    });

    test('502/504 gateway ⇒ NO redirect', async () => {
        for (const status of [502, 504]) {
            const { sandbox, hrefSetter } = makeSandbox({ status, body: { error: 'gateway' } });
            load(sandbox);
            await sandbox.checkAuth();
            expect(hrefSetter).not.toHaveBeenCalled();
        }
    });

    test('non-JSON 503 body (proxy/HTML) ⇒ NO redirect', async () => {
        const { sandbox, hrefSetter } = makeSandbox({
            status: 503,
            body: '<html>Service Unavailable</html>',
            contentType: 'text/html',
            pathname: '/portal/dashboard.html',
        });
        load(sandbox);
        await sandbox.checkAuth();
        expect(hrefSetter).not.toHaveBeenCalled();
    });

    test('CONTRAST: a genuine 401 STILL redirects to login (auth behavior preserved)', async () => {
        const { sandbox, hrefSetter } = makeSandbox({
            status: 401,
            body: { error: 'Not authenticated' },
            pathname: '/portal/dashboard.html',
        });
        load(sandbox);
        await sandbox.checkAuth();
        expect(hrefSetter).toHaveBeenCalledWith('index.html');
    });

    test('defense-in-depth: a 401 on index.html does NOT redirect to itself', async () => {
        const { sandbox, hrefSetter } = makeSandbox({
            status: 401,
            body: { error: 'Not authenticated' },
            pathname: '/portal/index.html',
        });
        load(sandbox);
        await sandbox.checkAuth();
        expect(hrefSetter).not.toHaveBeenCalled();
    });
});

describe('auth.js static guard — transient statuses are handled before the redirect', () => {
    const source = fs.readFileSync(AUTH_JS, 'utf8');
    test('checkAuth classifies 503/429/502/504 as transient', () => {
        expect(source).toMatch(/===\s*503/);
        expect(source).toMatch(/===\s*429/);
        expect(source).toMatch(/starting up/i);
    });
    test('explicit redirect is guarded against firing from index.html', () => {
        expect(source).toMatch(/onLoginPage/);
        expect(source).toMatch(/if\s*\(\s*!onLoginPage\s*\)\s*window\.location\.href/);
    });
});
