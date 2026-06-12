/**
 * SmartRouter v1 — mode detection matrix + fallback degradation + split ack timeout.
 * Spec: docs/smart-router-spec.md §2/§3. Card: card_866e95ee74d5a168f2e35de6.
 *
 * Drives the module under a fresh jsdom-ish global per case (the file boots on
 * load, so we re-require with a reset global to exercise each detection branch).
 */
'use strict';

const path = require('path');

const ROUTER_PATH = path.join(__dirname, '../../public/portal/shared/smart-router.js');
const REGISTRY_PATH = path.join(__dirname, '../../shared/route-registry.js');

// Minimal window stub; per-case overrides merge in before load.
function makeWin(overrides) {
    const listeners = {};
    const win = Object.assign({
        location: { origin: 'https://eclawbot.com', search: '', assign: jest.fn(), href: '' },
        navigator: { userAgent: 'Mozilla/5.0' },
        document: { body: { dataset: {}, classList: { contains: () => false } } },
        parent: null,
        self: null,
        addEventListener: (t, h) => { (listeners[t] = listeners[t] || []).push(h); },
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (id) => clearTimeout(id),
        Math: Math,
        _emit: (t, ev) => (listeners[t] || []).forEach(h => h(ev)),
    }, overrides);
    win.self = win.self || win;
    return win;
}

// Load registry + router against a given window global, returning the SmartRouter.
function loadRouter(win) {
    jest.resetModules();
    const reg = require(REGISTRY_PATH);
    win.EClawRouteRegistry = reg;
    global.window = win;
    global.module = { exports: {} };
    // The router IIFE reads `window` via the param; require() returns its export.
    delete require.cache[require.resolve(ROUTER_PATH)];
    const SmartRouter = require(ROUTER_PATH);
    return SmartRouter;
}

afterEach(() => { delete global.window; });

describe('detectMode matrix (spec §2, first match wins)', () => {
    test('EClawNativeNav present → app (outranks split)', () => {
        const win = makeWin({ EClawNativeNav: { navigate: () => true } });
        win.parent = win; // even if embeddable, app wins
        expect(loadRouter(win).mode).toBe('app');
    });

    test('legacy AndroidBridge → app', () => {
        const win = makeWin({ AndroidBridge: {} });
        expect(loadRouter(win).mode).toBe('app');
    });

    test('EClawIOS UA → app', () => {
        const win = makeWin({ navigator: { userAgent: 'EClawIOS/1.0' } });
        expect(loadRouter(win).mode).toBe('app');
    });

    test('?embed=1 with same-origin parent → split', () => {
        const win = makeWin({ location: { origin: 'https://eclawbot.com', search: '?embed=1', assign: jest.fn() } });
        win.parent = { location: { origin: 'https://eclawbot.com' } };
        expect(loadRouter(win).mode).toBe('split');
    });

    test('parent !== self (no embed flag) same-origin → split', () => {
        const win = makeWin({});
        win.self = win;
        win.parent = { location: { origin: 'https://eclawbot.com' } };
        expect(loadRouter(win).mode).toBe('split');
    });

    test('cross-origin parent → single (not split)', () => {
        const win = makeWin({});
        win.parent = { get location() { throw new Error('cross-origin'); } };
        expect(loadRouter(win).mode).toBe('single');
    });

    test('standalone page → single', () => {
        const win = makeWin({});
        win.parent = win; // parent === self
        expect(loadRouter(win).mode).toBe('single');
    });

    test('boot sets body.dataset.navMode', () => {
        const win = makeWin({});
        win.parent = win;
        const SR = loadRouter(win);
        expect(win.document.body.dataset.navMode).toBe(SR.mode);
    });
});

describe('buildUrl tolerant-degrade (spec §3)', () => {
    test('strict registry URL when params present', () => {
        const win = makeWin({}); win.parent = win;
        const SR = loadRouter(win);
        expect(SR.buildUrl('chat', { publicCode: 'abc123' })).toBe('/portal/chat.html?contact=abc123');
    });
    test('bare path when required param absent (generic open-chat)', () => {
        const win = makeWin({}); win.parent = win;
        const SR = loadRouter(win);
        expect(SR.buildUrl('chat')).toBe('/portal/chat.html');
    });
    test('unknown target → null', () => {
        const win = makeWin({}); win.parent = win;
        const SR = loadRouter(win);
        expect(SR.buildUrl('nope')).toBeNull();
    });
});

describe('per-mode dispatch + fallback degradation (spec §3)', () => {
    test('single → location.assign with built url', () => {
        const win = makeWin({}); win.parent = win;
        const SR = loadRouter(win);
        SR.navigate('chat', { publicCode: 'abc123' });
        expect(win.location.assign).toHaveBeenCalledWith('/portal/chat.html?contact=abc123');
    });

    test('app unmapped target → immediate single fallback (no bridge call)', () => {
        const navSpy = jest.fn(() => true);
        const win = makeWin({ EClawNativeNav: { navigate: navSpy } });
        const SR = loadRouter(win);
        SR.navigate('settings'); // not in APP_TARGET_TAB
        expect(navSpy).not.toHaveBeenCalled();
        expect(win.location.assign).toHaveBeenCalledWith('/portal/settings.html');
    });

    test('app mapped target → bridge.navigate with targetTab', () => {
        const navSpy = jest.fn(() => true);
        const win = makeWin({ EClawNativeNav: { navigate: navSpy } });
        const SR = loadRouter(win);
        SR.navigate('card', { cardId: 'card_abc123' });
        expect(navSpy).toHaveBeenCalledWith(expect.objectContaining({ targetTab: 'mission', target: 'card' }));
    });

    test('app bridge returns false → degrade to single', () => {
        const win = makeWin({ EClawNativeNav: { navigate: () => false } });
        const SR = loadRouter(win);
        SR.navigate('chat', { publicCode: 'abc123' });
        expect(win.location.assign).toHaveBeenCalledWith('/portal/chat.html?contact=abc123');
    });
});

describe('split ack contract (spec §3)', () => {
    test('posts split_navigate to parent with nav_ requestId', () => {
        const post = jest.fn();
        const win = makeWin({ location: { origin: 'https://eclawbot.com', search: '?embed=1', assign: jest.fn() } });
        win.parent = { location: { origin: 'https://eclawbot.com' }, postMessage: post };
        const SR = loadRouter(win);
        SR.navigate('chat');
        expect(post).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'split_navigate', target: 'chat', requestId: expect.stringMatching(/^nav_[0-9a-f]{8}$/) }),
            'https://eclawbot.com'
        );
    });

    test('no ack within 300ms → degrade to single full-page navigate', (done) => {
        const post = jest.fn();
        const assign = jest.fn();
        const win = makeWin({ location: { origin: 'https://eclawbot.com', search: '?embed=1', assign } });
        win.parent = { location: { origin: 'https://eclawbot.com' }, postMessage: post };
        const SR = loadRouter(win);
        SR.navigate('chat');
        setTimeout(() => {
            expect(assign).toHaveBeenCalledWith('/portal/chat.html');
            done();
        }, 360);
    });

    test('ack before timeout → no degrade (location.assign NOT called)', (done) => {
        const post = jest.fn();
        const assign = jest.fn();
        const win = makeWin({ location: { origin: 'https://eclawbot.com', search: '?embed=1', assign } });
        win.parent = { location: { origin: 'https://eclawbot.com' }, postMessage: post };
        const SR = loadRouter(win);
        SR.navigate('chat');
        const requestId = post.mock.calls[0][0].requestId;
        // Simulate host ack back to the pane.
        win._emit('message', { origin: 'https://eclawbot.com', data: { type: 'split_navigate_ack', requestId } });
        setTimeout(() => {
            expect(assign).not.toHaveBeenCalled();
            done();
        }, 360);
    });
});
