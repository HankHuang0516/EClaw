/**
 * Portal auth race — WebView/iOS device-login should not lose to api.js's
 * 401 → index.html redirect.
 *
 * Bug: on iOS WebView / Playwright, the first `/api/auth/me` call returns
 * 401, api.js navigates to index.html immediately, and the still-in-flight
 * device-login POST from auth.js is aborted mid-fetch ("TypeError: Failed
 * to fetch"). The page never gets to device-login.
 *
 * Fix: api.js now accepts an `opts.skip401Redirect` flag; auth.js's /me
 * probe passes `skip401Redirect: true` so its own fallback chain can
 * complete. If every fallback fails, auth.js redirects explicitly.
 *
 * These tests load public/portal/shared/api.js into a vm sandbox so we
 * can exercise apiCall directly with mocked fetch + window.location, plus
 * a static-analysis guard so auth.js can't regress silently.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const API_JS = path.resolve(__dirname, '../../public/portal/shared/api.js');
const AUTH_JS = path.resolve(__dirname, '../../public/portal/shared/auth.js');

function makeSandbox({ status, body = {}, pathname = '/portal/dashboard.html' } = {}) {
    const fakeResponse = {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: () => 'application/json' },
        json: async () => body,
        text: async () => JSON.stringify(body),
    };
    const hrefSetter = jest.fn();
    const locationTarget = {
        origin: 'http://localhost:8787',
        pathname,
        search: '',
    };
    const locationProxy = new Proxy(locationTarget, {
        set(obj, prop, val) {
            if (prop === 'href') hrefSetter(val);
            obj[prop] = val;
            return true;
        },
    });
    const fetchMock = jest.fn().mockResolvedValue(fakeResponse);
    const sandbox = {
        window: { location: locationProxy },
        document: { createElement: () => ({ appendChild: () => {}, remove: () => {}, addEventListener: () => {}, querySelector: () => ({ focus: () => {}, addEventListener: () => {}, select: () => {} }), querySelectorAll: () => [], textContent: '', innerHTML: '', style: {} }), body: { appendChild: () => {} } },
        fetch: fetchMock,
        console: { log: () => {}, warn: () => {}, error: () => {} },
        setTimeout: (fn) => fn(),
    };
    sandbox.window.location = locationProxy;
    sandbox.window.alert = () => {};
    sandbox.window.confirm = () => {};
    sandbox.window.prompt = () => {};
    sandbox.location = locationProxy;
    return { sandbox, hrefSetter, fetchMock };
}

function loadApiJs(sandbox) {
    const src = fs.readFileSync(API_JS, 'utf8');
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
}

describe('apiCall 401 behavior', () => {
    test('401 on authenticated page redirects to index.html by default', async () => {
        const { sandbox, hrefSetter } = makeSandbox({
            status: 401,
            body: { error: 'Not authenticated' },
            pathname: '/portal/dashboard.html',
        });
        loadApiJs(sandbox);

        await expect(sandbox.apiCall('GET', '/api/auth/me')).rejects.toThrow(/Not authenticated/);
        // Pain-4 contract (OODA-R Phase 2 #6): redirect now carries the
        // machine-readable reason so index.html can explain the kick.
        expect(hrefSetter).toHaveBeenCalledWith('index.html?authReason=no_token');
    });

    test('401 with skip401Redirect=true does NOT navigate', async () => {
        const { sandbox, hrefSetter } = makeSandbox({
            status: 401,
            body: { error: 'Not authenticated' },
            pathname: '/portal/dashboard.html',
        });
        loadApiJs(sandbox);

        await expect(
            sandbox.apiCall('GET', '/api/auth/me', null, { skip401Redirect: true })
        ).rejects.toThrow(/Not authenticated/);
        expect(hrefSetter).not.toHaveBeenCalled();
    });

    test('401 with skip401Redirect=true still throws so caller can fallback', async () => {
        const { sandbox } = makeSandbox({
            status: 401,
            body: { error: 'Not authenticated' },
        });
        loadApiJs(sandbox);

        let threw = false;
        try {
            await sandbox.apiCall('GET', '/api/auth/me', null, { skip401Redirect: true });
        } catch (_) {
            threw = true;
        }
        expect(threw).toBe(true);
    });

    test('401 on index.html does not redirect (avoid loop)', async () => {
        const { sandbox, hrefSetter } = makeSandbox({
            status: 401,
            body: { error: 'Not authenticated' },
            pathname: '/portal/index.html',
        });
        loadApiJs(sandbox);

        await expect(sandbox.apiCall('GET', '/api/auth/me')).rejects.toThrow();
        expect(hrefSetter).not.toHaveBeenCalled();
    });

    test('200 on /me returns parsed body without touching window.location', async () => {
        const { sandbox, hrefSetter } = makeSandbox({
            status: 200,
            body: { user: { deviceId: 'd1', email: 'a@b' } },
        });
        loadApiJs(sandbox);

        const data = await sandbox.apiCall('GET', '/api/auth/me');
        expect(data.user.deviceId).toBe('d1');
        expect(hrefSetter).not.toHaveBeenCalled();
    });
});

describe('auth.js wiring (static analysis)', () => {
    const source = fs.readFileSync(AUTH_JS, 'utf8');

    test('/me probe passes skip401Redirect so api.js does not race the fallback', () => {
        // Look for an apiCall to /api/auth/me with a 4th arg containing skip401Redirect.
        // Allow arbitrary whitespace/quoting.
        const pattern = /apiCall\(\s*['"]GET['"]\s*,\s*['"]\/api\/auth\/me['"]\s*,[^,]*,\s*\{[^}]*skip401Redirect\s*:\s*true[^}]*\}\s*\)/;
        expect(source).toMatch(pattern);
    });

    test('auth.js keeps an explicit final redirect when every fallback fails', () => {
        // After iOS/Android fallbacks fail, auth.js must navigate to index.html
        // itself (api.js no longer does it for the /me probe).
        expect(source).toMatch(/window\.location\.href\s*=\s*['"]index\.html['"]/);
    });

    test('WebView device-mismatch guard re-logs into URL-param device', () => {
        // Incident 2026-04-24 card_f0d95b8d: mission.html's env-vars sub-tab
        // rendered blank in the iOS WebView because a stale session cookie
        // belonged to a different device than the URL params. The guard
        // detects mismatch between URL deviceId and /me's returned deviceId,
        // then calls /api/auth/device-login with the URL-param credentials.
        expect(source).toMatch(/urlDeviceId\s*!==\s*currentUser\.deviceId/);
        expect(source).toMatch(/apiCall\(\s*['"]POST['"]\s*,\s*['"]\/api\/auth\/device-login['"]/);
    });
});
