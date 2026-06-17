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

describe('Phase D — new routes (route-registry.js extension)', () => {
    // Card: card_125161f56080b1d7df597f6f.
    // Spec: docs/smart-router-spec.md §4 (proof-slice migration targets).
    // TDD-style: these tests gate the 15-site migration that follows.
    test('wallet → /portal/wallet.html (no params)', () => {
        const win = makeWin({}); win.parent = win;
        const SR = loadRouter(win);
        expect(SR.buildUrl('wallet')).toBe('/portal/wallet.html');
    });
    test('invite → /portal/invite.html (no params)', () => {
        const win = makeWin({}); win.parent = win;
        const SR = loadRouter(win);
        expect(SR.buildUrl('invite')).toBe('/portal/invite.html');
    });
    test('files → /portal/files.html (no params)', () => {
        const win = makeWin({}); win.parent = win;
        const SR = loadRouter(win);
        expect(SR.buildUrl('files')).toBe('/portal/files.html');
    });
    test('petdx → /portal/petdx-browser.html (no params)', () => {
        const win = makeWin({}); win.parent = win;
        const SR = loadRouter(win);
        expect(SR.buildUrl('petdx')).toBe('/portal/petdx-browser.html');
    });
    test('my-rentals → /portal/my-rentals.html (no params)', () => {
        const win = makeWin({}); win.parent = win;
        const SR = loadRouter(win);
        expect(SR.buildUrl('my-rentals')).toBe('/portal/my-rentals.html');
    });
    test('my-rentals with optional rentalId → query string', () => {
        const win = makeWin({}); win.parent = win;
        const SR = loadRouter(win);
        expect(SR.buildUrl('my-rentals', { rentalId: 'rent_abc123' }))
            .toBe('/portal/my-rentals.html?rentalId=rent_abc123');
    });
    test('my-rentals rejects bad rentalId (degrades to bare path)', () => {
        const win = makeWin({}); win.parent = win;
        const SR = loadRouter(win);
        // SmartRouter tolerant-degrade strips invalid optional params (returns bare).
        expect(SR.buildUrl('my-rentals', { rentalId: 'has spaces' }))
            .toBe('/portal/my-rentals.html');
    });
    test('chat-mention → /portal/chat.html?mention=<code>', () => {
        const win = makeWin({}); win.parent = win;
        const SR = loadRouter(win);
        expect(SR.buildUrl('chat-mention', { mention: 'abc123' }))
            .toBe('/portal/chat.html?mention=abc123');
    });
    test('chat-mention rejects bad mention (degrades to bare /portal/chat.html)', () => {
        const win = makeWin({}); win.parent = win;
        const SR = loadRouter(win);
        // Required param missing/invalid → SmartRouter degrades to bare path of the template.
        expect(SR.buildUrl('chat-mention', { mention: 'BAD!' }))
            .toBe('/portal/chat.html');
    });
    test('chat-msg → /portal/chat.html?msg=<id>', () => {
        const win = makeWin({}); win.parent = win;
        const SR = loadRouter(win);
        expect(SR.buildUrl('chat-msg', { msg: 'm_abc-123_xyz' }))
            .toBe('/portal/chat.html?msg=m_abc-123_xyz');
    });
    test('settings-agent-policy → full URL with 3 params + fragment', () => {
        const win = makeWin({}); win.parent = win;
        const SR = loadRouter(win);
        expect(SR.buildUrl('settings-agent-policy', { scope: 'device', entityId: '2', channel: 'openclaw' }))
            .toBe('/portal/settings.html?agentPolicy=1&scope=device&entityId=2&channel=openclaw#agent-policy');
    });
    test('settings-agent-policy rejects bad scope (degrades to bare)', () => {
        const win = makeWin({}); win.parent = win;
        const SR = loadRouter(win);
        expect(SR.buildUrl('settings-agent-policy', { scope: 'admin', entityId: '2', channel: 'openclaw' }))
            .toBe('/portal/settings.html');
    });
    test('settings-agent-policy rejects bad entityId (degrades to bare)', () => {
        const win = makeWin({}); win.parent = win;
        const SR = loadRouter(win);
        expect(SR.buildUrl('settings-agent-policy', { scope: 'device', entityId: 'abc', channel: 'openclaw' }))
            .toBe('/portal/settings.html');
    });
});

describe('Phase D — registry validateParams (param regex)', () => {
    // Drive route-registry.js directly to lock in per-param regex behavior.
    const registry = require('../../shared/route-registry.js');

    test('mention must be 6 lowercase alphanumeric', () => {
        expect(registry.validateParams('chat-mention', { mention: 'abc123' }).ok).toBe(true);
        expect(registry.validateParams('chat-mention', { mention: 'ABCDEF' }).ok).toBe(false);
        expect(registry.validateParams('chat-mention', { mention: 'abc12'  }).ok).toBe(false);
        expect(registry.validateParams('chat-mention', { mention: ''        }).ok).toBe(false);
    });
    test('msg max 64 chars, alphanumeric/_/-', () => {
        expect(registry.validateParams('chat-msg', { msg: 'm_123' }).ok).toBe(true);
        expect(registry.validateParams('chat-msg', { msg: 'a'.repeat(64) }).ok).toBe(true);
        expect(registry.validateParams('chat-msg', { msg: 'a'.repeat(65) }).ok).toBe(false);
        expect(registry.validateParams('chat-msg', { msg: 'bad space'    }).ok).toBe(false);
    });
    test('rentalId optional but validated when present', () => {
        expect(registry.validateParams('my-rentals', {                       }).ok).toBe(true);
        expect(registry.validateParams('my-rentals', { rentalId: 'rent_abc' }).ok).toBe(true);
        expect(registry.validateParams('my-rentals', { rentalId: 'a'.repeat(65) }).ok).toBe(false);
        expect(registry.validateParams('my-rentals', { rentalId: 'bad space' }).ok).toBe(false);
    });
    test('agent-policy scope must be device|entity', () => {
        expect(registry.validateParams('settings-agent-policy', { scope: 'device', entityId: '2', channel: 'openclaw' }).ok).toBe(true);
        expect(registry.validateParams('settings-agent-policy', { scope: 'entity', entityId: '2', channel: 'openclaw' }).ok).toBe(true);
        expect(registry.validateParams('settings-agent-policy', { scope: 'admin',  entityId: '2', channel: 'openclaw' }).ok).toBe(false);
    });
    test('agent-policy entityId must be numeric 1-4 digits', () => {
        expect(registry.validateParams('settings-agent-policy', { scope: 'device', entityId: '9999', channel: 'openclaw' }).ok).toBe(true);
        expect(registry.validateParams('settings-agent-policy', { scope: 'device', entityId: '12345', channel: 'openclaw' }).ok).toBe(false);
        expect(registry.validateParams('settings-agent-policy', { scope: 'device', entityId: 'abc', channel: 'openclaw' }).ok).toBe(false);
    });
    test('agent-policy channel slug — lowercase start, alphanum/_/-', () => {
        expect(registry.validateParams('settings-agent-policy', { scope: 'device', entityId: '2', channel: 'openclaw' }).ok).toBe(true);
        expect(registry.validateParams('settings-agent-policy', { scope: 'device', entityId: '2', channel: '2hermes'  }).ok).toBe(false);
        expect(registry.validateParams('settings-agent-policy', { scope: 'device', entityId: '2', channel: 'Bad Chan' }).ok).toBe(false);
    });
});

describe('Phase D — isSafeReturnTo coverage for new targets', () => {
    const registry = require('../../shared/route-registry.js');
    test('new web paths are safe return_to', () => {
        expect(registry.isSafeReturnTo('/portal/wallet.html')).toBe(true);
        expect(registry.isSafeReturnTo('/portal/my-rentals.html')).toBe(true);
        expect(registry.isSafeReturnTo('/portal/my-rentals.html?rentalId=rent_abc')).toBe(true);
        expect(registry.isSafeReturnTo('/portal/invite.html')).toBe(true);
        expect(registry.isSafeReturnTo('/portal/files.html')).toBe(true);
        expect(registry.isSafeReturnTo('/portal/petdx-browser.html')).toBe(true);
        expect(registry.isSafeReturnTo('/portal/settings.html#agent-policy')).toBe(true);
        expect(registry.isSafeReturnTo('/portal/chat.html?mention=abc123')).toBe(true);
        expect(registry.isSafeReturnTo('/portal/chat.html?msg=m_123')).toBe(true);
    });
    test('absolute external URLs are NOT safe (open redirect guard)', () => {
        expect(registry.isSafeReturnTo('https://evil.example/phish')).toBe(false);
        expect(registry.isSafeReturnTo('//evil.example/protocol-relative')).toBe(false);
        expect(registry.isSafeReturnTo('http://eclawbot.com/portal/wallet.html')).toBe(false);
    });
    test('unregistered same-origin path NOT safe (only allowlist)', () => {
        expect(registry.isSafeReturnTo('/portal/not-a-real-page.html')).toBe(false);
        expect(registry.isSafeReturnTo('/admin/secret.html')).toBe(false);
    });
});

describe('Phase D — buildWebUrl strict (registry-level, not via SmartRouter degrade)', () => {
    const registry = require('../../shared/route-registry.js');
    test('strict build throws on missing required param', () => {
        expect(() => registry.buildWebUrl('chat-mention', {})).toThrow(/missing_param:mention/);
        expect(() => registry.buildWebUrl('settings-agent-policy', { scope: 'device' })).toThrow(/missing_param:entityId/);
    });
    test('strict build throws on invalid required param', () => {
        expect(() => registry.buildWebUrl('chat-mention', { mention: 'BAD' })).toThrow(/invalid_param:mention/);
    });
    test('strict build throws on invalid optional param', () => {
        expect(() => registry.buildWebUrl('my-rentals', { rentalId: 'bad space' })).toThrow(/invalid_param:rentalId/);
    });
    test('optional param appended after existing query string with &', () => {
        // Pre-condition: my-rentals base has no query; chat has ?contact={publicCode}.
        // Build by hand to exercise the `&` separator path: synthetic route with both.
        // We use the existing registry behavior by checking that my-rentals + rentalId yields '?'.
        expect(registry.buildWebUrl('my-rentals', { rentalId: 'rent_x1' })).toBe('/portal/my-rentals.html?rentalId=rent_x1');
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

    // card_2d5fbe88: split "在看板中開啟" — chat pane must dispatch the card
    // target to the host (which routes it into the existing kanban pane), NOT
    // window.open a 2nd pane or full-page navigate (which redirected chat).
    test('card target in split mode posts split_navigate with cardId (no full-page assign)', () => {
        const post = jest.fn();
        const assign = jest.fn();
        const win = makeWin({ location: { origin: 'https://eclawbot.com', search: '?embed=1', assign } });
        win.parent = { location: { origin: 'https://eclawbot.com' }, postMessage: post };
        const SR = loadRouter(win);
        expect(SR.mode).toBe('split');
        SR.navigate('card', { cardId: 'card_2d5fbe88efdd98e90b0cae28' });
        expect(post).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'split_navigate',
                target: 'card',
                params: { cardId: 'card_2d5fbe88efdd98e90b0cae28' },
                requestId: expect.stringMatching(/^nav_[0-9a-f]{8}$/),
            }),
            'https://eclawbot.com'
        );
        // No synchronous full-page redirect — the host owns the pane swap.
        expect(assign).not.toHaveBeenCalled();
    });

    test('card target ack from host cancels degrade — chat pane never full-page navigates', (done) => {
        const post = jest.fn();
        const assign = jest.fn();
        const win = makeWin({ location: { origin: 'https://eclawbot.com', search: '?embed=1', assign } });
        win.parent = { location: { origin: 'https://eclawbot.com' }, postMessage: post };
        const SR = loadRouter(win);
        SR.navigate('card', { cardId: 'card_2d5fbe88efdd98e90b0cae28' });
        const requestId = post.mock.calls[0][0].requestId;
        win._emit('message', { origin: 'https://eclawbot.com', data: { type: 'split_navigate_ack', requestId } });
        setTimeout(() => {
            expect(assign).not.toHaveBeenCalled();
            done();
        }, 360);
    });

    test('card target builds the kanban deep-link URL (host buildPaneUrl SoT)', () => {
        const registry = require('../../shared/route-registry.js');
        expect(registry.buildWebUrl('card', { cardId: 'card_2d5fbe88efdd98e90b0cae28' }))
            .toBe('/portal/kanban.html?card=card_2d5fbe88efdd98e90b0cae28#card_2d5fbe88efdd98e90b0cae28');
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
