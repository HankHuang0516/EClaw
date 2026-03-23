// E-Claw Portal - Socket.IO Client + Notification Center
// Loaded after auth.js on all authenticated pages

let portalSocket = null;
let unreadNotifCount = 0;

// ============================================
// Socket.IO Connection
// ============================================

function initPortalSocket() {
    if (!currentUser) return;
    if (typeof io === 'undefined') {
        console.warn('[Socket] socket.io client not loaded');
        return;
    }

    portalSocket = io({
        auth: {
            deviceId: currentUser.deviceId,
            deviceSecret: currentUser.deviceSecret
        },
        reconnectionDelay: 2000,
        reconnectionAttempts: Infinity,
        transports: ['websocket', 'polling']
    });

    portalSocket.on('connect', () => {
        console.log('[Socket] Connected');
        updateNotifBadge();
    });

    portalSocket.on('notification', (notif) => {
        handleIncomingNotification(notif);
    });

    portalSocket.on('chat:message', (msg) => {
        if (typeof onSocketChatMessage === 'function') onSocketChatMessage(msg);
    });

    portalSocket.on('entity:update', (data) => {
        if (typeof onSocketEntityUpdate === 'function') onSocketEntityUpdate(data);
    });

    portalSocket.on('entityAdded', (data) => {
        if (typeof onSocketEntityAdded === 'function') onSocketEntityAdded(data);
    });

    portalSocket.on('entityDeleted', (data) => {
        if (typeof onSocketEntityDeleted === 'function') onSocketEntityDeleted(data);
    });

    portalSocket.on('channelAccountsUpdated', () => {
        if (typeof onSocketChannelAccountsUpdated === 'function') onSocketChannelAccountsUpdated();
    });

    portalSocket.on('disconnect', () => {
        console.log('[Socket] Disconnected');
    });

    portalSocket.on('connect_error', (err) => {
        console.warn('[Socket] Connect error:', err.message);
    });

    // Reconnect when page becomes visible again (Android WebView background→foreground)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && portalSocket && !portalSocket.connected) {
            console.log('[Socket] Page visible — reconnecting...');
            portalSocket.connect();
        }
    });
}

// ============================================
// Notification Bell + Dropdown
// ============================================

function handleIncomingNotification(notif) {
    unreadNotifCount++;
    renderNotifBadge(unreadNotifCount);

    // Show toast for important categories
    const toastCategories = ['bot_reply', 'feedback_resolved', 'feedback_reply', 'todo_done'];
    if (toastCategories.includes(notif.category)) {
        showToast(notif.title + ': ' + notif.body, 'info');
    }

    // Prepend to dropdown if open
    const list = document.getElementById('notifList');
    if (list) {
        const empty = list.querySelector('.notif-empty');
        if (empty) empty.remove();
        list.insertBefore(createNotifItem(notif), list.firstChild);
    }
}

async function updateNotifBadge() {
    try {
        const data = await apiCall('GET', '/api/notifications/count');
        unreadNotifCount = data.count || 0;
        renderNotifBadge(unreadNotifCount);
    } catch (e) {
        // Silently fail
    }
}

function renderNotifBadge(count) {
    const badge = document.getElementById('notifBadge');
    if (!badge) return;
    if (count > 0) {
        badge.textContent = count > 99 ? '99+' : count;
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
    }
}

function toggleNotifDropdown(e) {
    if (e) e.stopPropagation();
    const dropdown = document.getElementById('notifDropdown');
    if (!dropdown) return;

    const isVisible = dropdown.style.display !== 'none';
    if (isVisible) {
        dropdown.style.display = 'none';
    } else {
        dropdown.style.display = 'block';
        loadNotifDropdown();
    }
}

async function loadNotifDropdown() {
    const list = document.getElementById('notifList');
    if (!list) return;

    const t = (key, fallback) => typeof i18n !== 'undefined' ? i18n.t(key) : fallback;
    list.innerHTML = '<div class="notif-loading">...</div>';

    try {
        const data = await apiCall('GET', '/api/notifications?limit=20');
        const notifications = data.notifications || [];

        if (notifications.length === 0) {
            list.innerHTML = `<div class="notif-empty">${t('notif_empty', 'No notifications')}</div>`;
            return;
        }

        list.innerHTML = '';
        for (const notif of notifications) {
            list.appendChild(createNotifItem(notif));
        }
    } catch (e) {
        list.innerHTML = '<div class="notif-empty">Failed to load</div>';
    }
}

function createNotifItem(notif) {
    const item = document.createElement('div');
    item.className = 'notif-item' + (notif.is_read || notif.isRead ? '' : ' notif-unread');
    item.dataset.id = notif.id;

    const iconMap = {
        'bot_reply': '💬', 'speak_to': '🔄', 'broadcast': '📢',
        'feedback_resolved': '✅', 'feedback_reply': '💬',
        'todo_done': '✔️', 'scheduled': '⏰', 'system': '🔔'
    };
    const icon = iconMap[notif.category] || '🔔';
    const time = formatTime(notif.created_at || notif.createdAt);

    item.innerHTML = `
        <div class="notif-item-icon">${icon}</div>
        <div class="notif-item-content">
            <div class="notif-item-title">${escapeHtml(notif.title)}</div>
            <div class="notif-item-body">${escapeHtml(notif.body)}</div>
            <div class="notif-item-time">${time}</div>
        </div>
    `;

    item.addEventListener('click', () => {
        markNotifRead(notif.id);
        item.classList.remove('notif-unread');
        if (notif.link) {
            window.location.href = notif.link;
        }
    });

    return item;
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function markNotifRead(id) {
    try {
        await apiCall('POST', '/api/notifications/read', { id });
        if (unreadNotifCount > 0) unreadNotifCount--;
        renderNotifBadge(unreadNotifCount);
    } catch (e) { /* ignore */ }
}

async function markAllNotifsRead() {
    try {
        await apiCall('POST', '/api/notifications/read-all');
        unreadNotifCount = 0;
        renderNotifBadge(0);
        // Update dropdown items
        document.querySelectorAll('.notif-unread').forEach(el => el.classList.remove('notif-unread'));
    } catch (e) { /* ignore */ }
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('notifDropdown');
    const bell = document.getElementById('notifBell');
    if (dropdown && dropdown.style.display !== 'none' && !dropdown.contains(e.target) && !bell.contains(e.target)) {
        dropdown.style.display = 'none';
    }
});
