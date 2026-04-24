/**
 * AutolinkChipPreview — Smart-quote Chip B.
 *
 * Registers window.AutolinkChipPreview so AutolinkChip.onChipClick opens a
 * popover instead of deep-linking. Popover shows the referenced entity's
 * title / status / first 200 chars / last 1–2 comments, with a requote (📌)
 * button that inserts a fresh [引用 <id>] token into the active chat input.
 *
 * Only one popover at a time. ESC / outside-click closes it.
 *
 * Supported ref types (Phase 1):
 *   - src://kanban/card/<id>  → GET /api/mission/card/:id
 *
 * Unsupported types render a graceful "尚未支援" popover (later cards will
 * add note/review endpoints + rendering).
 */
(function (global) {
    'use strict';

    let currentPopover = null;
    let currentAnchor = null;

    function t(key, fallback) {
        try { return (global.i18n && typeof global.i18n.t === 'function') ? (global.i18n.t(key) || fallback) : fallback; }
        catch (_) { return fallback; }
    }

    function escapeHtml(s) {
        const d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function closePopover() {
        if (!currentPopover) return;
        currentPopover.remove();
        currentPopover = null;
        currentAnchor = null;
    }

    function positionPopover(pop, anchorEl) {
        const rect = anchorEl.getBoundingClientRect();
        const width = 320;
        const viewportW = window.innerWidth;
        const gap = 6;
        let left = rect.left + window.scrollX;
        if (left + width > window.scrollX + viewportW - 8) {
            left = window.scrollX + viewportW - width - 8;
        }
        if (left < window.scrollX + 8) left = window.scrollX + 8;
        pop.style.position = 'absolute';
        pop.style.top = (rect.bottom + window.scrollY + gap) + 'px';
        pop.style.left = left + 'px';
        pop.style.width = width + 'px';
        pop.style.zIndex = '9999';
    }

    function openPreview(refType, refId, anchorEl) {
        closePopover();
        const pop = document.createElement('div');
        pop.className = 'autolink-chip-popover';
        pop.setAttribute('data-ref-type', refType);
        pop.setAttribute('data-ref-id', refId);
        pop._refType = refType;
        pop._refId = refId;
        pop._data = null;
        pop.innerHTML = buildLoadingHtml();
        document.body.appendChild(pop);
        positionPopover(pop, anchorEl);
        currentPopover = pop;
        currentAnchor = anchorEl;
        bindPopoverActions(pop);

        resolveRef(refType, refId).then(data => {
            if (currentPopover !== pop) return;
            pop._data = data;
            pop.innerHTML = buildContentHtml(data, refType, refId);
        }).catch(err => {
            if (currentPopover !== pop) return;
            pop._data = null;
            pop.innerHTML = buildErrorHtml(err, refType, refId);
        });
    }

    function resolveRef(refType, refId) {
        if (refType === 'src') {
            const m = /^src:\/\/([a-z]+)\/([a-z]+)\/([a-f0-9]{8,})(#.+)?$/i.exec(refId);
            if (!m) return Promise.reject(new Error('bad src token'));
            const kind = m[1], type = m[2], id = m[3], anchor = m[4] || null;
            if (kind === 'kanban' && type === 'card') {
                const deviceId = (global.currentUser && global.currentUser.deviceId) || '';
                const url = '/api/mission/card/card_' + id + (deviceId ? '?deviceId=' + encodeURIComponent(deviceId) : '');
                return fetch(url, { credentials: 'include' })
                    .then(r => r.json())
                    .then(j => {
                        if (j && j.success === false) throw new Error(j.error || 'fetch failed');
                        const card = j.card || j;
                        if (!card || !card.id) throw new Error('card not found');
                        return { kind: 'card', data: card, anchor, refType, refId };
                    });
            }
            return Promise.reject(new Error('ref_not_supported:' + kind + '/' + type));
        }
        if (refType === 'review') {
            return Promise.reject(new Error('ref_not_supported:review'));
        }
        return Promise.reject(new Error('ref_not_supported:' + refType));
    }

    function buildLoadingHtml() {
        return `<div class="chip-popover-loading">${escapeHtml(t('chip_popover_loading', '載入中…'))}</div>`;
    }

    function buildErrorHtml(err, refType, refId) {
        const msg = (err && err.message && err.message.startsWith('ref_not_supported:'))
            ? t('chip_popover_not_supported', '此引用類型尚未支援預覽')
            : t('chip_popover_load_error', '載入失敗') + (err && err.message ? ' (' + escapeHtml(err.message.slice(0, 60)) + ')' : '');
        return `
            <div class="chip-popover-header">
                <span class="chip-popover-title">${escapeHtml(refId || '')}</span>
                <button class="chip-popover-btn chip-popover-close" title="${escapeHtml(t('common_close', '關閉'))}" data-action="close">✖</button>
            </div>
            <div class="chip-popover-body"><div class="chip-popover-error">${escapeHtml(msg)}</div></div>
        `;
    }

    function buildContentHtml(d, refType, refId) {
        if (d.kind !== 'card') return buildErrorHtml(new Error('ref_not_supported:kind'), refType, refId);
        const c = d.data;
        const status = c.status || 'todo';
        const desc = (c.description || '').slice(0, 200);
        const hasMoreDesc = (c.description || '').length > 200;
        const comments = (Array.isArray(c.comments) ? c.comments.slice(-2) : []).map(cmt => {
            const text = (cmt.text || '').slice(0, 120);
            return '<div class="chip-popover-comment">💬 ' + escapeHtml(text) + (cmt.text && cmt.text.length > 120 ? '…' : '') + '</div>';
        }).join('');
        const hashId = c.id.indexOf('card_') === 0 ? c.id : ('card_' + c.id);
        const fullUrl = '/portal/kanban.html#' + hashId;
        const requoteTitle = t('chip_popover_requote', '再引用到聊天');
        const closeTitle = t('common_close', '關閉');
        const openFullLabel = t('chip_popover_open_full', '打開完整頁面 →');
        return `
            <div class="chip-popover-header">
                <span class="chip-popover-title" title="${escapeHtml(c.title || '')}">${escapeHtml(c.title || '')}</span>
                <span class="chip-popover-status chip-status--${escapeHtml(status)}">${escapeHtml(status)}</span>
                <button class="chip-popover-btn chip-popover-quote" title="${escapeHtml(requoteTitle)}" data-action="requote">📌</button>
                <button class="chip-popover-btn chip-popover-close" title="${escapeHtml(closeTitle)}" data-action="close">✖</button>
            </div>
            <div class="chip-popover-body">
                ${desc ? '<div class="chip-popover-desc">' + escapeHtml(desc) + (hasMoreDesc ? '…' : '') + '</div>' : ''}
                ${comments}
            </div>
            <div class="chip-popover-footer">
                <a href="${escapeHtml(fullUrl)}" class="chip-popover-open">${escapeHtml(openFullLabel)}</a>
            </div>
        `;
    }

    function bindPopoverActions(pop) {
        pop.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            e.stopPropagation();
            const action = btn.getAttribute('data-action');
            if (action === 'close') { closePopover(); return; }
            if (action === 'requote') { insertRequoteToken(pop._data, pop._refType, pop._refId); closePopover(); return; }
        });
    }

    function insertRequoteToken(data, refType, refId) {
        const token = tokenFor(data, refType, refId);
        const input = document.getElementById('messageInput') || document.querySelector('textarea, [contenteditable="true"]');
        if (!input) return;
        if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') {
            const cur = input.value || '';
            const pos = input.selectionStart != null ? input.selectionStart : cur.length;
            const before = cur.slice(0, pos), after = cur.slice(pos);
            const insert = (before && !before.endsWith(' ') ? ' ' : '') + token + ' ';
            input.value = before + insert + after;
            input.focus();
            const caret = before.length + insert.length;
            try { input.setSelectionRange(caret, caret); } catch (_) {}
            input.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
            input.focus();
            document.execCommand && document.execCommand('insertText', false, token + ' ');
        }
    }

    function tokenFor(data, refType, refId) {
        if (data && data.kind === 'card' && data.data && data.data.id) {
            return data.data.id; // already `card_<hex>`; EntityLinkRender will re-chip it on render
        }
        return refId;
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && currentPopover) { closePopover(); }
    });
    document.addEventListener('click', (e) => {
        if (!currentPopover) return;
        if (e.target.closest('.autolink-chip-popover') || e.target === currentAnchor || e.target.closest('.autolink-chip')) return;
        closePopover();
    });

    global.AutolinkChipPreview = openPreview;
    global.AutolinkChipPreview._close = closePopover;
    global.AutolinkChipPreview._current = () => currentPopover;
})(window);
