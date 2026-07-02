/**
 * AutolinkChipPreview — Smart-quote Chip B + nested-recursion Chip C.
 *
 * Click an autolink chip → popover with title/status/desc/last-2 comments and
 * a 📌 requote button. Embedded refs inside the popover content (a card whose
 * description mentions another card_/src:// token) re-render as nested chips;
 * clicking one stacks a child popover on top, up to MAX_DEPTH layers.
 *
 * Cycle guard: clicking a chip whose refId is already on the open stack shows
 * a transient toast "已在引用堆疊上". Depth guard: stack at MAX_DEPTH shows
 * "太深，請直接跳頁".
 *
 * ESC / outside-click closes the entire stack.
 *
 * Supported ref types (Phase 1):
 *   - src://kanban/card/<id>  → GET /api/mission/card/:id
 */
(function (global) {
    'use strict';

    const MAX_DEPTH = 5;
    let stack = []; // pop elements; stack[0] = root, last = innermost
    let rootAnchor = null;

    function t(key, fallback) {
        try { return (global.i18n && typeof global.i18n.t === 'function') ? (global.i18n.t(key) || fallback) : fallback; }
        catch (_) { return fallback; }
    }

    function escapeHtml(s) {
        const d = document.createElement('div');
        d.textContent = s == null ? '' : String(s);
        return d.innerHTML;
    }

    function renderChips(escapedHtml) {
        if (global.AutolinkChip && typeof global.AutolinkChip.render === 'function') {
            try { return global.AutolinkChip.render(escapedHtml); } catch (_) {}
        }
        return escapedHtml;
    }

    function closeAll() {
        while (stack.length) stack.pop().remove();
        rootAnchor = null;
    }

    function closeFromIndex(idx) {
        while (stack.length > idx) stack.pop().remove();
        if (!stack.length) rootAnchor = null;
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
        pop.style.zIndex = String(9999 + stack.length);
    }

    function refKey(refType, refId) { return refType + '|' + refId; }

    function isOnStack(refType, refId) {
        const key = refKey(refType, refId);
        return stack.some(p => refKey(p._refType, p._refId) === key);
    }

    function openPreview(refType, refId, anchorEl) {
        // Top-level call (from a chip outside any popover) — close existing stack first
        if (!anchorEl || !anchorEl.closest('.autolink-chip-popover')) {
            closeAll();
            rootAnchor = anchorEl;
        }

        // Cycle / depth guards
        if (isOnStack(refType, refId)) {
            showToast(anchorEl, t('chip_popover_cycle', '已在引用堆疊上'));
            return;
        }
        if (stack.length >= MAX_DEPTH) {
            showToast(anchorEl, t('chip_popover_too_deep', '太深，請直接跳頁'));
            return;
        }

        const pop = document.createElement('div');
        pop.className = 'autolink-chip-popover';
        pop.setAttribute('data-ref-type', refType);
        pop.setAttribute('data-ref-id', refId);
        pop._refType = refType;
        pop._refId = refId;
        pop._data = null;
        pop._depth = stack.length;
        pop._anchorEl = anchorEl;
        pop.innerHTML = buildLoadingHtml();
        document.body.appendChild(pop);
        positionPopover(pop, anchorEl);
        stack.push(pop);
        bindPopoverActions(pop);

        resolveRef(refType, refId).then(data => {
            if (!stack.includes(pop)) return;
            pop._data = data;
            pop.innerHTML = buildContentHtml(data, refType, refId);
        }).catch(err => {
            if (!stack.includes(pop)) return;
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
                const deviceSecret = (global.currentUser && global.currentUser.deviceSecret) || '';
                // deviceId is non-secret and stays in the query; deviceSecret
                // moves to the X-Device-Secret header so it never lands in
                // browser history / access logs / the Referer header.
                const qs = deviceId ? '?deviceId=' + encodeURIComponent(deviceId) : '';
                const url = '/api/mission/card/card_' + id + qs;
                const headers = deviceSecret ? { 'X-Device-Secret': deviceSecret } : {};
                return fetch(url, { credentials: 'include', headers })
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
        const requoteTitle = t('chip_popover_requote', '再引用到聊天');
        const closeTitle = t('common_close', '關閉');
        return `
            <div class="chip-popover-header">
                <span class="chip-popover-title">${escapeHtml(refId || '')}</span>
                <button class="chip-popover-btn chip-popover-quote" title="${escapeHtml(requoteTitle)}" data-action="requote">📌</button>
                <button class="chip-popover-btn chip-popover-close" title="${escapeHtml(closeTitle)}" data-action="close">✖</button>
            </div>
            <div class="chip-popover-body"><div class="chip-popover-error">${escapeHtml(msg)}</div></div>
        `;
    }

    // Screenshot/attachment thumbnail strip for the card-chip popover.
    //
    // Regression note (card fix/chip-card-screenshot-thumbnails): the popover
    // fetches GET /api/mission/card/:id, whose payload carries `card.files[]`
    // ({ fileId, filename, url, mimeType, ... } — see backend/kanban.js
    // mapCardFileRow + the /card/:id handler which does `card.files = …`), and
    // the full kanban modal renders those images as a thumbnail grid + lightbox
    // (kanban.html loadScreenshots/openLightbox). The chip popover shipped
    // WITHOUT this block, so scrolling the chip never revealed the card's
    // screenshots — reachable everywhere else but not in the quick-preview chip.
    // This restores parity: image files → a scrollable thumbnail grid; each
    // thumb is a real <a href=signedUrl> so a click enlarges it (a host page's
    // window.openLightbox is preferred when present — see bindPopoverActions).
    function buildScreenshotBlockHtml(c) {
        const files = Array.isArray(c.files) ? c.files : [];
        const images = files.filter(f => f && typeof f.url === 'string' && f.url
            && /^image\//i.test(String(f.mimeType || f.mime_type || '')));
        if (!images.length) return '';
        const label = t('chip_popover_screenshots', '📸 截圖');
        // card_abdf0904: "?" spec-tooltip icon (Hank: 加上 ? icon 註解詳細規格).
        // Native title = robust bilingual affordance (hover on desktop, long-press
        // on mobile) that no i18n.apply pass can clobber; language by document lang,
        // same approach chat.html's replyPreviewHelp uses.
        const zh = ((typeof document !== 'undefined' && document.documentElement
            && document.documentElement.lang) || '').toLowerCase().indexOf('zh') === 0;
        const helpText = zh
            ? '此區顯示這張卡片的截圖／附件縮圖；點縮圖可放大檢視。內容來自卡片附件並隨其更新。此功能過去存在、一度消失，現已修復並加了防回歸測試以防再次消失。'
            : "This card's screenshots / attachment thumbnails — click a thumbnail to enlarge. It reflects the card's current attachments. The section had regressed away and is now restored with a guard test so it can't silently vanish again.";
        const helpIcon = ' <span class="chip-popover-shots-help" role="img"'
            + ' aria-label="' + escapeHtml(zh ? '截圖區說明' : 'about screenshots') + '"'
            + ' title="' + escapeHtml(helpText) + '">?</span>';
        const thumbs = images.map(f => {
            const url = escapeHtml(f.url);
            const name = escapeHtml(f.filename || 'screenshot');
            return '<a class="chip-popover-thumb" href="' + url + '"'
                + ' data-action="thumb" data-url="' + url + '" data-name="' + name + '"'
                + ' target="_blank" rel="noopener" title="' + name + '">'
                + '<img src="' + url + '" alt="' + name + '" loading="lazy"></a>';
        }).join('');
        return '<div class="chip-popover-shots">'
            + '<div class="chip-popover-shots-label" data-chip-help-anchor="screenshots">'
            + escapeHtml(label) + ' <span class="chip-popover-shots-count">' + images.length + '</span>'
            + helpIcon + '</div>'
            + '<div class="chip-popover-thumbs">' + thumbs + '</div>'
            + '</div>';
    }

    function buildContentHtml(d, refType, refId) {
        if (d.kind !== 'card') return buildErrorHtml(new Error('ref_not_supported:kind'), refType, refId);
        const c = d.data;
        const status = c.status || 'todo';
        const descRaw = (c.description || '').slice(0, 200);
        const hasMoreDesc = (c.description || '').length > 200;
        const desc = renderChips(escapeHtml(descRaw)) + (hasMoreDesc ? '…' : '');
        const comments = (Array.isArray(c.comments) ? c.comments.slice(-2) : []).map(cmt => {
            const raw = (cmt.text || '').slice(0, 120);
            const truncated = cmt.text && cmt.text.length > 120 ? '…' : '';
            return '<div class="chip-popover-comment">💬 ' + renderChips(escapeHtml(raw)) + truncated + '</div>';
        }).join('');
        const screenshotsHtml = buildScreenshotBlockHtml(c);
        const titleRendered = renderChips(escapeHtml(c.title || ''));
        const hashId = c.id.indexOf('card_') === 0 ? c.id : ('card_' + c.id);
        const fullUrl = '/portal/kanban.html#' + hashId;
        const requoteTitle = t('chip_popover_requote', '再引用到聊天');
        const closeTitle = t('common_close', '關閉');
        const openFullLabel = t('chip_popover_open_full', '打開完整頁面 →');
        return `
            <div class="chip-popover-header">
                <span class="chip-popover-title" title="${escapeHtml(c.title || '')}">${titleRendered}</span>
                <span class="chip-popover-status chip-status--${escapeHtml(status)}">${escapeHtml(status)}</span>
                <button class="chip-popover-btn chip-popover-quote" title="${escapeHtml(requoteTitle)}" data-action="requote">📌</button>
                <button class="chip-popover-btn chip-popover-close" title="${escapeHtml(closeTitle)}" data-action="close">✖</button>
            </div>
            <div class="chip-popover-body">
                ${descRaw ? '<div class="chip-popover-desc">' + desc + '</div>' : ''}
                ${comments}
                ${screenshotsHtml}
            </div>
            <div class="chip-popover-footer">
                <a href="${escapeHtml(fullUrl)}" class="chip-popover-open" data-action="open-full" data-card-id="${escapeHtml(hashId)}">${escapeHtml(openFullLabel)}</a>
            </div>
        `;
    }

    function bindPopoverActions(pop) {
        pop.addEventListener('click', (e) => {
            // Nested chip click → recurse into openPreview
            const chip = e.target.closest('.autolink-chip');
            if (chip && pop.contains(chip)) {
                e.stopPropagation();
                e.preventDefault();
                const refType = chip.getAttribute('data-ref-type');
                const refId = chip.getAttribute('data-ref-id');
                if (refType && refId) {
                    // Truncate stack above this popover (close any deeper siblings) before opening
                    const myIdx = stack.indexOf(pop);
                    if (myIdx >= 0) closeFromIndex(myIdx + 1);
                    openPreview(refType, refId, chip);
                }
                return;
            }
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            e.stopPropagation();
            const action = btn.getAttribute('data-action');
            if (action === 'thumb') {
                // Enlarge a screenshot thumbnail. Prefer the host page's own
                // lightbox (chat.html/kanban.html/feedback.html define
                // window.openLightbox); otherwise fall through to the native
                // <a target="_blank"> so the image still opens on the 4 pages
                // that host the chip without a lightbox.
                const url = btn.getAttribute('data-url') || '';
                const name = btn.getAttribute('data-name') || '';
                if (url && typeof window.openLightbox === 'function') {
                    e.preventDefault();
                    try { window.openLightbox(url, name); return; } catch (_) {}
                }
                return; // let the <a> open the signed URL in a new tab
            }
            if (action === 'close') {
                const idx = stack.indexOf(pop);
                if (idx >= 0) closeFromIndex(idx);
                return;
            }
            if (action === 'requote') { insertRequoteToken(pop._data, pop._refType, pop._refId, pop._anchorEl || rootAnchor); closeAll(); return; }
            if (action === 'open-full') {
                // card_2d5fbe88 sibling: in split mode the "打開完整頁面 →" link
                // must route into the EXISTING kanban pane, not navigate the
                // current (chat) pane. SmartRouter posts split_navigate; the
                // workspace host loads the card into the kanban pane.
                const SR = window.SmartRouter;
                const cardId = btn.getAttribute('data-card-id') || '';
                if (SR && SR.mode === 'split' && typeof SR.navigate === 'function' && cardId) {
                    e.preventDefault();
                    if (SR.navigate('card', { cardId }) !== false) { closeAll(); return; }
                }
                // Single/app or no router: fall through to the native <a> navigation.
                return;
            }
        });
    }

    function showToast(anchorEl, msg) {
        const tip = document.createElement('div');
        tip.className = 'autolink-chip-toast';
        tip.textContent = msg;
        const rect = (anchorEl && anchorEl.getBoundingClientRect) ? anchorEl.getBoundingClientRect() : { left: 100, top: 100, bottom: 120 };
        tip.style.position = 'absolute';
        tip.style.top = (rect.bottom + window.scrollY + 4) + 'px';
        tip.style.left = (rect.left + window.scrollX) + 'px';
        tip.style.zIndex = String(9999 + stack.length + 1);
        document.body.appendChild(tip);
        setTimeout(() => { tip.style.opacity = '0'; }, 1200);
        setTimeout(() => { tip.remove(); }, 1800);
    }

    function insertRequoteTokenIntoInput(input, token) {
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

    function insertRequoteToken(data, refType, refId, anchorEl) {
        const token = tokenFor(data, refType, refId);
        const chatInput = document.getElementById('messageInput');
        if (chatInput) {
            insertRequoteTokenIntoInput(chatInput, token);
            showToast(anchorEl, t('chip_popover_requoted', '已引用'));
            return;
        }
        // No local chat input — try cross-pane relay (workspace split-view).
        // Source page posts to its parent; workspace forwards to the chat iframe.
        if (window.parent && window.parent !== window) {
            try {
                window.parent.postMessage(
                    { type: 'eclaw_requote', token, refType, refId },
                    window.location.origin
                );
                showToast(anchorEl, t('chip_popover_requoted', '已引用'));
                return;
            } catch (_) {}
        }
        // Last-resort fallback: any other writable surface on the page (e.g. a
        // mindmap inline-note editor). Silent — caller doesn't know if landing
        // target was actually chat-shaped.
        const fallback = document.querySelector('textarea, [contenteditable="true"]');
        if (fallback) insertRequoteTokenIntoInput(fallback, token);
    }

    // Receive cross-pane requote (chat iframe side). Workspace forwards
    // 'eclaw_requote' here; insert into messageInput if present.
    window.addEventListener('message', (e) => {
        if (e.origin !== window.location.origin) return;
        if (!e.data || e.data.type !== 'eclaw_requote') return;
        const input = document.getElementById('messageInput');
        if (input && typeof e.data.token === 'string') {
            insertRequoteTokenIntoInput(input, e.data.token);
        }
    });

    function tokenFor(data, refType, refId) {
        if (data && data.kind === 'card' && data.data && data.data.id) {
            return data.data.id;
        }
        return refId;
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && stack.length) { closeAll(); }
    });
    document.addEventListener('click', (e) => {
        if (!stack.length) return;
        if (e.target.closest('.autolink-chip-popover')) return;
        if (e.target.closest('.autolink-chip-toast')) return;
        if (e.target === rootAnchor) return;
        if (e.target.closest('.autolink-chip')) return;
        closeAll();
    });

    global.AutolinkChipPreview = openPreview;
    global.AutolinkChipPreview._closeAll = closeAll;
    global.AutolinkChipPreview._stack = () => stack.slice();
    global.AutolinkChipPreview._MAX_DEPTH = MAX_DEPTH;
})(window);
