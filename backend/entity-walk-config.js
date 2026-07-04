// ============================================
// Entity Walk Config Module (card_31f828967b38f61b2043c808)
// Per-entity self-configured wallpaper "walking / idle stop-action" behavior.
//
// Each entity picks WEIGHTS for its neutral stop-actions and may opt IN to
// NEGATIVE actions (fail/sad/sick/angry). The App reads every bound entity's
// config to drive the live-wallpaper animation; when it picks a stop-action it
// MUST exclude negative actions for entities that did not opt in.
//
// Storage mirrors entity-cross-device-settings.js exactly: one JSONB row keyed
// by (device_id, entity_id). Auth for the WRITE path is self-sovereign — an
// entity may only configure ITSELF, proven by botSecret ownership (the same
// gate as GET /api/device-vars/value, card_keyref). See index.js endpoints.
// ============================================

// Canonical negative-action list. The App AND this backend agree on which
// stop-actions count as "negative"; an entity that has not opted in never
// performs any of these on the wallpaper. Keep in sync with the App renderer.
const NEGATIVE_ACTIONS = ['fail', 'sad', 'sick', 'angry'];

// Neutral stop-actions the App can pick from when no explicit weights are set.
// Missing weights → these are treated as equal weight (fail-safe default).
const NEUTRAL_ACTIONS = ['idle', 'walk', 'sit', 'look', 'sleep', 'eat'];

// Fail-safe defaults: negative actions are NOT performed unless the entity
// explicitly opts in (allowNegative:false), and neutral actions are all equal.
const DEFAULTS = Object.freeze({
    weights: {},          // {} → App treats neutral actions as equal weight
    allowNegative: false, // opt-in required before any negative action fires
});

// Clamp weights so a single value can't be gamed into an integer overflow or a
// negative pull. Any non-finite / <0 value is dropped; >MAX is capped.
const MAX_WEIGHT = 1000;

let pool = null;

async function initTable(chatPool) {
    pool = chatPool;
    if (!pool) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS entity_walk_config (
            device_id TEXT NOT NULL,
            entity_id INT NOT NULL,
            config JSONB DEFAULT '{}',
            updated_at BIGINT DEFAULT EXTRACT(EPOCH FROM NOW()) * 1000,
            PRIMARY KEY (device_id, entity_id)
        )
    `);
}

// Coerce/validate a caller-supplied weights object. Only keeps finite numbers
// >= 0, capped at MAX_WEIGHT; non-object input → {} (fail-safe: equal weight).
function sanitizeWeights(weights) {
    if (!weights || typeof weights !== 'object' || Array.isArray(weights)) return {};
    const clean = {};
    for (const [action, raw] of Object.entries(weights)) {
        const key = String(action).trim();
        if (!key) continue;
        const n = Number(raw);
        if (!Number.isFinite(n) || n < 0) continue; // drop invalid / negative
        clean[key] = Math.min(n, MAX_WEIGHT);
    }
    return clean;
}

// Merge a stored row with defaults so a missing/partial row still yields a
// complete, fail-safe config the App can consume directly.
function mergeWithDefaults(stored) {
    const s = (stored && typeof stored === 'object' && !Array.isArray(stored)) ? stored : {};
    return {
        weights: sanitizeWeights(s.weights),
        allowNegative: s.allowNegative === true, // fail-safe: anything else → false
    };
}

// Read ONE entity's config, always returning a complete fail-safe shape plus
// the canonical negativeActions list (so the App/gate agree on "negative").
async function getConfig(deviceId, entityId) {
    let stored = null;
    if (pool) {
        try {
            const result = await pool.query(
                'SELECT config FROM entity_walk_config WHERE device_id = $1 AND entity_id = $2',
                [deviceId, entityId]
            );
            if (result.rows.length > 0) {
                stored = result.rows[0].config;
                if (typeof stored === 'string') {
                    try { stored = JSON.parse(stored); } catch { stored = {}; }
                }
            }
        } catch (err) {
            console.error('[WalkConfig] getConfig error:', err.message);
        }
    }
    const merged = mergeWithDefaults(stored);
    return {
        weights: merged.weights,
        allowNegative: merged.allowNegative,
        negativeActions: [...NEGATIVE_ACTIONS],
    };
}

// Write ONE entity's config. Only weights + allowNegative are persisted; both
// are sanitized first. Replaces the row's config wholesale (a PUT sets the full
// desired state for that entity, like cross-device-settings' updateSettings).
async function setConfig(deviceId, entityId, { weights, allowNegative }) {
    const cleaned = {
        weights: sanitizeWeights(weights),
        allowNegative: allowNegative === true,
    };
    if (!pool) return cleaned;
    await pool.query(`
        INSERT INTO entity_walk_config (device_id, entity_id, config, updated_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (device_id, entity_id) DO UPDATE
        SET config = $3::jsonb,
            updated_at = $4
    `, [deviceId, entityId, JSON.stringify(cleaned), Date.now()]);
    return cleaned;
}

module.exports = {
    NEGATIVE_ACTIONS,
    NEUTRAL_ACTIONS,
    DEFAULTS,
    MAX_WEIGHT,
    initTable,
    sanitizeWeights,
    mergeWithDefaults,
    getConfig,
    setConfig,
};
