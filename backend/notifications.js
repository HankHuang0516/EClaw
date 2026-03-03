// ============================================
// Notification System Module
// Handles notification storage and retrieval
// ============================================

const DEFAULT_PREFS = {
    bot_reply: true,
    broadcast: true,
    speak_to: true,
    feedback_resolved: true,
    feedback_reply: true,
    todo_done: true,
    scheduled: true,
    platform_command: true
};

let pool = null;

async function initNotificationTables(chatPool) {
    pool = chatPool;
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS notifications (
                id SERIAL PRIMARY KEY,
                device_id TEXT NOT NULL,
                type VARCHAR(32) NOT NULL,
                category VARCHAR(32) NOT NULL,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                link TEXT,
                metadata JSONB DEFAULT '{}',
                is_read BOOLEAN DEFAULT FALSE,
                created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
            )
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_notifications_device
            ON notifications(device_id, created_at DESC)
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_notifications_unread
            ON notifications(device_id, is_read) WHERE is_read = FALSE
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS notification_preferences (
                device_id TEXT PRIMARY KEY,
                prefs JSONB DEFAULT '{}',
                updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
            )
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id SERIAL PRIMARY KEY,
                device_id TEXT NOT NULL,
                endpoint TEXT NOT NULL UNIQUE,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                user_agent TEXT,
                created_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
            )
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_push_subscriptions_device
            ON push_subscriptions(device_id)
        `);

        console.log('[Notifications] Tables ready');
    } catch (err) {
        console.error('[Notifications] Failed to init tables:', err.message);
    }
}

// ============================================
// Notification CRUD
// ============================================

async function saveNotification(deviceId, { type, category, title, body, link, metadata }) {
    if (!pool) return null;
    try {
        const result = await pool.query(
            `INSERT INTO notifications (device_id, type, category, title, body, link, metadata, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [deviceId, type, category, title, body, link || null, JSON.stringify(metadata || {}), Date.now()]
        );
        return result.rows[0] || null;
    } catch (err) {
        console.warn('[Notifications] Failed to save:', err.message);
        return null;
    }
}

async function getNotifications(deviceId, { limit = 50, offset = 0, unreadOnly = false } = {}) {
    if (!pool) return [];
    try {
        const where = unreadOnly
            ? 'WHERE device_id = $1 AND is_read = FALSE'
            : 'WHERE device_id = $1';
        const result = await pool.query(
            `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
            [deviceId, limit, offset]
        );
        return result.rows;
    } catch (err) {
        console.warn('[Notifications] Failed to get:', err.message);
        return [];
    }
}

async function getUnreadCount(deviceId) {
    if (!pool) return 0;
    try {
        const result = await pool.query(
            'SELECT COUNT(*) FROM notifications WHERE device_id = $1 AND is_read = FALSE',
            [deviceId]
        );
        return parseInt(result.rows[0].count) || 0;
    } catch (err) {
        console.warn('[Notifications] Failed to count:', err.message);
        return 0;
    }
}

async function markRead(deviceId, notifId) {
    if (!pool) return false;
    try {
        await pool.query(
            'UPDATE notifications SET is_read = TRUE WHERE id = $1 AND device_id = $2',
            [notifId, deviceId]
        );
        return true;
    } catch (err) {
        console.warn('[Notifications] Failed to mark read:', err.message);
        return false;
    }
}

async function markAllRead(deviceId) {
    if (!pool) return false;
    try {
        await pool.query(
            'UPDATE notifications SET is_read = TRUE WHERE device_id = $1 AND is_read = FALSE',
            [deviceId]
        );
        return true;
    } catch (err) {
        console.warn('[Notifications] Failed to mark all read:', err.message);
        return false;
    }
}

// Auto-cleanup: remove notifications older than 30 days
async function pruneOldNotifications() {
    if (!pool) return;
    try {
        const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
        const result = await pool.query(
            'DELETE FROM notifications WHERE created_at < $1',
            [cutoff]
        );
        if (result.rowCount > 0) {
            console.log(`[Notifications] Pruned ${result.rowCount} old notifications`);
        }
    } catch (err) {
        console.warn('[Notifications] Prune failed:', err.message);
    }
}

// ============================================
// Notification Preferences
// ============================================

async function getPrefs(deviceId) {
    if (!pool) return { ...DEFAULT_PREFS };
    try {
        const result = await pool.query(
            'SELECT prefs FROM notification_preferences WHERE device_id = $1',
            [deviceId]
        );
        if (result.rows.length === 0) return { ...DEFAULT_PREFS };
        const stored = typeof result.rows[0].prefs === 'string'
            ? JSON.parse(result.rows[0].prefs)
            : result.rows[0].prefs;
        return { ...DEFAULT_PREFS, ...stored };
    } catch (err) {
        console.warn('[Notifications] Failed to get prefs:', err.message);
        return { ...DEFAULT_PREFS };
    }
}

async function updatePrefs(deviceId, prefs) {
    if (!pool) return false;
    try {
        // Validate: only allow known category keys
        const validKeys = Object.keys(DEFAULT_PREFS);
        const sanitized = {};
        for (const key of validKeys) {
            if (key in prefs) {
                sanitized[key] = !!prefs[key];
            }
        }
        await pool.query(
            `INSERT INTO notification_preferences (device_id, prefs, updated_at)
             VALUES ($1, $2, $3)
             ON CONFLICT (device_id)
             DO UPDATE SET prefs = $2, updated_at = $3`,
            [deviceId, JSON.stringify(sanitized), Date.now()]
        );
        return true;
    } catch (err) {
        console.warn('[Notifications] Failed to update prefs:', err.message);
        return false;
    }
}

function isCategoryEnabled(prefs, category) {
    if (!prefs || typeof prefs !== 'object') return true;
    return prefs[category] !== false;
}

// ============================================
// Push Subscriptions (Web Push)
// ============================================

async function savePushSubscription(deviceId, subscription, userAgent) {
    if (!pool) return false;
    try {
        await pool.query(
            `INSERT INTO push_subscriptions (device_id, endpoint, p256dh, auth, user_agent, created_at)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (endpoint)
             DO UPDATE SET device_id = $1, p256dh = $3, auth = $4, user_agent = $5`,
            [deviceId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, userAgent || null, Date.now()]
        );
        return true;
    } catch (err) {
        console.warn('[Notifications] Failed to save push sub:', err.message);
        return false;
    }
}

async function removePushSubscription(endpoint) {
    if (!pool) return false;
    try {
        await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
        return true;
    } catch (err) {
        console.warn('[Notifications] Failed to remove push sub:', err.message);
        return false;
    }
}

async function getPushSubscriptions(deviceId) {
    if (!pool) return [];
    try {
        const result = await pool.query(
            'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE device_id = $1',
            [deviceId]
        );
        return result.rows;
    } catch (err) {
        console.warn('[Notifications] Failed to get push subs:', err.message);
        return [];
    }
}

module.exports = {
    DEFAULT_PREFS,
    initNotificationTables,
    // Notifications
    saveNotification,
    getNotifications,
    getUnreadCount,
    markRead,
    markAllRead,
    pruneOldNotifications,
    // Preferences
    getPrefs,
    updatePrefs,
    isCategoryEnabled,
    // Push subscriptions
    savePushSubscription,
    removePushSubscription,
    getPushSubscriptions
};