// ============================================
// Entity Cross-Device Settings Module
// Per-entity settings for cross-device messaging
// ============================================

const DEFAULTS = {
    pre_inject: '',
    forbidden_words: [],
    rate_limit_seconds: 0,
    blacklist: [],
    whitelist_enabled: false,
    whitelist: [],
    reject_message: '',
    allowed_media: ['text', 'photo', 'voice', 'video', 'file']
};

let pool = null;

async function initTable(chatPool) {
    pool = chatPool;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS entity_cross_device_settings (
            device_id TEXT NOT NULL,
            entity_id INT NOT NULL,
            settings JSONB DEFAULT '{}',
            updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
            PRIMARY KEY (device_id, entity_id)
        )
    `);
}

async function getSettings(deviceId, entityId) {
    if (!pool) return { ...DEFAULTS };
    try {
        const result = await pool.query(
            'SELECT settings FROM entity_cross_device_settings WHERE device_id = $1 AND entity_id = $2',
            [deviceId, entityId]
        );
        if (result.rows.length === 0) return { ...DEFAULTS };
        let stored = result.rows[0].settings;
        if (typeof stored === 'string') {
            try { stored = JSON.parse(stored); } catch { stored = {}; }
        }
        return mergeWithDefaults(stored);
    } catch (err) {
        console.error('[CrossDeviceSettings] getSettings error:', err.message);
        return { ...DEFAULTS };
    }
}

function mergeWithDefaults(stored) {
    const merged = {};
    for (const [key, defaultVal] of Object.entries(DEFAULTS)) {
        if (!(key in stored)) {
            merged[key] = Array.isArray(defaultVal) ? [...defaultVal] : defaultVal;
        } else {
            merged[key] = stored[key];
        }
    }
    return merged;
}

function validate(settings) {
    const clean = {};
    if ('pre_inject' in settings) {
        clean.pre_inject = String(settings.pre_inject || '').slice(0, 500);
    }
    if ('forbidden_words' in settings) {
        clean.forbidden_words = toStringArray(settings.forbidden_words, 50);
    }
    if ('rate_limit_seconds' in settings) {
        const n = parseInt(settings.rate_limit_seconds, 10);
        clean.rate_limit_seconds = (isNaN(n) || n < 0) ? 0 : Math.min(n, 86400);
    }
    if ('blacklist' in settings) {
        clean.blacklist = toStringArray(settings.blacklist, 100);
    }
    if ('whitelist_enabled' in settings) {
        clean.whitelist_enabled = !!settings.whitelist_enabled;
    }
    if ('whitelist' in settings) {
        clean.whitelist = toStringArray(settings.whitelist, 100);
    }
    if ('reject_message' in settings) {
        clean.reject_message = String(settings.reject_message || '').slice(0, 200);
    }
    if ('allowed_media' in settings) {
        const valid = ['text', 'photo', 'voice', 'video', 'file'];
        const arr = Array.isArray(settings.allowed_media) ? settings.allowed_media : [];
        clean.allowed_media = arr.filter(m => valid.includes(m));
        if (clean.allowed_media.length === 0) clean.allowed_media = [...valid];
    }
    return clean;
}

function toStringArray(val, maxItems) {
    const arr = Array.isArray(val) ? val : [];
    return arr.slice(0, maxItems).map(s => String(s).trim()).filter(Boolean);
}

async function updateSettings(deviceId, entityId, settings) {
    if (!pool) return;
    const cleaned = validate(settings);
    await pool.query(`
        INSERT INTO entity_cross_device_settings (device_id, entity_id, settings, updated_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (device_id, entity_id) DO UPDATE
        SET settings = entity_cross_device_settings.settings || $3::jsonb,
            updated_at = $4
    `, [deviceId, entityId, JSON.stringify(cleaned), Date.now()]);
}

async function resetSettings(deviceId, entityId) {
    if (!pool) {
        return;
    }
    await pool.query(
        'DELETE FROM entity_cross_device_settings WHERE device_id = $1 AND entity_id = $2',
        [deviceId, entityId]
    );
}

module.exports = { DEFAULTS, initTable, getSettings, updateSettings, resetSettings };
