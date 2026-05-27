/**
 * E-Claw Portal — Page Transition Overlay
 *
 * Shows a lightweight loading overlay during cross-page navigation so the
 * user does not stare at a blank/old screen while the new page is loading.
 *
 * Behavior:
 *   - 200ms delayed-show — sub-perceptual transitions (BFCache, warm cache)
 *     skip the flash entirely
 *   - 8s safety timeout — overlay self-clears if a nav stalls / aborts
 *   - intercepts only same-origin in-app <a> clicks (target=_blank, external,
 *     mailto:, tel:, javascript:, and download attributes are skipped)
 *   - pageshow + DOMContentLoaded clear the overlay on arrival (covers
 *     BFCache restore + normal navigation)
 *
 * Include AFTER ../shared/i18n.js so i18n.t() is available when text resolves:
 *   <script src="../shared/transition-overlay.js"></script>
 */
(function () {
    'use strict';

    if (window.__eclawTransitionOverlayLoaded) return;
    window.__eclawTransitionOverlayLoaded = true;

    var SHOW_DELAY_MS = 200;
    var SAFETY_TIMEOUT_MS = 8000;

    var overlayEl = null;
    var spinnerEl = null;
    var labelEl = null;
    var showTimer = null;
    var safetyTimer = null;
    var injected = false;

    function injectStyles() {
        if (document.getElementById('eclaw-transition-overlay-style')) return;
        var style = document.createElement('style');
        style.id = 'eclaw-transition-overlay-style';
        style.textContent =
            '#eclaw-transition-overlay{' +
                'position:fixed;inset:0;z-index:2147483600;' +
                'display:none;align-items:center;justify-content:center;' +
                'flex-direction:column;gap:14px;' +
                'background:rgba(15,15,20,0.55);' +
                'backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);' +
                'color:#fff;font:500 15px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;' +
                'pointer-events:auto;opacity:0;transition:opacity 140ms ease-out;' +
            '}' +
            '#eclaw-transition-overlay.is-visible{display:flex;opacity:1}' +
            '#eclaw-transition-overlay .eclaw-transition-spinner{' +
                'width:42px;height:42px;border-radius:50%;' +
                'border:3px solid rgba(255,255,255,0.25);' +
                'border-top-color:#fff;' +
                'animation:eclawTransitionSpin 720ms linear infinite;' +
            '}' +
            '#eclaw-transition-overlay .eclaw-transition-label{' +
                'letter-spacing:0.02em;text-shadow:0 1px 2px rgba(0,0,0,0.4);' +
            '}' +
            '@keyframes eclawTransitionSpin{to{transform:rotate(360deg)}}' +
            '@media (prefers-reduced-motion: reduce){' +
                '#eclaw-transition-overlay .eclaw-transition-spinner{animation-duration:1600ms}' +
            '}';
        (document.head || document.documentElement).appendChild(style);
    }

    function ensureDom() {
        if (injected && overlayEl) return overlayEl;
        injectStyles();
        overlayEl = document.createElement('div');
        overlayEl.id = 'eclaw-transition-overlay';
        overlayEl.setAttribute('role', 'status');
        overlayEl.setAttribute('aria-live', 'polite');
        overlayEl.setAttribute('aria-hidden', 'true');
        spinnerEl = document.createElement('div');
        spinnerEl.className = 'eclaw-transition-spinner';
        labelEl = document.createElement('div');
        labelEl.className = 'eclaw-transition-label';
        labelEl.setAttribute('data-i18n', 'transition_loading');
        labelEl.textContent = resolveLabel();
        overlayEl.appendChild(spinnerEl);
        overlayEl.appendChild(labelEl);
        var parent = document.body || document.documentElement;
        parent.appendChild(overlayEl);
        injected = true;
        return overlayEl;
    }

    function resolveLabel() {
        try {
            if (window.i18n && typeof window.i18n.t === 'function') {
                var v = window.i18n.t('transition_loading');
                if (v && v !== 'transition_loading') return v;
            }
        } catch (e) { /* noop */ }
        return 'Loading…';
    }

    function show() {
        var el = ensureDom();
        labelEl.textContent = resolveLabel();
        el.classList.add('is-visible');
        el.setAttribute('aria-hidden', 'false');
    }

    function hide() {
        if (showTimer) { clearTimeout(showTimer); showTimer = null; }
        if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
        if (!overlayEl) return;
        overlayEl.classList.remove('is-visible');
        overlayEl.setAttribute('aria-hidden', 'true');
    }

    function scheduleShow() {
        if (showTimer || (overlayEl && overlayEl.classList.contains('is-visible'))) return;
        showTimer = setTimeout(function () {
            showTimer = null;
            show();
        }, SHOW_DELAY_MS);
        safetyTimer = setTimeout(function () {
            hide();
        }, SAFETY_TIMEOUT_MS);
    }

    function isSameOriginNav(anchor) {
        if (!anchor || !anchor.href) return false;
        if (anchor.target && anchor.target !== '' && anchor.target !== '_self') return false;
        if (anchor.hasAttribute('download')) return false;
        var proto = (anchor.protocol || '').toLowerCase();
        if (proto === 'javascript:' || proto === 'mailto:' || proto === 'tel:' || proto === 'sms:') return false;
        if (anchor.origin && window.location && anchor.origin !== window.location.origin) return false;
        if (anchor.hash && anchor.pathname === window.location.pathname && anchor.search === window.location.search) {
            return false;
        }
        return true;
    }

    function onAnchorClick(event) {
        if (event.defaultPrevented) return;
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        var node = event.target;
        while (node && node !== document) {
            if (node.tagName === 'A') {
                if (isSameOriginNav(node)) scheduleShow();
                return;
            }
            node = node.parentNode;
        }
    }

    function onBeforeUnload() {
        scheduleShow();
    }

    function onArrival() {
        hide();
    }

    function init() {
        ensureDom();
        document.addEventListener('click', onAnchorClick, true);
        window.addEventListener('beforeunload', onBeforeUnload);
        window.addEventListener('pagehide', onBeforeUnload);
        window.addEventListener('pageshow', onArrival);
        document.addEventListener('DOMContentLoaded', onArrival);
        if (document.readyState === 'complete' || document.readyState === 'interactive') {
            onArrival();
        }
    }

    window.eclawTransitionOverlay = {
        show: function () { scheduleShow(); },
        hide: hide,
        _force: show
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
