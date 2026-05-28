/*
 * point-edit-demo.js — Track A (DOM selector + text-selection) and
 * Track B (coordinate resolver) of the
 * point-and-edit testbed. Feature-flagged via ?demo=pointedit or
 * window.POINTEDIT_DEMO === true. Track C (mind-map node) plugs into
 * the same `pointedit:target` event boundary
 * so the harness adapter below is reusable.
 *
 * Normalized target payload contract (must stay aligned with #6's plan):
 *   { mode, targetId, selector?, anchorId?, coordinates?, outerHTML,
 *     textSnippet, rect, confidence, sourceHint, astPath? }
 */
(function () {
    'use strict';

    function flagOn() {
        if (typeof window === 'undefined') return false;
        if (window.POINTEDIT_DEMO === true) return true;
        try {
            const qs = new URLSearchParams(window.location.search);
            const v = (qs.get('demo') || '').toLowerCase();
            return v === 'pointedit' || v === 'point-edit' || v === 'point-and-edit';
        } catch (_) {
            return false;
        }
    }

    function unveilTab() {
        const tab = document.querySelector('.info-tab[data-info-tab="point-edit-demo"]');
        if (tab) tab.hidden = false;
    }

    function clampText(s, max) {
        if (!s) return '';
        s = String(s).replace(/\s+/g, ' ').trim();
        return s.length > max ? s.slice(0, max - 1) + '…' : s;
    }

    function sanitizeOuterHtml(el, maxLen) {
        if (!el) return '';
        let html = el.outerHTML || '';
        html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
        html = html.replace(/\son\w+="[^"]*"/gi, '');
        html = html.replace(/\son\w+='[^']*'/gi, '');
        if (html.length > maxLen) html = html.slice(0, maxLen - 1) + '…';
        return html;
    }

    function isStableClass(cls) {
        if (!cls) return false;
        if (/^(active|hover|focus|open|selected|hidden|show)$/i.test(cls)) return false;
        if (/^[a-z]+-?\d+$/i.test(cls)) return false;
        return /^[a-z][a-z0-9_-]*$/i.test(cls);
    }

    function classPath(el) {
        const classes = (el.className || '').toString().split(/\s+/).filter(isStableClass);
        return classes.length ? '.' + classes.slice(0, 2).join('.') : null;
    }

    function nthOfType(el) {
        let i = 1;
        let n = el;
        while ((n = n.previousElementSibling)) {
            if (n.tagName === el.tagName) i++;
        }
        return `${el.tagName.toLowerCase()}:nth-of-type(${i})`;
    }

    function buildSelector(el, root) {
        const limit = root || document.querySelector('[data-ped-sandbox]') || document.body;
        if (el.dataset && el.dataset.pointEditId) {
            return {
                selector: `[data-point-edit-id="${el.dataset.pointEditId}"]`,
                priority: 'data-point-edit-id',
                confidence: 0.98,
            };
        }
        if (el.id) {
            return { selector: `#${el.id}`, priority: 'id', confidence: 0.95 };
        }
        const parts = [];
        let cursor = el;
        let priority = 'class-path';
        let confidence = 0.85;
        while (cursor && cursor !== limit && cursor.nodeType === 1) {
            if (cursor.dataset && cursor.dataset.pointEditId) {
                parts.unshift(`[data-point-edit-id="${cursor.dataset.pointEditId}"]`);
                priority = 'data-point-edit-id+descendant';
                confidence = Math.max(confidence, 0.9);
                break;
            }
            if (cursor.id) {
                parts.unshift(`#${cursor.id}`);
                priority = 'id+descendant';
                confidence = Math.max(confidence, 0.9);
                break;
            }
            const cp = classPath(cursor);
            if (cp) {
                parts.unshift(cursor.tagName.toLowerCase() + cp);
            } else {
                parts.unshift(nthOfType(cursor));
                priority = 'nth-of-type';
                confidence = Math.min(confidence, 0.7);
            }
            cursor = cursor.parentElement;
        }
        return { selector: parts.join(' > ') || nthOfType(el), priority, confidence };
    }

    function bboxRect(el) {
        const r = el.getBoundingClientRect();
        return {
            x: Math.round(r.left + window.scrollX),
            y: Math.round(r.top + window.scrollY),
            w: Math.round(r.width),
            h: Math.round(r.height),
        };
    }

    function targetIdFor(el) {
        if (el.dataset && el.dataset.pointEditId) return el.dataset.pointEditId;
        if (el.id) return el.id;
        return null;
    }

    function pickFromElement(el, opts) {
        const sandbox = document.querySelector('[data-ped-sandbox]');
        const sel = buildSelector(el, sandbox);
        return {
            mode: 'dom',
            targetId: targetIdFor(el),
            selector: sel.selector,
            outerHTML: sanitizeOuterHtml(el, 4096),
            textSnippet: clampText(el.textContent, 240),
            rect: bboxRect(el),
            confidence: sel.confidence,
            sourceHint: (opts && opts.sourceHint) || `dom:${sel.priority}`,
        };
    }

    function pickFromSelection() {
        const sel = window.getSelection && window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
        const range = sel.getRangeAt(0);
        const sandbox = document.querySelector('[data-ped-sandbox]');
        if (sandbox && !sandbox.contains(range.commonAncestorContainer)) return null;
        let anchorEl = range.commonAncestorContainer;
        if (anchorEl.nodeType !== 1) anchorEl = anchorEl.parentElement;
        const ancestor = anchorEl.closest('[data-point-edit-id]') || anchorEl;
        const rect = range.getBoundingClientRect();
        const anchorId = ancestor.dataset && ancestor.dataset.pointEditId
            ? ancestor.dataset.pointEditId
            : null;
        return {
            mode: 'dom',
            targetId: anchorId,
            selector: anchorId
                ? `rangeFor:[data-point-edit-id="${anchorId}"]`
                : 'rangeFor:selection',
            outerHTML: sanitizeOuterHtml(ancestor, 4096),
            textSnippet: clampText(sel.toString(), 240),
            rect: {
                x: Math.round(rect.left + window.scrollX),
                y: Math.round(rect.top + window.scrollY),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
            },
            confidence: anchorId ? 0.9 : 0.75,
            sourceHint: 'text-selection',
        };
    }

    function emitTarget(payload) {
        document.dispatchEvent(new CustomEvent('pointedit:target', { detail: payload }));
    }

    /* ---------- Hover/highlight overlay ---------- */

    function positionOverlay(overlay, rect) {
        overlay.hidden = false;
        overlay.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
        overlay.style.width = rect.w + 'px';
        overlay.style.height = rect.h + 'px';
    }

    function hideOverlay(overlay) {
        overlay.hidden = true;
    }

    /* ---------- Composer adapter (stub) ----------
     * Listens to pointedit:target events from any track and injects a
     * <target> block into the textarea. Stays deterministic — no LLM. */

    function escapeAttr(s) {
        return String(s || '').replace(/"/g, '&quot;');
    }

    function renderTargetBlock(payload) {
        const parts = [`<target mode="${escapeAttr(payload.mode)}"`];
        if (payload.targetId) parts.push(`targetId="${escapeAttr(payload.targetId)}"`);
        if (payload.selector) parts.push(`selector="${escapeAttr(payload.selector)}"`);
        if (payload.anchorId) parts.push(`anchorId="${escapeAttr(payload.anchorId)}"`);
        if (payload.astPath) parts.push(`astPath="${escapeAttr(payload.astPath)}"`);
        if (payload.coordinates) {
            parts.push(`x="${payload.coordinates.x}"`);
            parts.push(`y="${payload.coordinates.y}"`);
        }
        if (payload.rect) {
            parts.push(`rect="${payload.rect.x},${payload.rect.y},${payload.rect.w},${payload.rect.h}"`);
        }
        if (typeof payload.confidence === 'number') {
            parts.push(`confidence="${payload.confidence.toFixed(2)}"`);
        }
        return `${parts.join(' ')}>\n  ${payload.textSnippet || ''}\n</target>\n\n`;
    }

    function injectTargetIntoComposer(payload, textarea, payloadEl, statusEl) {
        if (textarea) {
            textarea.value = renderTargetBlock(payload) + textarea.value.replace(/^<target[\s\S]*?<\/target>\n*/, '');
            textarea.focus();
            textarea.setSelectionRange(textarea.value.length, textarea.value.length);
        }
        if (payloadEl) {
            payloadEl.textContent = JSON.stringify(payload, null, 2);
        }
        if (statusEl) {
            statusEl.textContent = `Picked: ${payload.mode} · ${payload.targetId || payload.selector || 'selection'} · confidence ${payload.confidence.toFixed(2)}`;
            statusEl.dataset.state = 'picked';
        }
    }

    /* ---------- Track B: coordinate resolver ---------- */

    function coordinateRequestFromEvent(ev) {
        return {
            x: Math.round(ev.clientX),
            y: Math.round(ev.clientY),
            viewportW: Math.round(window.innerWidth || document.documentElement.clientWidth || 0),
            viewportH: Math.round(window.innerHeight || document.documentElement.clientHeight || 0),
            url: window.location.href,
        };
    }

    function normalizeCoordinateResponse(body) {
        return body && body.target ? body.target : body;
    }

    function liftViewportRectToPage(payload) {
        if (!payload || !payload.rect) return payload;
        return {
            ...payload,
            rect: {
                x: Math.round(payload.rect.x + window.scrollX),
                y: Math.round(payload.rect.y + window.scrollY),
                w: payload.rect.w,
                h: payload.rect.h,
            },
        };
    }

    async function resolveCoordinateFromEvent(ev, statusEl) {
        const body = coordinateRequestFromEvent(ev);
        if (statusEl) {
            statusEl.dataset.state = 'resolving';
            statusEl.textContent = `Resolving coordinate ${body.x},${body.y} through AST endpoint…`;
        }

        const res = await fetch('/api/point-edit/resolve-coordinate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = json.message || json.error || `HTTP ${res.status}`;
            throw new Error(msg);
        }

        const payload = normalizeCoordinateResponse(json);
        if (!payload || payload.mode !== 'coord') {
            throw new Error('resolver returned an invalid target payload');
        }
        return liftViewportRectToPage(payload);
    }

    function reportCoordinateError(err, statusEl) {
        if (!statusEl) return;
        statusEl.dataset.state = 'error';
        statusEl.textContent = `Coordinate resolve failed: ${err && err.message ? err.message : 'unknown error'}`;
    }

    /* ---------- Bootstrap ---------- */

    function boot() {
        if (!flagOn()) return;
        const panel = document.getElementById('panel-point-edit-demo');
        if (!panel) return;
        unveilTab();

        const sandbox = panel.querySelector('[data-ped-sandbox]');
        const overlay = panel.querySelector('[data-ped-overlay]');
        const textarea = panel.querySelector('[data-ped-textarea]');
        const payloadEl = panel.querySelector('[data-ped-payload]');
        const statusEl = panel.querySelector('[data-ped-status]');
        const clearBtn = panel.querySelector('[data-ped-clear]');
        const modeBtns = panel.querySelectorAll('[data-ped-mode]');
        if (!sandbox || !overlay || !textarea) return;

        let mode = panel.dataset.modeDefault || 'dom';
        let lastHoverEl = null;
        let coordinatePending = false;

        const setMode = (next) => {
            mode = next;
            modeBtns.forEach((b) => {
                b.classList.toggle('active', b.dataset.pedMode === next);
            });
            if (statusEl) {
                statusEl.dataset.state = 'idle';
                if (next === 'dom') {
                    statusEl.textContent = statusEl.dataset.hintDom || 'Hover anywhere in the sandbox to highlight, click to commit.';
                } else if (next === 'coordinate') {
                    statusEl.textContent = statusEl.dataset.hintCoordinate || 'Tap or click inside the sandbox to resolve x/y to a source target.';
                } else if (next === 'textsel') {
                    statusEl.textContent = statusEl.dataset.hintTextsel || 'Drag-select any text inside the sandbox to commit.';
                }
            }
            hideOverlay(overlay);
        };

        modeBtns.forEach((b) => {
            b.addEventListener('click', () => {
                if (b.disabled) return;
                setMode(b.dataset.pedMode);
            });
        });

        sandbox.addEventListener('mousemove', (ev) => {
            if (mode !== 'dom') return;
            const t = ev.target;
            if (!(t instanceof Element) || t === overlay) return;
            if (t === lastHoverEl) return;
            lastHoverEl = t;
            positionOverlay(overlay, bboxRect(t));
        });

        sandbox.addEventListener('mouseleave', () => {
            lastHoverEl = null;
            hideOverlay(overlay);
        });

        sandbox.addEventListener('click', (ev) => {
            if (mode === 'coordinate') {
                ev.preventDefault();
                ev.stopPropagation();
                if (coordinatePending) return;
                coordinatePending = true;
                resolveCoordinateFromEvent(ev, statusEl)
                    .then((payload) => {
                        if (payload.rect) positionOverlay(overlay, payload.rect);
                        emitTarget(payload);
                    })
                    .catch((err) => reportCoordinateError(err, statusEl))
                    .finally(() => {
                        coordinatePending = false;
                    });
                return;
            }
            if (mode !== 'dom') return;
            const t = ev.target;
            if (!(t instanceof Element)) return;
            ev.preventDefault();
            ev.stopPropagation();
            const payload = pickFromElement(t);
            emitTarget(payload);
        });

        document.addEventListener('mouseup', () => {
            if (mode !== 'textsel') return;
            const payload = pickFromSelection();
            if (payload) emitTarget(payload);
        });

        document.addEventListener('pointedit:target', (ev) => {
            injectTargetIntoComposer(ev.detail, textarea, payloadEl, statusEl);
        });

        if (clearBtn) {
            clearBtn.addEventListener('click', () => {
                textarea.value = '';
                if (payloadEl) payloadEl.textContent = '{}';
                if (statusEl) {
                    statusEl.textContent = statusEl.dataset.hintIdle || 'Pick mode A, B, or D, then target the sandbox to begin.';
                    statusEl.dataset.state = 'idle';
                }
            });
        }

        setMode(mode);

        window.PointEditDemo = Object.freeze({
            emitTarget,
            pickFromElement,
            pickFromSelection,
            resolveCoordinateFromEvent,
            buildSelector,
            sanitizeOuterHtml,
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
