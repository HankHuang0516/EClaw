// ============================================
// Device Preferences Module
// Per-device settings stored in PostgreSQL
// ============================================

const DEFAULTS = {
    broadcast_recipient_info: true,
    remote_control_enabled: false,
    // Kanban nudge (stale-card reminder) — applies uniformly to all entities
    kanban_nudge_batch_size: 1,
    kanban_nudge_priority_mode: 'priority_first',  // 'priority_first' | 'column_first' | 'column_level'
    kanban_nudge_interval_minutes: 180,
    // Which columns get nudged. Default: everything except backlog (待排程).
    kanban_nudge_statuses: ['todo', 'in_progress', 'review'],
};

const NUDGE_PRIORITY_MODES = new Set(['priority_first', 'column_first', 'column_level']);
const NUDGE_STATUS_OPTIONS = new Set(['backlog', 'todo', 'in_progress', 'review']);

function coerceValue(key, raw) {
    const def = DEFAULTS[key];
    if (typeof def === 'boolean') return !!raw;
    if (typeof def === 'number') {
        const n = Number(raw);
        if (!Number.isFinite(n)) return def;
        if (key === 'kanban_nudge_batch_size') return Math.max(1, Math.min(20, Math.round(n)));
        if (key === 'kanban_nudge_interval_minutes') return Math.max(5, Math.min(24 * 60, Math.round(n)));
        return n;
    }
    if (key === 'kanban_nudge_priority_mode') {
        return NUDGE_PRIORITY_MODES.has(raw) ? raw : def;
    }
    if (key === 'kanban_nudge_statuses') {
        if (!Array.isArray(raw)) return [...def];
        const filtered = raw.filter(s => NUDGE_STATUS_OPTIONS.has(s));
        // Must nudge at least one column, else fall back to default.
        return filtered.length ? filtered : [...def];
    }
    return def;
}

let pool = null;

async function initTable(chatPool) {
    pool = chatPool;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS device_preferences (
            device_id TEXT PRIMARY KEY,
            prefs JSONB DEFAULT '{}',
            updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000
        )
    `);
}

async function getPrefs(deviceId) {
    if (!pool) return { ...DEFAULTS };
    try {
        const result = await pool.query(
            'SELECT prefs FROM device_preferences WHERE device_id = $1',
            [deviceId]
        );
        if (result.rows.length === 0) return { ...DEFAULTS };
        let stored = result.rows[0].prefs;
        if (typeof stored === 'string') {
            try { stored = JSON.parse(stored); } catch { stored = {}; }
        }
        return { ...DEFAULTS, ...stored };
    } catch (err) {
        console.error('[DevicePrefs] getPrefs error:', err.message);
        return { ...DEFAULTS };
    }
}

async function updatePrefs(deviceId, prefs) {
    if (!pool) return;
    const filtered = {};
    for (const key of Object.keys(DEFAULTS)) {
        if (key in prefs) filtered[key] = coerceValue(key, prefs[key]);
    }
    await pool.query(`
        INSERT INTO device_preferences (device_id, prefs, updated_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (device_id) DO UPDATE
        SET prefs = device_preferences.prefs || $2::jsonb,
            updated_at = $3
    `, [deviceId, JSON.stringify(filtered), Date.now()]);
}

async function setOnboarding(deviceId, payload) {
    if (!pool || !deviceId) return;
    const safe = {
        track: typeof payload.track === 'string' ? payload.track.slice(0, 32) : null,
        dismissed: !!payload.dismissed,
        completedAt: payload.completedAt || new Date().toISOString()
    };
    await pool.query(`
        INSERT INTO device_preferences (device_id, prefs, updated_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (device_id) DO UPDATE
        SET prefs = device_preferences.prefs || $2::jsonb,
            updated_at = $3
    `, [deviceId, JSON.stringify({ onboarding: safe }), Date.now()]);
}

module.exports = { DEFAULTS, initTable, getPrefs, updatePrefs, setOnboarding };
