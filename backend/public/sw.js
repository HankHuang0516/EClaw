// E-Claw Service Worker — Web Push Notifications

self.addEventListener('push', (event) => {
    const data = event.data ? event.data.json() : {};
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
