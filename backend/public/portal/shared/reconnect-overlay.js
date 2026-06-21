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
        const t = (k, fb) => (window.i18n && window.i18n.t) ? window.i18n.t(k, fb) : fb;
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

    function show() {
        const el = ensureBanner();
        if (!visible) {
            visible = true;
            requestAnimationFrame(() => el.classList.add('visible'));
            scheduleProbe();
        }
    }

    function hide() {
        const el = document.getElementById(BANNER_ID);
        if (el) el.classList.remove('visible');
        visible = false;
        probeDelay = 5000;
        if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
    }

    async function probe() {
        try {
            const r = await fetch('/api/version', { credentials: 'include', cache: 'no-store' });
            if (r && r.ok) { hide(); return; }
        } catch (_) { /* still offline */ }
        probeDelay = Math.min(30000, Math.round(probeDelay * 1.5));
        scheduleProbe();
    }

    function scheduleProbe() {
        if (probeTimer) clearTimeout(probeTimer);
        probeTimer = setTimeout(probe, probeDelay);
    }

    window.addEventListener('online', () => { if (visible) probe(); });
    window.addEventListener('offline', () => { show(); });

    window.__reconnectOverlay = { show, hide, isVisible: () => visible };
})();
