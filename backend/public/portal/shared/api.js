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
            window.location.href = 'index.html';
        }
        throw new Error(data.error || 'Not authenticated');
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
 * @param {string} opts.message - Main message text
 * @param {string} [opts.title] - Optional dialog title
 * @param {string} [opts.confirmText='OK'] - Confirm button label
 * @param {string} [opts.cancelText='Cancel'] - Cancel button label
 * @param {boolean} [opts.danger=false] - Red confirm button for destructive actions
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
function showConfirm({ message, title, confirmText, cancelText, danger } = {}) {
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
        overlay.innerHTML = `<div class="dialog eclaw-confirm-dialog" ${dialogAria}>
            ${title ? `<div class="dialog-title" id="${titleId}">${_escHtml(title)}</div>` : ''}
            <div class="dialog-body"><p id="${messageId}" style="margin:0;line-height:1.6;color:var(--text-secondary)">${_escHtml(message)}</p></div>
            <div class="dialog-actions">
                <button type="button" class="btn btn-outline eclaw-confirm-cancel">${_escHtml(cancelText || t('dialog_cancel', 'Cancel'))}</button>
                <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'} eclaw-confirm-ok">${_escHtml(confirmText || t('dialog_ok', 'OK'))}</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        const cleanup = (result) => { overlay.remove(); resolve(result); };
        // Safe default focus: when danger=true, focus Cancel so a stray
        // Enter / Space does not commit the destructive action. Matches the
        // Material Design and Apple HIG guidance for destructive confirms.
        const safeBtnSel = danger ? '.eclaw-confirm-cancel' : '.eclaw-confirm-ok';
        overlay.querySelector(safeBtnSel).focus();
        overlay.querySelector('.eclaw-confirm-ok').addEventListener('click', () => cleanup(true));
        overlay.querySelector('.eclaw-confirm-cancel').addEventListener('click', () => cleanup(false));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
        overlay.addEventListener('keydown', (e) => {
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
            }
        });
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
        overlay.innerHTML = `<div class="dialog eclaw-confirm-dialog" ${dialogAria}>
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
        const input = overlay.querySelector('.eclaw-prompt-input');
        input.focus();
        input.select();
        const cleanup = (result) => { overlay.remove(); resolve(result); };
        overlay.querySelector('.eclaw-confirm-ok').addEventListener('click', () => cleanup(input.value));
        overlay.querySelector('.eclaw-confirm-cancel').addEventListener('click', () => cleanup(null));
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') cleanup(input.value); });
        overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') cleanup(null); });
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