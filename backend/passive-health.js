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
// An entity is "unhealthy" if any error axis has accrued at least this many
// recent (still-open) failures, or its daemon heartbeat is stale, or the
// callback host /health probe fails.
const OPEN_FAIL_THRESHOLD = 3;
const STUCK_PENDING_THRESHOLD = 3;
const HEARTBEAT_STALE_MS = 300_000; // 5 min — matches index.js ENTITY_HEARTBEAT_STALE_MS default
const HEALTH_PROBE_TIMEOUT_MS = 4_000;

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

async function resolveChannel(entity) {
    const out = { provider: null, callbackHealthy: null };
    if (!entity || !entity.channelAccountId || !getChannelAccount) return out;
    let account = null;
    try {
        account = await getChannelAccount(entity.channelAccountId);
    } catch { /* ignore — treat as unknown */ }
    if (!account || !account.callback_url) return out;
    out.provider = deriveProvider ? deriveProvider(account.callback_url) : null;
    // Optional cheap GET to the callback host's /health. Best-effort: a failure
    // here is one signal among several, never the sole verdict.
    try {
        const u = new URL(account.callback_url);
        const healthUrl = `${u.protocol}//${u.host}/health`;
        const resp = await fetch(healthUrl, {
            method: 'GET',
            signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
        });
        out.callbackHealthy = resp.ok;
    } catch {
        out.callbackHealthy = false;
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
    const channel = await resolveChannel(entity);

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

    return {
        eligible: true,
        entityId,
        healthy: failing.length === 0,
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
 * Run passive health for one entity AND act on the verdict: log the result,
 * and on unhealthy+autoRepair attempt repair up to 3 times (spaced past the
 * 60s cooldown), then file a bug if still unhealthy. Returns a summary.
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

        await logEvent(deviceId, entityId, 'passive_health',
            health.healthy ? 'Passive health: healthy' : `Passive health: unhealthy (${health.failingSignals.join(', ')})`,
            { healthy: health.healthy, failingSignals: health.failingSignals, provider: health.provider, signals: health.signals });

        if (health.healthy || !settings.autoRepair) {
            return { entityId, eligible: true, healthy: health.healthy, repaired: false, failingSignals: health.failingSignals };
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
                await sleep(REPAIR_SPACING_MS); // respect the 60s self-repair cooldown
            }
        }

        if (recovered) {
            return { entityId, eligible: true, healthy: false, repaired: true, failingSignals: health.failingSignals };
        }

        // Still unhealthy after all attempts → file a bug.
        const bug = await fileBugIssue(deviceId, deviceSecret, entityId, health.provider, health.failingSignals);
        await logEvent(deviceId, entityId, 'self_repair',
            bug.filed ? `Bug filed after ${MAX_REPAIR_ATTEMPTS} failed repairs (feedback #${bug.feedbackId})` : `Bug filing failed: ${bug.reason}`,
            { filed: bug.filed, feedbackId: bug.feedbackId, issueUrl: bug.issueUrl, failingSignals: health.failingSignals });

        return { entityId, eligible: true, healthy: false, repaired: false, bugFiled: bug.filed, feedbackId: bug.feedbackId, failingSignals: health.failingSignals };
    } finally {
        // Always clear the transient flag + push the cleared state, even on error.
        if (entity) {
            entity.healthChecking = false;
            notifyEntityUpdate(deviceId, entityId);
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
    SETTINGS_DEFAULTS,
    MAX_REPAIR_ATTEMPTS,
    _internal: { collectHeartbeatSignal, authDevice },
};
