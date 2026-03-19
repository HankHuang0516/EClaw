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

    portalSocket.on('vars:approval-request', (data) => {
        showVarsApprovalDialog(data);
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

// ============================================
// Vars Approval Dialog (JIT Authorization)
// ============================================

let varsApprovalTimer = null;

function showVarsApprovalDialog(data) {
    const { requestId, entityName, varKeys, expiresAt } = data;

    // Remove any existing dialog
    const existing = document.getElementById('varsApprovalOverlay');
    if (existing) existing.remove();
    if (varsApprovalTimer) clearInterval(varsApprovalTimer);

    const t = (key, fallback) => typeof i18n !== 'undefined' ? i18n.t(key) : fallback;

    const overlay = document.createElement('div');
    overlay.id = 'varsApprovalOverlay';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const esc = (s) => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };

    const keysHtml = varKeys.length > 0
        ? varKeys.map(k => `<code style="background:#f0f0f0;padding:2px 8px;border-radius:4px;font-size:13px;">${esc(k)}</code>`).join(' ')
        : '<em>(' + t('vars_no_keys', 'no variables') + ')</em>';

    overlay.innerHTML = `
        <div style="background:#fff;border-radius:16px;padding:32px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.3);text-align:center;">
            <div style="font-size:40px;margin-bottom:12px;">&#x1f510;</div>
            <h3 style="margin:0 0 8px;font-size:18px;">${t('vars_approval_title', 'Variable Access Request')}</h3>
            <p style="margin:0 0 16px;color:#555;font-size:14px;">
                <strong>${esc(entityName)}</strong> ${t('vars_approval_body', 'wants to read your variables')}
            </p>
            <div style="margin:0 0 20px;text-align:left;padding:12px;background:#f8f8f8;border-radius:8px;">
                ${keysHtml}
            </div>
            <div style="display:flex;gap:12px;justify-content:center;">
                <button id="varsApprovalDeny" style="padding:10px 24px;border:1px solid #ddd;border-radius:8px;background:#fff;cursor:pointer;font-size:14px;">
                    ${t('vars_deny', 'Deny')}
                </button>
                <button id="varsApprovalAllow" disabled style="padding:10px 24px;border:none;border-radius:8px;background:#ccc;color:#fff;cursor:not-allowed;font-size:14px;min-width:120px;">
                    ${t('vars_allow', 'Allow')} (3s)
                </button>
            </div>
            <p id="varsApprovalCountdown" style="margin:12px 0 0;color:#999;font-size:12px;"></p>
        </div>
    `;

    document.body.appendChild(overlay);

    const allowBtn = document.getElementById('varsApprovalAllow');
    const denyBtn = document.getElementById('varsApprovalDeny');
    const countdownEl = document.getElementById('varsApprovalCountdown');

    // 3-second cooldown on Allow button
    let cooldown = 3;
    const cooldownInterval = setInterval(() => {
        cooldown--;
        if (cooldown > 0) {
            allowBtn.textContent = `${t('vars_allow', 'Allow')} (${cooldown}s)`;
        } else {
            clearInterval(cooldownInterval);
            allowBtn.disabled = false;
            allowBtn.style.background = '#4CAF50';
            allowBtn.style.cursor = 'pointer';
            allowBtn.textContent = t('vars_allow', 'Allow');
        }
    }, 1000);

    // Auto-timeout countdown
    const timeoutMs = expiresAt - Date.now();
    let remaining = Math.ceil(timeoutMs / 1000);
    countdownEl.textContent = `${t('vars_auto_deny', 'Auto-deny in')} ${remaining}s`;
    varsApprovalTimer = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            respond(false);
        } else {
            countdownEl.textContent = `${t('vars_auto_deny', 'Auto-deny in')} ${remaining}s`;
        }
    }, 1000);

    function respond(approved) {
        clearInterval(cooldownInterval);
        clearInterval(varsApprovalTimer);
        varsApprovalTimer = null;
        overlay.remove();
        if (portalSocket && portalSocket.connected) {
            portalSocket.emit('vars:approval-response', { requestId, approved });
        }
    }

    allowBtn.addEventListener('click', () => respond(true));
    denyBtn.addEventListener('click', () => respond(false));
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('notifDropdown');
    const bell = document.getElementById('notifBell');
    if (dropdown && dropdown.style.display !== 'none' && !dropdown.contains(e.target) && !bell.contains(e.target)) {
        dropdown.style.display = 'none';
    }
});
