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
 */

const STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000;  // 6 hours

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
 * Convenience wrapper: query the latest snapshot, decide, format.
 * Returns the warning prefix string, or null if no warning should be attached.
 * Never throws — quota warnings must not break the message-send path.
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
    WARNING_TEMPLATES,
    pickClaudeLivePct,
    shouldWarnNow,
    formatWarningText,
    getWarningPrefix,
};
