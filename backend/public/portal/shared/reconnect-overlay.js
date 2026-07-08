(function () {
    'use strict';
    if (window.__reconnectOverlay) return;

    const STYLE_ID = '__reconnect-overlay-style';
    const BANNER_ID = '__reconnect-overlay-banner';

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent =
            '#' + BANNER_ID + '{position:fixed;top:0;left:0;right:0;z-index:99999;' +
            'background:rgba(220,38,38,0.95);color:#fff;text-align:center;' +
            'padding:10px 16px;font-size:14px;font-weight:600;' +
            'box-shadow:0 2px 6px rgba(0,0,0,0.2);transition:transform 0.18s ease;' +
            'transform:translateY(-100%);}' +
            '#' + BANNER_ID + '.visible{transform:translateY(0);}' +
            '#' + BANNER_ID + ' .spinner{display:inline-block;width:12px;height:12px;' +
            'border:2px solid rgba(255,255,255,0.4);border-top-color:#fff;' +
            'border-radius:50%;animation:rcSpin 0.8s linear infinite;' +
            'vertical-align:middle;margin-right:8px;}' +
            '@keyframes rcSpin{to{transform:rotate(360deg);}}';
        document.head.appendChild(s);
    }

    function ensureBanner() {
        let el = document.getElementById(BANNER_ID);
        if (el) return el;
        ensureStyle();
        el = document.createElement('div');
        el.id = BANNER_ID;
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        // i18n.t(key, params) treats the 2nd arg as {name}-substitution params, NOT a
        // fallback, and returns the bare key string when the key is missing. So pass the
        // inline fallback ourselves when i18n has no translation (card_4cafbf7e QA).
        const t = (k, fb) => {
            if (window.i18n && window.i18n.t) {
                const v = window.i18n.t(k);
                if (v && v !== k) return v;
            }
            return fb;
        };
        el.innerHTML = '<span class="spinner" aria-hidden="true"></span>' +
            '<span>' + t('reconnect_overlay_text', '網路連線中斷，正在重新連線…') + '</span>';
        el.title = t('reconnect_overlay_help',
            '網路連線中斷，正在自動重連。Session 仍有效，不需重新登入。');
        document.body.appendChild(el);
        return el;
    }

    let visible = false;
    let probeTimer = null;
    let probeDelay = 5000;
    // True while a request has FAILED but we have not yet alarmed the user — we
    // hold the banner back and let a corroborating probe decide. This stops a
    // lone transient blip (mobile radio sleep, network handoff, a single dropped
    // background poll) from flashing the scary "disconnected" banner while the
    // live socket + messaging are perfectly healthy. (false-disconnect-banner fix)
    let suspecting = false;
    // Timestamp of the last PROVEN-good round-trip: a 2xx apiCall, a live-socket
    // (re)connect, or a message that actually went through. A failure that lands
    // within RECENT_OK_MS of proof is almost certainly a blip, not a real outage,
    // so we verify before alarming rather than flashing the banner.
    let lastReachableTs = 0;
    const RECENT_OK_MS = 6000;

    // Actually mount + slide the banner in. Separated from show() so the
    // suspect-then-corroborate path can defer the visible alarm.
    function reveal() {
        const el = ensureBanner();
        if (!visible) {
            visible = true;
            requestAnimationFrame(() => el.classList.add('visible'));
        }
        if (!probeTimer) scheduleProbe();
    }

    // A request failed (transport throw / offline event / unavailable). Decide
    // whether that is worth alarming the user about.
    function show() {
        if (visible) return;
        // If the channel proved good a moment ago, treat this as a possible blip:
        // probe quietly first and only reveal the banner if the probe ALSO fails.
        if (Date.now() - lastReachableTs < RECENT_OK_MS) {
            if (!suspecting) { suspecting = true; if (!probeTimer) scheduleProbe(); }
            return;
        }
        reveal();
    }

    function hide() {
        const el = document.getElementById(BANNER_ID);
        if (el) el.classList.remove('visible');
        visible = false;
        suspecting = false;
        probeDelay = 5000;
        if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
    }

    // Proof that the channel the user depends on is up: a 2xx apiCall round-tripped,
    // the live socket (re)connected, or a message was sent/received. Record it and
    // clear any stale banner immediately — never leave "reconnecting…" up while
    // messaging demonstrably works. This is the signal the old code lacked: the
    // banner could only clear via the /api/version probe and ignored the very
    // transport (WebSocket + /api/client/speak) the user was actually using.
    function noteServerReachable() {
        lastReachableTs = Date.now();
        hide();
    }

    async function probe() {
        probeTimer = null;
        if (!visible && !suspecting) return; // nothing to probe for
        try {
            const r = await fetch('/api/version', { credentials: 'include', cache: 'no-store' });
            if (r && r.ok) { noteServerReachable(); return; }
        } catch (_) { /* still unreachable */ }
        // Probe failed → the disconnect looks real. If we were only suspecting (held
        // the banner back as a possible blip), corroborate it now and reveal.
        if (suspecting) { suspecting = false; reveal(); return; }
        probeDelay = Math.min(30000, Math.round(probeDelay * 1.5));
        scheduleProbe();
    }

    function scheduleProbe() {
        if (probeTimer) clearTimeout(probeTimer);
        probeTimer = setTimeout(probe, probeDelay);
    }

    window.addEventListener('online', () => { if (visible || suspecting) probe(); });
    window.addEventListener('offline', () => { show(); });

    window.__reconnectOverlay = { show, hide, isVisible: () => visible, noteServerReachable };
})();
