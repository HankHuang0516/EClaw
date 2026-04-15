// E-Claw Portal - Auth Guard
// Include on every page except index.html

let currentUser = null;

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

    try {
        const data = await apiCall('GET', '/api/auth/me');
        currentUser = data.user;
        window.currentUser = currentUser;

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

        console.error('[Auth] checkAuth failed, redirecting to login:', e.message || e);
        window.location.href = 'index.html';
        return null;
    }
}
