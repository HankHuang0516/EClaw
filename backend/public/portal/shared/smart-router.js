/**
 * SmartRouter — 3-mode in-session navigation (docs/smart-router-spec.md).
 * Card: card_866e95ee74d5a168f2e35de6 (v1 impl). Spec APPROVED 94109cf1.
 *
 * Modes (spec §1): 'single' (full-page), 'split' (workspace pane swap),
 * 'app' (native tab bridge). Mode is frozen at boot; navigate() dispatches
 * per-mode and degrades one level on failure so navigation never dead-ends.
 *
 * Consumes the SAME route registry as the server via /shared-core/route-registry.js
 * (window.EClawRouteRegistry) — single URL SoT. Load that BEFORE this file.
 */
(function (global) {
    'use strict';

    var registry = global.EClawRouteRegistry || null;

    // Native host mapping (spec §3, #6 review am.1): the native shells today host
    // only chat + mission tabs. Any target absent from this map degrades to
    // 'single' IMMEDIATELY in app mode — no bridge round-trip, no timeout wait.
    var APP_TARGET_TAB = { chat: 'chat', card: 'mission', note: 'mission' };

    var SPLIT_ACK_TIMEOUT_MS = 300; // spec §3 split ack contract

    // ── Mode detection (spec §2, first match wins) ──
    function detectMode() {
        // 1. app outranks split — a WebView inside the native app is still app mode.
        if (global.EClawNativeNav) return 'app';
        if (global.AndroidBridge || /EClawAndroid|EClawIOS/i.test(global.navigator && global.navigator.userAgent || '')) {
            return 'app';
        }
        // 2. split — embedded pane whose parent is same-origin.
        var body = global.document && global.document.body;
        var embedFlag = (body && body.classList && body.classList.contains('embed-mode'))
            || /[?&]embed=1\b/.test(global.location && global.location.search || '')
            || (global.parent && global.parent !== global.self);
        if (embedFlag && _parentIsSameOrigin()) return 'split';
        // 3. single — standalone page.
        return 'single';
    }

    function _parentIsSameOrigin() {
        if (!global.parent || global.parent === global.self) return false;
        try {
            // Throws on cross-origin; a readable parent.location.origin === ours = same-origin.
            return global.parent.location.origin === global.location.origin;
        } catch (_) {
            return false;
        }
    }

    // ── URL building (spec §3: delegates to the registry, single SoT) ──
    // Tolerant-degrade: a bare target whose required params are absent (e.g.
    // generic "open chat" with no contact) strips the unfilled {param} query/hash
    // segments instead of throwing, so navigate('chat') still resolves. This keeps
    // route-registry.js untouched as the SoT (its buildWebUrl stays strict).
    function buildUrl(target, params) {
        params = params || {};
        if (!registry || !registry.isKnownTarget(target)) {
            // No registry / unknown target: last-resort same-origin no-op guard.
            return null;
        }
        try {
            return registry.buildWebUrl(target, params);
        } catch (e) {
            // Missing/invalid param → build the bare path by dropping unfilled tokens.
            return _bareUrl(target);
        }
    }

    function _bareUrl(target) {
        var raw = registry.ROUTES[target].web; // e.g. '/portal/chat.html?contact={publicCode}'
        // Drop a trailing '?a={x}&b={y}' / '#{x}' whose tokens were never filled.
        var path = raw.split(/[?#]/)[0];
        return path;
    }

    // ── Per-mode dispatch (spec §3) ──
    var _pendingAcks = {}; // requestId -> timer handle (split mode)

    function navigate(target, opts) {
        opts = opts || {};
        var params = opts.params || opts; // allow navigate(t, {params}) or navigate(t, params)
        var mode = SmartRouter.mode;

        if (mode === 'app') return _navigateApp(target, params, opts);
        if (mode === 'split') return _navigateSplit(target, params, opts);
        return _navigateSingle(target, params);
    }

    function _navigateSingle(target, params) {
        var url = buildUrl(target, params);
        if (!url) return false;
        global.location.assign(url); // never replace() — natural browser history (spec §Q3)
        return true;
    }

    function _navigateApp(target, params, opts) {
        var tab = APP_TARGET_TAB[target];
        if (!tab) return _navigateSingle(target, params); // unmapped → immediate single fallback
        try {
            var ok = global.EClawNativeNav.navigate(Object.assign({
                targetTab: tab,
                sourceTab: opts.sourceTab,
                target: target
            }, params));
            if (ok === false) return _navigateSingle(target, params); // bridge declined → degrade
            return true;
        } catch (_) {
            return _navigateSingle(target, params); // bridge threw → degrade
        }
    }

    function _navigateSplit(target, params, opts) {
        if (!_parentIsSameOrigin()) return _navigateSingle(target, params);
        var requestId = 'nav_' + _hex8();
        var origin = global.location.origin;
        var degraded = false;

        // 300ms timer: no ack → degrade to single (full-page navigate). A late ack
        // after degradation is ignored because the requestId is no longer pending.
        _pendingAcks[requestId] = global.setTimeout(function () {
            delete _pendingAcks[requestId];
            if (!degraded) {
                degraded = true;
                _navigateSingle(target, params);
            }
        }, SPLIT_ACK_TIMEOUT_MS);

        global.parent.postMessage({
            type: 'split_navigate',
            requestId: requestId,
            target: target,
            params: params,
            panel: 'self'
        }, origin);
        return true;
    }

    // Listen for the host's ack (split mode) — cancels the degrade timer.
    function _onMessage(e) {
        if (e.origin !== global.location.origin || !e.data) return;
        if (e.data.type === 'split_navigate_ack' && e.data.requestId) {
            var timer = _pendingAcks[e.data.requestId];
            if (timer) {
                global.clearTimeout(timer);
                delete _pendingAcks[e.data.requestId];
            }
        }
        if (e.data.type === 'split_navigated' && _navHandlers.length) {
            _navHandlers.forEach(function (h) { try { h(e.data); } catch (_) {} });
        }
    }

    // ── onNavigate(handler) — in-mode transition hook (spec §3) ──
    var _navHandlers = [];
    function onNavigate(handler) {
        if (typeof handler !== 'function') return;
        _navHandlers.push(handler);
        if (SmartRouter.mode === 'app') {
            // Wrap the existing native replay so pages subscribe once.
            global.eclawHandleNativeNavigateIntent = function (intent) {
                _navHandlers.forEach(function (h) { try { h(intent); } catch (_) {} });
            };
        }
        // 'single' is a no-op (full reload re-boots the page).
    }

    function _hex8() {
        var s = '';
        for (var i = 0; i < 8; i++) s += Math.floor(Math.random() * 16).toString(16);
        return s;
    }

    var SmartRouter = {
        mode: 'single', // overwritten at boot
        navigate: navigate,
        onNavigate: onNavigate,
        buildUrl: buildUrl,
        detectMode: detectMode,        // exposed for tests
        APP_TARGET_TAB: APP_TARGET_TAB // exposed for tests
    };

    function boot() {
        SmartRouter.mode = detectMode();
        if (global.document && global.document.body) {
            global.document.body.dataset.navMode = SmartRouter.mode; // spec §2 marker
        }
        global.addEventListener('message', _onMessage);
    }

    // Boot now if DOM is ready, else on DOMContentLoaded (body must exist for data-nav-mode).
    if (global.document && global.document.body) {
        boot();
    } else if (global.document) {
        global.document.addEventListener('DOMContentLoaded', boot);
    }

    global.SmartRouter = SmartRouter;

    // CJS export for jest (jsdom) — tests can require() and drive detectMode/buildUrl.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = SmartRouter;
    }
})(typeof window !== 'undefined' ? window : this);
