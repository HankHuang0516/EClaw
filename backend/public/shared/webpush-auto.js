(function () {
    'use strict';
    if (window.__webpushAutoLoaded) return;
    window.__webpushAutoLoaded = true;

    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = atob(base64);
        const out = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
        return out;
    }

    async function autoEnableWebPush() {
        try {
            if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
            if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
            const reg = await navigator.serviceWorker.register('/sw.js');
            const existing = await reg.pushManager.getSubscription();
            if (existing) return;
            const vapidRes = await fetch('/api/push/vapid-public-key', { credentials: 'include' })
                .then(r => r.ok ? r.json() : null)
                .catch(() => null);
            if (!vapidRes || !vapidRes.publicKey) return;
            const sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(vapidRes.publicKey)
            });
            const subRes = await fetch('/api/push/subscribe', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subscription: sub.toJSON() })
            });
            // Round-trip push health (card_0a5d4a97): stash the server-side
            // subscription id so the SW can include it on /api/push/ack.
            // Server is free to omit subscriptionId — SW falls back to
            // nonce-only attribution if missing.
            try {
                const body = subRes && subRes.ok ? await subRes.clone().json() : null;
                const subId = body && (body.subscriptionId || (body.subscription && body.subscription.id));
                if (subId && 'caches' in window) {
                    const cache = await caches.open('webpush-meta-v1');
                    await cache.put(
                        '/__webpush-subscription-id',
                        new Response(String(subId), { headers: { 'Content-Type': 'text/plain' } })
                    );
                }
            } catch (_) { /* best-effort */ }
        } catch (e) {
            if (typeof console !== 'undefined') console.debug('[webpush] auto-enable skipped:', e && e.message);
        }
    }

    window.autoEnableWebPush = autoEnableWebPush;

    function tryFire() {
        if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            autoEnableWebPush();
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tryFire);
    } else {
        tryFire();
    }
})();
