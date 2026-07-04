/**
 * Regression guard for the task-completed notification deep-link (card_92c17b66).
 *
 * MissionControlActivity hosts mission.html and, on an inbound card push, replays
 * `eclawHandleNativeNavigateIntent({ targetTab:'mission', target:'card', cardId })`
 * into the WebView. mission.html is a dashboard; card detail lives in kanban.html.
 *
 * The bug: the handler used to call `SmartRouter.navigate('card', {cardId})`. In
 * app mode SmartRouter maps the 'card' target to the 'mission' tab (APP_TARGET_TAB)
 * — the tab we are already on — so it re-enters the native bridge, which re-launches
 * MissionControlActivity (SINGLE_TOP → onNewIntent → replay → this handler) in an
 * INFINITE LOOP and the card never opens (the notification appears to only reach
 * the home/mission screen). Fix: navigate the WebView straight to the canonical
 * kanban.html deep-link instead of round-tripping through the tab router.
 *
 * This test drives the REAL router (app mode) + the REAL mission.html handler and
 * asserts the handler never re-enters the native bridge and lands on kanban.html.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '../..');
const ROUTER_PATH = path.join(REPO, 'public/portal/shared/smart-router.js');
const REGISTRY_PATH = path.join(REPO, 'shared/route-registry.js');
const MISSION_HTML = path.join(REPO, 'public/portal/mission.html');

// Extract the exact `window.eclawHandleNativeNavigateIntent = async function ... };`
// block from mission.html so the test exercises the shipped source, not a copy.
function extractMissionHandlerSource(html) {
    const start = html.indexOf('window.eclawHandleNativeNavigateIntent = async function');
    if (start === -1) throw new Error('mission.html: handler not found');
    // Close on the first 8-space-indented `};` (the assignment terminator).
    const end = html.indexOf('\n        };', start);
    if (end === -1) throw new Error('mission.html: handler terminator not found');
    return html.slice(start, end + '\n        };'.length);
}

// Load the real registry + router bound to a given window (mirrors smart-router.test.js).
function loadRouter(win) {
    jest.resetModules();
    const reg = require(REGISTRY_PATH);
    win.EClawRouteRegistry = reg;
    global.window = win;
    global.module = { exports: {} };
    delete require.cache[require.resolve(ROUTER_PATH)];
    return require(ROUTER_PATH);
}

function makeAppWindow(bridgeSpy) {
    const win = {
        location: { origin: 'https://eclawbot.com', search: '', assign: jest.fn(), href: '' },
        navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14) EClawAndroid' },
        document: { body: { dataset: {}, classList: { contains: () => false } } },
        parent: null,
        self: null,
        addEventListener: () => {},
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (id) => clearTimeout(id),
        Math,
        // Native bridge — in app mode SmartRouter routes tab navigations here.
        EClawNativeNav: { navigate: bridgeSpy },
    };
    win.self = win;
    return win;
}

afterEach(() => { delete global.window; delete global.module; });

describe('mission.html card deep-link (card_92c17b66 no-loop guard)', () => {
    test('app-mode SmartRouter maps card→mission tab (proves the self-loop trap)', () => {
        // Positive control: this is WHY the handler must not use SmartRouter here.
        const bridgeSpy = jest.fn(() => true);
        const win = makeAppWindow(bridgeSpy);
        const SmartRouter = loadRouter(win);
        expect(SmartRouter.mode).toBe('app');
        expect(SmartRouter.APP_TARGET_TAB.card).toBe('mission');

        const ok = SmartRouter.navigate('card', { cardId: 'card_abc123def456' });
        expect(ok).toBe(true);
        // In app mode navigate('card') re-enters the native bridge aimed at the
        // 'mission' tab — the same Activity → the loop the handler must avoid.
        expect(bridgeSpy).toHaveBeenCalledTimes(1);
        expect(bridgeSpy.mock.calls[0][0]).toMatchObject({ targetTab: 'mission', target: 'card' });
    });

    test('handler navigates straight to kanban.html and never re-enters the bridge', async () => {
        const bridgeSpy = jest.fn(() => true);
        const win = makeAppWindow(bridgeSpy);
        win.SmartRouter = loadRouter(win); // real, app-mode router available to the handler

        const src = extractMissionHandlerSource(fs.readFileSync(MISSION_HTML, 'utf8'));
        const factory = new Function('window', 'console', src + '\nreturn window.eclawHandleNativeNavigateIntent;');
        const handler = factory(win, { warn() {} });

        const handled = await handler({ targetTab: 'mission', target: 'card', cardId: 'card_abc123def456' });

        expect(handled).toBe(true);
        // The card opens in kanban.html within the same WebView…
        expect(win.location.href).toBe('/portal/kanban.html?card=card_abc123def456#card_abc123def456');
        // …WITHOUT any native-bridge round-trip (which would re-launch this Activity → loop).
        expect(bridgeSpy).not.toHaveBeenCalled();
    });

    test('handler ignores non-card / foreign-tab intents', async () => {
        const bridgeSpy = jest.fn(() => true);
        const win = makeAppWindow(bridgeSpy);
        win.SmartRouter = loadRouter(win);
        const src = extractMissionHandlerSource(fs.readFileSync(MISSION_HTML, 'utf8'));
        const handler = new Function('window', 'console', src + '\nreturn window.eclawHandleNativeNavigateIntent;')(win, { warn() {} });

        expect(await handler({ targetTab: 'chat', target: 'card', cardId: 'card_abc123def456' })).toBe(false);
        expect(await handler({ targetTab: 'mission', target: 'card', cardId: '   ' })).toBe(false);
        expect(await handler(null)).toBe(false);
        expect(win.location.href).toBe('');
        expect(bridgeSpy).not.toHaveBeenCalled();
    });
});
