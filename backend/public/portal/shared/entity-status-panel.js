/**
 * Entity Status Panel — drawer that shows cumulative error counters for an
 * entity. Opens when a user clicks any non-dashboard avatar.
 *
 * P0 (this PR, per card_dbe18b333ac98076cc213055):
 *   - Counter section (Block 1)
 * P1 (follow-up):
 *   - Operation log (Block 2), smart chip, smart quote
 *
 * Per Hank 2026-06-06 19:55 TW directive: drawer data fetched via public
 * GET /api/entity-status/:eId, which authenticates by deviceSecret OR botSecret
 * so other entities on the same device can also call it for observation.
 *
 * API surface (global window.EntityStatusPanel):
 *   open(entityId, opts?) — fetch + render + slide-in
 *   close()              — slide-out + remove
 *   isOpen()             — bool
 */

(function () {
    'use strict';

    const ROOT_CLASS = 'entity-status-panel';
    const COUNTER_LABELS_ZH = {
        chat_no_reply:         '已讀聊天未回覆',
        a2a_no_reply:          '實體對實體訊息未回覆',
        kanban_nudge_no_reply: '任務催促未回覆',
        system_msg_no_reply:   '系統訊息未回覆',
    };
    const COUNTER_LABELS_EN = {
        chat_no_reply:         'Chats read but not replied',
        a2a_no_reply:          'Entity-to-entity msgs not acked',
        kanban_nudge_no_reply: 'Task nudges not acted on',
        system_msg_no_reply:   'System msgs not acked',
    };

    let rootEl = null;
    let currentEid = null;

    function pickLabel(axis) {
        const lang = (document.documentElement.getAttribute('lang') || 'en').toLowerCase();
        const isZh = lang.startsWith('zh') || lang === 'tw' || lang === 'cn';
        const dict = isZh ? COUNTER_LABELS_ZH : COUNTER_LABELS_EN;
        return dict[axis] || axis;
    }

    function readCreds() {
        // Reuse the same credential plumbing that every portal page already
        // sets up (api.js / auth.js writes to window.EClawAuth or localStorage).
        const w = window;
        const ls = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
        return {
            deviceId: w.DEVICE_ID || w.deviceId || ls('deviceId'),
            deviceSecret: w.DEVICE_SECRET || w.deviceSecret || ls('deviceSecret'),
            botSecret: w.BOT_SECRET || w.botSecret || ls('botSecret'),
            entityId: w.ENTITY_ID || w.entityId || ls('entityId'),
        };
    }

    async function fetchStatus(eid) {
        const c = readCreds();
        const qs = new URLSearchParams();
        if (c.deviceId) qs.set('deviceId', c.deviceId);
        if (c.deviceSecret) qs.set('deviceSecret', c.deviceSecret);
        else if (c.botSecret) {
            qs.set('botSecret', c.botSecret);
            if (c.entityId) qs.set('entityId', String(c.entityId));
        }
        const res = await fetch(`/api/entity-status/${eid}?${qs.toString()}`, {
            credentials: 'include',
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    function buildDom(eid) {
        const root = document.createElement('aside');
        root.className = ROOT_CLASS;
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-label', 'Entity status');
        // Use targetEntityId (not data-entity-id) so the delegated
        // attachAvatarClickHandler on document.body doesn't treat clicks inside
        // the drawer — including the close button or scrim — as a fresh avatar
        // click and re-open the drawer.
        root.dataset.targetEntityId = String(eid);
        root.innerHTML = `
            <div class="${ROOT_CLASS}__scrim" data-action="close"></div>
            <div class="${ROOT_CLASS}__sheet">
                <header class="${ROOT_CLASS}__header">
                    <strong class="${ROOT_CLASS}__title">Entity #${eid}</strong>
                    <button type="button" class="${ROOT_CLASS}__close" aria-label="Close" data-action="close">✕</button>
                </header>
                <section class="${ROOT_CLASS}__section" data-section="counters">
                    <h3 class="${ROOT_CLASS}__section-title">累計錯誤次數 / Error counters</h3>
                    <ul class="${ROOT_CLASS}__counter-list" data-role="counter-list">
                        <li class="${ROOT_CLASS}__counter-row" data-state="loading">Loading…</li>
                    </ul>
                </section>
                <section class="${ROOT_CLASS}__section ${ROOT_CLASS}__section--placeholder">
                    <h3 class="${ROOT_CLASS}__section-title">操作 log / Operation log</h3>
                    <p class="${ROOT_CLASS}__placeholder-note">P1 follow-up — see card_dbe18b333ac98076cc213055.</p>
                </section>
            </div>
        `;
        root.addEventListener('click', (e) => {
            const action = e.target?.dataset?.action;
            if (action === 'close') close();
        });
        return root;
    }

    function renderCounters(root, counters) {
        const list = root.querySelector('[data-role="counter-list"]');
        if (!list) return;
        if (!counters || counters.length === 0) {
            list.innerHTML = `<li class="${ROOT_CLASS}__counter-row" data-state="empty">No counters yet.</li>`;
            return;
        }
        list.innerHTML = counters.map(c => `
            <li class="${ROOT_CLASS}__counter-row" data-axis="${c.axis}">
                <span class="${ROOT_CLASS}__counter-label">${pickLabel(c.axis)}</span>
                <span class="${ROOT_CLASS}__counter-value">${c.count}</span>
            </li>
        `).join('');
    }

    function ensureStyles() {
        if (document.getElementById('entity-status-panel-style')) return;
        const style = document.createElement('style');
        style.id = 'entity-status-panel-style';
        style.textContent = `
.${ROOT_CLASS} { position: fixed; inset: 0; z-index: 9998; pointer-events: none; }
.${ROOT_CLASS}__scrim { position: absolute; inset: 0; background: rgba(0,0,0,0.45);
    opacity: 0; transition: opacity 0.18s ease; pointer-events: auto; }
.${ROOT_CLASS}--visible .${ROOT_CLASS}__scrim { opacity: 1; }
.${ROOT_CLASS}__sheet { position: absolute; top: 0; right: 0; bottom: 0;
    width: min(420px, 92vw); background: var(--card, #1e1e2e); color: var(--text, #e0e0e0);
    box-shadow: -8px 0 32px rgba(0,0,0,0.5); transform: translateX(100%);
    transition: transform 0.22s ease; pointer-events: auto; display: flex; flex-direction: column;
    overflow-y: auto; }
.${ROOT_CLASS}--visible .${ROOT_CLASS}__sheet { transform: translateX(0); }
@media (max-width: 480px) {
    .${ROOT_CLASS}__sheet { width: 100vw; }
}
.${ROOT_CLASS}__header { display: flex; align-items: center; justify-content: space-between;
    padding: 14px 18px; border-bottom: 1px solid var(--card-border, #333); }
.${ROOT_CLASS}__title { font-size: 16px; font-weight: 600; }
.${ROOT_CLASS}__close { background: none; border: none; color: var(--text-muted, #888);
    cursor: pointer; font-size: 18px; padding: 4px 8px; border-radius: 6px; }
.${ROOT_CLASS}__close:hover { color: var(--text, #fff); background: rgba(255,255,255,0.06); }
.${ROOT_CLASS}__section { padding: 14px 18px; border-bottom: 1px solid var(--card-border, #333); }
.${ROOT_CLASS}__section-title { font-size: 13px; font-weight: 600;
    color: var(--text-secondary, #aaa); margin: 0 0 10px; text-transform: uppercase; letter-spacing: 0.04em; }
.${ROOT_CLASS}__counter-list { list-style: none; margin: 0; padding: 0; }
.${ROOT_CLASS}__counter-row { display: flex; justify-content: space-between; align-items: center;
    padding: 8px 0; border-bottom: 1px dashed var(--card-border, #333); }
.${ROOT_CLASS}__counter-row:last-child { border-bottom: none; }
.${ROOT_CLASS}__counter-label { font-size: 13px; color: var(--text, #e0e0e0); }
.${ROOT_CLASS}__counter-value { font-size: 16px; font-weight: 600; color: var(--primary, #6c63ff);
    background: rgba(108,99,255,0.12); padding: 2px 10px; border-radius: 999px; min-width: 32px;
    text-align: center; }
.${ROOT_CLASS}__placeholder-note { font-size: 12px; color: var(--text-muted, #888); font-style: italic; }
        `.trim();
        document.head.appendChild(style);
    }

    async function open(eid, opts) {
        opts = opts || {};
        const targetEid = Number(eid);
        if (!Number.isFinite(targetEid) || targetEid < 0) return;
        if (rootEl) close();

        ensureStyles();
        rootEl = buildDom(targetEid);
        document.body.appendChild(rootEl);
        currentEid = targetEid;

        // Animate in on the next frame so the CSS transition fires.
        requestAnimationFrame(() => rootEl.classList.add(ROOT_CLASS + '--visible'));

        // ESC closes.
        document.addEventListener('keydown', _onEsc);

        try {
            const data = await fetchStatus(targetEid);
            renderCounters(rootEl, data.counters);
        } catch (err) {
            const list = rootEl.querySelector('[data-role="counter-list"]');
            if (list) {
                list.innerHTML = `<li class="${ROOT_CLASS}__counter-row" data-state="error">Failed to load: ${err.message}</li>`;
            }
        }
    }

    function close() {
        if (!rootEl) return;
        document.removeEventListener('keydown', _onEsc);
        rootEl.classList.remove(ROOT_CLASS + '--visible');
        const el = rootEl;
        rootEl = null;
        currentEid = null;
        setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 240);
    }

    function isOpen() {
        return !!rootEl;
    }

    function _onEsc(e) {
        if (e.key === 'Escape') {
            e.stopPropagation();
            close();
        }
    }

    window.EntityStatusPanel = { open, close, isOpen };
})();
