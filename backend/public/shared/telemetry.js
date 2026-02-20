/**
 * E-Claw Portal — Device Telemetry SDK
 *
 * Auto-captures:
 *   - Page views (on DOMContentLoaded)
 *   - API calls (wraps global apiCall)
 *   - Errors (window.onerror + unhandledrejection)
 *
 * Manual tracking:
 *   - telemetry.trackAction(action, meta)
 *   - telemetry.trackError(error, meta)
 *   - telemetry.trackLifecycle(action, meta)
 *
 * Include AFTER api.js and auth.js:
 *   <script src="../shared/telemetry.js"></script>
 *
 * Batches entries and flushes every 30s or on page unload.
 */

const _telemetry = (() => {
    const FLUSH_INTERVAL = 30000; // 30 seconds
    const MAX_BATCH = 50;
    let _buffer = [];
    let _page = null;
    let _flushTimer = null;

    // ---- helpers ----

    function _getDeviceCredentials() {
        if (typeof currentUser !== 'undefined' && currentUser) {
            return { deviceId: currentUser.deviceId, deviceSecret: currentUser.deviceSecret };
        }
        return null;
    }

    function _push(entry) {
        entry.ts = entry.ts || Date.now();
        entry.page = entry.page || _page;
        _buffer.push(entry);
        if (_buffer.length >= MAX_BATCH) _flush();
    }

    async function _flush() {
        if (_buffer.length === 0) return;
        const creds = _getDeviceCredentials();
        if (!creds) return; // not authenticated yet

        const batch = _buffer.splice(0, MAX_BATCH);
        try {
            await fetch(`${API_BASE}/api/device-telemetry`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    deviceId: creds.deviceId,
                    deviceSecret: creds.deviceSecret,
                    entries: batch
                })
            });
        } catch {
            // Re-queue on failure (drop if buffer is huge to avoid memory leak)
            if (_buffer.length < 200) {
                _buffer.unshift(...batch);
            }
        }
    }

    // ---- auto: wrap apiCall ----

    if (typeof apiCall === 'function') {
        const _origApiCall = apiCall;
        // Replace global apiCall
        window.apiCall = async function (method, path, body) {
            const start = Date.now();
            try {
                const result = await _origApiCall(method, path, body);
                _push({
                    type: 'api_call',
                    action: `${method} ${path.split('?')[0]}`,
                    input: body ? _summarize(body) : null,
                    output: { success: result.success !== undefined ? result.success : true },
                    duration: Date.now() - start
                });
                return result;
            } catch (err) {
                _push({
                    type: 'api_call',
                    action: `${method} ${path.split('?')[0]}`,
                    input: body ? _summarize(body) : null,
                    output: { success: false, error: (err.message || '').substring(0, 200), status: err.status },
                    duration: Date.now() - start
                });
                throw err;
            }
        };
    }

    function _summarize(obj) {
        if (!obj || typeof obj !== 'object') return obj;
        const SENSITIVE = ['deviceSecret', 'botSecret', 'password', 'secret', 'token'];
        const out = {};
        for (const [k, v] of Object.entries(obj)) {
            if (SENSITIVE.some(s => k.toLowerCase().includes(s))) {
                out[k] = '[REDACTED]';
            } else if (typeof v === 'string' && v.length > 100) {
                out[k] = v.substring(0, 100) + '...';
            } else {
                out[k] = v;
            }
        }
        return out;
    }

    // ---- auto: page view ----

    function _detectPage() {
        const path = window.location.pathname;
        if (path.includes('dashboard')) return 'dashboard';
        if (path.includes('chat')) return 'chat';
        if (path.includes('mission')) return 'mission';
        if (path.includes('settings')) return 'settings';
        if (path.includes('admin')) return 'admin';
        if (path.includes('index') || path.endsWith('/portal/')) return 'login';
        return path.split('/').pop()?.replace('.html', '') || 'unknown';
    }

    window.addEventListener('DOMContentLoaded', () => {
        _page = _detectPage();
        // Delay slightly so auth.js can set currentUser
        setTimeout(() => {
            _push({ type: 'page_view', action: _page });
        }, 500);
    });

    // ---- auto: error tracking ----

    window.addEventListener('error', (event) => {
        _push({
            type: 'error',
            action: 'js_error',
            meta: {
                message: (event.message || '').substring(0, 200),
                source: event.filename ? event.filename.split('/').pop() : null,
                line: event.lineno,
                col: event.colno
            }
        });
    });

    window.addEventListener('unhandledrejection', (event) => {
        const reason = event.reason;
        _push({
            type: 'error',
            action: 'unhandled_promise',
            meta: {
                message: (reason && reason.message ? reason.message : String(reason)).substring(0, 200)
            }
        });
    });

    // ---- auto: flush on unload ----

    window.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') _flush();
    });
    window.addEventListener('beforeunload', () => _flush());

    // ---- periodic flush ----

    _flushTimer = setInterval(_flush, FLUSH_INTERVAL);

    // ---- public API ----

    return {
        /** Track a user action (button click, dialog open, etc.) */
        trackAction(action, meta = null) {
            _push({ type: 'user_action', action, meta });
        },

        /** Track an error */
        trackError(error, meta = null) {
            const msg = error instanceof Error ? error.message : String(error);
            _push({ type: 'error', action: msg.substring(0, 128), meta });
        },

        /** Track a lifecycle event (app resume, visibility change, etc.) */
        trackLifecycle(action, meta = null) {
            _push({ type: 'lifecycle', action, meta });
        },

        /** Force flush the buffer now */
        flush: _flush,

        /** Get current buffer size (for debugging) */
        get bufferSize() { return _buffer.length; }
    };
})();

// Expose as global
window.telemetry = _telemetry;
