// ============================================
// Device Preferences Module
// Per-device settings stored in PostgreSQL
// ============================================

const DEFAULTS = {
    broadcast_recipient_info: true,
    remote_control_enabled: false
};

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
        if (key in prefs) filtered[key] = !!prefs[key];
    }
    await pool.query(`
        INSERT INTO device_preferences (device_id, prefs, updated_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (device_id) DO UPDATE
        SET prefs = device_preferences.prefs || $2::jsonb,
            updated_at = $3
    `, [deviceId, JSON.stringify(filtered), Date.now()]);
}

module.exports = { DEFAULTS, initTable, getPrefs, updatePrefs };
