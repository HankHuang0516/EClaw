/**
 * Usage Warning Module (card_9cd84ee7d830b2f76c595f6c)
 *
 * Reads the latest usage_snapshots row for a device, decides whether the
 * remaining quota crossed the per-device threshold, and formats an i18n
 * system-warning prefix that /api/transform prepends to outbound messages.
 *
 * Spec: device opts in via usage_warning_config pref
 *   { enabled: bool, threshold_5h_pct: 0..100, threshold_7d_pct: 0..100 }
 *
 * Trigger:  (5h_remaining ≤ threshold_5h_pct) OR (7d_remaining ≤ threshold_7d_pct)
 * Stale:    captured_at older than 6h → skip (no false-positive warnings)
 * Cooldown: once attached, suppress re-attachment for COOLDOWN window per device
 *           (card_a69e8ffa — without this the prefix rode EVERY message ≤ threshold,
 *           so it read as a repeated standalone conversational line rather than a
 *           one-off piggyback on a content push).
 */

const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;  // 6 hours
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;     // 30 min — one warning per device per window

// Per-device last-attached timestamp (ms epoch). In-memory is sufficient: a missed
// cooldown across a process restart at most lets one extra warning through, which is
// harmless. Keyed by deviceId.
const _lastWarnedAt = new Map();

const WARNING_TEMPLATES = {
    'zh': '⚠️ 系統訊息：本 Agent 5h 剩餘 {five}% / 7d 剩餘 {seven}%。已達警戒閾值。',
    'zh-TW': '⚠️ 系統訊息：本 Agent 5h 剩餘 {five}% / 7d 剩餘 {seven}%。已達警戒閾值。',
    'zh-CN': '⚠️ 系统消息：本 Agent 5h 剩余 {five}% / 7d 剩余 {seven}%。已达警戒阈值。',
    'en': '⚠️ System notice: this Agent has {five}% of its 5h budget and {seven}% of its weekly budget left — quota warning threshold reached.',
};

/**
 * Pull the Claude rate-limit % from either the flat or nested live shape.
 * Mirrors backend/usage-api.js#pickClaudeLivePct so we never drift.
 */
function pickClaudeLivePct(live, key) {
    if (!live) return null;
    const flatKey = key + '_pct';
    if (typeof live[flatKey] === 'number') return live[flatKey];
    const nested = live.rate_limits && live.rate_limits[key];
    if (nested && typeof nested.used_percentage === 'number') return nested.used_percentage;
    return null;
}

/**
 * Pure decision function: should we attach the warning right now?
 *
 * @param {object|null} snapshot — { claude_json, codex_json, captured_at } or null
 * @param {object|null} config   — usage_warning_config pref
 * @param {number}      nowMs    — current ms epoch (injected for testability)
 * @returns {object}
 *   warn:        bool — true → caller should prepend the warning
 *   stale:       bool — snapshot too old to trust
 *   no_snapshot: bool — nothing in the DB yet
 *   disabled:    bool — user opted out
 *   five_hour_remaining_pct, seven_day_remaining_pct (number|null)
 */
function shouldWarnNow(snapshot, config, nowMs = Date.now()) {
    const cfg = config || {};
    const enabled = cfg.enabled !== false;
    const t5 = Number.isFinite(cfg.threshold_5h_pct) ? cfg.threshold_5h_pct : 15;
    const t7 = Number.isFinite(cfg.threshold_7d_pct) ? cfg.threshold_7d_pct : 5;

    if (!enabled) {
        return { warn: false, disabled: true, stale: false, no_snapshot: false,
                 five_hour_remaining_pct: null, seven_day_remaining_pct: null };
    }
    if (!snapshot) {
        return { warn: false, disabled: false, stale: false, no_snapshot: true,
                 five_hour_remaining_pct: null, seven_day_remaining_pct: null };
    }

    const capturedAtMs = snapshot.captured_at ? Date.parse(snapshot.captured_at) : NaN;
    if (!Number.isFinite(capturedAtMs) || (nowMs - capturedAtMs) > STALE_THRESHOLD_MS) {
        return { warn: false, disabled: false, stale: true, no_snapshot: false,
                 five_hour_remaining_pct: null, seven_day_remaining_pct: null };
    }

    const live = (snapshot.claude_json && snapshot.claude_json.live) || {};
    const used5 = pickClaudeLivePct(live, 'five_hour');
    const used7 = pickClaudeLivePct(live, 'seven_day');

    const rem5 = (typeof used5 === 'number') ? Math.max(0, 100 - used5) : null;
    const rem7 = (typeof used7 === 'number') ? Math.max(0, 100 - used7) : null;

    if (rem5 == null && rem7 == null) {
        return { warn: false, disabled: false, stale: false, no_snapshot: true,
                 five_hour_remaining_pct: null, seven_day_remaining_pct: null };
    }

    const breach5 = rem5 != null && rem5 <= t5;
    const breach7 = rem7 != null && rem7 <= t7;

    return {
        warn: breach5 || breach7,
        disabled: false,
        stale: false,
        no_snapshot: false,
        five_hour_remaining_pct: rem5,
        seven_day_remaining_pct: rem7,
    };
}

function formatWarningText(lang, fiveRem, sevenRem) {
    const tpl = WARNING_TEMPLATES[lang] || WARNING_TEMPLATES[String(lang || '').split('-')[0]] || WARNING_TEMPLATES.en;
    const five = (typeof fiveRem === 'number') ? Math.round(fiveRem) : '—';
    const seven = (typeof sevenRem === 'number') ? Math.round(sevenRem) : '—';
    return tpl.replace('{five}', five).replace('{seven}', seven);
}

/**
 * Pure cooldown check. Returns true when a prior warning at `lastMs` is still
 * inside the `cooldownMs` window relative to `nowMs` (so a new one should be
 * suppressed). lastMs == null/undefined → never warned → not within cooldown.
 */
function withinCooldown(lastMs, nowMs, cooldownMs = DEFAULT_COOLDOWN_MS) {
    if (lastMs == null || !Number.isFinite(lastMs)) return false;
    return (nowMs - lastMs) < cooldownMs;
}

/**
 * Resolve the per-device cooldown window from config (cooldown_min minutes),
 * falling back to the 30-min default. 0/negative disables the cooldown.
 */
function resolveCooldownMs(config) {
    const m = config && config.cooldown_min;
    if (Number.isFinite(m)) return Math.max(0, m * 60 * 1000);
    return DEFAULT_COOLDOWN_MS;
}

/**
 * Convenience wrapper: query the latest snapshot, decide, format.
 * Returns the warning prefix string, or null if no warning should be attached.
 * Applies a per-device cooldown so the prefix piggybacks at most once per window
 * instead of riding every message (card_a69e8ffa). Never throws — quota warnings
 * must not break the message-send path.
 */
async function getWarningPrefix(pool, deviceId, config, lang, nowMs = Date.now()) {
    if (!pool || !deviceId) return null;
    if (!config || config.enabled === false) return null;
    try {
        const r = await pool.query(
            `SELECT captured_at, claude_json, codex_json
             FROM usage_snapshots
             WHERE device_id = $1
             ORDER BY captured_at DESC
             LIMIT 1`,
            [deviceId]
        );
        const row = r.rows[0] || null;
        const snapshot = row ? {
            captured_at: row.captured_at instanceof Date ? row.captured_at.toISOString() : row.captured_at,
            claude_json: row.claude_json,
            codex_json:  row.codex_json,
        } : null;
        const decision = shouldWarnNow(snapshot, config, nowMs);
        if (!decision.warn) return null;
        // Cooldown: suppress if we already attached a warning for this device
        // inside the window — keeps it a one-off piggyback, not a per-message echo.
        if (withinCooldown(_lastWarnedAt.get(deviceId), nowMs, resolveCooldownMs(config))) {
            return null;
        }
        _lastWarnedAt.set(deviceId, nowMs);
        return formatWarningText(lang, decision.five_hour_remaining_pct, decision.seven_day_remaining_pct);
    } catch (err) {
        // Quota warnings are advisory — swallow errors so we never block delivery.
        if (process.env.NODE_ENV !== 'test') {
            console.error('[usage-warning] getWarningPrefix error:', err.message);
        }
        return null;
    }
}

module.exports = {
    STALE_THRESHOLD_MS,
    DEFAULT_COOLDOWN_MS,
    WARNING_TEMPLATES,
    pickClaudeLivePct,
    shouldWarnNow,
    formatWarningText,
    withinCooldown,
    resolveCooldownMs,
    getWarningPrefix,
    // Test/ops hook: clear the in-memory per-device cooldown state.
    _resetCooldownState: () => _lastWarnedAt.clear(),
};
