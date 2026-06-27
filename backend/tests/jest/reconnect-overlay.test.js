const fs = require('fs');
const path = require('path');

// Regression for the false "網路連線中斷，正在重新連線…" (reconnecting) banner that
// stayed up in the Android chat WebView even though the user could send/receive
// messages (Hank P0 2026-06-27).
//
// Root cause: the portal reconnect overlay (backend/public/portal/shared/
// reconnect-overlay.js) was shown by ANY transport-level fetch failure and could
// only ever clear itself via its own GET /api/version probe. It ignored the
// transport the user actually depends on — the live socket + /api/client/speak —
// so a lone background-poll blip (or a spurious Android-WebView `offline` event)
// flashed the banner while messaging kept working, and a successful message
// round-trip never cleared it.
//
// Fix:
//   1. noteServerReachable() — proof-of-connectivity signal, called by api.js on
//      every 2xx round-trip and by socket.js on (re)connect; clears the banner.
//   2. transient-blip grace — a failure that lands within RECENT_OK_MS of proof
//      is verified by a probe before the banner is ever revealed.
//
// jest env here is 'node' (no jsdom), so the DOM-coupled overlay IIFE is loaded
// into a hand-rolled window/document stub via `new Function` and exercised for
// real (state machine + probe + timers), rather than statically scanned.

const SHARED = path.join(__dirname, '..', '..', 'public', 'portal', 'shared');
const OVERLAY_PATH = path.join(SHARED, 'reconnect-overlay.js');
const API_PATH = path.join(SHARED, 'api.js');
const SOCKET_PATH = path.join(SHARED, 'socket.js');

function makeNode() {
    const node = {
        _children: [],
        style: {},
        attributes: {},
        title: '',
        _classes: new Set(),
        classList: {
            add: (c) => node._classes.add(c),
            remove: (c) => node._classes.delete(c),
            contains: (c) => node._classes.has(c),
        },
        setAttribute(k, v) { this.attributes[k] = v; },
        appendChild(c) { this._children.push(c); return c; },
    };
    return node;
}

// Build a fresh sandbox and load the overlay IIFE into it.
function loadOverlay(opts = {}) {
    const registry = {};
    const document = {
        getElementById: (id) => registry[id] || null,
        createElement: () => {
            const n = makeNode();
            Object.defineProperty(n, 'id', {
                get() { return n._id; },
                set(v) { n._id = v; if (v) registry[v] = n; },
                configurable: true,
            });
            return n;
        },
        head: makeNode(),
        body: makeNode(),
    };
    const listeners = {};
    const window = {
        addEventListener: (ev, cb) => { (listeners[ev] = listeners[ev] || []).push(cb); },
    };
    const nowRef = { value: opts.now || 100000 };
    const DateStub = { now: () => nowRef.value };
    const fetchRef = { fn: opts.fetchFn || (async () => ({ ok: true })) };
    const fetchFn = (...args) => fetchRef.fn(...args);
    const raf = (cb) => { cb(); return 1; };

    const src = fs.readFileSync(OVERLAY_PATH, 'utf8');
    // Free identifiers in the IIFE (window/document/fetch/timers/Date) resolve to
    // these params; built-ins (Promise/Math) stay native so async/await is real.
    // eslint-disable-next-line no-new-func
    const runner = new Function(
        'window', 'document', 'requestAnimationFrame', 'fetch', 'setTimeout', 'clearTimeout', 'Date',
        src,
    );
    runner(window, document, raf, fetchFn, setTimeout, clearTimeout, DateStub);

    return {
        overlay: window.__reconnectOverlay,
        registry,
        setNow: (v) => { nowRef.value = v; },
        setFetch: (fn) => { fetchRef.fn = fn; },
        fireWindow: (ev) => (listeners[ev] || []).forEach((cb) => cb()),
    };
}

describe('reconnect overlay — false-disconnect banner', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.useRealTimers(); });

    test('exposes a noteServerReachable() connectivity signal', () => {
        const { overlay } = loadOverlay();
        expect(typeof overlay.noteServerReachable).toBe('function');
    });

    test('show() reveals the banner when nothing proved the channel good recently', () => {
        const { overlay } = loadOverlay({ now: 100000 }); // lastReachable=0 → no recent proof
        overlay.show();
        expect(overlay.isVisible()).toBe(true);
    });

    // FAIL-ON-OLD: old overlay had no way to clear on a proven round-trip; the
    // banner could only self-clear via its own /api/version probe.
    test('noteServerReachable() clears a visible reconnect banner (a message round-tripped)', () => {
        const { overlay } = loadOverlay({ now: 100000 });
        overlay.show();
        expect(overlay.isVisible()).toBe(true);
        overlay.noteServerReachable(); // simulate a successful apiCall / socket connect
        expect(overlay.isVisible()).toBe(false);
    });

    // FAIL-ON-OLD: old show() revealed immediately on the first failed request, so
    // a lone blip while messaging works flashed the scary banner.
    test('a transient blip right after a good round-trip does NOT alarm the user', async () => {
        const { overlay, setNow } = loadOverlay({ now: 100000, fetchFn: async () => ({ ok: true }) });
        overlay.noteServerReachable();   // proof the channel is good at t=100000
        setNow(101000);                  // 1s later — well within the grace window
        overlay.show();                  // a single background fetch just failed
        expect(overlay.isVisible()).toBe(false); // held back — not alarmed

        // The corroborating probe finds the server reachable → banner stays hidden.
        await jest.advanceTimersByTimeAsync(6000);
        expect(overlay.isVisible()).toBe(false);
    });

    test('a blip that the probe CANNOT corroborate is escalated to a real banner', async () => {
        let online = true; // probe will fail
        const { overlay, setNow } = loadOverlay({
            now: 100000,
            fetchFn: async () => { if (!online) throw new Error('net'); return { ok: true }; },
        });
        overlay.noteServerReachable();
        setNow(101000);
        online = false;             // network truly dropped right after the proof
        overlay.show();
        expect(overlay.isVisible()).toBe(false); // suspect first, don't flash
        await jest.advanceTimersByTimeAsync(5000); // probe fails → corroborated
        expect(overlay.isVisible()).toBe(true);
    });

    test('a genuine outage stays shown until a probe confirms recovery (no false hide, no latch)', async () => {
        let online = false;
        const { overlay } = loadOverlay({
            now: 100000,
            fetchFn: async () => { if (!online) throw new Error('net'); return { ok: true }; },
        });
        overlay.show();                              // no recent proof → reveal immediately
        expect(overlay.isVisible()).toBe(true);
        await jest.advanceTimersByTimeAsync(5000);   // probe #1 fails
        expect(overlay.isVisible()).toBe(true);      // still down → stays up (not falsely hidden)
        online = true;
        await jest.advanceTimersByTimeAsync(30000);  // a later probe succeeds (backoff)
        expect(overlay.isVisible()).toBe(false);     // recovered → cleared, did not latch
    });
});

describe('reconnect overlay — wiring into the real transports', () => {
    // FAIL-ON-OLD: old api.js never told the overlay about a successful round-trip.
    test('api.js clears the banner on a successful (2xx) apiCall round-trip', () => {
        const src = fs.readFileSync(API_PATH, 'utf8');
        expect(src).toMatch(/__reconnectOverlay\.noteServerReachable\s*\(\s*\)/);
    });

    // FAIL-ON-OLD: old socket.js 'connect' handler only logged + updated the badge.
    test("socket.js clears the banner when the live socket (re)connects", () => {
        const src = fs.readFileSync(SOCKET_PATH, 'utf8');
        expect(src).toMatch(/on\('connect'[\s\S]{0,900}__reconnectOverlay\.noteServerReachable\s*\(\s*\)/);
    });
});
