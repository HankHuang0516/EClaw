/**
 * Product Tour — minimal spotlight + callout overlay for onboarding flows.
 *
 * Usage:
 *   ProductTour.register('track1', [
 *     { target: '#rental-chip', i18nKey: 'onboarding_tour_track1_step1', fallback: '...' },
 *     { target: () => document.querySelector('.bot-card'), i18nKey: 'onboarding_tour_track1_step2' },
 *     ...
 *   ]);
 *   ProductTour.start('track1');
 *   ProductTour.goTo('track1', 3);  // resume at step (0-indexed)
 *   ProductTour.isDone('track1');
 *   ProductTour.markDone('track1');
 *
 * Cross-page: pages read URL param ?tour=<id>&step=<n> and resume via goTo.
 * State persists in localStorage: eclaw_tour_<id>_step, eclaw_tour_<id>_done.
 */
(function (global) {
    'use strict';

    const STYLE_ID = 'product-tour-style';
    const CSS = `
        .pt-overlay {
            position: fixed; inset: 0; z-index: 99998;
            background: rgba(0,0,0,0.55);
            pointer-events: auto;
            transition: clip-path 0.22s ease;
        }
        .pt-spotlight {
            position: fixed; z-index: 99999;
            border-radius: 10px;
            box-shadow: 0 0 0 4px rgba(124,58,237,0.7), 0 0 0 9999px rgba(0,0,0,0.55);
            pointer-events: none;
            transition: top 0.22s ease, left 0.22s ease, width 0.22s ease, height 0.22s ease;
        }
        .pt-callout {
            position: fixed; z-index: 100000;
            max-width: 320px; min-width: 220px;
            background: #fff; color: #222;
            border-radius: 12px;
            padding: 14px 16px 12px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.35);
            font-size: 14px; line-height: 1.5;
        }
        @media (prefers-color-scheme: dark) {
            .pt-callout { background: #1f2937; color: #f3f4f6; }
        }
        .pt-callout-text { margin: 0 0 12px; }
        .pt-callout-progress { font-size: 11px; color: #6b7280; margin-bottom: 6px; }
        .pt-callout-actions { display: flex; justify-content: flex-end; gap: 8px; }
        .pt-btn {
            font: inherit;
            border-radius: 8px;
            padding: 6px 14px;
            border: 1px solid transparent;
            cursor: pointer;
        }
        .pt-btn-primary { background: #7c3aed; color: #fff; }
        .pt-btn-primary:hover { background: #6d28d9; }
        .pt-btn-ghost { background: transparent; color: inherit; border-color: rgba(0,0,0,0.15); }
        .pt-callout .pt-close {
            position: absolute; top: 6px; right: 8px;
            background: transparent; border: 0; font-size: 16px;
            cursor: pointer; color: inherit; opacity: 0.6;
        }
        .pt-callout .pt-close:hover { opacity: 1; }
    `;

    const tours = Object.create(null);
    let active = null;  // { id, stepIdx, step, els: { overlay, spotlight, callout } }

    function injectStyle() {
        if (document.getElementById(STYLE_ID)) return;
        const s = document.createElement('style');
        s.id = STYLE_ID;
        s.textContent = CSS;
        document.head.appendChild(s);
    }

    function lsKey(id, suffix) { return `eclaw_tour_${id}_${suffix}`; }

    function register(id, steps, opts) {
        tours[id] = { steps, opts: opts || {} };
    }

    function isDone(id) { return localStorage.getItem(lsKey(id, 'done')) === '1'; }
    function markDone(id) { localStorage.setItem(lsKey(id, 'done'), '1'); }
    function savedStep(id) { return parseInt(localStorage.getItem(lsKey(id, 'step')) || '0', 10) || 0; }

    function translate(step) {
        const fb = step.fallback || '';
        if (step.i18nKey && typeof global.i18n !== 'undefined' && global.i18n.t) {
            const v = global.i18n.t(step.i18nKey);
            if (v && v !== step.i18nKey) return v;
        }
        return fb;
    }

    function resolveTarget(step, cb) {
        const deadline = Date.now() + (step.timeout || 8000);
        const tryFind = () => {
            let el = null;
            try {
                if (typeof step.target === 'function') el = step.target();
                else if (typeof step.target === 'string') el = document.querySelector(step.target);
            } catch (_) { el = null; }
            if (el && el.offsetParent !== null) { cb(el); return; }
            if (Date.now() > deadline) { cb(null); return; }
            setTimeout(tryFind, 180);
        };
        tryFind();
    }

    function teardown() {
        if (!active) return;
        ['overlay', 'spotlight', 'callout'].forEach(k => {
            if (active.els[k] && active.els[k].parentNode) active.els[k].parentNode.removeChild(active.els[k]);
        });
        document.removeEventListener('keydown', active.onKey, true);
        window.removeEventListener('resize', active.onReposition);
        window.removeEventListener('scroll', active.onReposition, true);
        active = null;
    }

    function positionCallout(calloutEl, rect) {
        const vw = window.innerWidth, vh = window.innerHeight;
        const cw = calloutEl.offsetWidth || 280, ch = calloutEl.offsetHeight || 120;
        const pad = 12;
        let top = rect.bottom + pad;
        let left = rect.left + (rect.width / 2) - (cw / 2);
        if (top + ch + pad > vh) top = Math.max(pad, rect.top - ch - pad);
        left = Math.max(pad, Math.min(left, vw - cw - pad));
        calloutEl.style.top = top + 'px';
        calloutEl.style.left = left + 'px';
    }

    function renderStep(targetEl) {
        const { step, stepIdx, id } = active;
        const tour = tours[id];
        const total = (tour.opts && tour.opts.totalSteps) || tour.steps.length;
        const displayNum = step.stepNumber || (stepIdx + 1);

        const overlay = document.createElement('div');
        overlay.className = 'pt-overlay';
        overlay.addEventListener('click', (e) => { if (e.target === overlay) { /* click-outside is soft dismiss */ dismiss(); } });

        const spotlight = document.createElement('div');
        spotlight.className = 'pt-spotlight';

        const callout = document.createElement('div');
        callout.className = 'pt-callout';
        const closeLabel = (typeof global.i18n !== 'undefined' && global.i18n.t('onboarding_tour_skip')) || 'Skip';
        const nextLabel = stepIdx === total - 1
            ? ((typeof global.i18n !== 'undefined' && global.i18n.t('onboarding_tour_finish')) || 'Finish')
            : ((typeof global.i18n !== 'undefined' && global.i18n.t('onboarding_tour_next')) || 'Next');
        const text = translate(step);
        callout.innerHTML = `
            <button class="pt-close" type="button" aria-label="Close">×</button>
            <div class="pt-callout-progress">${displayNum} / ${total}</div>
            <p class="pt-callout-text"></p>
            <div class="pt-callout-actions">
                <button class="pt-btn pt-btn-ghost" data-role="skip" type="button"></button>
                <button class="pt-btn pt-btn-primary" data-role="next" type="button"></button>
            </div>
        `;
        callout.querySelector('.pt-callout-text').textContent = text;
        callout.querySelector('[data-role="skip"]').textContent = closeLabel;
        callout.querySelector('[data-role="next"]').textContent = nextLabel;

        document.body.appendChild(overlay);
        document.body.appendChild(callout);
        document.body.appendChild(spotlight);
        active.els = { overlay, spotlight, callout };

        const reposition = () => {
            const rect = targetEl.getBoundingClientRect();
            const pad = 6;
            spotlight.style.top = (rect.top - pad) + 'px';
            spotlight.style.left = (rect.left - pad) + 'px';
            spotlight.style.width = (rect.width + pad * 2) + 'px';
            spotlight.style.height = (rect.height + pad * 2) + 'px';
            positionCallout(callout, rect);
        };
        reposition();
        active.onReposition = reposition;
        window.addEventListener('resize', reposition);
        window.addEventListener('scroll', reposition, true);

        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); dismiss(); }
            else if (e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); next(); }
        };
        document.addEventListener('keydown', onKey, true);
        active.onKey = onKey;

        callout.querySelector('.pt-close').addEventListener('click', dismiss);
        callout.querySelector('[data-role="skip"]').addEventListener('click', dismiss);
        callout.querySelector('[data-role="next"]').addEventListener('click', next);

        if (step.highlightClick !== false) {
            // Allow user to still click through the spotlight
            spotlight.style.pointerEvents = 'none';
            overlay.style.pointerEvents = 'none';
        }
    }

    function startAtIndex(id, stepIdx) {
        const tour = tours[id];
        if (!tour) { console.warn('[tour] not registered:', id); return; }
        if (stepIdx < 0 || stepIdx >= tour.steps.length) { markDone(id); teardown(); return; }
        const step = tour.steps[stepIdx];
        teardown();
        injectStyle();
        active = { id, stepIdx, step, els: {} };
        localStorage.setItem(lsKey(id, 'step'), String(stepIdx));
        if (typeof step.onBeforeShow === 'function') {
            try { step.onBeforeShow(); } catch (_) {}
        }
        resolveTarget(step, (el) => {
            if (!active || active.stepIdx !== stepIdx) return;
            if (!el) {
                // Target not found — skip to next step silently so the tour doesn't wedge.
                console.warn('[tour] target not found for step', stepIdx, step.target);
                return startAtIndex(id, stepIdx + 1);
            }
            renderStep(el);
        });
    }

    function start(id) {
        if (isDone(id)) return;
        const resumeAt = savedStep(id);
        startAtIndex(id, resumeAt);
    }

    function goTo(id, stepIdx) {
        if (isDone(id)) return;
        startAtIndex(id, stepIdx);
    }

    function next() {
        if (!active) return;
        const { id, stepIdx, step } = active;
        if (typeof step.onNext === 'function') {
            try { step.onNext(); } catch (_) {}
        }
        const tour = tours[id];
        if (stepIdx + 1 >= tour.steps.length) {
            markDone(id);
            teardown();
            if (tour.opts && typeof tour.opts.onComplete === 'function') tour.opts.onComplete();
            return;
        }
        startAtIndex(id, stepIdx + 1);
    }

    function dismiss() {
        if (!active) return;
        const { id } = active;
        markDone(id);
        teardown();
        const tour = tours[id];
        if (tour && tour.opts && typeof tour.opts.onDismiss === 'function') tour.opts.onDismiss();
    }

    function getState() {
        if (!active) return null;
        return { id: active.id, stepIdx: active.stepIdx };
    }

    global.ProductTour = {
        register, start, goTo, next, dismiss,
        isDone, markDone, getState
    };

})(typeof window !== 'undefined' ? window : this);
