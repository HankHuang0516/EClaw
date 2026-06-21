// E-Claw Service Worker — Web Push Notifications

// Round-trip push health ack (card_0a5d4a97). The push-health-check cron
// fires a silent push (TTL=60, urgency=very-low) with a per-subscription
// nonce. We POST it back to /api/push/ack and DO NOT show a notification,
// so the user never sees the probe. The server uses the ack window to
// compute real end-to-end delivery rate and mark dead subscriptions.
async function ackHealthPush(payload) {
    try {
        // subscriptionId is best-effort: webpush-auto.js stashes the row id
        // in a cache after subscribe; a fresh tab may not have it yet, in
        // which case the server matches on nonce alone.
        let subscriptionId = null;
        try {
            const cache = await caches.open('webpush-meta-v1');
            const match = await cache.match('/__webpush-subscription-id');
            if (match) {
                const txt = await match.text();
                const n = Number(txt);
                if (Number.isInteger(n) && n > 0) subscriptionId = n;
            }
        } catch (_) { /* cache may be empty */ }
        await fetch('/api/push/ack', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                nonce: payload && payload.nonce,
                runId: payload && payload.runId,
                subscriptionId
            })
        });
    } catch (_) { /* network error — server treats as failure */ }
}

self.addEventListener('push', (event) => {
    const data = event.data ? event.data.json() : {};

    // Health probe — ack silently and exit. NEVER call showNotification for
    // this branch; the user must not see the round-trip probe.
    if (data && data.type === 'health') {
        event.waitUntil(ackHealthPush(data));
        return;
    }

    const { title, body, link, category } = data;

    const urlMap = {
        'bot_reply': '/portal/chat.html',
        'speak_to': '/portal/chat.html',
        'broadcast': '/portal/chat.html',
        'feedback_resolved': '/portal/feedback.html',
        'feedback_reply': '/portal/feedback.html',
        'todo_done': '/portal/kanban.html',
        'scheduled': '/portal/chat.html'
    };
    const targetUrl = link ? `/portal/${link}` : (urlMap[category] || '/portal/dashboard.html');

    const iconMap = {
        'bot_reply': '💬', 'speak_to': '🔄', 'broadcast': '📢',
        'feedback_resolved': '✅', 'feedback_reply': '💬',
        'todo_done': '✔️', 'scheduled': '⏰'
    };

    event.waitUntil(
        self.registration.showNotification(title || 'EClawbot', {
            body: body || '',
            icon: '/portal/icon-192.png',
            badge: '/portal/icon-192.png',
            data: { targetUrl },
            tag: category || 'default',
            renotify: true
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = event.notification.data?.targetUrl || '/portal/dashboard.html';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
            // Try to focus an existing portal tab
            const match = windowClients.find(w => w.url.includes('/portal/'));
            if (match) {
                return match.navigate(targetUrl).then(w => w.focus());
            }
            return clients.openWindow(targetUrl);
        })
    );
});
