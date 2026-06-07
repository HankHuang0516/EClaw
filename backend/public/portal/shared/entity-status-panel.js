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
    let logCursor = null;        // pagination cursor for /log endpoint
    let logLoading = false;
    let logScrollObserver = null;
    const STATUS_COLOR = {
        backlog:     '#9ca3af',
        todo:        '#3b82f6',
        in_progress: '#f59e0b',
        review:      '#a855f7',
        blocked:     '#ef4444',
        done:        '#22c55e',
    };

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

    function _credQs() {
        const c = readCreds();
        const qs = new URLSearchParams();
        if (c.deviceId) qs.set('deviceId', c.deviceId);
        if (c.deviceSecret) qs.set('deviceSecret', c.deviceSecret);
        else if (c.botSecret) {
            qs.set('botSecret', c.botSecret);
            if (c.entityId) qs.set('entityId', String(c.entityId));
        }
        return qs;
    }

    async function fetchStatus(eid) {
        const qs = _credQs();
        const res = await fetch(`/api/entity-status/${eid}?${qs.toString()}`, {
            credentials: 'include',
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    async function fetchLog(eid, before, limit) {
        const qs = _credQs();
        qs.set('limit', String(limit || 20));
        if (before) qs.set('before', String(before));
        const res = await fetch(`/api/entity-status/${eid}/log?${qs.toString()}`, {
            credentials: 'include',
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    async function fetchQuote(eid, logId) {
        const c = readCreds();
        const body = { logId: Number(logId) };
        if (c.deviceId) body.deviceId = c.deviceId;
        if (c.deviceSecret) body.deviceSecret = c.deviceSecret;
        else if (c.botSecret) {
            body.botSecret = c.botSecret;
            if (c.entityId) body.entityId = Number(c.entityId);
        }
        const res = await fetch(`/api/entity-status/${eid}/quote`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            credentials: 'include',
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
    }

    function escapeHtml(s) {
        return String(s || '').replace(/[&<>"']/g, (c) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[c]));
    }

    // Render event_summary text with card_xxxxxxxx tokens replaced by clickable
    // status-colored chips. Status comes from event_payload.status if present.
    function renderSummaryHtml(summary, payload) {
        const text = escapeHtml(summary);
        const payloadCardId = payload && payload.card_id;
        const payloadStatus = (payload && payload.status) || null;
        // Match card_<hex|alnum>{6,32} — covers card_71d075680e6e2c952fbc3ffe etc.
        return text.replace(/(card_[a-zA-Z0-9]{6,32})|(#card_[a-zA-Z0-9]{6,32})/g, (match) => {
            const cardId = match.replace(/^#/, '');
            const status = (payloadCardId === cardId && payloadStatus) || 'todo';
            const color = STATUS_COLOR[status] || STATUS_COLOR.todo;
            return `<a class="${ROOT_CLASS}__chip" data-card-id="${escapeHtml(cardId)}" `
                + `style="background:${color}22;border-color:${color};color:${color};" `
                + `href="/portal/kanban.html?card=${encodeURIComponent(cardId)}" `
                + `title="Open ${escapeHtml(cardId)}">${escapeHtml(cardId.slice(0, 12))}</a>`;
        });
    }

    function formatTs(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        const pad = (n) => String(n).padStart(2, '0');
        return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }

    function renderLogRow(item) {
        const ts = formatTs(item.occurredAt);
        const summary = renderSummaryHtml(item.eventSummary, item.eventPayload);
        return `
            <li class="${ROOT_CLASS}__log-row" data-log-id="${escapeHtml(item.id)}" data-event-type="${escapeHtml(item.eventType)}">
                <time class="${ROOT_CLASS}__log-time">${escapeHtml(ts)}</time>
                <span class="${ROOT_CLASS}__log-summary">${summary}</span>
                <button type="button" class="${ROOT_CLASS}__log-quote" data-action="quote"
                    data-log-id="${escapeHtml(item.id)}" title="Quote this row">❝</button>
            </li>`;
    }

    function appendLogRows(root, items) {
        const list = root.querySelector('[data-role="log-list"]');
        if (!list) return;
        const sentinel = list.querySelector('[data-role="log-sentinel"]');
        if (!items || !items.length) {
            if (list.querySelector('[data-state="empty"]')) return;
            if (!list.querySelector('[data-log-id]')) {
                list.insertAdjacentHTML('afterbegin',
                    `<li class="${ROOT_CLASS}__log-row" data-state="empty">No operations yet.</li>`);
            }
            if (sentinel) sentinel.style.display = 'none';
            return;
        }
        const emptyMark = list.querySelector('[data-state="empty"]');
        if (emptyMark) emptyMark.remove();
        const html = items.map(renderLogRow).join('');
        if (sentinel) sentinel.insertAdjacentHTML('beforebegin', html);
        else list.insertAdjacentHTML('beforeend', html);
    }

    async function loadMoreLog(root, eid) {
        if (logLoading) return;
        if (logCursor === null && root.dataset.logFetchedOnce === '1') return;
        logLoading = true;
        try {
            const data = await fetchLog(eid, logCursor, 20);
            root.dataset.logFetchedOnce = '1';
            appendLogRows(root, data.items || []);
            logCursor = data.nextCursor || null;
            const sentinel = root.querySelector('[data-role="log-sentinel"]');
            if (sentinel && !logCursor) sentinel.style.display = 'none';
        } catch (err) {
            const list = root.querySelector('[data-role="log-list"]');
            if (list && !list.querySelector('[data-state="error"]')) {
                list.insertAdjacentHTML('beforeend',
                    `<li class="${ROOT_CLASS}__log-row" data-state="error">Failed to load log: ${escapeHtml(err.message)}</li>`);
            }
        } finally {
            logLoading = false;
        }
    }

    function setupInfiniteScroll(root, eid) {
        const sentinel = root.querySelector('[data-role="log-sentinel"]');
        if (!sentinel || !('IntersectionObserver' in window)) return;
        logScrollObserver = new IntersectionObserver((entries) => {
            if (entries.some(e => e.isIntersecting)) loadMoreLog(root, eid);
        }, { root: root.querySelector(`.${ROOT_CLASS}__sheet`), rootMargin: '120px' });
        logScrollObserver.observe(sentinel);
    }

    async function handleQuoteClick(eid, logId) {
        try {
            const res = await fetchQuote(eid, logId);
            if (!res.quote || !res.quote.text) return;
            // Try common chat textbox selectors; degrade to clipboard if none found.
            const targets = [
                'textarea#chatInput', 'textarea#chat-input', '#chatTextarea',
                'textarea[data-chat-input]', 'textarea[name="message"]',
            ];
            let pasted = false;
            for (const sel of targets) {
                const ta = document.querySelector(sel);
                if (ta && typeof ta.value === 'string') {
                    ta.value = res.quote.text + ta.value;
                    ta.focus();
                    try { ta.setSelectionRange(0, 0); } catch (_) { /* ok */ }
                    pasted = true;
                    break;
                }
            }
            if (!pasted && navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(res.quote.text);
            }
            close();
        } catch (err) {
            console.warn('[EntityStatusPanel] quote error:', err.message);
        }
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
                <section class="${ROOT_CLASS}__section" data-section="log">
                    <h3 class="${ROOT_CLASS}__section-title">操作 log / Operation log</h3>
                    <ol class="${ROOT_CLASS}__log-list" data-role="log-list">
                        <li class="${ROOT_CLASS}__log-row" data-state="loading">Loading…</li>
                        <li class="${ROOT_CLASS}__log-sentinel" data-role="log-sentinel" aria-hidden="true"></li>
                    </ol>
                </section>
            </div>
        `;
        root.addEventListener('click', (e) => {
            const action = e.target?.dataset?.action || e.target?.closest('[data-action]')?.dataset?.action;
            if (action === 'close') { close(); return; }
            if (action === 'quote') {
                const btn = e.target.closest('[data-action="quote"]');
                const logId = btn && btn.dataset.logId;
                if (logId) handleQuoteClick(eid, logId);
                e.stopPropagation();
                return;
            }
            // Card chip click: let default <a> navigation happen, just close drawer.
            if (e.target.closest('.' + ROOT_CLASS + '__chip')) {
                close();
            }
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
.${ROOT_CLASS}__log-list { list-style: none; margin: 0; padding: 0; }
.${ROOT_CLASS}__log-row { display: grid; grid-template-columns: auto 1fr auto; gap: 8px;
    align-items: start; padding: 8px 0; border-bottom: 1px dashed var(--card-border, #333);
    font-size: 12.5px; line-height: 1.45; }
.${ROOT_CLASS}__log-row[data-state="empty"], .${ROOT_CLASS}__log-row[data-state="loading"],
.${ROOT_CLASS}__log-row[data-state="error"] {
    grid-template-columns: 1fr; color: var(--text-muted, #888); font-style: italic;
    text-align: center; padding: 16px 0; }
.${ROOT_CLASS}__log-time { font-variant-numeric: tabular-nums; color: var(--text-muted, #888);
    font-size: 11px; padding-top: 2px; }
.${ROOT_CLASS}__log-summary { color: var(--text, #e0e0e0); word-break: break-word; }
.${ROOT_CLASS}__log-quote { background: none; border: none; color: var(--text-muted, #888);
    cursor: pointer; font-size: 13px; padding: 2px 6px; border-radius: 4px;
    opacity: 0; transition: opacity 0.15s, color 0.15s; }
.${ROOT_CLASS}__log-row:hover .${ROOT_CLASS}__log-quote { opacity: 1; }
.${ROOT_CLASS}__log-quote:hover { color: var(--primary, #6c63ff); background: rgba(108,99,255,0.1); }
.${ROOT_CLASS}__log-sentinel { padding: 0; border: none; height: 1px; }
.${ROOT_CLASS}__chip { display: inline-block; font-size: 11px; padding: 1px 8px; margin: 0 2px;
    border-radius: 999px; border: 1px solid transparent; text-decoration: none;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; vertical-align: baseline; }
.${ROOT_CLASS}__chip:hover { filter: brightness(1.4); text-decoration: none; }
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

        // Initial log fetch + infinite scroll setup.
        logCursor = null;
        const logList = rootEl.querySelector('[data-role="log-list"]');
        if (logList) {
            // Clear "Loading…" placeholder before first paint.
            logList.querySelectorAll('[data-state="loading"]').forEach(n => n.remove());
        }
        await loadMoreLog(rootEl, targetEid);
        setupInfiniteScroll(rootEl, targetEid);
    }

    function close() {
        if (!rootEl) return;
        document.removeEventListener('keydown', _onEsc);
        if (logScrollObserver) {
            try { logScrollObserver.disconnect(); } catch (_) { /* ok */ }
            logScrollObserver = null;
        }
        rootEl.classList.remove(ROOT_CLASS + '--visible');
        const el = rootEl;
        rootEl = null;
        currentEid = null;
        logCursor = null;
        logLoading = false;
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
