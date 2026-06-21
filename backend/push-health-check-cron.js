'use strict';

// Push round-trip health check cron — card_0a5d4a97.
//
// Why this exists: web-push sendNotification() returning 201 only proves the
// VAPID-signed request reached the push service; it says nothing about
// whether the user's browser actually woke its service worker and showed (or
// would have shown) anything. We've shipped "push works" weeks where prod was
// silently dead because endpoints quietly drained without the server noticing.
//
// What this does on every cron tick:
//   1. SELECT all is_active=TRUE rows from push_subscriptions.
//   2. For each row, send a *silent* push (TTL=60, urgency=very-low) carrying
//      a per-subscription nonce. The SW (backend/public/sw.js) catches
//      payload.type==='health', does NOT show a notification, and POSTs
//      /api/push/ack with the nonce.
//   3. Wait 60s, then count nonces that landed in push_ack_log this run.
//   4. Increment consecutive_failures for any subscription whose nonce never
//      came back; reset it for the ones that did. After >=3 consecutive
//      failures, flip is_active=FALSE and open a follow-up kanban card.
//   5. Persist the rollup to push_health_run and report to the bot fakechat
//      thread (per feedback_auto_cron_report_first).
//
// Design choices:
//   - The waiter is injectable so Jest can drive multiple synthetic runs in
//     milliseconds. Production injects `setTimeout`-based sleep.
//   - sendNotification + the kanban card POST are also injectable; production
//     wires the real `web-push` and the chatPool kanban_cards insert.
//   - We don't reuse hermes-health-check.js because that monitor is a
//     single-target git probe; here we have N targets per tick with
//     per-target dead-tracking, plus the round-trip ack window. Different
//     shape entirely; trying to extend hermes would have leaked push concerns
//     into a git module.

const crypto = require('crypto');
const { newCardId } = require('./entity-id');

const DEFAULT_CRON = '*/30 * * * *';
const DEFAULT_TIMEZONE = 'Asia/Taipei';
const DEFAULT_ACK_WINDOW_MS = 60_000;
const DEFAULT_DEAD_THRESHOLD = 3;          // consecutive failed runs → mark dead
const DEFAULT_PUSH_TTL_SECONDS = 60;
const FOLLOWUP_CARD_PRIORITY = 'P1';

const VALID_PRIORITIES = new Set(['P0', 'P1', 'P2', 'P3']);

function parseCsv(value) {
    return String(value || '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
}

function positiveInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function firstConfiguredDeviceId(env) {
    return (env.PUSH_HEALTH_DEVICE_ID || parseCsv(env.ADMIN_DEVICE_IDS)[0] || '').trim();
}

function loadConfig(env = process.env) {
    const enabled = env.PUSH_HEALTH_CRON_ENABLED !== '0';
    const cron = (env.PUSH_HEALTH_CRON || DEFAULT_CRON).trim();
    const timezone = (env.PUSH_HEALTH_TIMEZONE || DEFAULT_TIMEZONE).trim();
    const ackWindowMs = positiveInt(env.PUSH_HEALTH_ACK_WINDOW_MS, DEFAULT_ACK_WINDOW_MS);
    const deadThreshold = positiveInt(env.PUSH_HEALTH_DEAD_THRESHOLD, DEFAULT_DEAD_THRESHOLD);
    const pushTtl = positiveInt(env.PUSH_HEALTH_TTL_SECONDS, DEFAULT_PUSH_TTL_SECONDS);
    const cardDeviceId = firstConfiguredDeviceId(env);
    const priority = VALID_PRIORITIES.has(env.PUSH_HEALTH_FOLLOWUP_PRIORITY)
        ? env.PUSH_HEALTH_FOLLOWUP_PRIORITY
        : FOLLOWUP_CARD_PRIORITY;
    // assignedBots:[2] per spec — lobster owns the push pipeline.
    const assignedBots = (env.PUSH_HEALTH_FOLLOWUP_BOTS
        ? parseCsv(env.PUSH_HEALTH_FOLLOWUP_BOTS).map(n => Number(n)).filter(n => Number.isInteger(n) && n >= 0)
        : [2]);

    let skipReason = null;
    if (!enabled) skipReason = 'disabled';
    else if (!cron) skipReason = 'PUSH_HEALTH_CRON empty';

    let cardSkipReason = null;
    if (!cardDeviceId) cardSkipReason = 'PUSH_HEALTH_DEVICE_ID or ADMIN_DEVICE_IDS required';
    else if (assignedBots.length === 0) cardSkipReason = 'PUSH_HEALTH_FOLLOWUP_BOTS empty';

    return {
        enabled,
        configured: enabled && !skipReason,
        skipReason,
        cron,
        timezone,
        ackWindowMs,
        deadThreshold,
        pushTtl,
        cardDeviceId,
        assignedBots,
        priority,
        cardConfigured: !cardSkipReason,
        cardSkipReason,
    };
}

function genRunId() {
    return 'run_' + crypto.randomBytes(8).toString('hex');
}

function genNonce() {
    return crypto.randomBytes(16).toString('hex');
}

// ---- DB primitives -----------------------------------------------------
// All DB access is funneled through these helpers so the cron core stays
// pool-agnostic (and easy to mock in Jest).

async function listActiveSubscriptions(pool) {
    const res = await pool.query(
        `SELECT id, device_id, endpoint, p256dh, auth, consecutive_failures
           FROM push_subscriptions
          WHERE is_active = TRUE
          ORDER BY id`
    );
    return res.rows || [];
}

async function insertRunStart(pool, { runId, reason, sentCount, startedAtIso }) {
    await pool.query(
        `INSERT INTO push_health_run
            (run_id, started_at, sent_count, reason)
         VALUES ($1, $2, $3, $4)`,
        [runId, startedAtIso, sentCount, reason]
    );
}

async function finalizeRun(pool, { runId, deliveredCount, ackedCount, deadCount, errorCount, finishedAtIso }) {
    await pool.query(
        `UPDATE push_health_run
            SET finished_at = $1,
                delivered_count = $2,
                acked_count_60s = $3,
                dead_count = $4,
                error_count = $5
          WHERE run_id = $6`,
        [finishedAtIso, deliveredCount, ackedCount, deadCount, errorCount, runId]
    );
}

async function recordSentTimestamp(pool, subscriptionId, sentAtIso) {
    await pool.query(
        `UPDATE push_subscriptions
            SET last_health_sent_at = $1
          WHERE id = $2`,
        [sentAtIso, subscriptionId]
    );
}

async function countAckedNonces(pool, runId, nonces) {
    if (!nonces.length) return 0;
    const res = await pool.query(
        `SELECT COUNT(DISTINCT nonce)::int AS acked
           FROM push_ack_log
          WHERE run_id = $1 AND nonce = ANY($2::text[])`,
        [runId, nonces]
    );
    return Number((res.rows[0] || {}).acked || 0);
}

async function ackedNonceSet(pool, runId, nonces) {
    if (!nonces.length) return new Set();
    const res = await pool.query(
        `SELECT DISTINCT nonce
           FROM push_ack_log
          WHERE run_id = $1 AND nonce = ANY($2::text[])`,
        [runId, nonces]
    );
    return new Set((res.rows || []).map(r => r.nonce));
}

async function resetSubscriptionStreak(pool, subscriptionId, ackedAtIso) {
    await pool.query(
        `UPDATE push_subscriptions
            SET consecutive_failures = 0,
                last_health_acked_at = $1
          WHERE id = $2`,
        [ackedAtIso, subscriptionId]
    );
}

async function incrementSubscriptionFailure(pool, subscriptionId) {
    const res = await pool.query(
        `UPDATE push_subscriptions
            SET consecutive_failures = consecutive_failures + 1
          WHERE id = $1
        RETURNING consecutive_failures`,
        [subscriptionId]
    );
    return Number((res.rows[0] || {}).consecutive_failures || 0);
}

async function deactivateSubscription(pool, subscriptionId, reason, atIso) {
    await pool.query(
        `UPDATE push_subscriptions
            SET is_active = FALSE,
                deactivated_at = $1,
                deactivated_reason = $2
          WHERE id = $3`,
        [atIso, reason, subscriptionId]
    );
}

async function removeSubscriptionByEndpoint(pool, endpoint) {
    await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [endpoint]);
}

// ---- Follow-up kanban card --------------------------------------------

function describeDeadSubscription(sub) {
    const endpointHint = String(sub.endpoint || '').slice(0, 80);
    return [
        `Push subscription has failed ${sub.consecutiveFailures || 0} consecutive`,
        `round-trip health checks (≥${sub.threshold} required).`,
        '',
        `- subscription_id: ${sub.id}`,
        `- device_id: ${sub.deviceId}`,
        `- endpoint (first 80 chars): ${endpointHint}`,
        `- deactivated_at: ${sub.deactivatedAtIso}`,
        '',
        'Triage:',
        '1. Check if the user still has the browser/PWA tab open and granted permission.',
        '2. If the endpoint host (Mozilla / Apple / Google) consistently 410s, the',
        '   browser revoked the subscription server-side — user must re-subscribe.',
        '3. If many subscriptions died at once, suspect a VAPID key rotation or',
        '   service-worker registration regression and roll back.',
    ].join('\n');
}

async function openDeadSubscriptionCard(pool, config, sub) {
    if (!config.cardConfigured) {
        return { skipped: true, reason: config.cardSkipReason };
    }
    const cardId = newCardId();
    const title = `[Bug/P1] Push subscription dead — sub_id=${sub.id}`;
    const description = describeDeadSubscription(sub);
    await pool.query(
        `INSERT INTO kanban_cards (
            id, device_id, title, description, priority, status, assigned_bots, created_by,
            reviewer_entity_id, status_changed_at, requires_screenshot_review, dispatch_mode
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, NOW(), false, 'immediate')`,
        [
            cardId,
            config.cardDeviceId,
            title,
            description,
            config.priority,
            'todo',
            JSON.stringify(config.assignedBots),
            0,
            null,
        ]
    );
    return { created: true, cardId };
}

// ---- Run loop ---------------------------------------------------------

function initialState() {
    return {
        running: false,
        totalRuns: 0,
        lastRunAt: null,
        lastOkAt: null,
        lastFailureAt: null,
        lastSkippedAt: null,
        lastRunId: null,
        lastSentCount: 0,
        lastDeliveredCount: 0,
        lastAckedCount: 0,
        lastDeadCount: 0,
        lastErrorCount: 0,
        lastAckRate: null,           // 0..1; null when no sends
        lastError: null,
        skipReason: null,
    };
}

function createPushHealthCheckCron({
    env = process.env,
    pool = null,
    getPool = null,
    sendNotification = null,                              // (subscription, payload, opts) => Promise
    wait = (ms) => new Promise(r => setTimeout(r, ms)),    // injectable for tests
    reportFakechat = null,                                // optional async (line) => void
    audit = () => {},
    now = () => Date.now(),
    genId = genRunId,
    nonceFn = genNonce,
} = {}) {
    const state = initialState();

    function resolvePool() {
        if (pool) return pool;
        if (typeof getPool === 'function') return getPool();
        throw new Error('push_health_check_cron: pool or getPool required');
    }

    function getStatus() {
        const config = loadConfig(env);
        return {
            enabled: config.enabled,
            configured: config.configured,
            running: state.running,
            cron: config.cron,
            timezone: config.timezone,
            ackWindowMs: config.ackWindowMs,
            deadThreshold: config.deadThreshold,
            cardConfigured: config.cardConfigured,
            cardSkipReason: config.cardSkipReason,
            totalRuns: state.totalRuns,
            lastRunAt: state.lastRunAt,
            lastOkAt: state.lastOkAt,
            lastFailureAt: state.lastFailureAt,
            lastSkippedAt: state.lastSkippedAt,
            lastRunId: state.lastRunId,
            lastSentCount: state.lastSentCount,
            lastDeliveredCount: state.lastDeliveredCount,
            lastAckedCount: state.lastAckedCount,
            lastDeadCount: state.lastDeadCount,
            lastErrorCount: state.lastErrorCount,
            lastAckRate: state.lastAckRate,
            lastError: state.lastError,
            skipReason: config.skipReason || state.skipReason || null,
        };
    }

    // Real-time read of active/dead counts. Used by /api/bot/push-status so
    // operators always see the current truth, not a stale cron-tick snapshot.
    async function getDbCounts() {
        try {
            const p = resolvePool();
            const res = await p.query(
                `SELECT
                    COALESCE(SUM(CASE WHEN is_active THEN 1 ELSE 0 END), 0)::int AS active,
                    COALESCE(SUM(CASE WHEN NOT is_active THEN 1 ELSE 0 END), 0)::int AS dead
                   FROM push_subscriptions`
            );
            const row = res.rows[0] || {};
            return { activeSubscriptions: Number(row.active || 0), deadSubscriptions: Number(row.dead || 0) };
        } catch (_) {
            return { activeSubscriptions: null, deadSubscriptions: null };
        }
    }

    async function runOnce(reason = 'manual') {
        const config = loadConfig(env);
        const startedAt = now();
        state.running = true;
        state.lastRunAt = startedAt;
        state.skipReason = config.skipReason;

        if (!config.configured) {
            state.running = false;
            state.lastSkippedAt = startedAt;
            audit('info', 'push_health_check', `[PushHealth] skipped: ${config.skipReason}`, {
                action: 'push_health_check',
                result: 'skipped',
                metadata: { reason, skipReason: config.skipReason },
            });
            return { ok: null, skipped: true, reason: config.skipReason };
        }

        if (typeof sendNotification !== 'function') {
            state.running = false;
            state.lastSkippedAt = startedAt;
            audit('warn', 'push_health_check', '[PushHealth] skipped: sendNotification not wired', {
                action: 'push_health_check',
                result: 'skipped',
                metadata: { reason, skipReason: 'sendNotification_missing' },
            });
            return { ok: null, skipped: true, reason: 'sendNotification_missing' };
        }

        const dbPool = resolvePool();
        state.totalRuns += 1;
        const runId = genId();
        state.lastRunId = runId;

        let subscriptions;
        try {
            subscriptions = await listActiveSubscriptions(dbPool);
        } catch (err) {
            state.running = false;
            state.lastFailureAt = now();
            state.lastError = err && err.message;
            audit('error', 'push_health_check', `[PushHealth] subscription list query failed: ${state.lastError}`, {
                action: 'push_health_check',
                result: 'error',
                metadata: { reason, runId },
            });
            return { ok: false, skipped: false, runId, error: state.lastError };
        }

        const sentCount = subscriptions.length;
        const startedAtIso = new Date(startedAt).toISOString();

        try {
            await insertRunStart(dbPool, { runId, reason, sentCount, startedAtIso });
        } catch (err) {
            // Logging is non-fatal; we keep running so we still hit dead-cleanup paths.
            audit('warn', 'push_health_check', `[PushHealth] insertRunStart failed: ${err && err.message}`, {
                action: 'push_health_check',
                result: 'insert_failed',
                metadata: { runId },
            });
        }

        // Fire all pushes with per-subscription nonces. Failures (410/404) are
        // collected so we can clean up endpoints immediately rather than wait
        // for the 60s ack window — those are unambiguous server-side deletions.
        const nonces = [];
        const subByNonce = new Map();
        let deliveredCount = 0;
        let errorCount = 0;
        let removedNow = 0;

        for (const sub of subscriptions) {
            const nonce = nonceFn();
            nonces.push(nonce);
            subByNonce.set(nonce, sub);
            const payload = JSON.stringify({
                type: 'health',
                nonce,
                runId,
                ts: now(),
            });
            const pushSub = {
                endpoint: sub.endpoint,
                keys: { p256dh: sub.p256dh, auth: sub.auth },
            };
            try {
                await sendNotification(pushSub, payload, {
                    TTL: config.pushTtl,
                    urgency: 'very-low',
                });
                deliveredCount += 1;
                try {
                    await recordSentTimestamp(dbPool, sub.id, startedAtIso);
                } catch (_) { /* non-fatal */ }
            } catch (e) {
                const statusCode = e && e.statusCode;
                if (statusCode === 410 || statusCode === 404) {
                    // Push service told us the endpoint is gone. Remove the
                    // subscription row now (matches sendWebPush's existing
                    // behavior in index.js); no ack possible so don't even
                    // hold the nonce for the wait window.
                    try {
                        await removeSubscriptionByEndpoint(dbPool, sub.endpoint);
                        removedNow += 1;
                    } catch (_) { /* non-fatal */ }
                } else {
                    errorCount += 1;
                    audit('warn', 'push_health_check', `[PushHealth] push send failed: status=${statusCode} ${e && e.message}`, {
                        action: 'push_health_check',
                        result: 'send_failed',
                        metadata: { runId, subId: sub.id, statusCode },
                    });
                }
            }
        }

        // Wait the ack window. Injectable so tests run instantly.
        await wait(config.ackWindowMs);

        // Reconcile: which nonces came back? (Only the ones we actually sent
        // to a still-living subscription have a chance — the 410/404 sweep
        // above already removed dead rows.)
        let acked;
        try {
            acked = await ackedNonceSet(dbPool, runId, nonces);
        } catch (err) {
            acked = new Set();
            audit('warn', 'push_health_check', `[PushHealth] ack query failed: ${err && err.message}`, {
                action: 'push_health_check',
                result: 'ack_query_failed',
                metadata: { runId },
            });
        }

        const finishedAt = now();
        const finishedAtIso = new Date(finishedAt).toISOString();
        const ackedCount = acked.size;

        const followups = [];
        let newlyDeadCount = removedNow;   // immediate-removal counts as dead this run

        // Per-subscription streak bookkeeping. The UPDATE statements below are
        // keyed by subscription id; if a row was deleted in the 410/404 sweep
        // above, rowCount=0 and we fall through harmlessly. No need to filter
        // — the SQL is idempotent for the missing-row case.
        for (const nonce of nonces) {
            const sub = subByNonce.get(nonce);
            if (!sub) continue;

            if (acked.has(nonce)) {
                try {
                    await resetSubscriptionStreak(dbPool, sub.id, finishedAtIso);
                } catch (_) { /* non-fatal */ }
            } else {
                try {
                    const newStreak = await incrementSubscriptionFailure(dbPool, sub.id);
                    if (newStreak >= config.deadThreshold) {
                        await deactivateSubscription(dbPool, sub.id, 'consecutive_health_failures', finishedAtIso);
                        newlyDeadCount += 1;
                        try {
                            const card = await openDeadSubscriptionCard(dbPool, config, {
                                id: sub.id,
                                deviceId: sub.device_id,
                                endpoint: sub.endpoint,
                                consecutiveFailures: newStreak,
                                threshold: config.deadThreshold,
                                deactivatedAtIso: finishedAtIso,
                            });
                            followups.push(card);
                            audit('warn', 'push_health_check', `[PushHealth] subscription ${sub.id} deactivated after ${newStreak} consecutive failures`, {
                                action: 'push_health_check',
                                result: 'subscription_deactivated',
                                resource: String(sub.id),
                                metadata: { runId, cardId: card && card.cardId, newStreak },
                            });
                        } catch (cardErr) {
                            audit('error', 'push_health_check', `[PushHealth] follow-up card open failed: ${cardErr && cardErr.message}`, {
                                action: 'push_health_check',
                                result: 'followup_card_failed',
                                metadata: { runId, subId: sub.id },
                            });
                        }
                    }
                } catch (_) { /* non-fatal */ }
            }
        }

        // Finalize the run row with the actual numbers.
        try {
            await finalizeRun(dbPool, {
                runId,
                deliveredCount,
                ackedCount,
                deadCount: newlyDeadCount,
                errorCount,
                finishedAtIso,
            });
        } catch (err) {
            audit('warn', 'push_health_check', `[PushHealth] finalizeRun failed: ${err && err.message}`, {
                action: 'push_health_check',
                result: 'finalize_failed',
                metadata: { runId },
            });
        }

        state.running = false;
        state.lastSentCount = sentCount;
        state.lastDeliveredCount = deliveredCount;
        state.lastAckedCount = ackedCount;
        state.lastDeadCount = newlyDeadCount;
        state.lastErrorCount = errorCount;
        state.lastAckRate = sentCount > 0 ? (ackedCount / sentCount) : null;
        state.lastError = null;

        const ok = errorCount === 0 && newlyDeadCount === 0;
        if (ok) state.lastOkAt = finishedAt;
        else state.lastFailureAt = finishedAt;

        audit(ok ? 'info' : 'warn', 'push_health_check',
            `[PushHealth] run ${runId} sent=${sentCount} delivered=${deliveredCount} acked=${ackedCount} dead=${newlyDeadCount} errors=${errorCount}`,
            {
                action: 'push_health_check',
                result: ok ? 'ok' : 'partial',
                metadata: { reason, runId, sentCount, deliveredCount, ackedCount, deadCount: newlyDeadCount, errorCount, followups: followups.length },
            }
        );

        // Fakechat report per feedback_auto_cron_report_first. Optional so
        // tests don't need to wire one.
        if (typeof reportFakechat === 'function') {
            try {
                const ratePct = sentCount > 0 ? Math.round((ackedCount / sentCount) * 100) : null;
                const line = `[Auto/PushHealth] run ${runId}: sent=${sentCount} delivered=${deliveredCount} acked=${ackedCount}${ratePct == null ? '' : ` (${ratePct}%)`} dead=${newlyDeadCount} errors=${errorCount}`;
                await reportFakechat(line);
            } catch (e) {
                audit('warn', 'push_health_check', `[PushHealth] fakechat report failed: ${e && e.message}`, {
                    action: 'push_health_check',
                    result: 'report_failed',
                    metadata: { runId },
                });
            }
        }

        return {
            ok,
            skipped: false,
            runId,
            sentCount,
            deliveredCount,
            ackedCount,
            deadCount: newlyDeadCount,
            errorCount,
            followups,
        };
    }

    function startCron({ nodeCron } = {}) {
        const config = loadConfig(env);
        if (!config.enabled) {
            console.log('[PushHealth] disabled via PUSH_HEALTH_CRON_ENABLED=0');
            return () => {};
        }
        if (!config.configured) {
            console.log(`[PushHealth] cron not scheduled: ${config.skipReason}`);
            return () => {};
        }
        if (!nodeCron || typeof nodeCron.schedule !== 'function') {
            throw new Error('nodeCron_required');
        }
        const task = nodeCron.schedule(config.cron, () => {
            runOnce('cron').catch(err => {
                console.error('[PushHealth] cron tick error:', err && err.message);
            });
        }, { timezone: config.timezone });
        audit('info', 'push_health_check', `[PushHealth] scheduled ${config.cron} ${config.timezone}`, {
            action: 'push_health_check',
            result: 'scheduled',
            metadata: {
                cron: config.cron,
                timezone: config.timezone,
                ackWindowMs: config.ackWindowMs,
                deadThreshold: config.deadThreshold,
                cardConfigured: config.cardConfigured,
                cardSkipReason: config.cardSkipReason,
            },
        });
        return () => {
            if (task && typeof task.stop === 'function') task.stop();
        };
    }

    return {
        runOnce,
        startCron,
        getStatus,
        getDbCounts,
        _state: state,
    };
}

module.exports = {
    DEFAULT_CRON,
    DEFAULT_TIMEZONE,
    DEFAULT_ACK_WINDOW_MS,
    DEFAULT_DEAD_THRESHOLD,
    createPushHealthCheckCron,
    loadConfig,
    describeDeadSubscription,
    openDeadSubscriptionCard,
    // Test/diagnostic exports — kept stable so tooling can probe primitives.
    listActiveSubscriptions,
    insertRunStart,
    finalizeRun,
    ackedNonceSet,
    countAckedNonces,
    resetSubscriptionStreak,
    incrementSubscriptionFailure,
    deactivateSubscription,
};
