/**
 * Outbox UI helpers — spec acceptance #4 (bubble states) + #5 (banner).
 * Card: card_751775f0435f3a17e669d12a. Spec: docs/offline-delivery-queue-spec.md.
 *
 * Pure DOM helpers separated from chat.html so they can be exercised under
 * jsdom in Jest without booting the whole portal page. Three responsibilities:
 *   1. updateBanner()      — flips #outboxBanner visibility + text from stats
 *   2. renderQueuedBubble  — appends an inline outbox bubble while the entry
 *                            sits in localStorage waiting to be flushed
 *   3. setBubbleState/remove — flip the bubble's state class on transitions
 *   4. attachTapHandlers    — delegated click → cancel/retry/delete
 */
(function (global) {
    'use strict';

    // 'sending' = online optimistic first attempt (情緒價值 #2). It is NOT
    // tap-cancellable like queued/retrying — the POST is already in flight.
    var STATES = ['queued', 'sending', 'retrying', 'sent', 'failed'];

    function tt(t, key, fallback) {
        if (typeof t === 'function') {
            try { var v = t(key); if (v && v !== key) return v; } catch (_e) { /* swallow */ }
        }
        return fallback;
    }

    function updateBanner(bannerEl, textEl, stats, t) {
        if (!bannerEl || !textEl) return;
        var by = (stats && stats.by) || {};
        var queued = by.queued || 0;
        var retrying = by.retrying || 0;
        if (queued === 0 && retrying === 0) {
            bannerEl.hidden = true;
            textEl.textContent = '';
            return;
        }
        var parts = [];
        if (queued > 0) {
            var qTpl = tt(t, 'chat_outbox_queued_n', '{n} queued');
            parts.push(qTpl.replace('{n}', String(queued)));
        }
        if (retrying > 0) {
            var rTpl = tt(t, 'chat_outbox_retrying_n', '{n} retrying');
            parts.push(rTpl.replace('{n}', String(retrying)));
        }
        textEl.textContent = parts.join(' · ');
        bannerEl.hidden = false;
    }

    function findBubble(container, idempotencyKey) {
        if (!container || !idempotencyKey) return null;
        return container.querySelector('[data-outbox-key="' + cssEscape(idempotencyKey) + '"]');
    }

    function cssEscape(s) {
        // jsdom may lack CSS.escape; escape only what closes the attr-value
        // selector — backslash and the surrounding double quote.
        return String(s).replace(/["\\]/g, '\\$&');
    }

    function renderQueuedBubble(container, opts) {
        if (!container || !opts || !opts.idempotencyKey) return null;
        var existing = findBubble(container, opts.idempotencyKey);
        if (existing) return existing;
        var doc = container.ownerDocument || global.document;
        var wrap = doc.createElement('div');
        wrap.className = 'chat-msg sent msg-outbox msg-outbox-queued';
        wrap.setAttribute('data-outbox-key', opts.idempotencyKey);
        wrap.setAttribute('role', 'button');
        wrap.setAttribute('tabindex', '0');

        var bubble = doc.createElement('div');
        bubble.className = 'chat-bubble';
        bubble.textContent = String(opts.text || '');
        wrap.appendChild(bubble);

        var spinner = doc.createElement('span');
        spinner.className = 'msg-outbox-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        wrap.appendChild(spinner);

        var warn = doc.createElement('span');
        warn.className = 'msg-outbox-warn';
        warn.setAttribute('aria-hidden', 'true');
        warn.textContent = '⚠️';
        wrap.appendChild(warn);

        container.appendChild(wrap);
        return wrap;
    }

    function setBubbleState(container, idempotencyKey, state) {
        var el = findBubble(container, idempotencyKey);
        if (!el) return null;
        if (STATES.indexOf(state) === -1) return el;
        STATES.forEach(function (s) {
            el.classList.remove('msg-outbox-' + s);
        });
        el.classList.add('msg-outbox-' + state);
        return el;
    }

    function removeBubble(container, idempotencyKey) {
        var el = findBubble(container, idempotencyKey);
        if (el && el.parentNode) el.parentNode.removeChild(el);
        return !!el;
    }

    function classifyClick(target) {
        // Walk up to find the nearest outbox bubble + its state.
        var el = target;
        while (el && el !== el.ownerDocument) {
            if (el.classList && el.classList.contains('msg-outbox')) {
                var key = el.getAttribute('data-outbox-key');
                var state = STATES.find(function (s) { return el.classList.contains('msg-outbox-' + s); }) || null;
                return { el: el, key: key, state: state };
            }
            el = el.parentNode;
        }
        return null;
    }

    function attachTapHandlers(container, callbacks) {
        if (!container || !callbacks) return function () {};
        function onClick(ev) {
            var hit = classifyClick(ev.target);
            if (!hit || !hit.key) return;
            if (hit.state === 'queued' || hit.state === 'retrying') {
                if (typeof callbacks.onCancel === 'function') {
                    ev.preventDefault();
                    ev.stopPropagation();
                    callbacks.onCancel(hit.key, hit.el);
                }
            } else if (hit.state === 'failed') {
                if (typeof callbacks.onFailedMenu === 'function') {
                    ev.preventDefault();
                    ev.stopPropagation();
                    callbacks.onFailedMenu(hit.key, hit.el);
                }
            }
        }
        container.addEventListener('click', onClick);
        return function detach() { container.removeEventListener('click', onClick); };
    }

    var api = {
        STATES: STATES,
        updateBanner: updateBanner,
        renderQueuedBubble: renderQueuedBubble,
        setBubbleState: setBubbleState,
        removeBubble: removeBubble,
        findBubble: findBubble,
        classifyClick: classifyClick,
        attachTapHandlers: attachTapHandlers,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    } else if (global) {
        global.EclawOutboxUI = api;
    }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
