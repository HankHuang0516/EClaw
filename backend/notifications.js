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
    platform_command: true,
    delivery_alert: true,
    kanban_done: true,
    kanban_done_auto: true,
    // user_mention: separate toggle for `@<user_display_name>` mentions
    // (card_db71f4423cb1697f9935f460). Independent of speak_to so a user
    // can mute generic chat traffic but keep direct @-pings, or vice
    // versa. Default ON because being addressed by name is the highest-
    // signal notification we send.
    user_mention: true,
    // rich_card_question: separate toggle for rich-card UX where an agent
    // asks the user to pick an option (card_a9edf960). Hank's framing:
    // "like Claude Code asking the user for permission" — these are
    // blocking-style asks that demand a user action before the agent can
    // proceed, so they need a higher-priority notification independent of
    // generic bot replies / speak_to chatter. Default ON for the same
    // reason as user_mention: the user is being explicitly addressed.
    rich_card_question: true
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
        // Atomic shallow-merge via PostgreSQL JSONB `||` so concurrent partial
        // PUTs cannot interleave a stale read with a fresh write. Without the
        // merge, each toggle would erase all prior toggles back to DEFAULT_PREFS.
        await pool.query(
            `INSERT INTO notification_preferences (device_id, prefs, updated_at)
             VALUES ($1, $2::jsonb, $3)
             ON CONFLICT (device_id)
             DO UPDATE SET prefs = COALESCE(notification_preferences.prefs, '{}'::jsonb) || EXCLUDED.prefs,
                           updated_at = EXCLUDED.updated_at`,
            [deviceId, JSON.stringify(sanitized), Date.now()]
        );
        return true;
    } catch (err) {
        console.warn('[Notifications] Failed to update prefs:', err.message);
        return false;
    }
}

// Some dispatch sites use sub-categories that share a single user-facing toggle.
// e.g. "speak_to" toggle in Settings governs bot-to-bot pushes regardless of
// whether the dispatch is same-device (`speak_to`) or cross-device
// (`cross_speak`, `cross_speak_sent`). Without this map, cross-device pushes
// bypass the toggle because the unknown key falls through DEFAULT_PREFS.
const CATEGORY_ALIASES = {
    cross_speak: 'speak_to',
    cross_speak_sent: 'speak_to'
};

function isCategoryEnabled(prefs, category) {
    if (!prefs || typeof prefs !== 'object') return true;
    const effective = CATEGORY_ALIASES[category] || category;
    return prefs[effective] !== false;
}

// ============================================
// Rich-card-question notification helpers
// (card_a9edf960 — "Richard 跳出時觸發 APP + Web 通知")
// ============================================

/**
 * Truncate a string to at most `maxBytes` UTF-8 bytes without splitting a
 * multi-byte codepoint or a high/low surrogate pair. Notification bodies
 * delivered to Web Push / FCM have hard payload limits and a half-truncated
 * emoji renders as the replacement character on some platforms — we cut on
 * a clean codepoint boundary so the body stays readable.
 *
 * @param {string} str
 * @param {number} maxBytes
 * @returns {string}
 */
function truncateUtf8(str, maxBytes) {
    if (typeof str !== 'string') return '';
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return '';
    const buf = Buffer.from(str, 'utf8');
    if (buf.length <= maxBytes) return str;
    let end = maxBytes;
    // Walk back to the first non-continuation byte (0x80..0xBF are continuation).
    while (end > 0 && (buf[end] & 0xC0) === 0x80) end--;
    let out = buf.slice(0, end).toString('utf8');
    // Defensive: drop a trailing lone high surrogate that JS may have left
    // dangling if the UTF-8 walk-back stopped right between surrogate halves.
    if (out.length > 0) {
        const lastCode = out.charCodeAt(out.length - 1);
        if (lastCode >= 0xD800 && lastCode <= 0xDBFF) out = out.slice(0, -1);
    }
    return out;
}

/**
 * Per-device rate limiter for rich-card-question notifications.
 *
 * An agent that fires 100 rich cards in a tight loop should NOT drum-roll
 * the user's phone 100 times. We allow up to `max` pushes per `windowMs`
 * per device; the underlying chat message rows + Socket.IO events still
 * flow normally, only the *notification surface* (Web Push / FCM / DB row)
 * is throttled.
 *
 * Factory returns { check(deviceId), _buckets, _stop() } so each call site
 * (production: one shared instance; tests: fresh instances per test) has
 * isolated state and we can clean up a setInterval handle in tests.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowMs=10000]
 * @param {number} [opts.max=5]
 * @returns {{ check: function, _buckets: Map, _stop: function }}
 */
function createRichCardNotifLimiter(opts = {}) {
    // Guard `>0` (not just `Number.isFinite`) so a caller passing windowMs:0
    // or max:0 doesn't accidentally bypass rate-limiting entirely.
    const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0 ? opts.windowMs : 10_000;
    const max = Number.isFinite(opts.max) && opts.max > 0 ? opts.max : 5;
    // Per-ask dedup TTL: a buggy agent that re-emits the same ask_id 5×
    // (re-render, network retry) burns the whole bucket otherwise. Real
    // Claude-Code-style permission asks dedupe by request id, so we keep
    // a short LRU-ish window. Tests can override via opts.askDedupTtlMs.
    const askDedupTtlMs = Number.isFinite(opts.askDedupTtlMs) && opts.askDedupTtlMs > 0 ? opts.askDedupTtlMs : 60_000;

    const buckets = new Map(); // deviceId -> { count, resetAt }
    const recentAsks = new Map(); // `${deviceId}|${askId}` -> expiresAt

    /**
     * Check whether a notification for (deviceId, askId?) should fire.
     * Returns true → fire and bucket has been incremented.
     * Returns false → either rate-limited or already-seen ask_id.
     *
     * The ask_id dedup short-circuits BEFORE the bucket increments so a
     * re-emit of the same card doesn't burn the user's 5/10s budget.
     */
    function check(deviceId, askId) {
        if (!deviceId) return false;
        const now = Date.now();
        // Per-ask dedup first — repeat of same card to same device is silent.
        if (askId) {
            const key = `${deviceId}|${askId}`;
            const exp = recentAsks.get(key);
            if (exp && exp > now) return false;
            recentAsks.set(key, now + askDedupTtlMs);
            // Opportunistic cleanup inline (cheap; map is small) so the dedup
            // map can't grow unbounded between prune ticks under heavy load.
            if (recentAsks.size > 5000) {
                for (const [k, e] of recentAsks) {
                    if (e <= now) recentAsks.delete(k);
                    if (recentAsks.size <= 1000) break;
                }
            }
        }
        const bucket = buckets.get(deviceId);
        if (!bucket || bucket.resetAt <= now) {
            buckets.set(deviceId, { count: 1, resetAt: now + windowMs });
            return true;
        }
        if (bucket.count >= max) return false;
        bucket.count++;
        return true;
    }

    // Opportunistic cleanup so the Maps don't grow forever in long-running
    // processes. Tests pass `disablePrune: true` to skip the timer.
    let pruneHandle = null;
    if (!opts.disablePrune) {
        pruneHandle = setInterval(() => {
            const now = Date.now();
            const cutoff = now - 60_000;
            for (const [k, v] of buckets) {
                if (v.resetAt < cutoff) buckets.delete(k);
            }
            for (const [k, exp] of recentAsks) {
                if (exp <= now) recentAsks.delete(k);
            }
        }, 5 * 60_000);
        if (typeof pruneHandle.unref === 'function') pruneHandle.unref();
    }

    function _stop() {
        if (pruneHandle) clearInterval(pruneHandle);
        buckets.clear();
        recentAsks.clear();
    }

    return { check, _buckets: buckets, _recentAsks: recentAsks, _stop };
}

/**
 * Decide whether a chat-message payload carries a rich-card question that
 * needs the higher-priority notification.
 *
 * Returns true only when:
 *  - card is a plain object (not null/array/string)
 *  - card.ask_id is a non-empty string
 *  - card.buttons is a non-empty array
 *
 * The caller is expected to have already validated/sanitized the card via
 * the inbound /api/transform or /api/channel/message gate, so this is a
 * cheap defensive check before firing the notification.
 *
 * @param {*} card
 * @returns {boolean}
 */
function isRichCardQuestion(card) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) return false;
    if (typeof card.ask_id !== 'string' || card.ask_id.length === 0) return false;
    if (!Array.isArray(card.buttons) || card.buttons.length === 0) return false;
    return true;
}

/**
 * Build the notification payload (title/body/metadata) for a rich-card
 * question. Pure — no side effects, no DB / WS / push. Callers handle the
 * actual notifyDevice() dispatch so they can also handle rate-limiting and
 * preference gates uniformly with the rest of the notification surface.
 *
 * @param {object} card - validated card { ask_id, buttons[] }
 * @param {object} ctx
 * @param {string} [ctx.questionText] - the message text the agent attached
 *   the buttons to; truncated UTF-8-safe at 240 bytes for the notif body
 *   (FCM/Web-Push payload-safe AND fits CJK/RTL where 100 bytes ≈ 33 Han or
 *   25 Arabic chars — too tight for a real question)
 * @param {string} [ctx.fromName] - display name of the sending agent
 * @param {string} [ctx.titleSuffix='needs your input'] - locale-agnostic
 *   suffix appended to the title (locale-specific suffixes live in i18n.js
 *   for portal-side rendering of the in-app notification panel)
 * @param {number|null} [ctx.fromEntityId]
 * @param {number|null} [ctx.toEntityId]
 * @returns {{type:string,category:string,title:string,body:string,link:string,metadata:object}}
 */
function buildRichCardNotification(card, ctx = {}) {
    const fromName = String(ctx.fromName || 'Agent');
    const titleSuffix = String(ctx.titleSuffix || 'needs your input');
    const title = `${fromName} ${titleSuffix}`;
    // 240 bytes ≈ FCM/Web-Push payload-safe AND wide enough for ~80 Han or
    // ~60 Arabic characters — 100 bytes (the legacy notif body cap) is too
    // tight for localized questions.
    const body = truncateUtf8(String(ctx.questionText || ''), 240);
    return {
        type: 'chat',
        category: 'rich_card_question',
        title,
        body,
        link: 'chat.html',
        metadata: {
            ask_id: String(card.ask_id),
            fromEntityId: ctx.fromEntityId ?? null,
            toEntityId: ctx.toEntityId ?? null,
            buttonCount: Array.isArray(card.buttons) ? card.buttons.length : 0
        }
    };
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
    getPushSubscriptions,
    // Rich-card-question helpers (card_a9edf960)
    truncateUtf8,
    createRichCardNotifLimiter,
    isRichCardQuestion,
    buildRichCardNotification
};
