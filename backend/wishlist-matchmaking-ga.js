/**
 * wishlist-matchmaking-ga — GA (general-availability) hardening for the
 * wishlist × EClaw matchmaking chain (card_bdf2f1f549aaf71238048b01, P4).
 *
 * This module is PURELY ADDITIVE defense on top of the settled P0-P3 design. It
 * NEVER weakens an existing control (opt-in default-OFF, kill-switch, per-entity
 * invite quota, dual human-marked consent, P3 from-caller binding, device-scoped
 * fileId, opt-in-only reachability). It ADDS four GA-hardening layers:
 *
 *   1. METRICS (observability) — an in-process counter registry for
 *      invites sent / blocked / deduped, accepts, declines, contacts released,
 *      and per-reason block counts (killswitch / quota / rate-limit / abuse /
 *      GA-gate / unreachable). Derived rates (accept-rate, block-rate,
 *      dedup-rate) are computed from the raw counters. Exposed as a snapshot for
 *      a read-only /metrics endpoint. Counters are cheap and lossy-on-restart by
 *      design (mirrors the existing in-memory botToBotCounter) — the durable
 *      audit trail is still serverLog.
 *
 *   2. PER-CALLER / PER-IP RATE LIMIT — a sliding-window limiter keyed by the
 *      caller's deviceId (falling back to IP) that is DISTINCT from the P2
 *      business quota. The quota caps how many *matches* one entity may invite
 *      per hour (a product rule); this limiter caps request *velocity* to blunt
 *      spam / quota-exhaustion probing / malformed-input floods before they even
 *      reach the router. The N+1 request in a window is rejected with 429 and no
 *      side effect. It layers UNDER the quota — passing the limiter still hits
 *      every P2 gate.
 *
 *   3. GA ROLLOUT GATE (dark-launch → default-on) — matchmaking SENDS are gated
 *      by a GLOBAL rollout flag on TOP of the per-owner opt-in. Dark-launch: the
 *      flag is OFF by default, so even an owner who opted in sends nothing until
 *      the platform operator flips the global flag (intended once REAL inventory
 *      exists — card_d950bd8a's first real listing). The flag is read server-side
 *      by NAME from env (WISHLIST_MATCHMAKING_GA_ENABLED) and is never logged.
 *      This is an ADDITIONAL gate: it can only ever BLOCK a send, never enable one
 *      that opt-in/kill-switch/quota/reachability would have blocked.
 *
 *   4. OFFLINE / NON-ECLAW SELLER FALLBACK (C0b gap) — when a send cannot be
 *      delivered right now (target not an opted-in EClaw entity, or a transient
 *      delivery error), the invite is enqueued for a BOUNDED number of retries
 *      instead of being silently dropped. This is the caller's OWN retry buffer —
 *      there is NO central scheduler and NO platform compute acting on an agent's
 *      behalf (官方不介入): the queue only re-drives the SAME governed send with the
 *      SAME caller principal. A permanently-undeliverable invite is dead-lettered
 *      (surfaced, not retried forever).
 *
 * Everything is dependency-injected + unit-testable with no network, no DB, and
 * no real clock (mirrors wishlist-matchmaking.js / wishlist-matchmaking-p3.js).
 */

'use strict';

// ── Metric names (frozen so a typo can't silently mint a new counter) ────────
const METRICS = Object.freeze({
    INVITES_SENT: 'invites_sent',
    INVITES_DEDUPED: 'invites_deduped',
    INVITES_BLOCKED: 'invites_blocked',
    ACCEPTS: 'accepts',
    DECLINES: 'declines',
    CONTACTS_RELEASED: 'contacts_released',
    // Per-reason block breakdown (all subsets of INVITES_BLOCKED except where a
    // reason is not an invite, e.g. a rate-limit hit before routing).
    BLOCK_KILLSWITCH: 'block_killswitch',
    BLOCK_QUOTA: 'block_quota',
    BLOCK_RATE_LIMIT: 'block_rate_limit',
    BLOCK_ABUSE: 'block_abuse',
    BLOCK_GA_GATE: 'block_ga_gate',
    BLOCK_UNREACHABLE: 'block_unreachable',
    BLOCK_OPT_IN_OFF: 'block_opt_in_off',
    // Offline fallback lifecycle.
    OFFLINE_QUEUED: 'offline_queued',
    OFFLINE_RETRIED: 'offline_retried',
    OFFLINE_DELIVERED: 'offline_delivered',
    OFFLINE_DEAD_LETTERED: 'offline_dead_lettered',
    // (MED#2) enqueue rejected because a queue cap was hit — a memory-DoS guard.
    OFFLINE_QUEUE_FULL: 'offline_queue_full',
    // (MED#1) a queued retry was dead-lettered because the target became opted-out /
    // killswitched / unreachable AFTER enqueue (the "stop reaching me" control wins).
    OFFLINE_REVOKED: 'offline_revoked',
});

// Reason string (from a P2/P3 blocked result) → the fine-grained block counter.
const REASON_TO_METRIC = Object.freeze({
    killswitch: METRICS.BLOCK_KILLSWITCH,
    target_killswitch: METRICS.BLOCK_KILLSWITCH,
    quota: METRICS.BLOCK_QUOTA,
    rate_limit: METRICS.BLOCK_RATE_LIMIT,
    abuse: METRICS.BLOCK_ABUSE,
    ga_gate: METRICS.BLOCK_GA_GATE,
    ga_disabled: METRICS.BLOCK_GA_GATE,
    unreachable: METRICS.BLOCK_UNREACHABLE,
    opt_in_off: METRICS.BLOCK_OPT_IN_OFF,
});

// ── (1) Metrics registry ─────────────────────────────────────────────────────

/**
 * A tiny in-process counter registry. Cheap, lossy-on-restart by design (the
 * durable trail is serverLog). All counter names are validated against METRICS so
 * a stray string can't silently create a shadow counter.
 */
function createMetrics({ now } = {}) {
    const clock = typeof now === 'function' ? now : () => Date.now();
    const counters = Object.create(null);
    for (const name of Object.values(METRICS)) counters[name] = 0;
    const startedAt = clock();

    function inc(name, by = 1) {
        if (!Object.prototype.hasOwnProperty.call(counters, name)) return false;
        const n = Number(by);
        counters[name] += Number.isFinite(n) ? n : 1;
        return true;
    }

    // Convenience: record a blocked invite AND its per-reason breakdown in one call.
    function recordBlock(reason) {
        inc(METRICS.INVITES_BLOCKED);
        const fine = REASON_TO_METRIC[String(reason || '').toLowerCase()];
        if (fine) inc(fine);
    }

    function snapshot() {
        const c = { ...counters };
        const sent = c[METRICS.INVITES_SENT];
        const deduped = c[METRICS.INVITES_DEDUPED];
        const blocked = c[METRICS.INVITES_BLOCKED];
        const attempted = sent + deduped + blocked;
        const ratio = (num, den) => (den > 0 ? Number((num / den).toFixed(4)) : 0);
        return {
            counters: c,
            derived: {
                // accept-rate = accepts / invites actually sent (a dedup/blocked
                // invite never reaches a seller so it can't be accepted).
                acceptRate: ratio(c[METRICS.ACCEPTS], sent),
                declineRate: ratio(c[METRICS.DECLINES], sent),
                blockRate: ratio(blocked, attempted),
                dedupRate: ratio(deduped, attempted),
                contactReleaseRate: ratio(c[METRICS.CONTACTS_RELEASED], c[METRICS.ACCEPTS]),
                invitesAttempted: attempted,
            },
            uptimeMs: clock() - startedAt,
        };
    }

    function reset() {
        for (const name of Object.values(METRICS)) counters[name] = 0;
    }

    return { inc, recordBlock, snapshot, reset, _counters: counters };
}

// ── (2) Per-caller / per-IP sliding-window rate limiter ──────────────────────

const RATE_LIMIT_MAX_DEFAULT = 20; // requests
const RATE_LIMIT_WINDOW_MS_DEFAULT = 60 * 1000; // per minute

/**
 * Sliding-window limiter, keyed by caller deviceId (an attacker rotating IPs
 * shouldn't get a fresh budget) with an IP fallback for a body-less/malformed
 * request that hits the limiter before validation. DISTINCT from the P2 business
 * quota: this caps request velocity; the quota caps matches per hour.
 *
 * Returns { check(key), middleware() }. check() is pure + directly testable
 * (records the hit and returns { allowed, remaining, retryAfterMs }); middleware()
 * wraps it for express and, when configured, increments a metrics counter on block.
 */
function createRateLimiter({ max, windowMs, now, metrics, disabled } = {}) {
    const cap = Number.isFinite(Number(max)) ? Number(max) : RATE_LIMIT_MAX_DEFAULT;
    const win = Number.isFinite(Number(windowMs)) ? Number(windowMs) : RATE_LIMIT_WINDOW_MS_DEFAULT;
    const clock = typeof now === 'function' ? now : () => Date.now();
    const isDisabled = typeof disabled === 'function' ? disabled : () => false;
    const hits = new Map(); // key -> [timestamps within window]

    function check(rawKey) {
        const key = String(rawKey || 'anon');
        const t = clock();
        const start = t - win;
        const arr = (hits.get(key) || []).filter((ts) => ts > start);
        if (arr.length >= cap) {
            hits.set(key, arr);
            const retryAfterMs = arr.length ? Math.max(0, arr[0] + win - t) : win;
            return { allowed: false, remaining: 0, retryAfterMs };
        }
        arr.push(t);
        hits.set(key, arr);
        return { allowed: true, remaining: Math.max(0, cap - arr.length), retryAfterMs: 0 };
    }

    // (LOW#3) This limiter runs PRE-auth (in front of the router), so req.body.deviceId
    // is attacker-controlled and NOT verified — keying on it would let an unauth
    // attacker rotate deviceId for a fresh bucket each request, diluting the cap. The
    // velocity key is therefore anchored on the IP, which an attacker can't rotate for
    // free at scale, so an unauth flood from one IP is capped no matter how many
    // deviceIds it invents. (Per-CALLER business fairness — one entity vs. another —
    // is separately enforced POST-auth by the P2 invite quota, keyed on the verified
    // deviceId; this pre-auth layer's job is only to blunt raw request velocity.)
    function keyFor(req) {
        const ip = (req && (req.ip || (req.headers && req.headers['x-forwarded-for']))) || 'noip';
        return `ip:${ip}`;
    }

    function middleware() {
        return (req, res, next) => {
            if (isDisabled()) return next();
            const r = check(keyFor(req));
            if (r.allowed) {
                res.setHeader && res.setHeader('X-RateLimit-Remaining', String(r.remaining));
                return next();
            }
            if (metrics && typeof metrics.inc === 'function') metrics.inc(METRICS.BLOCK_RATE_LIMIT);
            res.setHeader && res.setHeader('Retry-After', String(Math.ceil(r.retryAfterMs / 1000)));
            return res.status(429).json({
                error: 'matchmaking rate limit exceeded — slow down',
                reason: 'rate_limit',
                retryAfterMs: r.retryAfterMs,
            });
        };
    }

    return { check, middleware, keyFor, cap, windowMs: win };
}

// ── (3) GA rollout gate (dark-launch → default-on) ───────────────────────────

const GA_ENV_FLAG = 'WISHLIST_MATCHMAKING_GA_ENABLED';

/**
 * The GLOBAL rollout gate. Read server-side by NAME from env (never logged).
 * Dark-launch default is OFF (a bare `!!` would turn the string 'false' true, so
 * we require an explicit truthy token — same string-safe coercion the device
 * prefs use). Only '1' / 'true' / 'on' / 'yes' (case-insensitive) enable GA.
 *
 * This is an ADDITIVE gate: matchmaking SENDS require BOTH the per-owner opt-in
 * (unchanged, checked by P2) AND this global flag. It can only BLOCK; it can never
 * turn on a send that a lower gate would refuse.
 */
function isGaEnabled(env = process.env) {
    const raw = env && env[GA_ENV_FLAG];
    if (raw == null) return false;
    const v = String(raw).trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'on' || v === 'yes';
}

/**
 * Express guard: 403 with reason 'ga_disabled' when the global GA flag is off.
 * Mounted in FRONT of the send-capable matchmaking routes. Read-only routes
 * (/search, /photo-search, /metrics) are NOT gated — dark-launch still lets an
 * operator exercise search + read metrics while sends stay dark.
 */
function gaGate({ env, metrics } = {}) {
    return (req, res, next) => {
        if (isGaEnabled(env || process.env)) return next();
        if (metrics && typeof metrics.inc === 'function') metrics.inc(METRICS.BLOCK_GA_GATE);
        return res.status(403).json({
            error: 'wishlist matchmaking is in dark-launch — global rollout not enabled',
            reason: 'ga_disabled',
        });
    };
}

// ── (4) Offline / non-EClaw seller fallback (bounded retry queue) ────────────

const OFFLINE_MAX_ATTEMPTS_DEFAULT = 3;
const OFFLINE_BASE_BACKOFF_MS_DEFAULT = 60 * 1000; // 1 min, exponential
// (MED#2) buffer-size caps — this queue lives in process memory, so an attacker (or
// a bug) that enqueues without bound is a memory-DoS. A TOTAL cap bounds the whole
// buffer; a PER-DEVICE cap stops one caller from starving/evicting everyone else.
const OFFLINE_MAX_QUEUE_SIZE_DEFAULT = 5000;
const OFFLINE_MAX_PER_DEVICE_DEFAULT = 100;

/**
 * A bounded, per-caller retry buffer for a governed send that could not be
 * delivered right now. This is NOT a central scheduler and it never acts on an
 * agent's behalf beyond re-driving the SAME governed send the caller already
 * authorised (官方不介入). A job that keeps failing past maxAttempts is
 * dead-lettered (surfaced via onDeadLetter) rather than retried forever.
 *
 * The queue is deliberately transport-agnostic: `sender(job)` is injected and is
 * expected to return { delivered: true } | { delivered: false, permanent?: bool }.
 * A `permanent:true` result (e.g. target opted out / not an EClaw entity and no
 * wishlist-native channel) short-circuits straight to dead-letter — no wasted
 * retries. A transient failure backs off exponentially up to maxAttempts.
 */
function createOfflineFallbackQueue({ sender, maxAttempts, baseBackoffMs, now, metrics, onDeadLetter, maxQueueSize, maxPerDevice } = {}) {
    const deliver = typeof sender === 'function' ? sender : async () => ({ delivered: false });
    const maxA = Number.isFinite(Number(maxAttempts)) ? Number(maxAttempts) : OFFLINE_MAX_ATTEMPTS_DEFAULT;
    const backoff = Number.isFinite(Number(baseBackoffMs)) ? Number(baseBackoffMs) : OFFLINE_BASE_BACKOFF_MS_DEFAULT;
    const clock = typeof now === 'function' ? now : () => Date.now();
    const deadLetterCb = typeof onDeadLetter === 'function' ? onDeadLetter : () => {};
    const maxSize = Number.isFinite(Number(maxQueueSize)) ? Number(maxQueueSize) : OFFLINE_MAX_QUEUE_SIZE_DEFAULT;
    const maxPerDev = Number.isFinite(Number(maxPerDevice)) ? Number(maxPerDevice) : OFFLINE_MAX_PER_DEVICE_DEFAULT;
    const jobs = new Map(); // jobKey -> record
    const perDevice = new Map(); // fromDeviceId -> live job count
    let seq = 0;

    function nextDelayMs(attempts) {
        return backoff * Math.pow(2, Math.max(0, attempts - 1));
    }

    function deviceKeyOf(payload) {
        const d = payload && payload.fromDeviceId;
        return d ? String(d) : '__nodev__';
    }
    function bump(devKey, delta) {
        const n = (perDevice.get(devKey) || 0) + delta;
        if (n <= 0) perDevice.delete(devKey);
        else perDevice.set(devKey, n);
    }

    // Enqueue a job. jobKey de-dups so the same undeliverable (buyer,item,seller)
    // enqueued twice is ONE job (idempotent, mirrors matchId dedup upstream).
    //
    // (MED#2) Buffer caps enforced BEFORE insert: an over-total or over-per-device
    // enqueue is REJECTED (not inserted, no eviction of an existing job) and a
    // queue-full metric is incremented. The dedup fast-path returns first so a
    // replay of an already-queued job is never counted against the cap.
    function enqueue({ jobKey, payload }) {
        const key = jobKey || `job-${++seq}`;
        if (jobs.has(key)) return { queued: true, jobKey: key, deduped: true };
        const devKey = deviceKeyOf(payload);
        if (jobs.size >= maxSize) {
            if (metrics) metrics.inc(METRICS.OFFLINE_QUEUE_FULL);
            return { queued: false, jobKey: key, reason: 'queue_full' };
        }
        if ((perDevice.get(devKey) || 0) >= maxPerDev) {
            if (metrics) metrics.inc(METRICS.OFFLINE_QUEUE_FULL);
            return { queued: false, jobKey: key, reason: 'device_queue_full' };
        }
        const t = clock();
        jobs.set(key, {
            jobKey: key, payload, attempts: 0, status: 'queued',
            enqueuedAt: t, nextAttemptAt: t, lastError: null, devKey,
        });
        bump(devKey, 1);
        if (metrics) metrics.inc(METRICS.OFFLINE_QUEUED);
        return { queued: true, jobKey: key, deduped: false };
    }

    // Drive every job whose nextAttemptAt is due. Returns a run summary. Callers
    // (a cron OR the caller's own Agent) invoke this — there is no internal timer,
    // so there is no platform-side background compute.
    async function drain() {
        const t = clock();
        const summary = { delivered: 0, retried: 0, deadLettered: 0, pending: 0 };
        for (const rec of Array.from(jobs.values())) {
            if (rec.status !== 'queued' || rec.nextAttemptAt > t) {
                if (rec.status === 'queued') summary.pending += 1;
                continue;
            }
            rec.attempts += 1;
            if (metrics) metrics.inc(METRICS.OFFLINE_RETRIED);
            let result;
            try {
                result = await deliver(rec.payload);
            } catch (err) {
                result = { delivered: false, error: err && err.message };
            }
            if (result && result.delivered) {
                rec.status = 'delivered';
                if (metrics) metrics.inc(METRICS.OFFLINE_DELIVERED);
                summary.delivered += 1;
                jobs.delete(rec.jobKey);
                bump(rec.devKey, -1);
                continue;
            }
            rec.lastError = (result && result.error) || 'undelivered';
            const permanent = !!(result && result.permanent);
            // (MED#1) `revoked` marks a job the sender refused because the target
            // became opted-out / killswitched / unreachable after enqueue — a
            // permanent dead-letter that ALSO bumps a dedicated metric so operators
            // can see the "stop reaching me" control taking effect.
            const revoked = !!(result && result.revoked);
            if (permanent || revoked || rec.attempts >= maxA) {
                rec.status = 'dead_letter';
                if (metrics) metrics.inc(METRICS.OFFLINE_DEAD_LETTERED);
                if (revoked && metrics) metrics.inc(METRICS.OFFLINE_REVOKED);
                summary.deadLettered += 1;
                try { deadLetterCb({ ...rec, permanent, revoked }); } catch (_e) { /* non-critical */ }
                jobs.delete(rec.jobKey);
                bump(rec.devKey, -1);
                continue;
            }
            rec.nextAttemptAt = t + nextDelayMs(rec.attempts);
            summary.retried += 1;
            summary.pending += 1;
        }
        return summary;
    }

    function stats() {
        let queued = 0;
        for (const rec of jobs.values()) if (rec.status === 'queued') queued += 1;
        return { queued, total: jobs.size, maxSize, maxPerDevice: maxPerDev, devices: perDevice.size };
    }

    return { enqueue, drain, stats, _jobs: jobs, _perDevice: perDevice, maxAttempts: maxA, maxSize, maxPerDevice: maxPerDev };
}

module.exports = {
    // (1) metrics
    createMetrics,
    METRICS,
    REASON_TO_METRIC,
    // (2) rate limit
    createRateLimiter,
    RATE_LIMIT_MAX_DEFAULT,
    RATE_LIMIT_WINDOW_MS_DEFAULT,
    // (3) GA rollout gate
    isGaEnabled,
    gaGate,
    GA_ENV_FLAG,
    // (4) offline fallback
    createOfflineFallbackQueue,
    OFFLINE_MAX_ATTEMPTS_DEFAULT,
    OFFLINE_BASE_BACKOFF_MS_DEFAULT,
    OFFLINE_MAX_QUEUE_SIZE_DEFAULT,
    OFFLINE_MAX_PER_DEVICE_DEFAULT,
};
