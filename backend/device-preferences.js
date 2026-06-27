// ============================================
// Device Preferences Module
// Per-device settings stored in PostgreSQL
// ============================================

const KanbanStatus = require('./public/shared/kanban-status.js');

const DEFAULTS = {
    broadcast_recipient_info: true,
    remote_control_enabled: false,
    // Codex channel: entity-specific auto-approve toggle for "requests input"
    codex_auto_approve_targets: {},
    // Kanban nudge (stale-card reminder) — applies uniformly to all entities
    kanban_nudge_batch_size: 1,
    kanban_nudge_priority_mode: 'priority_first',  // 'priority_first' | 'column_first' | 'column_level'
    kanban_nudge_interval_minutes: 180,
    // Which columns get nudged. Default = active work columns; see kanban-status.js SoT.
    kanban_nudge_statuses: [...KanbanStatus.NUDGE_DEFAULT_STATUSES],
    // 內容督促 hard cap per (device, entity): 1 nudge / interval regardless of card count.
    kanban_nudge_per_entity_throttle: true,
    // Stop-mode pauses stale-card nudges for an entity without changing card ownership.
    // Exposed through per-entity overrides; device default remains false.
    kanban_nudge_stop_mode: false,
    // Auto-escalation master switch (card_a0c2bc798affdf0a6310f5bb / Hank-direct).
    // Governs the clock-triggered L2/L3 ladder: priority-bump (L2),
    // P0-stalled supervisor ping + auto-block (L3). When false, ONLY L1 standard
    // nudges fire — no priority changes, no supervisor pings, no auto-block.
    // Device-wide settable via PUT /api/device-preferences.
    kanban_auto_escalate_enabled: true,
    // When true (default), automation cards NEVER auto-escalate even if the master
    // switch above is on. "Automation card" = cron母卡 (is_automation=true) OR a
    // cron-spawned child card (is_auto_generated=true, the "[Auto] … (date)" rows).
    // This is the cron-noise fix: those child cards never have their own owner
    // working them, so the L2/L3 ladder fired "🚨 P0 stalled 主管請介入" every
    // interval. They still get L1 nudges so the work isn't forgotten.
    kanban_auto_escalate_skip_automation: true,
    // Phase 2 (card_e066cb6b / kanban-nudge-spec.md §6): per-entity overrides on top
    // of the device-wide defaults above. Shape: { "<entityId>": { ...partialPrefs } }.
    // Only the keys in NUDGE_ENTITY_OVERRIDE_KEYS may be overridden — batch_size and
    // priority_mode stay device-wide because they govern global candidate selection.
    kanban_nudge_per_entity_overrides: {},
    // 排程觸發母卡 self-recurring (no子卡, only re-trigger self): notify on each fire?
    // Default true — these fire less often (one per cron tick) and the user usually wants to know.
    kanban_cron_recurring_notify: true,
    // Usage warning (card_9cd84ee7d830b2f76c595f6c): when Claude 5h/7d remaining
    // drops below the thresholds, each outbound Agent message is prepended with
    // a system warning so the dialog partner knows quota is tight.
    // Shape: { enabled: bool, threshold_5h_pct: 0-100, threshold_7d_pct: 0-100 }
    // Trigger logic: warn if (5h_remaining ≤ threshold_5h_pct) OR (7d_remaining ≤ threshold_7d_pct).
    usage_warning_config: { enabled: true, threshold_5h_pct: 15, threshold_7d_pct: 5 },
    // "需要你" HITL inbox (card_8151054f). Backend stub defaults only — the full
    // settings UI is a separate PR (#6). The backend ALWAYS emits the
    // 'action_request:changed' socket event; the frontend gates live-refresh
    // display on this flag. timeout policy = what to do with an un-answered
    // request after a deadline (consumed by a future settings/timeout PR).
    action_request_realtime: true,
    // What to do with a "需要你" request the user never answers, once it is older
    // than action_request_timeout_minutes. Consumed by the timeout worker in
    // backend/agent-action-requests.js (card_ce0d685b):
    //   'keep'         → never auto-act (device is a no-op for the worker)
    //   'auto_dismiss' → mark dismissed + tell the emitter it was skipped
    //   'safe_default' → resolve with a safe-default answer; agent continues
    //   'consensus'    → trigger ONE bot-to-bot consensus round; the emitting
    //                    agent synthesizes the entities' replies and resolves via
    //                    the existing resolve API → auto-executes the decision
    //                    (Hank's decision: no user confirmation gate).
    action_request_timeout_policy: 'keep', // 'keep' | 'auto_dismiss' | 'safe_default' | 'consensus'
    // Deadline (minutes) after which the policy above fires. Default 1440 (24h).
    // Clamped to [5, 43200] (5 min .. 30 days).
    action_request_timeout_minutes: 1440,
    // 計畫E ratify-loop (card_e9d01b6e). DARK-LAUNCH master switch: when true, the
    // worker's independent ratify pass may passively default-agree (silence ⇒ the
    // agent's server-armed decided option ships) on requests whose
    // decision_context.ratify.mode was recomputed to 'default_agree'. DEFAULT FALSE
    // — flipping it on in prod is the OWNER's decision; everything else (build /
    // merge) ships dark. Consumed by runRatifyPass in agent-action-requests.js.
    action_request_ratify_enabled: false,
    // Silence grace (minutes) before an armed default_agree ratify auto-resolves,
    // anchored to when it was armed (decision_context.ratify.armedAt), not emit
    // time. Default 1440 (24h); clamped [5, 43200] like the timeout deadline.
    action_request_ratify_grace_minutes: 1440,
    // Server-authoritative entity ACTIVITY state machine (lib/entity-activity.js).
    // Deterministic decay thresholds (replaces the old random sleep coin-flip).
    // entity_idle_after_seconds: seconds since the last SEND (no pending work)
    //   before ACTIVE → IDLE. Default 60; clamped [15, 3600].
    entity_idle_after_seconds: 60,
    // entity_sleep_after_minutes: minutes of inactivity (no pending work, no
    //   message in the window) before IDLE → SLEEPING. Default 20; clamped [1, 1440].
    entity_sleep_after_minutes: 20,
};

const ENTITY_IDLE_AFTER_SECONDS_MIN = 15;
const ENTITY_IDLE_AFTER_SECONDS_MAX = 3600;
const ENTITY_SLEEP_AFTER_MINUTES_MIN = 1;
const ENTITY_SLEEP_AFTER_MINUTES_MAX = 1440;

const ACTION_REQUEST_TIMEOUT_POLICIES = new Set(['keep', 'auto_dismiss', 'safe_default', 'consensus']);
const ACTION_REQUEST_TIMEOUT_MINUTES_MIN = 5;
const ACTION_REQUEST_TIMEOUT_MINUTES_MAX = 43200; // 30 days

// Spec: docs/specs/kanban-nudge-spec.md §6 — restricted override key set.
const NUDGE_ENTITY_OVERRIDE_KEYS = [
    'kanban_nudge_interval_minutes',
    'kanban_nudge_statuses',
    'kanban_nudge_per_entity_throttle',
    'kanban_nudge_stop_mode',
];

// Decommissioned 2026-05-03 (card_dfe3b8df Phase 2): kanban_cron_spawn_notify.
// Replaced by always-on smart-queue notify (per-bot pending_notify table —
// see backend/kanban.js helpers + kanban_schema.sql `kanban_pending_notify`).
// Spec: docs/mission-v2-kanban-spec.md §十一 "通知 gates（smart per-bot queue）".

const NUDGE_PRIORITY_MODES = new Set(['priority_first', 'column_first', 'column_level']);
const NUDGE_STATUS_OPTIONS = new Set(KanbanStatus.NUDGEABLE_STATUSES);

function coerceValue(key, raw) {
    const def = DEFAULTS[key];
    // Auto-escalation toggles accept a real boolean OR the string 'true'/'false'
    // (a bare `!!raw` would coerce the string 'false' to true — wrong for an API
    // that may serialize the flag as a query/JSON string).
    if (key === 'kanban_auto_escalate_enabled' || key === 'kanban_auto_escalate_skip_automation'
        || key === 'action_request_ratify_enabled') {
        // 計畫E: ratify master switch — same string-safe boolean coercion (a bare
        // `!!raw` would turn the string 'false' true, fail-OPEN for an auto-merge gate).
        return raw === true || raw === 'true';
    }
    if (typeof def === 'boolean') return !!raw;
    if (key === 'action_request_timeout_minutes' || key === 'action_request_ratify_grace_minutes') {
        // parseInt-style coercion + clamp to [5, 43200]; invalid → default 1440.
        const n = parseInt(raw, 10);
        if (!Number.isFinite(n)) return def;
        return Math.max(ACTION_REQUEST_TIMEOUT_MINUTES_MIN, Math.min(ACTION_REQUEST_TIMEOUT_MINUTES_MAX, n));
    }
    if (typeof def === 'number') {
        const n = Number(raw);
        if (!Number.isFinite(n)) return def;
        if (key === 'kanban_nudge_batch_size') return Math.max(1, Math.min(20, Math.round(n)));
        if (key === 'kanban_nudge_interval_minutes') return Math.max(5, Math.min(24 * 60, Math.round(n)));
        if (key === 'entity_idle_after_seconds') {
            return Math.max(ENTITY_IDLE_AFTER_SECONDS_MIN, Math.min(ENTITY_IDLE_AFTER_SECONDS_MAX, Math.round(n)));
        }
        if (key === 'entity_sleep_after_minutes') {
            return Math.max(ENTITY_SLEEP_AFTER_MINUTES_MIN, Math.min(ENTITY_SLEEP_AFTER_MINUTES_MAX, Math.round(n)));
        }
        return n;
    }
    if (key === 'kanban_nudge_priority_mode') {
        return NUDGE_PRIORITY_MODES.has(raw) ? raw : def;
    }
    if (key === 'action_request_timeout_policy') {
        return ACTION_REQUEST_TIMEOUT_POLICIES.has(raw) ? raw : def;
    }
    if (key === 'kanban_nudge_statuses') {
        if (!Array.isArray(raw)) return [...def];
        const filtered = raw.filter(s => NUDGE_STATUS_OPTIONS.has(s));
        // Must nudge at least one column, else fall back to default.
        return filtered.length ? filtered : [...def];
    }
    if (key === 'codex_auto_approve_targets') {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        const out = {};
        for (const [entityId, enabled] of Object.entries(raw)) {
            const n = Number(entityId);
            if (Number.isFinite(n) && n >= 0) {
                out[String(n)] = !!enabled;
            }
        }
        return out;
    }
    if (key === 'usage_warning_config') {
        const d = DEFAULTS.usage_warning_config;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...d };
        const enabled = 'enabled' in raw ? !!raw.enabled : d.enabled;
        const clampPct = (v, fallback) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return fallback;
            return Math.max(0, Math.min(100, Math.round(n)));
        };
        return {
            enabled,
            threshold_5h_pct: 'threshold_5h_pct' in raw ? clampPct(raw.threshold_5h_pct, d.threshold_5h_pct) : d.threshold_5h_pct,
            threshold_7d_pct: 'threshold_7d_pct' in raw ? clampPct(raw.threshold_7d_pct, d.threshold_7d_pct) : d.threshold_7d_pct,
        };
    }
    if (key === 'kanban_nudge_per_entity_overrides') {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
        const out = {};
        for (const [entityId, override] of Object.entries(raw)) {
            const n = Number(entityId);
            if (!Number.isFinite(n) || n < 0) continue;
            if (!override || typeof override !== 'object' || Array.isArray(override)) continue;
            const partial = {};
            for (const k of NUDGE_ENTITY_OVERRIDE_KEYS) {
                if (k in override) partial[k] = coerceValue(k, override[k]);
            }
            // Empty override → drop the entity entry entirely.
            if (Object.keys(partial).length > 0) out[String(n)] = partial;
        }
        return out;
    }
    return def;
}

/**
 * Resolve effective nudge prefs for a single entity = device base + per-entity
 * overrides (restricted to NUDGE_ENTITY_OVERRIDE_KEYS).
 *
 * Pure function — exported for unit testing without a pool.
 */
function mergeEntityOverride(basePrefs, entityId) {
    const overrides = basePrefs.kanban_nudge_per_entity_overrides || {};
    const key = String(entityId);
    const partial = overrides[key];
    if (!partial || typeof partial !== 'object') return { ...basePrefs };
    const merged = { ...basePrefs };
    for (const k of NUDGE_ENTITY_OVERRIDE_KEYS) {
        if (k in partial) merged[k] = partial[k];
    }
    return merged;
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

async function getEffectivePrefsForEntity(deviceId, entityId) {
    const base = await getPrefs(deviceId);
    if (entityId == null) return base;
    const n = Number(entityId);
    if (!Number.isFinite(n) || n < 0) return base;
    return mergeEntityOverride(base, n);
}

module.exports = {
    DEFAULTS,
    NUDGE_ENTITY_OVERRIDE_KEYS,
    initTable,
    getPrefs,
    updatePrefs,
    setOnboarding,
    mergeEntityOverride,
    getEffectivePrefsForEntity,
};
