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

    // Lucide/Feather-family quote icon. Matches the rest of portal/shared (24x24
    // viewBox, fill=none, stroke=currentColor, stroke-width=2, round caps) so
    // the panel doesn't look out of place next to nav, ai-chat, etc.
    const SVG_QUOTE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" '
        + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" '
        + 'aria-hidden="true" focusable="false">'
        + '<path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-.5 2-2 2-1 0-1 .989-1 .989C2 18.978 2 21 3 21z"/>'
        + '<path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-.5 2-2 2-1 0-1 .989-1 .989C14 18.978 14 21 15 21z"/>'
        + '</svg>';
    // Same family as nav.js, just the help-circle variant. Used as the ? icon
    // next to the panel title.
    const SVG_HELP = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" '
        + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" '
        + 'aria-hidden="true" focusable="false">'
        + '<circle cx="12" cy="12" r="10"/>'
        + '<path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>'
        + '<line x1="12" y1="17" x2="12.01" y2="17"/>'
        + '</svg>';
    // Chevron right (collapsed) / down (expanded). Mirrors counter drill-down.
    const SVG_CHEVRON = '<svg class="' + ROOT_CLASS + '__counter-chevron" width="12" height="12" '
        + 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" '
        + 'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
        + '<polyline points="9 6 15 12 9 18"/></svg>';

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

    async function fetchCounterEvents(eid, axis) {
        const qs = _credQs();
        qs.set('limit', '50');
        const res = await fetch(`/api/entity-status/${eid}/counter/${encodeURIComponent(axis)}/events?${qs.toString()}`, {
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

    // Render event_summary text with card_xxxxxxxx tokens replaced by .autolink-chip
    // spans so the existing AutolinkChipPreview popover system owns the click —
    // popover (with "open full page →" inside) instead of full navigate. Status
    // color comes from event_payload.status if present.
    function renderSummaryHtml(summary, payload) {
        const text = escapeHtml(summary);
        const payloadCardId = payload && payload.card_id;
        const payloadStatus = (payload && payload.status) || null;
        // Match card_<hex|alnum>{6,32} — covers card_71d075680e6e2c952fbc3ffe etc.
        return text.replace(/(card_[a-zA-Z0-9]{6,32})|(#card_[a-zA-Z0-9]{6,32})/g, (match) => {
            const cardId = match.replace(/^#/, '');
            const status = (payloadCardId === cardId && payloadStatus) || 'todo';
            const color = STATUS_COLOR[status] || STATUS_COLOR.todo;
            // .autolink-chip + data-ref-type/data-ref-id makes the document-level
            // listener in autolink-chip-preview.js open the popover on click.
            return `<span class="autolink-chip ${ROOT_CLASS}__chip" `
                + `data-ref-type="card" data-ref-id="${escapeHtml(cardId)}" `
                + `data-card-id="${escapeHtml(cardId)}" `
                + `style="background:${color}22;border-color:${color};color:${color};" `
                + `title="${escapeHtml(cardId)}">${escapeHtml(cardId.slice(0, 12))}</span>`;
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
                    data-log-id="${escapeHtml(item.id)}" title="Quote this row" aria-label="Quote this row">${SVG_QUOTE}</button>
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
            if (!res.quote) return;
            // Preferred path: insert a card_<id> token so the chat renderer
            // turns it into the same .autolink-chip popover as every other
            // quoted card on the platform — single quote style across the app
            // instead of a free-form "> [Entity #X ...]" block.
            const cardId = res.quote.payload && res.quote.payload.card_id;
            const chatInput = document.getElementById('messageInput');
            if (cardId && chatInput) {
                const token = ' ' + cardId + ' ';
                const cur = chatInput.value || '';
                const pos = chatInput.selectionStart != null ? chatInput.selectionStart : cur.length;
                chatInput.value = cur.slice(0, pos) + token + cur.slice(pos);
                chatInput.focus();
                const caret = pos + token.length;
                try { chatInput.setSelectionRange(caret, caret); } catch (_) { /* ok */ }
                chatInput.dispatchEvent(new Event('input', { bubbles: true }));
                close();
                return;
            }
            // Fallback for log rows without a card_id payload (msg/system/etc):
            // legacy quote block — kept for parity with rows that don't have a
            // chip token to lean on. Try common chat textbox selectors first;
            // last-resort clipboard write.
            if (res.quote.text) {
                const targets = [
                    'textarea#messageInput', 'textarea#chatInput', 'textarea#chat-input',
                    '#chatTextarea', 'textarea[data-chat-input]', 'textarea[name="message"]',
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
                    <button type="button" class="${ROOT_CLASS}__help"
                        data-action="help" aria-label="What does this panel show?"
                        aria-expanded="false" title="What does this panel show?">${SVG_HELP}</button>
                    <span class="${ROOT_CLASS}__header-spacer"></span>
                    <button type="button" class="${ROOT_CLASS}__close" aria-label="Close" data-action="close">✕</button>
                </header>
                <div class="${ROOT_CLASS}__help-popover" data-role="help-popover" hidden>
                    <p><strong>Counters</strong> — each row counts open events the entity hasn&#39;t acted on. Number is live: it drops as the entity replies. Click a counter to see <em>which</em> events.</p>
                    <p><strong>Operation log</strong> — recent kanban / message / system events for this entity, newest first. Card chips open the card&#39;s popover; ${SVG_QUOTE} quotes the row into your chat composer.</p>
                </div>
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
            if (action === 'help') {
                const btn = e.target.closest('[data-action="help"]');
                const pop = root.querySelector('[data-role="help-popover"]');
                if (pop && btn) {
                    const open = pop.hasAttribute('hidden') ? false : true;
                    if (open) { pop.setAttribute('hidden', ''); btn.setAttribute('aria-expanded', 'false'); }
                    else { pop.removeAttribute('hidden'); btn.setAttribute('aria-expanded', 'true'); }
                }
                e.stopPropagation();
                return;
            }
            if (action === 'quote') {
                const btn = e.target.closest('[data-action="quote"]');
                const logId = btn && btn.dataset.logId;
                if (logId) handleQuoteClick(eid, logId);
                e.stopPropagation();
                return;
            }
            // Counter drill-down: clicking a counter row expands the open
            // events that comprise the live `openCount`. Toggles closed on
            // a second click. Doesn't fire if the user clicked inside an
            // already-rendered drill-down child (those bubble up).
            const counterRow = e.target.closest && e.target.closest(`.${ROOT_CLASS}__counter-row[data-axis]`);
            if (counterRow && !e.target.closest(`.${ROOT_CLASS}__counter-events`)) {
                const axis = counterRow.dataset.axis;
                if (axis) toggleCounterDrilldown(root, eid, axis, counterRow);
                e.stopPropagation();
                return;
            }
            // Card chip click: the chip is now a .autolink-chip span — let the
            // global AutolinkChipPreview document listener open its popover
            // (the popover has a "打開完整頁面 →" link to navigate). Stop
            // propagation so the drawer's own click-outside-closes logic
            // (if any) doesn't fire.
            if (e.target.closest('.autolink-chip')) {
                e.stopPropagation();
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
        // Live counter = openCount when the backend provides it; fall back to
        // cumulative count for old clients / old backends. Hank's spec: the
        // displayed number is "what's currently open", not lifetime total.
        list.innerHTML = counters.map(c => {
            const live = (typeof c.openCount === 'number') ? c.openCount : c.count;
            return `
            <li class="${ROOT_CLASS}__counter-row" data-axis="${c.axis}"
                role="button" tabindex="0"
                aria-expanded="false"
                aria-label="${pickLabel(c.axis)}: ${live} open. Click to see which events.">
                ${SVG_CHEVRON}
                <span class="${ROOT_CLASS}__counter-label">${pickLabel(c.axis)}</span>
                <span class="${ROOT_CLASS}__counter-value">${live}</span>
            </li>`;
        }).join('');
    }

    // Render the drill-down rows for one axis. Each row = (timestamp, chip).
    // Chip is a card chip if event payload carries card_id, otherwise a
    // message-coord chip from message_id. The list lives as a child <ul>
    // appended to the counter row so it slots in-line under the counter that
    // owns it (no second drawer push).
    function renderCounterEvents(items) {
        if (!items || items.length === 0) {
            return `<li class="${ROOT_CLASS}__counter-event-row" data-state="empty">No open events.</li>`;
        }
        return items.map(it => {
            const ts = formatTs(it.dispatchedAt);
            let chipHtml = '';
            const cardId = it.payload && it.payload.card_id;
            const messageId = it.payload && (it.payload.message_id || it.payload.msg_id);
            if (cardId) {
                const status = (it.payload && it.payload.status) || 'todo';
                const color = STATUS_COLOR[status] || STATUS_COLOR.todo;
                chipHtml = `<span class="autolink-chip ${ROOT_CLASS}__chip" `
                    + `data-ref-type="card" data-ref-id="${escapeHtml(cardId)}" `
                    + `data-card-id="${escapeHtml(cardId)}" `
                    + `style="background:${color}22;border-color:${color};color:${color};" `
                    + `title="${escapeHtml(cardId)}">${escapeHtml(cardId.slice(0, 12))}</span>`;
            } else if (messageId) {
                chipHtml = `<span class="autolink-chip ${ROOT_CLASS}__chip" `
                    + `data-ref-type="message" data-ref-id="${escapeHtml(messageId)}" `
                    + `title="${escapeHtml(messageId)}">msg ${escapeHtml(String(messageId).slice(-6))}</span>`;
            } else {
                chipHtml = `<span class="${ROOT_CLASS}__chip" title="${escapeHtml(it.eventType || '')}">`
                    + `${escapeHtml(it.eventType || 'event')}</span>`;
            }
            return `<li class="${ROOT_CLASS}__counter-event-row" data-event-id="${escapeHtml(it.id)}">
                <time class="${ROOT_CLASS}__counter-event-time">${escapeHtml(ts)}</time>
                <span class="${ROOT_CLASS}__counter-event-chip">${chipHtml}</span>
            </li>`;
        }).join('');
    }

    async function toggleCounterDrilldown(root, eid, axis, counterRow) {
        if (!counterRow) return;
        const existing = counterRow.nextElementSibling
            && counterRow.nextElementSibling.matches(`.${ROOT_CLASS}__counter-events[data-axis="${axis}"]`)
            ? counterRow.nextElementSibling : null;
        if (existing) {
            existing.remove();
            counterRow.setAttribute('aria-expanded', 'false');
            counterRow.classList.remove(`${ROOT_CLASS}__counter-row--expanded`);
            return;
        }
        const list = document.createElement('ul');
        list.className = `${ROOT_CLASS}__counter-events`;
        list.dataset.axis = axis;
        list.innerHTML = `<li class="${ROOT_CLASS}__counter-event-row" data-state="loading">Loading…</li>`;
        counterRow.insertAdjacentElement('afterend', list);
        counterRow.setAttribute('aria-expanded', 'true');
        counterRow.classList.add(`${ROOT_CLASS}__counter-row--expanded`);
        try {
            const data = await fetchCounterEvents(eid, axis);
            list.innerHTML = renderCounterEvents(data.items || []);
        } catch (err) {
            list.innerHTML = `<li class="${ROOT_CLASS}__counter-event-row" data-state="error">Failed to load: ${escapeHtml(err.message)}</li>`;
        }
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
.${ROOT_CLASS}__counter-row { display: grid; grid-template-columns: 16px 1fr auto; gap: 8px;
    align-items: center; padding: 8px 0; border-bottom: 1px dashed var(--card-border, #333);
    cursor: pointer; user-select: none; }
.${ROOT_CLASS}__counter-row[data-state] { grid-template-columns: 1fr; cursor: default;
    color: var(--text-muted, #888); font-style: italic; padding: 12px 0; }
.${ROOT_CLASS}__counter-row:last-child { border-bottom: none; }
.${ROOT_CLASS}__counter-row:hover:not([data-state]) { background: rgba(255,255,255,0.03); }
.${ROOT_CLASS}__counter-row:focus { outline: 2px solid var(--primary, #6c63ff); outline-offset: -2px; border-radius: 4px; }
.${ROOT_CLASS}__counter-chevron { transition: transform 0.15s ease; color: var(--text-muted, #888); }
.${ROOT_CLASS}__counter-row--expanded .${ROOT_CLASS}__counter-chevron { transform: rotate(90deg); }
.${ROOT_CLASS}__counter-label { font-size: 13px; color: var(--text, #e0e0e0); }
.${ROOT_CLASS}__counter-value { font-size: 16px; font-weight: 600; color: var(--primary, #6c63ff);
    background: rgba(108,99,255,0.12); padding: 2px 10px; border-radius: 999px; min-width: 32px;
    text-align: center; }
.${ROOT_CLASS}__counter-events { list-style: none; margin: 4px 0 8px 24px; padding: 0;
    border-left: 2px solid var(--card-border, #333); }
.${ROOT_CLASS}__counter-event-row { display: grid; grid-template-columns: auto 1fr; gap: 8px;
    align-items: center; padding: 4px 8px; font-size: 12px; color: var(--text-secondary, #aaa); }
.${ROOT_CLASS}__counter-event-row[data-state] { grid-template-columns: 1fr; text-align: center;
    color: var(--text-muted, #888); font-style: italic; padding: 8px; }
.${ROOT_CLASS}__counter-event-time { font-variant-numeric: tabular-nums; font-size: 11px;
    color: var(--text-muted, #888); }
.${ROOT_CLASS}__help { background: none; border: none; color: var(--text-muted, #888);
    cursor: pointer; padding: 4px; border-radius: 6px; display: inline-flex; align-items: center; }
.${ROOT_CLASS}__help:hover, .${ROOT_CLASS}__help[aria-expanded="true"] { color: var(--primary, #6c63ff); background: rgba(108,99,255,0.1); }
.${ROOT_CLASS}__header-spacer { flex: 1; }
.${ROOT_CLASS}__help-popover { padding: 12px 18px; font-size: 12.5px; line-height: 1.55;
    color: var(--text-secondary, #aaa); background: var(--bg-secondary, rgba(108,99,255,0.04));
    border-bottom: 1px solid var(--card-border, #333); }
.${ROOT_CLASS}__help-popover p { margin: 0 0 8px; }
.${ROOT_CLASS}__help-popover p:last-child { margin-bottom: 0; }
.${ROOT_CLASS}__help-popover svg { vertical-align: -2px; }
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
        } else if ((e.key === 'Enter' || e.key === ' ') && rootEl) {
            // Counter row keyboard activation (focused counter expands via
            // Enter/Space, same as a button — they have role="button" set).
            const active = document.activeElement;
            if (active && active.classList && active.classList.contains(ROOT_CLASS + '__counter-row') && active.dataset.axis) {
                e.preventDefault();
                toggleCounterDrilldown(rootEl, currentEid, active.dataset.axis, active);
            }
        }
    }

    window.EntityStatusPanel = { open, close, isOpen };
})();
