// E-Claw Portal - Auth Guard
// Include on every page except index.html

let currentUser = null;

// ── Session keeper (OODA-R Phase 2 #6, pain 4) ──
// Single-flight refresh: many tabs / many callers collapse onto one
// in-flight POST /api/auth/refresh (mutex against thundering herd on
// expiry). Refresh fires 10 minutes before expiresAt (floor 30s).
let _refreshTimer = null;
let _refreshInflight = null;

function _refreshSession() {
    if (_refreshInflight) return _refreshInflight;
    _refreshInflight = apiCall('POST', '/api/auth/refresh', {}, { skip401Redirect: true })
        .then((resp) => {
            if (resp && resp.expiresAt) _scheduleSessionRefresh(resp.expiresAt);
            return resp;
        })
        .catch((err) => {
            // Refresh with an already-expired/invalid token: let the next
            // regular apiCall surface the reason-coded 401 prompt.
            console.warn('[Auth] session refresh failed:', err && err.message);
            return null;
        })
        .finally(() => { _refreshInflight = null; });
    return _refreshInflight;
}

function _scheduleSessionRefresh(expiresAtMs) {
    if (_refreshTimer) clearTimeout(_refreshTimer);
    const lead = 10 * 60 * 1000;
    const delay = Math.max(expiresAtMs - Date.now() - lead, 30 * 1000);
    _refreshTimer = setTimeout(_refreshSession, delay);
    _refreshTimer && _refreshTimer.unref && _refreshTimer.unref();
}

async function checkAuth() {
    // If WebView host passed an authToken in the URL (iOS shell), stash it as a cookie
    // so apiCall's default credentials include it on /me. Also mirror to localStorage
    // so subsequent reloads inside the same WebView see it.
    try {
        const qp = new URLSearchParams(window.location.search);
        const qToken = qp.get('authToken');
        if (qToken) {
            // Set a short-lived cookie for this origin; HttpOnly flag is not settable from JS
            // but the server-side eclaw_session cookie is still authoritative for web.
            try { document.cookie = 'eclaw_session=' + qToken + '; path=/; SameSite=Lax'; } catch (_) {}
            try { localStorage.setItem('authToken', qToken); } catch (_) {}
        }
    } catch (_) { /* ignore */ }

    // Collect any URL-param device credentials up-front so we can detect a
    // session-vs-URL device mismatch after /me succeeds.
    let urlDeviceId = null;
    let urlDeviceSecret = null;
    try {
        const params = new URLSearchParams(window.location.search);
        urlDeviceId = params.get('deviceId');
        urlDeviceSecret = params.get('deviceSecret');
    } catch (_) { /* ignore */ }

    try {
        // Suppress api.js's built-in 401->index redirect so the WebView / URL-param
        // fallbacks below get a chance to device-login. Without this, the redirect
        // starts before our fallback fetch completes and the browser aborts it
        // with "TypeError: Failed to fetch". If every fallback fails, we redirect
        // to index.html explicitly at the bottom of this function.
        const data = await apiCall('GET', '/api/auth/me', null, { skip401Redirect: true });
        currentUser = data.user;
        window.currentUser = currentUser;

        // Pain 4 fix: proactive sliding-session renewal. /me now returns
        // session.expiresAt; refresh shortly before expiry so a long-lived
        // tab never hits a hard token_expired 401.
        if (data.session && data.session.expiresAt) {
            _scheduleSessionRefresh(data.session.expiresAt);
        }

        // WebView stale-session guard: if the host passed deviceId+deviceSecret
        // in the URL but /me returned a DIFFERENT device (e.g. leftover session
        // cookie from a prior account or test device), the URL-param device is
        // authoritative for this launch. Re-login so env-vars and other pages
        // hit the device the shell intended, not whoever the stale cookie
        // happens to belong to. Without this, pages like env-vars.html render
        // empty because they query the wrong device_vars row.
        if (urlDeviceId && urlDeviceSecret && currentUser.deviceId && urlDeviceId !== currentUser.deviceId) {
            try {
                const relogin = await apiCall('POST', '/api/auth/device-login', {
                    deviceId: urlDeviceId,
                    deviceSecret: urlDeviceSecret
                });
                if (relogin && relogin.success && relogin.user) {
                    currentUser = relogin.user;
                    if (!currentUser.deviceSecret) currentUser.deviceSecret = urlDeviceSecret;
                    if (!currentUser.deviceId) currentUser.deviceId = urlDeviceId;
                    window.currentUser = currentUser;
                    console.log('[Auth] WebView device mismatch → re-logged into URL-param device');
                }
            } catch (reloginErr) {
                console.warn('[Auth] WebView device mismatch but re-login failed, staying on session user:', reloginErr);
            }
        }

        // Restore language preference from server if not set locally
        if (currentUser.language && typeof i18n !== 'undefined') {
            const local = localStorage.getItem('eclaw-language');
            if (!local && currentUser.language !== 'en') {
                localStorage.setItem('eclaw-language', currentUser.language);
                i18n.lang = currentUser.language;
                i18n.apply();
            }
        }

        // Update nav email
        const emailEl = document.getElementById('navEmail');
        if (emailEl) emailEl.textContent = currentUser.email;

        // Ensure admin link is added after user data is available
        // (the 600ms timeout in nav.js may fire before this API call completes)
        if (typeof window._addAdminLink === 'function') window._addAdminLink();

        return currentUser;
    } catch (e) {
        // Android WebView: auto-login with device credentials from JS Bridge
        if (typeof AndroidBridge !== 'undefined') {
            try {
                const deviceId = AndroidBridge.getDeviceId();
                const deviceSecret = AndroidBridge.getDeviceSecret();
                const loginData = await apiCall('POST', '/api/auth/device-login', { deviceId, deviceSecret });
                if (loginData.success && loginData.user) {
                    currentUser = loginData.user;
                    // device-login may not return deviceSecret in user object
                    if (!currentUser.deviceSecret) currentUser.deviceSecret = deviceSecret;
                    if (!currentUser.deviceId) currentUser.deviceId = deviceId;
                    window.currentUser = currentUser;
                    return currentUser;
                }
            } catch (bridgeErr) {
                console.error('[Auth] Android Bridge device-login failed:', bridgeErr);
            }
        }

        // iOS WebView (and any other WebView host that can't use a JS bridge) — read
        // credentials from the URL query string first (native shell puts them there) and
        // fall back to localStorage (native shell may also stash them via injected JS).
        // Once we device-login, the server sets the session cookie on the WebView.
        try {
            let deviceId = null;
            let deviceSecret = null;
            try {
                const params = new URLSearchParams(window.location.search);
                deviceId = params.get('deviceId');
                deviceSecret = params.get('deviceSecret');
            } catch (_) { /* ignore */ }
            if (!deviceId) deviceId = localStorage.getItem('deviceId');
            if (!deviceSecret) deviceSecret = localStorage.getItem('deviceSecret');
            console.log('[Auth] iOS WebView fallback: deviceId=', deviceId ? 'present' : 'missing',
                        'deviceSecret=', deviceSecret ? 'present' : 'missing');
            if (deviceId && deviceSecret) {
                const loginData = await apiCall('POST', '/api/auth/device-login', { deviceId, deviceSecret });
                if (loginData && loginData.success && loginData.user) {
                    currentUser = loginData.user;
                    if (!currentUser.deviceSecret) currentUser.deviceSecret = deviceSecret;
                    if (!currentUser.deviceId) currentUser.deviceId = deviceId;
                    window.currentUser = currentUser;
                    // Persist so future reloads skip this branch
                    try {
                        if (!localStorage.getItem('deviceId')) localStorage.setItem('deviceId', deviceId);
                        if (!localStorage.getItem('deviceSecret')) localStorage.setItem('deviceSecret', deviceSecret);
                    } catch (_) { /* ignore */ }
                    return currentUser;
                }
                console.warn('[Auth] device-login returned non-success:', loginData);
            }
        } catch (iosErr) {
            console.error('[Auth] iOS WebView device-login failed:', iosErr);
        }

        // Distinguish transport-level disconnect from auth-level failure.
        // api.js tags fetch-throw with `networkError:true`; do NOT force logout
        // on transport blips — show the reconnect overlay and keep session state.
        if (e && (e.networkError || e.name === 'TypeError'
            || (typeof navigator !== 'undefined' && navigator.onLine === false))) {
            console.warn('[Auth] checkAuth transport failure (network) — keeping session, showing reconnect overlay:', e.message || e);
            try {
                if (window.__reconnectOverlay && typeof window.__reconnectOverlay.show === 'function') {
                    window.__reconnectOverlay.show();
                }
            } catch (_) { /* overlay optional */ }
            return null;
        }
        console.error('[Auth] checkAuth failed, redirecting to login:', e.message || e);
        window.location.href = 'index.html';
        return null;
    }
}
