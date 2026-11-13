/**
 * Passive Health-Check + Auto Self-Repair Subsystem
 *
 * Mounted at: /api/passive-health (+ GET /api/channel/passive-health/:entityId)
 *
 * DEFAULT OFF — opt-in per device. Deploying this is INERT until a device sets
 * passiveHealth.enabled = true in its device_preferences.prefs JSONB block.
 *
 * "Passive" = derive an entity's health from signals the backend has ALREADY
 * collected (entity_error_counters, outbound_msg_pending, the entity daemon
 * heartbeat, and an optional cheap GET to the channel callback host's /health) —
 * WITHOUT sending a chat message or consuming a model turn.
 *
 * Eligibility gate: only entities with isBound === true AND
 * bindingType === 'channel' are eligible. Ineligible entities short-circuit to
 * { eligible:false, reason:'not channel-bound' }.
 *
 * On unhealthy + autoRepair: invoke the existing self-repair flow (the same
 * logic behind POST /api/channel/self-repair) via an internal HTTP self-call
 * using the device's own deviceSecret. Up to 3 attempts spaced past the 60s
 * cooldown. If still unhealthy → file a bug via the device-feedback module.
 * Every step is logged to the entity status log (entity_operation_log).
 *
 * One outage is one incident, not one per sweep (2026-11-13). An entity that
 * stays unhealthy used to get 3 repair attempts, a feedback row and a GitHub
 * issue on EVERY sweep, forever, so entities that never recovered kept opening
 * duplicate issues. Now, counted from the entity's last healthy check:
 *   - repairs back off: the first failed cycle is retried after a day, twice,
 *     then once a week (REPAIR_RETRY_MS / REPAIR_RETRY_SLOW_MS);
 *   - the same failure is reported once, then at most once a week while it lasts
 *     (REPORT_REPEAT_MS). A recovery in between starts a new incident.
 * And the callback probe no longer calls a host down because it has no /health
 * route: see probeCallback().
 *
 * Endpoints (auth = deviceId + deviceSecret, mirrors /api/logs):
 *   GET /api/channel/passive-health/:entityId  — compute one entity (no repair)
 *   GET /api/passive-health/settings           — read per-device settings block
 *   PUT /api/passive-health/settings           — update per-device settings block
 *   POST /api/passive-health/run               — run the full device sweep
 *
 * Scheduler: started on server boot (mirrors the OODA-R heartbeat). A safe
 * hourly tick that no-ops until persistenceReady, then for each device with
 * passiveHealth.enabled && (now - lastRunAt) >= intervalHours, runs the sweep.
 */

const express = require('express');
const safeEqual = require('./safe-equal');

// ── Module wiring (injected via init) ────────────────────────────────────────
let pool = null;            // pg Pool (device_preferences read/write + signals)
let devicesRef = null;      // in-memory devices map (auth + entity inspection)
let entityStatus = null;    // entity-status module (logOperation)
let feedbackModule = null;  // device-feedback module (saveFeedback + createGithubIssue)
let deriveProvider = null;  // index.js deriveChannelProvider(callbackUrl)
let getChannelAccount = null; // db.getChannelAccountById(id)
let isReady = () => false;  // () => persistenceReady
let selfBaseUrl = 'http://localhost:3000'; // base URL for internal self-repair call
// Optional broadcaster (injected): emitEntityUpdate(deviceId, entityId) pushes a
// live Socket.IO entity-update to portal clients so the 健檢中 (health-checking)
// animation flips on/off in real time. No-op if not wired.
let emitEntityUpdate = null;
// Optional (injected): getPushSnapshot({ deviceId, entityId, channelAccountId }) →
// channel-backpressure's view of recent pushes to this callback, or null.
let getPushSnapshot = null;
let repairSpacingMs = null; // tests shorten the wait between repair attempts

// ── Settings defaults (stored under prefs.passiveHealth) ──────────────────────
const SETTINGS_DEFAULTS = {
    enabled: false,        // DEFAULT OFF — deploy is inert until opt-in
    intervalHours: 6,
    autoRepair: true,
    lastRunAt: null,       // epoch ms of last completed sweep (scheduler bookkeeping)
};

const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 168; // one week
const MAX_REPAIR_ATTEMPTS = 3;
const REPAIR_COOLDOWN_MS = 60_000; // self-repair endpoint enforces a 60s cooldown
const REPAIR_SPACING_MS = REPAIR_COOLDOWN_MS + 5_000; // space attempts past the cooldown
// Minimum time the in-memory `healthChecking` flag stays on so the 健檢中 avatar/
// wallpaper animation is perceptible even on a fast healthy check (which can finish
// in <1s). The clear is scheduled non-blocking (does not slow the sweep).
const HEALTH_CHECKING_MIN_VISIBLE_MS = 4500;
// An entity is "unhealthy" if any error axis has accrued at least this many
// recent (still-open) failures, or its daemon heartbeat is stale, or the
// callback host /health probe fails.
const OPEN_FAIL_THRESHOLD = 3;
const STUCK_PENDING_THRESHOLD = 3;
const HEARTBEAT_STALE_MS = 300_000; // 5 min — matches index.js ENTITY_HEARTBEAT_STALE_MS default
const HEALTH_PROBE_TIMEOUT_MS = 4_000;
// Gateway answers that mean "nothing is listening behind this address" (a tunnel or
// proxy speaking for a dead origin). Any other answer — 404, 405, 501, even 500 —
// came from the host itself: it is up, it just has no health route there.
const PROBE_DOWN_STATUSES = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 530]);
// A push the callback accepted this recently (with no failure since) outweighs a
// failed probe: the entity demonstrably receives messages.
const PUSH_EVIDENCE_MS = 6 * 60 * 60 * 1000;
// While one incident lasts (no healthy check in between):
const REPAIR_RETRY_MS = 24 * 60 * 60 * 1000;          // after the 1st and 2nd failed repair cycle
const REPAIR_RETRY_SLOW_MS = 7 * 24 * 60 * 60 * 1000; // from the 3rd failed cycle on
const REPAIR_FAST_CYCLES = 3;
const REPORT_REPEAT_MS = 7 * 24 * 60 * 60 * 1000;     // the same failure is re-reported at most weekly
const USAGE_WARNING_ENGINES = new Set(['claude', 'codex']);

function init(opts) {
    pool = opts.pool || null;
    devicesRef = opts.devices || null;
    entityStatus = opts.entityStatus || null;
    feedbackModule = opts.feedbackModule || null;
    deriveProvider = opts.deriveChannelProvider || null;
    getChannelAccount = opts.getChannelAccountById || null;
    if (typeof opts.isReady === 'function') isReady = opts.isReady;
    if (opts.selfBaseUrl) selfBaseUrl = opts.selfBaseUrl;
    if (typeof opts.emitEntityUpdate === 'function') emitEntityUpdate = opts.emitEntityUpdate;
    getPushSnapshot = typeof opts.getPushSnapshot === 'function' ? opts.getPushSnapshot : null;
    repairSpacingMs = Number.isFinite(opts.repairSpacingMs) ? opts.repairSpacingMs : null;
}

// Best-effort live push of the in-memory healthChecking flag. Never throws —
// a broadcast failure must not abort a health sweep.
function notifyEntityUpdate(deviceId, entityId) {
    if (!emitEntityUpdate) return;
    try {
        emitEntityUpdate(deviceId, entityId);
    } catch (err) {
        console.error('[PassiveHealth] emitEntityUpdate error:', err.message);
    }
}

// ── Settings read/write (prefs.passiveHealth JSONB merge) ─────────────────────
// device_preferences.updatePrefs() only persists keys in its own DEFAULTS map,
// so passiveHealth is read/written directly here with a JSONB deep-merge that
// preserves every other pref block.
async function getSettings(deviceId) {
    if (!pool || !deviceId) return { ...SETTINGS_DEFAULTS };
    try {
        const r = await pool.query(
            'SELECT prefs FROM device_preferences WHERE device_id = $1',
            [deviceId]
        );
        let stored = r.rows[0] ? r.rows[0].prefs : null;
        if (typeof stored === 'string') {
            try { stored = JSON.parse(stored); } catch { stored = null; }
        }
        const ph = (stored && stored.passiveHealth && typeof stored.passiveHealth === 'object')
            ? stored.passiveHealth : {};
        return { ...SETTINGS_DEFAULTS, ...ph };
    } catch (err) {
        console.error('[PassiveHealth] getSettings error:', err.message);
        return { ...SETTINGS_DEFAULTS };
    }
}

function coerceSettings(current, patch) {
    const out = { ...current };
    if (patch && typeof patch === 'object') {
        if ('enabled' in patch) out.enabled = !!patch.enabled;
        if ('autoRepair' in patch) out.autoRepair = !!patch.autoRepair;
        if ('intervalHours' in patch) {
            const n = Math.round(Number(patch.intervalHours));
            if (Number.isFinite(n)) {
                out.intervalHours = Math.max(MIN_INTERVAL_HOURS, Math.min(MAX_INTERVAL_HOURS, n));
            }
        }
        // lastRunAt is scheduler-internal; only accept a finite number.
        if ('lastRunAt' in patch) {
            const n = Number(patch.lastRunAt);
            out.lastRunAt = Number.isFinite(n) ? n : current.lastRunAt;
        }
    }
    return out;
}

async function updateSettings(deviceId, patch) {
    if (!pool || !deviceId) return { ...SETTINGS_DEFAULTS };
    const current = await getSettings(deviceId);
    const merged = coerceSettings(current, patch);
    try {
        // jsonb_set into the passiveHealth key only — leaves all other prefs intact.
        // Coalesce keeps a row that has no prefs yet from going NULL.
        await pool.query(`
            INSERT INTO device_preferences (device_id, prefs, updated_at)
            VALUES ($1, jsonb_build_object('passiveHealth', $2::jsonb), $3)
            ON CONFLICT (device_id) DO UPDATE
            SET prefs = jsonb_set(
                    COALESCE(device_preferences.prefs, '{}'::jsonb),
                    '{passiveHealth}', $2::jsonb, true),
                updated_at = $3
        `, [deviceId, JSON.stringify(merged), Date.now()]);
    } catch (err) {
        console.error('[PassiveHealth] updateSettings error:', err.message);
    }
    return merged;
}

function normalizeUsageWarningEngine(provider) {
    return USAGE_WARNING_ENGINES.has(provider) ? provider : null;
}

function parsePrefs(raw) {
    if (!raw) return {};
    if (typeof raw === 'string') {
        try { return JSON.parse(raw) || {}; } catch { return {}; }
    }
    return (typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
}

function normalizeEntityEngines(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [entityId, engine] of Object.entries(raw)) {
        const n = Number(entityId);
        if (Number.isFinite(n) && n >= 0 && USAGE_WARNING_ENGINES.has(engine)) {
            out[String(n)] = engine;
        }
    }
    return out;
}

async function repairUsageWarningEngine(deviceId, entityId, provider) {
    const engine = normalizeUsageWarningEngine(provider);
    const eid = Number(entityId);
    if (!pool || !deviceId) return { changed: false, reason: 'pool_unavailable' };
    if (!Number.isFinite(eid) || eid < 0) return { changed: false, reason: 'invalid_entity_id' };
    if (!engine) return { changed: false, reason: 'provider_not_managed', provider: provider || null };

    try {
        const r = await pool.query(
            'SELECT prefs FROM device_preferences WHERE device_id = $1',
            [deviceId]
        );
        const prefs = parsePrefs(r.rows[0] && r.rows[0].prefs);
        const currentCfg = (prefs.usage_warning_config && typeof prefs.usage_warning_config === 'object' && !Array.isArray(prefs.usage_warning_config))
            ? prefs.usage_warning_config : {};
        const entityEngines = normalizeEntityEngines(currentCfg.entity_engines);
        const key = String(eid);
        if (entityEngines[key] === engine) {
            return { changed: false, reason: 'already_current', engine, entityId: eid };
        }
        const previous = entityEngines[key] || null;
        entityEngines[key] = engine;
        const nextCfg = {
            ...currentCfg,
            enabled: currentCfg.enabled !== false,
            threshold_5h_pct: Number.isFinite(currentCfg.threshold_5h_pct) ? currentCfg.threshold_5h_pct : 15,
            threshold_7d_pct: Number.isFinite(currentCfg.threshold_7d_pct) ? currentCfg.threshold_7d_pct : 5,
            entity_engines: entityEngines,
        };

        await pool.query(`
            INSERT INTO device_preferences (device_id, prefs, updated_at)
            VALUES ($1, jsonb_build_object('usage_warning_config', $2::jsonb), $3)
            ON CONFLICT (device_id) DO UPDATE
            SET prefs = jsonb_set(
                    COALESCE(device_preferences.prefs, '{}'::jsonb),
                    '{usage_warning_config}', $2::jsonb, true),
                updated_at = $3
        `, [deviceId, JSON.stringify(nextCfg), Date.now()]);
        return { changed: true, engine, previous, entityId: eid };
    } catch (err) {
        console.error('[PassiveHealth] repairUsageWarningEngine error:', err.message);
        return { changed: false, reason: 'error', error: err.message };
    }
}

// ── Eligibility ───────────────────────────────────────────────────────────────
function getEntity(deviceId, entityId) {
    const device = devicesRef && devicesRef[deviceId];
    if (!device || !device.entities) return null;
    return device.entities[entityId] || null;
}

function checkEligible(entity) {
    if (!entity || !entity.isBound) return { eligible: false, reason: 'not channel-bound' };
    if (entity.bindingType !== 'channel') return { eligible: false, reason: 'not channel-bound' };
    return { eligible: true };
}

// ── Passive signal collection (no message sent, no model turn) ────────────────
async function collectErrorSignals(deviceId, entityId) {
    // Recent error counters (cumulative) + currently-open pending rows per axis.
    const signals = { counters: [], openByAxis: {}, stuckPending: 0 };
    if (!pool) return signals;
    try {
        const counters = await pool.query(
            `SELECT axis, count, last_event_at
               FROM entity_error_counters
              WHERE device_id = $1 AND entity_id = $2`,
            [deviceId, entityId]
        );
        signals.counters = counters.rows.map(r => ({
            axis: r.axis,
            count: Number(r.count) || 0,
            lastEventAt: r.last_event_at ? r.last_event_at.toISOString() : null,
        }));
    } catch (err) {
        console.error('[PassiveHealth] error_counters query failed:', err.message);
    }
    try {
        const open = await pool.query(
            `SELECT axis, COUNT(*)::int AS open_count
               FROM outbound_msg_pending
              WHERE device_id = $1 AND recipient_entity_id = $2
              GROUP BY axis`,
            [deviceId, entityId]
        );
        for (const row of open.rows) {
            const c = Number(row.open_count) || 0;
            signals.openByAxis[row.axis] = c;
            signals.stuckPending += c;
        }
    } catch (err) {
        console.error('[PassiveHealth] outbound_msg_pending query failed:', err.message);
    }
    return signals;
}

function collectHeartbeatSignal(entity, nowMs) {
    const raw = entity && (entity.lastSeen || entity.last_seen || entity.daemonLastSeenAt || entity.lastSeenAt);
    let lastSeenMs = null;
    if (raw !== undefined && raw !== null && raw !== '') {
        if (typeof raw === 'number' && Number.isFinite(raw)) lastSeenMs = raw;
        else { const ms = Date.parse(raw); if (Number.isFinite(ms)) lastSeenMs = ms; }
    }
    // Only flag stale when a heartbeat is actually KNOWN and old. Channel-push
    // entities (claude-code, openclaw channel, etc.) legitimately never report a
    // daemon lastSeen — treating "no heartbeat" as stale would falsely mark every
    // healthy channel entity unhealthy and trigger needless repairs. For those,
    // liveness is judged by the callback /health probe + stuck-message signals.
    const heartbeatKnown = lastSeenMs !== null;
    const stale = heartbeatKnown && (nowMs - lastSeenMs) > HEARTBEAT_STALE_MS;
    return {
        lastSeen: heartbeatKnown ? new Date(lastSeenMs).toISOString() : null,
        heartbeatKnown,
        heartbeatStale: stale,
    };
}

// One GET, three possible readings. 'ok' = 2xx. 'down' = no answer, or a gateway
// answering for a dead origin. 'answered' = the host itself replied with something
// else, which says it is alive and says nothing about its health.
async function probeHealthUrl(url) {
    try {
        const resp = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
        if (resp.ok) return 'ok';
        return PROBE_DOWN_STATUSES.has(resp.status) ? 'down' : 'answered';
    } catch {
        return 'down';
    }
}

/**
 * Is the callback's host alive? Looks for /health beside the webhook first
 * (https://host/codex12/eclaw-webhook → https://host/codex12/health), because a
 * tunnel that routes by path sends the host's root somewhere else entirely, then
 * at the host's root. Returns { healthy: true | false | null, beside, root }:
 * null = the host answers but offers no health route, so the probe has no opinion.
 * (Before 2026-11-13 only the root was asked and anything but 2xx meant unhealthy:
 * a Python bridge answering 501 to GET, and a bridge living under a path prefix,
 * were "repaired" three times every sweep while delivering messages normally.)
 */
async function probeCallback(callbackUrl) {
    const u = new URL(callbackUrl);
    const origin = `${u.protocol}//${u.host}`;
    const rootUrl = `${origin}/health`;
    const besideUrl = `${origin}${u.pathname.replace(/\/[^/]*\/?$/, '')}/health`;
    const beside = besideUrl === rootUrl ? null : await probeHealthUrl(besideUrl);
    if (beside === 'ok') return { healthy: true, beside, root: null };
    const root = await probeHealthUrl(rootUrl);
    if (beside === 'down') return { healthy: false, beside, root };       // the webhook's own address is dead
    if (root === 'ok') return { healthy: true, beside, root };
    if (beside === 'answered') return { healthy: null, beside, root };    // alive; the root belongs to something else
    return { healthy: root === 'down' ? false : null, beside, root };
}

// True when the callback accepted a push recently and none has failed since.
function recentPushOk(deviceId, entityId, channelAccountId, nowMs) {
    if (!getPushSnapshot) return false;
    try {
        const snap = getPushSnapshot({ deviceId, entityId, channelAccountId });
        return !!snap && snap.consecutiveFailures === 0 && Number.isFinite(snap.lastSuccessAt)
            && nowMs - snap.lastSuccessAt >= 0 && nowMs - snap.lastSuccessAt <= PUSH_EVIDENCE_MS;
    } catch {
        return false;
    }
}

async function resolveChannel(entity, deviceId, entityId) {
    // callbackActive distinguishes "this entity literally cannot be reached/reply"
    // (no callback_url registered on its channel account) from "callback is set but
    // unhealthy" (callbackHealthy:false). A live daemon with no callback registered
    // is the #6-Codex failure mode: the process is up so liveness looks green, yet
    // EClaw has nowhere to push a message, so the entity can never receive/reply.
    // null = unknown (no account record / lookup failed); we don't assert either way.
    const out = { provider: null, callbackHealthy: null, callbackActive: null, callbackProbe: null };
    if (!entity || !entity.channelAccountId || !getChannelAccount) return out;
    let account = null;
    try {
        account = await getChannelAccount(entity.channelAccountId);
    } catch { /* ignore — treat as unknown */ }
    if (!account) return out; // no account record → unknown, leave callbackActive null
    // Account record exists → we CAN assert callback registration state.
    out.callbackActive = !!account.callback_url;
    if (!account.callback_url) return out; // registered=false; no provider, no probe
    out.provider = deriveProvider ? deriveProvider(account.callback_url) : null;
    // Cheap GETs to the callback host's /health (see probeCallback). A failed probe
    // is overruled by a push the callback accepted recently: that is the thing the
    // probe is trying to predict.
    try {
        const probe = await probeCallback(account.callback_url);
        out.callbackProbe = { beside: probe.beside, root: probe.root };
        out.callbackHealthy = probe.healthy;
        if (probe.healthy === false && recentPushOk(deviceId, entityId, account.id, Date.now())) {
            out.callbackHealthy = null;
            out.callbackProbe.overruledByPush = true;
        }
    } catch {
        out.callbackHealthy = false; // callback_url is not a URL at all
    }
    return out;
}

/**
 * Compute passive health for one entity. Pure read — never sends a message,
 * never repairs. Returns a verdict object the caller can act on or surface.
 */
async function computePassiveHealth(deviceId, entityId) {
    const entity = getEntity(deviceId, entityId);
    const elig = checkEligible(entity);
    if (!elig.eligible) {
        return { eligible: false, reason: elig.reason, entityId };
    }

    const nowMs = Date.now();
    const errorSignals = await collectErrorSignals(deviceId, entityId);
    const heartbeat = collectHeartbeatSignal(entity, nowMs);
    const channel = await resolveChannel(entity, deviceId, entityId);

    const failing = [];
    const maxOpen = Object.values(errorSignals.openByAxis).reduce((m, v) => Math.max(m, v), 0);
    if (maxOpen >= OPEN_FAIL_THRESHOLD) {
        failing.push(`open_errors:${maxOpen}`);
    }
    if (errorSignals.stuckPending >= STUCK_PENDING_THRESHOLD) {
        failing.push(`stuck_pending:${errorSignals.stuckPending}`);
    }
    if (heartbeat.heartbeatStale) {
        failing.push('heartbeat_stale');
    }
    if (channel.callbackHealthy === false) {
        failing.push('callback_unhealthy');
    }

    // No callback registered = the entity CANNOT receive a push or reply, even
    // though its daemon process may be perfectly alive. This is a hard not-ready
    // condition (distinct from a transient unhealthy signal): a self-repair won't
    // fix it — the callback must be re-bound. Surface it as its own failing signal
    // AND a top-level callbackActive flag so the UI can render "無法回覆" / amber
    // instead of a misleading green "healthy".
    const noCallback = channel.callbackActive === false;
    if (noCallback) {
        failing.push('no_callback');
    }

    const healthy = failing.length === 0;
    // readiness is the user-facing verdict the dashboard light keys off:
    //   'no_callback'  → live process but unreachable (can't reply) → amber 無法回覆
    //   'unhealthy'    → has a callback but failing other signals    → red
    //   'healthy'      → reachable + no failing signals              → green
    let readiness;
    if (noCallback) readiness = 'no_callback';
    else if (!healthy) readiness = 'unhealthy';
    else readiness = 'healthy';

    return {
        eligible: true,
        entityId,
        healthy,
        // canReply is false whenever there is no registered callback — the single
        // boolean a caller needs to decide "is this entity actually answerable?".
        canReply: !noCallback,
        callbackActive: channel.callbackActive,
        readiness,
        failingSignals: failing,
        provider: channel.provider,
        signals: {
            openByAxis: errorSignals.openByAxis,
            stuckPending: errorSignals.stuckPending,
            counters: errorSignals.counters,
            lastSeen: heartbeat.lastSeen,
            heartbeatKnown: heartbeat.heartbeatKnown,
            heartbeatStale: heartbeat.heartbeatStale,
            callbackHealthy: channel.callbackHealthy,
            callbackActive: channel.callbackActive,
            callbackProbe: channel.callbackProbe,
        },
        checkedAt: new Date(nowMs).toISOString(),
    };
}

async function logEvent(deviceId, entityId, eventType, summary, payload) {
    if (!entityStatus || typeof entityStatus.logOperation !== 'function') return;
    try {
        await entityStatus.logOperation(deviceId, entityId, eventType, summary, payload || {});
    } catch (err) {
        console.error('[PassiveHealth] logEvent error:', err.message);
    }
}

// ── Self-repair (internal HTTP self-call to the existing endpoint) ────────────
// Reuses the exact logic behind POST /api/channel/self-repair so the passive
// subsystem never re-implements the repair flow. Uses the device's own
// deviceSecret (already in memory) — no new credential is minted or stored.
async function attemptSelfRepair(deviceId, deviceSecret, entityId) {
    try {
        const resp = await fetch(`${selfBaseUrl}/api/channel/self-repair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceId, deviceSecret, entityId }),
            signal: AbortSignal.timeout(170_000),
        });
        const data = await resp.json().catch(() => ({}));
        return { status: resp.status, ok: resp.ok && data.success === true, data };
    } catch (err) {
        return { status: 0, ok: false, data: { error: err.message } };
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── File a bug via the device-feedback module (same path as /api/feedback) ────
async function fileBugIssue(deviceId, deviceSecret, entityId, provider, failingSignals) {
    if (!feedbackModule || typeof feedbackModule.saveFeedback !== 'function') {
        return { filed: false, reason: 'feedback module unavailable' };
    }
    const message = [
        `[passive-health] Entity #${entityId} still unhealthy after ${MAX_REPAIR_ATTEMPTS} self-repair attempts.`,
        `Channel provider: ${provider || 'unknown'}.`,
        `Failing signals: ${failingSignals.join(', ') || 'none'}.`,
    ].join('\n');

    try {
        const saved = await feedbackModule.saveFeedback(pool, {
            deviceId,
            deviceSecret,
            message,
            category: 'bug',
            appVersion: 'passive-health',
            logSnapshot: { source: 'passive-health', entityId, provider, failingSignals },
            deviceState: { entityId, provider },
            markTs: null,
            source: 'unknown',
        });
        if (!saved) return { filed: false, reason: 'saveFeedback returned null' };

        let issueUrl = null;
        if (typeof feedbackModule.createGithubIssue === 'function' &&
            typeof feedbackModule.getFeedbackById === 'function') {
            try {
                const full = await feedbackModule.getFeedbackById(pool, saved.id);
                const issue = full && await feedbackModule.createGithubIssue(full);
                if (issue && issue.url) {
                    issueUrl = issue.url;
                    if (typeof feedbackModule.updateFeedback === 'function') {
                        await feedbackModule.updateFeedback(pool, saved.id, { github_issue_url: issue.url });
                    }
                }
            } catch (err) {
                console.error('[PassiveHealth] createGithubIssue error:', err.message);
            }
        }
        return { filed: true, feedbackId: saved.id, issueUrl };
    } catch (err) {
        console.error('[PassiveHealth] fileBugIssue error:', err.message);
        return { filed: false, reason: err.message };
    }
}

/**
 * Where an unhealthy entity stands in its current incident, read from its own
 * status log: an incident runs from the entity's last healthy check to now.
 * failedCycles counts the repair cycles that ended without a recovery since then
 * (every such cycle logs one self_repair event carrying `filed`; the no-callback
 * shortcut is not a repair cycle). Repairs are due at once on a new incident,
 * a day after the 1st and 2nd failed cycle, a week after every later one.
 * A read error answers "due": better one needless repair than a silent outage.
 */
async function incidentState(deviceId, entityId, nowMs) {
    const state = { healthyAt: 0, failedCycles: 0, lastCycleAt: 0, repairDue: true, nextRepairAt: nowMs };
    if (!pool) return state;
    try {
        const healthy = await pool.query(
            `SELECT occurred_at
               FROM entity_operation_log
              WHERE device_id = $1 AND entity_id = $2 AND event_type = 'passive_health'
                AND event_payload->>'healthy' = 'true'
              ORDER BY occurred_at DESC LIMIT 1`,
            [deviceId, entityId]
        );
        if (healthy.rows[0]) state.healthyAt = new Date(healthy.rows[0].occurred_at).getTime() || 0;
        const cycles = await pool.query(
            `SELECT COUNT(*)::int AS failed_cycles, MAX(occurred_at) AS last_cycle_at
               FROM entity_operation_log
              WHERE device_id = $1 AND entity_id = $2 AND event_type = 'self_repair'
                AND event_payload ? 'filed'
                AND COALESCE(event_payload->>'reason', '') <> 'no_callback'
                AND occurred_at > $3`,
            [deviceId, entityId, new Date(state.healthyAt)]
        );
        const row = cycles.rows[0] || {};
        state.failedCycles = Number(row.failed_cycles) || 0;
        state.lastCycleAt = row.last_cycle_at ? (new Date(row.last_cycle_at).getTime() || 0) : 0;
    } catch (err) {
        console.error('[PassiveHealth] incidentState query failed:', err.message);
        return state;
    }
    if (state.failedCycles > 0) {
        const wait = state.failedCycles < REPAIR_FAST_CYCLES ? REPAIR_RETRY_MS : REPAIR_RETRY_SLOW_MS;
        state.nextRepairAt = state.lastCycleAt + wait;
        state.repairDue = nowMs >= state.nextRepairAt;
    }
    return state;
}

// "open_errors:5" and "open_errors:7" are the same failure; compare signal names only.
function signalKinds(list) {
    return [...new Set((Array.isArray(list) ? list : []).map(x => String(x).split(':')[0]))].sort().join(',');
}

/**
 * File the bug unless this incident's failure is already on record: a passive-health
 * report for the same entity, with the same failing signals, made since the entity
 * was last healthy and within the last week. Then nothing new is written — no
 * feedback row, no GitHub issue — and the earlier report is returned instead.
 */
async function reportOnce(deviceId, deviceSecret, entityId, provider, failingSignals, incident, nowMs) {
    const since = Math.max((incident && incident.healthyAt) || 0, nowMs - REPORT_REPEAT_MS);
    if (pool) {
        try {
            const r = await pool.query(
                `SELECT id, created_at, github_issue_url, log_snapshot->'failingSignals' AS signals
                   FROM feedback
                  WHERE device_id = $1 AND app_version = 'passive-health'
                    AND log_snapshot->>'entityId' = $2 AND created_at > $3
                  ORDER BY created_at DESC LIMIT 1`,
                [deviceId, String(entityId), since]
            );
            const prior = r.rows[0];
            if (prior && signalKinds(prior.signals) === signalKinds(failingSignals)) {
                return { filed: false, reason: 'already_reported', feedbackId: prior.id, issueUrl: prior.github_issue_url || null,
                    nextReportAt: Number(prior.created_at) + REPORT_REPEAT_MS };
            }
        } catch (err) {
            console.error('[PassiveHealth] reportOnce lookup failed:', err.message);
        }
    }
    return fileBugIssue(deviceId, deviceSecret, entityId, provider, failingSignals);
}

/**
 * Run passive health for one entity AND act on the verdict: log the result,
 * and on unhealthy+autoRepair attempt repair up to 3 times (spaced past the
 * 60s cooldown), then file a bug if still unhealthy. While the same incident
 * lasts, repairs back off and the bug is not filed again (see incidentState,
 * reportOnce). Returns a summary.
 */
async function runEntity(deviceId, deviceSecret, entityId, settings) {
    // Mark the entity as "health-checking" for the whole check+repair span so
    // the Web Portal (and polling clients) can show the 健檢中 animation. The
    // flag is in-memory only and is guaranteed cleared by the finally guard
    // below, even if the check/repair throws.
    const entity = getEntity(deviceId, entityId);
    if (entity) {
        entity.healthChecking = true;
        entity.healthCheckingAt = Date.now();
        notifyEntityUpdate(deviceId, entityId);
    }

    try {
        const health = await computePassiveHealth(deviceId, entityId);
        if (!health.eligible) {
            return { entityId, eligible: false, reason: health.reason };
        }

        const noCallback = health.callbackActive === false;
        // Only an unhealthy entity that would be repaired has an incident to look up.
        const incident = (!health.healthy && settings.autoRepair) ? await incidentState(deviceId, entityId, Date.now()) : null;
        const held = !!incident && !noCallback && !incident.repairDue;
        const heldUntil = held ? new Date(incident.nextRepairAt).toISOString() : null;
        await logEvent(deviceId, entityId, 'passive_health',
            health.healthy ? 'Passive health: healthy'
                : noCallback ? 'Passive health: no callback registered — entity cannot reply (re-bind required)'
                : `Passive health: unhealthy (${health.failingSignals.join(', ')})`
                    + (held ? ` — repair on hold until ${heldUntil} after ${incident.failedCycles} failed repair cycle(s)` : ''),
            { healthy: health.healthy, readiness: health.readiness, canReply: health.canReply, callbackActive: health.callbackActive, failingSignals: health.failingSignals, provider: health.provider, signals: health.signals,
                ...(held ? { repairHeldUntil: heldUntil, failedCycles: incident.failedCycles } : {}) });

        const usageDisplayRepair = await repairUsageWarningEngine(deviceId, entityId, health.provider);
        if (usageDisplayRepair.changed) {
            await logEvent(deviceId, entityId, 'usage_warning_self_repair',
                `Usage display source repaired: entity #${entityId} → ${usageDisplayRepair.engine}`,
                { engine: usageDisplayRepair.engine, previous: usageDisplayRepair.previous });
        }

        if (health.healthy || !settings.autoRepair) {
            return { entityId, eligible: true, healthy: health.healthy, readiness: health.readiness, canReply: health.canReply, callbackActive: health.callbackActive, repaired: false, usageDisplayRepair, failingSignals: health.failingSignals };
        }

        // No callback registered is NOT self-repairable — the callback must be
        // re-bound at the container/channel-account level. Skip the (futile) repair
        // attempts and file a bug directly so a human gets the re-bind signal.
        if (noCallback) {
            const bug = await reportOnce(deviceId, deviceSecret, entityId, health.provider, health.failingSignals, incident, Date.now());
            const known = bug.reason === 'already_reported';
            await logEvent(deviceId, entityId, 'self_repair',
                bug.filed ? `No-callback bug filed (feedback #${bug.feedbackId}) — re-bind required, not self-repairable`
                    : known ? `No callback registered — already reported (feedback #${bug.feedbackId}), not filed again; re-bind required`
                    : `No-callback bug filing failed: ${bug.reason}`,
                { filed: bug.filed, feedbackId: bug.feedbackId, issueUrl: bug.issueUrl, reason: 'no_callback', report: bug.filed ? 'filed' : known ? 'already_reported' : 'failed', failingSignals: health.failingSignals });
            return { entityId, eligible: true, healthy: false, readiness: health.readiness, canReply: false, callbackActive: false, repaired: false, bugFiled: bug.filed, alreadyReported: known, feedbackId: bug.feedbackId, usageDisplayRepair, failingSignals: health.failingSignals };
        }

        // Same incident, repaired not long ago without success: leave it until the retry is due.
        if (held) {
            return { entityId, eligible: true, healthy: false, readiness: health.readiness, canReply: health.canReply, callbackActive: health.callbackActive, repaired: false, repairHeld: true, nextRepairAt: heldUntil, failedCycles: incident.failedCycles, usageDisplayRepair, failingSignals: health.failingSignals };
        }

        // Unhealthy + autoRepair → up to 3 repair attempts, spaced past the cooldown.
        let recovered = false;
        for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
            const repair = await attemptSelfRepair(deviceId, deviceSecret, entityId);
            await logEvent(deviceId, entityId, 'self_repair',
                `Self-repair attempt ${attempt}/${MAX_REPAIR_ATTEMPTS}: ${repair.ok ? 'triggered' : 'failed'} (http ${repair.status})`,
                { attempt, ok: repair.ok, httpStatus: repair.status, mode: repair.data && repair.data.mode });

            // Re-check health after the attempt.
            const recheck = await computePassiveHealth(deviceId, entityId);
            if (recheck.eligible && recheck.healthy) {
                recovered = true;
                await logEvent(deviceId, entityId, 'passive_health',
                    `Recovered after self-repair attempt ${attempt}`,
                    { healthy: true, afterAttempt: attempt });
                break;
            }
            if (attempt < MAX_REPAIR_ATTEMPTS) {
                await sleep(repairSpacingMs === null ? REPAIR_SPACING_MS : repairSpacingMs); // respect the 60s self-repair cooldown
            }
        }

        if (recovered) {
            return { entityId, eligible: true, healthy: false, repaired: true, usageDisplayRepair, failingSignals: health.failingSignals };
        }

        // Still unhealthy after all attempts → file a bug, once per incident and week.
        // This event (it carries `filed`) is what incidentState counts as a failed cycle.
        const bug = await reportOnce(deviceId, deviceSecret, entityId, health.provider, health.failingSignals, incident, Date.now());
        const known = bug.reason === 'already_reported';
        await logEvent(deviceId, entityId, 'self_repair',
            bug.filed ? `Bug filed after ${MAX_REPAIR_ATTEMPTS} failed repairs (feedback #${bug.feedbackId})`
                : known ? `Still unhealthy after ${MAX_REPAIR_ATTEMPTS} failed repairs — already reported (feedback #${bug.feedbackId}), not filed again`
                : `Bug filing failed: ${bug.reason}`,
            { filed: bug.filed, feedbackId: bug.feedbackId, issueUrl: bug.issueUrl, report: bug.filed ? 'filed' : known ? 'already_reported' : 'failed', failingSignals: health.failingSignals });

        return { entityId, eligible: true, healthy: false, repaired: false, bugFiled: bug.filed, alreadyReported: known, feedbackId: bug.feedbackId, usageDisplayRepair, failingSignals: health.failingSignals };
    } finally {
        // Clear the transient flag + push the cleared state, but hold it visible for a
        // minimum duration so the 健檢中 animation is perceptible even on a fast healthy
        // check. Non-blocking (scheduled, does not slow the sweep) and guarded so a newer
        // check on the same entity (different healthCheckingAt) is never cleared early.
        if (entity) {
            const startedAt = entity.healthCheckingAt;
            const clearFlag = () => {
                if (entity.healthCheckingAt === startedAt) {
                    entity.healthChecking = false;
                    notifyEntityUpdate(deviceId, entityId);
                }
            };
            const remaining = HEALTH_CHECKING_MIN_VISIBLE_MS - (Date.now() - (startedAt || Date.now()));
            if (remaining > 0) {
                const t = setTimeout(clearFlag, remaining);
                if (t.unref) t.unref();
            } else {
                clearFlag();
            }
        }
    }
}

/**
 * Run the full sweep for one device: every bound channel entity gets a passive
 * health check (and repair/bug-file on unhealthy + autoRepair). Updates lastRunAt.
 */
async function runDeviceSweep(deviceId, deviceSecret, settingsOverride) {
    const device = devicesRef && devicesRef[deviceId];
    if (!device || !device.entities) return { deviceId, ran: false, reason: 'device not found', results: [] };

    const settings = settingsOverride || await getSettings(deviceId);
    const results = [];
    for (const [eidKey, entity] of Object.entries(device.entities)) {
        const elig = checkEligible(entity);
        if (!elig.eligible) continue; // skip non-channel-bound entities silently
        const entityId = Number(eidKey);
        try {
            results.push(await runEntity(deviceId, deviceSecret, entityId, settings));
        } catch (err) {
            console.error(`[PassiveHealth] runEntity error device ${deviceId} entity ${entityId}:`, err.message);
            results.push({ entityId, eligible: true, error: err.message });
        }
    }

    // Persist last-run timestamp so the scheduler honours intervalHours.
    await updateSettings(deviceId, { lastRunAt: Date.now() });

    return { deviceId, ran: true, checked: results.length, results };
}

// ── Scheduler (started on boot; mirrors OODA-R heartbeat) ─────────────────────
let schedulerTimer = null;

async function schedulerTick() {
    // Safe before the DB/devices are ready — no-op until persistenceReady.
    if (!isReady() || !pool || !devicesRef) return;
    const nowMs = Date.now();
    for (const [deviceId, device] of Object.entries(devicesRef)) {
        if (!device || !device.deviceSecret) continue;
        let settings;
        try {
            settings = await getSettings(deviceId);
        } catch { continue; }
        if (!settings.enabled) continue;
        const intervalMs = Math.max(MIN_INTERVAL_HOURS, settings.intervalHours) * 60 * 60 * 1000;
        const last = Number(settings.lastRunAt) || 0;
        if (nowMs - last < intervalMs) continue;
        try {
            await runDeviceSweep(deviceId, device.deviceSecret, settings);
        } catch (err) {
            console.error(`[PassiveHealth] scheduler sweep error device ${deviceId}:`, err.message);
        }
    }
}

function startScheduler(tickMs) {
    const ms = Math.max(60_000, parseInt(tickMs) || 3_600_000); // default hourly
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = setInterval(() => {
        schedulerTick().catch(err => console.error('[PassiveHealth] scheduler tick error:', err.message));
    }, ms);
    if (schedulerTimer.unref) schedulerTimer.unref();
    return schedulerTimer;
}

function stopScheduler() {
    if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
}

// ── Auth (mirrors /api/logs: deviceId + deviceSecret) ─────────────────────────
function authDevice(req) {
    const deviceId = req.query.deviceId || (req.body && req.body.deviceId);
    const deviceSecret = req.query.deviceSecret || (req.body && req.body.deviceSecret);
    if (!deviceId || !deviceSecret) return { ok: false, status: 400, error: 'deviceId and deviceSecret required' };
    const device = devicesRef && devicesRef[deviceId];
    if (!device || !safeEqual(device.deviceSecret, deviceSecret)) {
        return { ok: false, status: 401, error: 'Invalid credentials' };
    }
    return { ok: true, deviceId, deviceSecret };
}

// ── Router ────────────────────────────────────────────────────────────────────
const router = express.Router();           // mounted at /api/passive-health
const channelRouter = express.Router();     // mounted at /api/channel/passive-health

// GET /api/channel/passive-health/:entityId — compute one entity (no auto-repair).
channelRouter.get('/:entityId', async (req, res) => {
    const auth = authDevice(req);
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error });
    const entityId = parseInt(req.params.entityId, 10);
    if (!Number.isFinite(entityId) || entityId < 0) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }
    try {
        const health = await computePassiveHealth(auth.deviceId, entityId);
        return res.json({ success: true, deviceId: auth.deviceId, ...health });
    } catch (err) {
        console.error('[PassiveHealth] compute endpoint error:', err.message);
        return res.status(500).json({ success: false, error: 'internal' });
    }
});

// GET /api/passive-health/settings — read the per-device settings block.
router.get('/settings', async (req, res) => {
    const auth = authDevice(req);
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error });
    try {
        const settings = await getSettings(auth.deviceId);
        return res.json({ success: true, deviceId: auth.deviceId, settings });
    } catch (err) {
        console.error('[PassiveHealth] get settings error:', err.message);
        return res.status(500).json({ success: false, error: 'internal' });
    }
});

// PUT /api/passive-health/settings — update the per-device settings block.
router.put('/settings', express.json(), async (req, res) => {
    const auth = authDevice(req);
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error });
    const body = req.body || {};
    // Validate intervalHours up front so a bad value is a 400 (not silently clamped).
    if ('intervalHours' in body) {
        const n = Number(body.intervalHours);
        if (!Number.isFinite(n) || n < MIN_INTERVAL_HOURS || n > MAX_INTERVAL_HOURS) {
            return res.status(400).json({ success: false, error: `intervalHours must be ${MIN_INTERVAL_HOURS}-${MAX_INTERVAL_HOURS}` });
        }
    }
    try {
        // Partial update: only patch keys actually present in the body. (Passing
        // undefined for an omitted key would make coerceSettings clobber it — e.g.
        // a PUT of just {autoRepair:false} must NOT silently disable `enabled`.)
        const patch = {};
        if ('enabled' in body) patch.enabled = body.enabled;
        if ('intervalHours' in body) patch.intervalHours = body.intervalHours;
        if ('autoRepair' in body) patch.autoRepair = body.autoRepair;
        const settings = await updateSettings(auth.deviceId, patch);
        return res.json({ success: true, deviceId: auth.deviceId, settings });
    } catch (err) {
        console.error('[PassiveHealth] put settings error:', err.message);
        return res.status(500).json({ success: false, error: 'internal' });
    }
});

// POST /api/passive-health/run — run the full device sweep (manual trigger).
router.post('/run', express.json(), async (req, res) => {
    const auth = authDevice(req);
    if (!auth.ok) return res.status(auth.status).json({ success: false, error: auth.error });
    try {
        const summary = await runDeviceSweep(auth.deviceId, auth.deviceSecret);
        return res.json({ success: true, ...summary });
    } catch (err) {
        console.error('[PassiveHealth] run endpoint error:', err.message);
        return res.status(500).json({ success: false, error: 'internal' });
    }
});

module.exports = {
    init,
    router,
    channelRouter,
    startScheduler,
    stopScheduler,
    schedulerTick,
    // Exported for tests + reuse
    getSettings,
    updateSettings,
    coerceSettings,
    checkEligible,
    computePassiveHealth,
    runEntity,
    runDeviceSweep,
    repairUsageWarningEngine,
    SETTINGS_DEFAULTS,
    MAX_REPAIR_ATTEMPTS,
    _internal: { collectHeartbeatSignal, authDevice, normalizeUsageWarningEngine, normalizeEntityEngines, probeCallback, incidentState, reportOnce, signalKinds },
    REPAIR_RETRY_MS,
    REPAIR_RETRY_SLOW_MS,
    REPORT_REPEAT_MS,
    PUSH_EVIDENCE_MS,
};
