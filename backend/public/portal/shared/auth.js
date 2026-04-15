// E-Claw Portal - Auth Guard
// Include on every page except index.html

let currentUser = null;

async function checkAuth() {
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

        // iOS WebView (and any other WebView host that can't use a JS bridge) — the native
        // shell stashes deviceId/deviceSecret into localStorage via injected JS before the
        // page runs, so fall back to device-login here. This lets native-authenticated users
        // hit embedded portal pages (mission, wallet, invite, community, chat) without being
        // bounced back to the portal's login form.
        try {
            const deviceId = localStorage.getItem('deviceId');
            const deviceSecret = localStorage.getItem('deviceSecret');
            if (deviceId && deviceSecret) {
                const loginData = await apiCall('POST', '/api/auth/device-login', { deviceId, deviceSecret });
                if (loginData && loginData.success && loginData.user) {
                    currentUser = loginData.user;
                    if (!currentUser.deviceSecret) currentUser.deviceSecret = deviceSecret;
                    if (!currentUser.deviceId) currentUser.deviceId = deviceId;
                    window.currentUser = currentUser;
                    return currentUser;
                }
            }
        } catch (iosErr) {
            console.error('[Auth] iOS WebView device-login failed:', iosErr);
        }

        console.error('[Auth] checkAuth failed, redirecting to login:', e.message || e);
        window.location.href = 'index.html';
        return null;
    }
}
