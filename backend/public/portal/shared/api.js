// E-Claw Portal - Shared API Helper

const API_BASE = window.location.origin;

async function apiCall(method, path, body = null, opts = {}) {
    const options = {
        method: method,
        credentials: 'include', // Send cookies
        headers: {}
    };

    if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE')) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }

    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    const response = await fetch(url, options);

    // Guard against non-JSON responses (e.g. HTML error pages)
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        const text = await response.text();
        throw new Error(`Server returned non-JSON response (HTTP ${response.status})`);
    }
    const data = await response.json();

    if (response.status === 401) {
        // Not authenticated - redirect to login (skip public pages, info page, and Android WebView).
        // Callers that handle 401 themselves (e.g. auth.js's /me probe that falls back to
        // device-login) pass { skip401Redirect: true } so the redirect doesn't race against
        // their fallback fetch — see the Portal auth race bug on iOS / Playwright.
        const isAndroidWebView = typeof AndroidBridge !== 'undefined';
        if (!opts.skip401Redirect
            && !isAndroidWebView
            && !window.location.pathname.includes('index.html')
            && !window.location.pathname.endsWith('/portal/')
            && !window.location.pathname.includes('info.html')) {
            // Pain 4 fix: tell the user WHY they are being sent to login
            // instead of a silent kick. `reason` comes from authMiddleware
            // (no_token / token_expired / token_invalid).
            const reason = data.reason || 'no_token';
            const t = (k, fb) => (window.i18n && window.i18n.t) ? window.i18n.t(k, fb) : fb;
            const msg = reason === 'token_expired'
                ? t('session_expired_relogin', 'Session expired — please log in again')
                : t('session_invalid_relogin', 'Please log in to continue');
            try { showToast(msg, 'warning'); } catch (_) { /* toast not ready pre-DOM */ }
            // Carry the interrupted destination so login can round-trip back
            // (redirect spec §4 LOGIN_REDIRECT; index.html validates against
            // its portal-page allowlist before honoring it).
            const returnTo = (window.location.pathname || '')
                + (window.location.search || '') + (window.location.hash || '');
            setTimeout(() => {
                window.location.href = 'index.html?authReason=' + encodeURIComponent(reason)
                    + '&return_to=' + encodeURIComponent(returnTo);
            }, 1200);
        }
        const authErr = new Error(data.error || 'Not authenticated');
        authErr.status = 401;
        authErr.reason = data.reason || null;
        throw authErr;
    }

    if (!response.ok) {
        const err = new Error(data.error || data.message || `HTTP ${response.status}`);
        err.status = response.status;
        err.data = data;
        throw err;
    }

    return data;
}

// Toast notifications
function showToast(message, type = 'info') {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 3000);
}

/**
 * showConfirm — styled replacement for window.confirm()
 * @param {Object} opts
 * @param {string} opts.message - Main message text. For destructive flows prefer the {itemName} field
 *   below over baking the item name into this string — it lets the dialog quote the item in distinct
 *   styling and lets the daily destructive-modals E2E spot-check that the user can see WHAT they're about to destroy.
 * @param {string} [opts.title] - Optional dialog title
 * @param {string} [opts.confirmText='OK'] - Confirm button label
 * @param {string} [opts.cancelText='Cancel'] - Cancel button label
 * @param {boolean} [opts.danger=false] - Red confirm button for destructive actions
 * @param {string} [opts.itemName] - Name of the specific item being destroyed (card title,
 *   note name, entity label, etc). When provided AND `danger:true`, the dialog renders this
 *   below the message in a quoted, bold strip so the user can verify WHICH item they're confirming.
 *   Omitting it on a `danger:true` call logs a dev-time console.warn (production stays silent).
 * @returns {Promise<boolean>}
 */
// i18n helper that honours a fallback string. i18n.t(key, params) uses the
// 2nd arg as substitution params, not as a fallback — so passing 'OK' was
// silently ignored and the dialog rendered the raw key. Wrap to fall back
// when the lookup returns the key itself.
function _tFb(k, fb) {
    if (typeof i18n === 'undefined' || !i18n.t) return fb || k;
    const v = i18n.t(k);
    return (v === k || !v) ? (fb || k) : v;
}

let _eclawDialogId = 0;

// Body scroll-lock for modal dialogs (showConfirm / showPrompt). Without it the
// page behind a destructive confirm still scrolls (wheel/touch AND programmatic),
// so the user can lose the dialog out of view or mis-tap a moved control.
//
// `overflow:hidden` alone only blocks USER wheel/touch — programmatic scrollTo
// still moves the page. The robust mobile lock is position:fixed on body with
// top:-scrollY: the document collapses to the viewport so it cannot scroll at all,
// and the visual position is preserved. Restored (incl. scroll position) on the
// last close. Ref-counted so stacked dialogs don't unlock prematurely.
let _eclawScrollLockCount = 0;
let _eclawPrevBody = null;     // saved inline styles to restore
let _eclawLockedScrollY = 0;   // scroll position captured at first lock
function _eclawLockBodyScroll() {
    if (typeof document === 'undefined' || !document.body) return;
    if (_eclawScrollLockCount === 0) {
        const b = document.body.style;
        _eclawPrevBody = { overflow: b.overflow, position: b.position, top: b.top, width: b.width };
        _eclawLockedScrollY = window.scrollY || window.pageYOffset || 0;
        b.overflow = 'hidden';
        b.position = 'fixed';
        b.top = `-${_eclawLockedScrollY}px`;
        b.width = '100%';
    }
    _eclawScrollLockCount++;
}
function _eclawUnlockBodyScroll() {
    if (typeof document === 'undefined' || !document.body) return;
    if (_eclawScrollLockCount === 0) return;
    _eclawScrollLockCount--;
    if (_eclawScrollLockCount === 0 && _eclawPrevBody) {
        const b = document.body.style;
        b.overflow = _eclawPrevBody.overflow;
        b.position = _eclawPrevBody.position;
        b.top = _eclawPrevBody.top;
        b.width = _eclawPrevBody.width;
        _eclawPrevBody = null;
        window.scrollTo(0, _eclawLockedScrollY); // restore the pre-lock scroll position
    }
}
const _ECLAW_DIALOG_SHADOW_STYLE = 'style="box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);"';
function showConfirm({ message, title, confirmText, cancelText, danger, itemName } = {}) {
    // Dev-time hint: destructive confirms should name the item so a fast-clicking user can
    // verify what's about to be destroyed. Localhost / dev hosts only; silent in production.
    const _isDevHost = typeof window !== 'undefined' && window.location
        && /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$/.test(window.location.hostname);
    if (danger && !itemName && _isDevHost) {
        console.warn('[showConfirm] danger:true called without itemName — caller should pass `itemName` so the dialog can name the destroyed item. Caller:', new Error().stack);
    }
    // Dev-time hint: catch contributors who pass a raw i18n key as title/message and the
    // lookup resolves to itself (key not registered in TRANSLATIONS[*]). Without this the
    // dialog renders the literal key string to the user with no console signal.
    if (_isDevHost && typeof i18n !== 'undefined' && i18n.t) {
        [['title', title], ['message', message]].forEach(([field, val]) => {
            if (typeof val !== 'string' || !val) return;
            if (/^[a-z][a-z0-9_]+$/.test(val) && i18n.t(val) === val) {
                console.warn(`[showConfirm] ${field} looks like an unresolved i18n key (t() returned the key itself): "${val}"`);
            }
        });
    }
    return new Promise((resolve) => {
        const t = _tFb;
        const overlay = document.createElement('div');
        overlay.className = 'dialog-overlay eclaw-confirm-overlay';
        const dialogId = ++_eclawDialogId;
        const titleId = title ? `eclaw-confirm-title-${dialogId}` : '';
        const messageId = `eclaw-confirm-message-${dialogId}`;
        const dialogAria = title
            ? `role="alertdialog" aria-modal="true" aria-labelledby="${titleId}" aria-describedby="${messageId}"`
            : `role="alertdialog" aria-modal="true" aria-label="${_escAttr(message)}" aria-describedby="${messageId}"`;
        const itemStrip = (danger && itemName)
            ? `<div class="eclaw-confirm-item" style="margin:8px 0 0;padding:8px 12px;background:var(--bg-secondary, rgba(0,0,0,0.04));border-left:3px solid var(--danger, #e53e3e);border-radius:4px;font-weight:600;color:var(--text);word-break:break-word">${_escHtml(itemName)}</div>`
            : '';
        overlay.innerHTML = `<div class="dialog eclaw-confirm-dialog" ${dialogAria} ${_ECLAW_DIALOG_SHADOW_STYLE}>
            ${title ? `<div class="dialog-title" id="${titleId}">${_escHtml(title)}</div>` : ''}
            <div class="dialog-body"><p id="${messageId}" style="margin:0;line-height:1.6;color:var(--text-secondary)">${_escHtml(message)}</p>${itemStrip}</div>
            <div class="dialog-actions">
                <button type="button" class="btn btn-outline eclaw-confirm-cancel"${danger && !cancelText ? ` aria-label="${_escAttr(t('dialog_cancel_aria', 'Cancel, keep current state'))}"` : ''}>${_escHtml(cancelText || t('dialog_cancel', 'Cancel'))}</button>
                <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'} eclaw-confirm-ok"${danger && !confirmText ? ` aria-label="${_escAttr(t('dialog_confirm_destructive', 'Confirm destructive action'))}"` : ''}>${_escHtml(confirmText || (danger ? t('dialog_confirm', 'Confirm') : t('dialog_ok', 'OK')))}</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        _eclawLockBodyScroll();
        const cleanup = (result) => { document.removeEventListener('keydown', _keyHandler, true); overlay.remove(); _eclawUnlockBodyScroll(); resolve(result); };
        // Safe default focus: when danger=true, focus Cancel so a stray
        // Enter / Space does not commit the destructive action. Matches the
        // Material Design and Apple HIG guidance for destructive confirms.
        const safeBtnSel = danger ? '.eclaw-confirm-cancel' : '.eclaw-confirm-ok';
        overlay.querySelector(safeBtnSel).focus();
        overlay.querySelector('.eclaw-confirm-ok').addEventListener('click', () => cleanup(true));
        overlay.querySelector('.eclaw-confirm-cancel').addEventListener('click', () => cleanup(false));
        // Backdrop-tap dismiss: only allowed when NOT destructive. iOS HIG forbids
        // scrim-dismiss on .alert-style modals because the backdrop is ~80% of a
        // mobile viewport and accidental thumb-stretch taps shouldn't cancel a
        // confirmation the user is actively reading. Esc + the explicit Cancel
        // button still dismiss either way.
        if (!danger) {
            overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
        }
        const _keyHandler = (e) => {
            if (e.key === 'Escape') cleanup(false);
            // For destructive confirms Enter dismisses (= cancel) so an
            // accidental keypress on a focused Cancel button still resolves
            // false. Non-danger confirms keep the original Enter=confirm
            // ergonomics so OK-flow dialogs still feel snappy.
            if (e.key === 'Enter') cleanup(!danger ? true : false);
            // Focus trap: keep Tab / Shift+Tab cycling among the two buttons so
            // focus cannot escape onto background elements while the modal is
            // open. Cancel is the first tabbable, OK is the last.
            if (e.key === 'Tab') {
                const cancel = overlay.querySelector('.eclaw-confirm-cancel');
                const ok = overlay.querySelector('.eclaw-confirm-ok');
                const active = document.activeElement;
                if (e.shiftKey && active === cancel) { e.preventDefault(); ok.focus(); }
                else if (!e.shiftKey && active === ok) { e.preventDefault(); cancel.focus(); }
                // Focus escaped the dialog (scrim click / programmatic blur): pull it back in.
                else if (active !== cancel && active !== ok) { e.preventDefault(); cancel.focus(); }
            }
        };
        // Document-level capture so the dialog's key handling keeps working even
        // when focus has escaped the dialog (scrim click / programmatic blur).
        // Removed in cleanup.
        document.addEventListener('keydown', _keyHandler, true);
    });
}

/**
 * showPrompt — styled replacement for window.prompt()
 * @param {Object} opts
 * @param {string} opts.message - Label / instruction text
 * @param {string} [opts.title] - Optional dialog title
 * @param {string} [opts.defaultValue=''] - Pre-filled input value
 * @param {string} [opts.placeholder=''] - Input placeholder
 * @param {string} [opts.confirmText='OK'] - Confirm button label
 * @param {string} [opts.cancelText='Cancel'] - Cancel button label
 * @returns {Promise<string|null>} The entered string, or null if cancelled
 */
function showPrompt({ message, title, defaultValue, placeholder, confirmText, cancelText } = {}) {
    return new Promise((resolve) => {
        const t = _tFb;
        const overlay = document.createElement('div');
        overlay.className = 'dialog-overlay eclaw-confirm-overlay';
        const dialogId = ++_eclawDialogId;
        const titleId = title ? `eclaw-confirm-title-${dialogId}` : '';
        const messageId = `eclaw-confirm-message-${dialogId}`;
        const dialogAria = title
            ? `role="alertdialog" aria-modal="true" aria-labelledby="${titleId}" aria-describedby="${messageId}"`
            : `role="alertdialog" aria-modal="true" aria-label="${_escAttr(message)}" aria-describedby="${messageId}"`;
        overlay.innerHTML = `<div class="dialog eclaw-confirm-dialog" ${dialogAria} ${_ECLAW_DIALOG_SHADOW_STYLE}>
            ${title ? `<div class="dialog-title" id="${titleId}">${_escHtml(title)}</div>` : ''}
            <div class="dialog-body">
                <p id="${messageId}" style="margin:0 0 12px;line-height:1.6;color:var(--text-secondary)">${_escHtml(message)}</p>
                <input type="text" class="eclaw-prompt-input" value="${_escAttr(defaultValue || '')}" placeholder="${_escAttr(placeholder || '')}" style="width:100%;padding:8px 12px;border:1px solid var(--card-border);border-radius:var(--radius);background:var(--bg);color:var(--text);font-size:14px;box-sizing:border-box;">
            </div>
            <div class="dialog-actions">
                <button type="button" class="btn btn-outline eclaw-confirm-cancel">${_escHtml(cancelText || t('dialog_cancel', 'Cancel'))}</button>
                <button type="button" class="btn btn-primary eclaw-confirm-ok">${_escHtml(confirmText || t('dialog_ok', 'OK'))}</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        _eclawLockBodyScroll();
        const input = overlay.querySelector('.eclaw-prompt-input');
        input.focus();
        input.select();
        const cleanup = (result) => { document.removeEventListener('keydown', _escHandler, true); overlay.remove(); _eclawUnlockBodyScroll(); resolve(result); };
        overlay.querySelector('.eclaw-confirm-ok').addEventListener('click', () => cleanup(input.value));
        overlay.querySelector('.eclaw-confirm-cancel').addEventListener('click', () => cleanup(null));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') cleanup(input.value); });
        const _escHandler = (e) => { if (e.key === 'Escape') cleanup(null); };
        // Document-level capture so Esc works even when focus left the dialog. Removed in cleanup.
        document.addEventListener('keydown', _escHandler, true);
    });
}

// HTML escape helpers for dialog content
function _escHtml(s) { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; }
function _escAttr(s) { return (s || '').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

// ─── DEV GUARD: Prevent native alert/confirm/prompt ───
// Wraps native dialogs with console warnings so developers notice and migrate.
// In production the dialogs still work but log a deprecation trace.
(function() {
    const _nativeAlert = window.alert;
    const _nativeConfirm = window.confirm;
    const _nativePrompt = window.prompt;
    window.alert = function(msg) {
        console.warn('[DEPRECATED] alert() used — migrate to showToast(). Message:', msg, new Error().stack);
        return _nativeAlert.call(window, msg);
    };
    window.confirm = function(msg) {
        console.warn('[DEPRECATED] confirm() used — migrate to showConfirm(). Message:', msg, new Error().stack);
        return _nativeConfirm.call(window, msg);
    };
    window.prompt = function(msg, def) {
        console.warn('[DEPRECATED] prompt() used — migrate to showPrompt(). Message:', msg, new Error().stack);
        return _nativePrompt.call(window, msg, def);
    };
})();

// Format timestamp
function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(typeof ts === 'string' && /^\d+$/.test(ts) ? Number(ts) : ts);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    if (isToday) {
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
           d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// State badge color
function getStateBadgeClass(state) {
    const s = (state || '').toLowerCase();
    if (s === 'idle') return 'badge-idle';
    if (s === 'busy' || s === 'active') return 'badge-busy';
    if (s === 'sleeping') return 'badge-sleeping';
    if (s === 'excited' || s === 'eating') return 'badge-excited';
    return 'badge-idle';
}
