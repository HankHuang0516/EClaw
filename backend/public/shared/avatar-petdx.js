/**
 * Avatar Petdx mount helper — drops the user's selected companion into
 * any entity avatar slot. The fallback path keeps the existing emoji /
 * icon_url rendering when no companion is selected, so this is purely
 * additive on top of `renderAvatarHtml` from entity-utils.js.
 *
 * Two-phase usage:
 *
 *   1. `AvatarPetdx.preload({ deviceId, deviceSecret | botSecret, entityIds })`
 *      Fires one /api/companion/current per entityId, populates the
 *      module-local cache, returns Promise<void>.
 *
 *   2. `AvatarPetdx.mount(rootEl)` walks `rootEl` (default: document)
 *      for any `<canvas data-petdx-entity-id="N">` placeholders. Where a
 *      cached descriptor exists, a PetdxRenderer controller is created
 *      and started; placeholders without a descriptor are left as the
 *      original element so the page's emoji/icon fallback shows.
 *
 * The `renderAvatarHtml(avatar, size, entityId)` extension in entity-utils.js
 * emits the placeholder canvas when entityId has a cached companion.
 *
 * Memory: shares descriptor cache across all callers; the spritesheet
 * image is also cached inside PetdxRenderer's internal loader so the
 * same URL never decodes twice on a page.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.AvatarPetdx = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const descriptorByEntityId = new Map();       // entityId -> descriptor | null
    const inflightByEntityId = new Map();         // entityId -> Promise
    const controllersByCanvas = new WeakMap();    // canvas -> controller

    function hasDescriptor(entityId) {
        return descriptorByEntityId.has(Number(entityId))
            && descriptorByEntityId.get(Number(entityId)) != null;
    }

    function getDescriptor(entityId) {
        return descriptorByEntityId.get(Number(entityId)) || null;
    }

    async function fetchOne({ deviceId, deviceSecret, botSecret, entityId }) {
        const eid = Number(entityId);
        if (inflightByEntityId.has(eid)) return inflightByEntityId.get(eid);

        const params = new URLSearchParams({ deviceId, entityId: String(eid) });
        if (deviceSecret) params.set('deviceSecret', deviceSecret);
        else if (botSecret) params.set('botSecret', botSecret);
        const p = fetch('/api/companion/current?' + params.toString(), {
            credentials: 'same-origin'
        }).then(async (r) => {
            if (!r.ok) {
                descriptorByEntityId.set(eid, null);
                return null;
            }
            const data = await r.json();
            const companion = data && data.selection && data.selection.companion;
            descriptorByEntityId.set(eid, companion || null);
            return companion || null;
        }).catch(() => {
            descriptorByEntityId.set(eid, null);
            return null;
        }).finally(() => {
            inflightByEntityId.delete(eid);
        });
        inflightByEntityId.set(eid, p);
        return p;
    }

    /**
     * Batch preload for an array of entityIds. Resolves once every fetch
     * has settled (so a single misbehaving entry can't stall the rest).
     */
    function preload({ deviceId, deviceSecret, botSecret, entityIds }) {
        if (!deviceId || (!deviceSecret && !botSecret)) {
            return Promise.resolve();
        }
        const ids = Array.from(new Set((entityIds || []).map(Number).filter(Number.isFinite)));
        if (ids.length === 0) return Promise.resolve();
        return Promise.all(ids.map((entityId) =>
            fetchOne({ deviceId, deviceSecret, botSecret, entityId })
        )).then(() => {});
    }

    /**
     * Walk root for placeholder canvases and animate them. Idempotent:
     * canvases that already have a controller are skipped.
     */
    function mount(rootEl) {
        if (typeof window === 'undefined' || !window.PetdxRenderer) return;
        const scope = rootEl || document;
        const nodes = scope.querySelectorAll
            ? scope.querySelectorAll('canvas[data-petdx-entity-id]')
            : [];
        for (const canvas of nodes) {
            if (controllersByCanvas.has(canvas)) continue;
            const entityId = Number(canvas.getAttribute('data-petdx-entity-id'));
            const descriptor = getDescriptor(entityId);
            if (!descriptor) continue;
            try {
                const controller = window.PetdxRenderer.createRenderer({
                    canvas,
                    descriptor,
                    state: canvas.getAttribute('data-petdx-state') || 'IDLE'
                });
                controller.start();
                controllersByCanvas.set(canvas, controller);
            } catch (err) {
                if (window.console && window.console.warn) {
                    window.console.warn('[AvatarPetdx] mount failed for entity', entityId, err.message);
                }
            }
        }
    }

    /** Stop and detach the controller for a canvas (e.g. node being removed). */
    function unmount(canvas) {
        const c = controllersByCanvas.get(canvas);
        if (c) {
            try { c.stop(); } catch (_) { /* swallow */ }
            controllersByCanvas.delete(canvas);
        }
    }

    /** Test seam — lets unit tests inject a descriptor without hitting the API. */
    function _setDescriptor(entityId, descriptor) {
        descriptorByEntityId.set(Number(entityId), descriptor || null);
    }

    let observer = null;

    /**
     * Install a MutationObserver that auto-mounts new placeholder canvases
     * as the page renders/replaces chat content. Safe to call multiple
     * times — only one observer is ever attached.
     */
    function autoMount() {
        if (observer || typeof window === 'undefined' || typeof MutationObserver === 'undefined') return;
        // Initial sweep so existing canvases come up without waiting for a mutation.
        mount(document);
        observer = new MutationObserver((mutations) => {
            let needsScan = false;
            for (const m of mutations) {
                if (m.removedNodes && m.removedNodes.length) {
                    // Stop any running controller whose canvas just left the
                    // DOM — PetdxRenderer's rAF loop holds a strong ref to its
                    // controller so without this the WeakMap can't reclaim it
                    // and the rAF tick keeps firing on a detached canvas.
                    for (const n of m.removedNodes) {
                        if (!n || n.nodeType !== 1) continue;
                        if (n.matches && n.matches('canvas[data-petdx-entity-id]')) {
                            unmount(n);
                        }
                        if (n.querySelectorAll) {
                            n.querySelectorAll('canvas[data-petdx-entity-id]')
                                .forEach(unmount);
                        }
                    }
                }
                if (m.addedNodes && m.addedNodes.length) {
                    needsScan = true;
                }
            }
            if (needsScan) mount(document);
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    return {
        preload,
        mount,
        autoMount,
        unmount,
        hasDescriptor,
        getDescriptor,
        _setDescriptor,
    };
}));
