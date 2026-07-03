// ============================================
// E-Claw Resize Grip — reusable drag-to-resize helper
// (card_c44c318865d2aa77376e9746)
// ============================================
// A small, standalone, no-bundler vanilla-JS helper that turns any element
// into a keyboard- and pointer-resizable surface via a separate "grip" bar.
//
// Distilled from the AI-chat resize implementation shipped in #3873/#3874/#3875
// (backend/public/portal/shared/ai-chat.js: clampPanelSize / startPanelResize /
// adjustPanelSizeByKeyboard / per-path saveWindowState). That code is left
// untouched to avoid regressing the just-shipped AI-chat resize; a FUTURE PR can
// dedupe ai-chat.js onto this helper. For now this is intentionally independent.
//
// FIRST consumer (this PR): the per-item 需要你 (action-request) reply textarea
// `.reply-preview-chip-answer` in chat.html renderReplyPreviews(). Hank's ask:
// 「讓所有對話視窗的外框，按住上下拖拉改變視窗大小的『拉桿』UX；每個視窗此功能可
// 在設定內啟用/禁用.」 — a per-window, settings-gated drag handle.
//
// Public API:
//   window.EclawResizeGrip.attach({
//       el,                 // HTMLElement being resized (height and/or width)
//       grip,               // optional existing grip element; if omitted, one is
//                           //   created + inserted after `el` (or into `mount`)
//       mount,              // optional parent to append the auto-created grip to
//                           //   (default: el.parentNode)
//       storageKey,         // stable string key for persistence (e.g. 'ar-reply')
//       axis,               // 'vertical' (height only, default) | 'horizontal'
//                           //   (width only) | 'both'
//       min,                // { height, width } px minimums (defaults below)
//       max,                // { height, width } px maximums OR
//                           //   { heightVh, widthVw } viewport-relative caps
//       step,               // keyboard base step px (default 24; Shift = 2x)
//       getEnabled,         // () => boolean — re-checked on every interaction;
//                           //   when it returns false the grip is a no-op + hidden
//       ariaLabel,          // grip aria-label (default 'Resize')
//   }) => { detach(), refresh(), setEnabled(bool) } | null
//
// Persistence: a single namespaced localStorage object
//   'eclaw_resize_grip_state_v1' keyed by the provided storageKey, storing
//   { height, width } in px. Shared storageKey → one saved size applies to every
//   element that uses it (the reply input uses a shared 'ar-reply' key on purpose,
//   so a size the user picks once carries across inbox items).
(function () {
    'use strict';

    if (window.EclawResizeGrip) return; // idempotent (page may include twice)

    const STORAGE_KEY = 'eclaw_resize_grip_state_v1';
    const VIEWPORT_MARGIN = 16;
    const DEFAULT_MIN = { height: 26, width: 120 };
    const DEFAULT_STEP = 24;

    function readAll() {
        try {
            const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (_) {
            return {};
        }
    }

    function loadSize(storageKey) {
        const state = readAll()[storageKey] || {};
        return {
            height: Number.isFinite(Number(state.height)) ? Number(state.height) : undefined,
            width: Number.isFinite(Number(state.width)) ? Number(state.width) : undefined,
        };
    }

    function saveSize(storageKey, patch) {
        try {
            const all = readAll();
            const prev = all[storageKey] || {};
            const next = {};
            const h = Number(patch && patch.height);
            const w = Number(patch && patch.width);
            if (Number.isFinite(h)) next.height = Math.round(h);
            else if (Number.isFinite(Number(prev.height))) next.height = Math.round(Number(prev.height));
            if (Number.isFinite(w)) next.width = Math.round(w);
            else if (Number.isFinite(Number(prev.width))) next.width = Math.round(Number(prev.width));
            all[storageKey] = next;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
        } catch (_) { /* persistence is best-effort */ }
    }

    function resolveMax(max) {
        // Support both absolute px and viewport-relative caps.
        const vh = Math.max(0, window.innerHeight || 0);
        const vw = Math.max(0, window.innerWidth || 0);
        const out = {};
        if (max && Number.isFinite(Number(max.height))) out.height = Number(max.height);
        else if (max && Number.isFinite(Number(max.heightVh))) out.height = Math.round((vh * Number(max.heightVh)) / 100);
        if (max && Number.isFinite(Number(max.width))) out.width = Number(max.width);
        else if (max && Number.isFinite(Number(max.widthVw))) out.width = Math.round((vw * Number(max.widthVw)) / 100);
        // Fall back to (viewport - margin) so a size never overflows the screen.
        if (!Number.isFinite(out.height)) out.height = Math.max(DEFAULT_MIN.height, vh - VIEWPORT_MARGIN);
        if (!Number.isFinite(out.width)) out.width = Math.max(DEFAULT_MIN.width, vw - VIEWPORT_MARGIN);
        return out;
    }

    function clampSize(cfg, height, width) {
        const min = cfg._min;
        const max = resolveMax(cfg.max);
        const vh = Math.max(0, window.innerHeight || 0);
        const vw = Math.max(0, window.innerWidth || 0);
        const maxHeight = Math.max(min.height, Math.min(max.height, vh - VIEWPORT_MARGIN || max.height));
        const maxWidth = Math.max(min.width, Math.min(max.width, vw - VIEWPORT_MARGIN || max.width));
        return {
            height: Math.round(Math.min(Math.max(Number(height) || min.height, min.height), maxHeight)),
            width: Math.round(Math.min(Math.max(Number(width) || min.width, min.width), maxWidth)),
        };
    }

    function applyStoredSize(cfg) {
        const el = cfg.el;
        if (!el) return;
        const stored = loadSize(cfg.storageKey);
        if (cfg.axis !== 'horizontal' && Number.isFinite(Number(stored.height))) {
            const size = clampSize(cfg, stored.height, el.getBoundingClientRect().width);
            el.style.height = size.height + 'px';
        }
        if (cfg.axis === 'horizontal' || cfg.axis === 'both') {
            if (Number.isFinite(Number(stored.width))) {
                const size = clampSize(cfg, el.getBoundingClientRect().height, stored.width);
                el.style.width = size.width + 'px';
            }
        }
    }

    function createGrip(cfg) {
        const grip = document.createElement('div');
        grip.className = 'eclaw-resize-grip';
        grip.setAttribute('role', 'separator');
        grip.setAttribute('aria-orientation', cfg.axis === 'horizontal' ? 'vertical' : 'horizontal');
        grip.setAttribute('aria-label', cfg.ariaLabel || 'Resize');
        grip.setAttribute('title', cfg.ariaLabel || 'Resize');
        grip.setAttribute('tabindex', '0');
        return grip;
    }

    function syncGripVisibility(cfg) {
        const enabled = cfg.getEnabled ? !!cfg.getEnabled() : true;
        if (cfg.grip) {
            cfg.grip.classList.toggle('eclaw-resize-grip-disabled', !enabled);
            cfg.grip.setAttribute('aria-hidden', enabled ? 'false' : 'true');
            cfg.grip.tabIndex = enabled ? 0 : -1;
        }
        return enabled;
    }

    function startPointerResize(cfg, event) {
        if (!syncGripVisibility(cfg)) return;
        if (event.button !== undefined && event.button !== 0) return;
        const el = cfg.el;
        if (!el) return;
        event.preventDefault();

        const rect = el.getBoundingClientRect();
        const startY = event.clientY;
        const startX = event.clientX;
        const startHeight = rect.height;
        const startWidth = rect.width;
        el.classList.add('eclaw-resizing');
        // Capture the pointer so a fast drag that leaves the tiny grip keeps tracking.
        try { if (cfg.grip && cfg.grip.setPointerCapture && event.pointerId != null) cfg.grip.setPointerCapture(event.pointerId); } catch (_) {}

        const onMove = (moveEvent) => {
            const nextHeight = cfg.axis === 'horizontal' ? startHeight : startHeight + (moveEvent.clientY - startY);
            const nextWidth = (cfg.axis === 'horizontal' || cfg.axis === 'both')
                ? startWidth + (moveEvent.clientX - startX)
                : startWidth;
            const size = clampSize(cfg, nextHeight, nextWidth);
            if (cfg.axis !== 'horizontal') el.style.height = size.height + 'px';
            if (cfg.axis === 'horizontal' || cfg.axis === 'both') el.style.width = size.width + 'px';
        };

        const onUp = () => {
            el.classList.remove('eclaw-resizing');
            const finalRect = el.getBoundingClientRect();
            const size = clampSize(cfg, finalRect.height, finalRect.width);
            const patch = {};
            if (cfg.axis !== 'horizontal') patch.height = size.height;
            if (cfg.axis === 'horizontal' || cfg.axis === 'both') patch.width = size.width;
            saveSize(cfg.storageKey, patch);
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onUp);
            document.removeEventListener('pointercancel', onUp);
        };

        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
    }

    function keyboardResize(cfg, event) {
        if (!syncGripVisibility(cfg)) return;
        const step = (cfg.step || DEFAULT_STEP) * (event.shiftKey ? 2 : 1);
        let heightDelta = 0;
        let widthDelta = 0;
        if (event.key === 'ArrowUp') heightDelta = cfg.axis === 'horizontal' ? 0 : -step;
        else if (event.key === 'ArrowDown') heightDelta = cfg.axis === 'horizontal' ? 0 : step;
        else if (event.key === 'ArrowLeft') widthDelta = (cfg.axis === 'horizontal' || cfg.axis === 'both') ? -step : 0;
        else if (event.key === 'ArrowRight') widthDelta = (cfg.axis === 'horizontal' || cfg.axis === 'both') ? step : 0;
        else return;
        if (heightDelta === 0 && widthDelta === 0) return;

        event.preventDefault();
        const el = cfg.el;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const size = clampSize(cfg, rect.height + heightDelta, rect.width + widthDelta);
        const patch = {};
        if (cfg.axis !== 'horizontal') { el.style.height = size.height + 'px'; patch.height = size.height; }
        if (cfg.axis === 'horizontal' || cfg.axis === 'both') { el.style.width = size.width + 'px'; patch.width = size.width; }
        saveSize(cfg.storageKey, patch);
    }

    function attach(options) {
        const cfg = Object.assign({ axis: 'vertical', step: DEFAULT_STEP }, options || {});
        if (!cfg.el || !cfg.storageKey) return null;
        cfg._min = Object.assign({}, DEFAULT_MIN, cfg.min || {});

        // No-op cleanly when disabled at attach time (no grip inserted).
        const enabledNow = cfg.getEnabled ? !!cfg.getEnabled() : true;

        if (!cfg.grip) {
            cfg.grip = createGrip(cfg);
            const mount = cfg.mount || cfg.el.parentNode;
            if (mount) {
                // Insert directly AFTER the resized element so the handle reads as
                // "bottom edge of this box" both visually and in the a11y tree.
                if (cfg.el.nextSibling) mount.insertBefore(cfg.grip, cfg.el.nextSibling);
                else mount.appendChild(cfg.grip);
            }
        }

        const onPointerDown = (e) => startPointerResize(cfg, e);
        const onKeyDown = (e) => keyboardResize(cfg, e);
        cfg.grip.addEventListener('pointerdown', onPointerDown);
        cfg.grip.addEventListener('keydown', onKeyDown);

        applyStoredSize(cfg);
        syncGripVisibility(cfg);
        // If disabled at attach time, still leave the grip present-but-hidden so a
        // later setEnabled(true)/refresh() can turn it on without re-attaching.
        if (!enabledNow) syncGripVisibility(cfg);

        return {
            detach() {
                cfg.grip.removeEventListener('pointerdown', onPointerDown);
                cfg.grip.removeEventListener('keydown', onKeyDown);
                if (cfg.grip.parentNode) cfg.grip.parentNode.removeChild(cfg.grip);
            },
            refresh() { applyStoredSize(cfg); syncGripVisibility(cfg); },
            setEnabled(v) { cfg.getEnabled = () => !!v; syncGripVisibility(cfg); },
        };
    }

    window.EclawResizeGrip = {
        attach,
        STORAGE_KEY,
        _clampSize: clampSize,      // exposed for tests / debugging
        _loadSize: loadSize,
        _saveSize: saveSize,
    };
})();
