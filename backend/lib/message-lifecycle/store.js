/**
 * MessageLifecycle store — DB persistence + transition application (spec §3,§5,§7).
 *
 * Card: card_1b1c13225f10e8a803cef532 (Phase 2 Step 3 — dual-write store).
 * Spec: docs/specs/message-lifecycle-spec.md §3 (Option B schema), §5 (backfill),
 *       §7 (dual-write protocol), §11 (#6 constraints).
 *
 * Schema option: B (companion `message_lifecycle` table) — choice carried from
 * Step 1 (backend/migrations/20260614_message_lifecycle.up.sql). Rationale in
 * that file's header + spec §3.4.
 *
 * Dual-write discipline (spec §7):
 *   - Every method is best-effort and NEVER throws on the hot path. A lifecycle
 *     write failure must not break the legacy counter path (legacy stays
 *     authoritative for reads during parallel run).
 *   - Persistence applies ONLY the verdict the pure engine returns. The engine
 *     guarantees idempotency + monotonicity; the store never writes a SQL
 *     UPDATE that lowers a state rank or backfills a skipped *_at.
 *
 * Source of truth = PG. Redis (the deadline wheel) is an optional cache passed
 * in via setWheel(); if absent, transitions still persist, they just won't
 * auto-arm stuck alerts (the cold-start scan can re-arm on next boot).
 */
'use strict';

const { decideTransition, APPLIED, STATE_AT_FIELD, stateIndex, isValidState } = require('./engine');

let pool = null;
let wheel = null; // optional deadline wheel (createWheel result)

// Per-state stuck timeout (ms). Spec §2.2 defaults; tunable per entity class.
// These are the conservative ceilings used to arm the deadline wheel. The
// sweeper re-checks the DB row before alerting, so over-scheduling is harmless.
const STATE_TIMEOUTS_MS = {
    inbound_seen: 90_000,        // 90s free-bot bot_acked deadline (spec §2.2)
    bot_acked: 60_000,           // 60s channel push deadline
    push_delivered: 86_400_000,  // 24h best-effort (never paged — spec §6.4)
};

function setPool(p) { pool = p; }
function setWheel(w) { wheel = w; }
function getStateTimeoutMs(state) { return STATE_TIMEOUTS_MS[state] ?? 0; }

/**
 * Replayable DDL. The repo applies schema via initTable() at boot (not a SQL
 * migration runner); this mirrors backend/migrations/20260614_message_lifecycle.up.sql
 * verbatim so the two never drift. IF NOT EXISTS everywhere — safe to re-run.
 */
async function initTable(chatPool) {
    pool = chatPool;
    if (!pool) return;
    await pool.query(`
        CREATE TABLE IF NOT EXISTS message_lifecycle (
            message_id          TEXT PRIMARY KEY,
            tenant_id           TEXT NOT NULL,
            device_id           VARCHAR(64) NOT NULL,
            entity_id           INTEGER NOT NULL,
            direction           TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
            reply_to_message_id TEXT,
            state               TEXT NOT NULL CHECK (state IN ('inbound_seen','bot_acked','push_delivered','user_seen')),
            inbound_seen_at     TIMESTAMPTZ NOT NULL,
            bot_acked_at        TIMESTAMPTZ,
            push_delivered_at   TIMESTAMPTZ,
            user_seen_at        TIMESTAMPTZ,
            skipped_states      TEXT[] NOT NULL DEFAULT '{}',
            last_error          TEXT,
            alerted_at          TIMESTAMPTZ,
            source              TEXT NOT NULL DEFAULT 'live'
                                CHECK (source IN ('live','backfill','backfill+link','backfill+heuristic','inferred')),
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_ml_device_entity_state
            ON message_lifecycle (device_id, entity_id, state);
        CREATE INDEX IF NOT EXISTS idx_ml_stuck_lookup
            ON message_lifecycle (state, COALESCE(push_delivered_at, bot_acked_at, inbound_seen_at))
            WHERE state <> 'user_seen';
        CREATE INDEX IF NOT EXISTS idx_ml_reply_chain
            ON message_lifecycle (reply_to_message_id)
            WHERE reply_to_message_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS lifecycle_event_log (
            id              BIGSERIAL PRIMARY KEY,
            message_id      TEXT NOT NULL,
            attempted_state TEXT NOT NULL
                            CHECK (attempted_state IN ('inbound_seen','bot_acked','push_delivered','user_seen')),
            event_at        TIMESTAMPTZ NOT NULL,
            transition_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            applied         TEXT NOT NULL
                            CHECK (applied IN ('accepted','idempotent_noop','rejected_late','rejected_unknown_message')),
            reason          TEXT,
            source          TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_lel_message
            ON lifecycle_event_log (message_id, transition_at DESC);

        -- Divergence detector (spec §6.5 / §9.10): every dual-write site that
        -- fails to also bump its legacy counter records here so the Phase 3
        -- cutover gate can surface it instead of silently passing.
        CREATE TABLE IF NOT EXISTS lifecycle_divergence_log (
            id                BIGSERIAL PRIMARY KEY,
            message_id        TEXT,
            device_id         VARCHAR(64),
            entity_id         INTEGER,
            legacy_counter    TEXT NOT NULL,   -- 'chat_no_reply' | 'delivery_alert' | ...
            direction         TEXT NOT NULL,   -- 'legacy_skipped' | 'lifecycle_skipped'
            reason            TEXT,
            occurred_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_ldl_window
            ON lifecycle_divergence_log (occurred_at DESC);
    `);
}

async function fetchRow(messageId) {
    if (!pool) return null;
    const r = await pool.query(
        `SELECT * FROM message_lifecycle WHERE message_id = $1`,
        [String(messageId)]
    );
    return r.rows[0] || null;
}

async function writeAudit(client, messageId, attemptedState, eventAt, applied, reason, source) {
    const exec = client || pool;
    if (!exec) return;
    await exec.query(
        `INSERT INTO lifecycle_event_log (message_id, attempted_state, event_at, applied, reason, source)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [String(messageId), attemptedState, toTs(eventAt), applied, reason || null, source || 'unknown']
    );
}

/**
 * Apply a transition (spec §2.3, §7). Best-effort: returns a verdict object,
 * never throws on the hot path.
 *
 * @param {object} opts
 * @param {string} opts.messageId
 * @param {string} opts.targetState  'inbound_seen'|'bot_acked'|'push_delivered'|'user_seen'
 * @param {Date|number|string} [opts.eventAt]  upstream event time (default now)
 * @param {string} [opts.source]  audit source ('transform'|'enqueue'|'chat_read'|...)
 * @param {object} [opts.create]  fields used only when creating the inbound_seen
 *        row: { deviceId, entityId, direction, replyToMessageId, tenantId }
 * @param {string} [opts.rowSource]  message_lifecycle.source override (backfill etc.)
 * @returns {Promise<{applied:string, state?:string, reason?:string}>}
 */
async function transition(opts) {
    const {
        messageId,
        targetState,
        eventAt = new Date(),
        source = 'unknown',
        create = {},
        rowSource = null,
    } = opts || {};

    if (!pool || !messageId || !targetState) {
        return { applied: 'skipped', reason: 'store not ready or missing args' };
    }

    let client;
    try {
        client = await pool.connect();
    } catch (err) {
        console.error('[lifecycle] transition: pool.connect failed', err.message);
        return { applied: 'skipped', reason: 'no db connection' };
    }

    try {
        await client.query('BEGIN');
        // Lock the row for the duration so concurrent transitions serialize
        // (idempotency + monotonicity must hold under parallel events).
        const sel = await client.query(
            `SELECT * FROM message_lifecycle WHERE message_id = $1 FOR UPDATE`,
            [String(messageId)]
        );
        const row = sel.rows[0] || null;

        const verdict = decideTransition(row, targetState, eventAt);

        if (verdict.applied === APPLIED.IDEMPOTENT_NOOP
            || verdict.applied === APPLIED.REJECTED_LATE
            || verdict.applied === APPLIED.REJECTED_UNKNOWN_MESSAGE) {
            await writeAudit(client, messageId, targetState, eventAt, verdict.applied, verdict.reason, source);
            await client.query('COMMIT');
            return { applied: verdict.applied, state: row ? row.state : null, reason: verdict.reason };
        }

        // ACCEPTED
        if (!row) {
            // Create the inbound_seen row. We only ever create on inbound_seen
            // (engine guarantees this; later states with no row are rejected).
            const deviceId = String(create.deviceId || 'unknown').slice(0, 64);
            const entityId = Number(create.entityId) || 0;
            const direction = create.direction === 'outbound' ? 'outbound' : 'inbound';
            const tenantId = String(create.tenantId || create.deviceId || 'unknown');
            const replyTo = create.replyToMessageId ? String(create.replyToMessageId) : null;
            await client.query(
                `INSERT INTO message_lifecycle
                    (message_id, tenant_id, device_id, entity_id, direction, reply_to_message_id,
                     state, inbound_seen_at, source)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 ON CONFLICT (message_id) DO NOTHING`,
                [String(messageId), tenantId, deviceId, entityId, direction, replyTo,
                 'inbound_seen', toTs(verdict.setValue), rowSource || 'live']
            );
        } else {
            // Forward advance on an existing row. Build a dynamic SET that only
            // touches: state, the new *_at column, skipped_states, alerted_at
            // reset, updated_at. NEVER touches a lower *_at (engine guarantees
            // setField is strictly forward) — this is the structural no-rollback.
            const sets = [`state = $2`, `${verdict.setField} = $3`, `updated_at = NOW()`];
            const params = [String(messageId), verdict.nextState, toTs(verdict.setValue)];
            // Reset alert state so the new state's timeout starts fresh (spec §9.6).
            sets.push(`alerted_at = NULL`);
            // last_error cleared on successful advance (spec §1 last_error def).
            sets.push(`last_error = NULL`);
            if (verdict.skippedStates && verdict.skippedStates.length) {
                // Read-modify-write the array within the locked txn (avoids a
                // hard dependency on array_cat and is safe under FOR UPDATE).
                const existingSkips = Array.isArray(row.skipped_states) ? row.skipped_states : [];
                const merged = Array.from(new Set([...existingSkips, ...verdict.skippedStates]));
                params.push(merged);
                sets.push(`skipped_states = $${params.length}::text[]`);
            }
            if (rowSource) {
                params.push(rowSource);
                sets.push(`source = $${params.length}`);
            }
            await client.query(
                `UPDATE message_lifecycle SET ${sets.join(', ')} WHERE message_id = $1`,
                params
            );
        }

        await writeAudit(client, messageId, targetState, eventAt, APPLIED.ACCEPTED, verdict.reason, source);
        await client.query('COMMIT');

        // Arm / cancel the deadline wheel (best-effort; outside the txn).
        await syncWheel(messageId, verdict.nextState, verdict.setValue).catch(() => {});

        return { applied: APPLIED.ACCEPTED, state: verdict.nextState, reason: verdict.reason };
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* swallow */ }
        console.error('[lifecycle] transition failed', err.message);
        return { applied: 'error', reason: err.message };
    } finally {
        client.release();
    }
}

/**
 * Arm or cancel the deadline wheel for a row that just advanced (spec §4.2).
 * user_seen is terminal → cancel. Other states → schedule next stuck deadline.
 */
async function syncWheel(messageId, state, stateAt) {
    if (!wheel || !wheel.enabled) return;
    if (state === 'user_seen') {
        await wheel.cancel(messageId);
        return;
    }
    const timeout = getStateTimeoutMs(state);
    if (!timeout) return;
    const pivot = stateAt instanceof Date ? stateAt.getTime() : Date.now();
    await wheel.schedule(messageId, pivot + timeout);
}

/**
 * Backfill resolver (spec §5) — lazy on read, per message.
 *
 * Derives inbound_seen (+ bot_acked from explicit reply link or time-proximity
 * heuristic). NEVER derives push_delivered_at or user_seen_at (constraint #2).
 *
 * @param {string} messageId
 * @param {object} opts
 * @param {function} opts.fetchInbound  async (messageId) => { device_id, entity_id, created_at, is_from_user } | null
 * @param {function} opts.findReply     async (messageId) => { created_at } | null  (explicit reply_to link)
 * @param {function} opts.findNearestOutbound  async ({device_id, entity_id, after, withinSeconds}) => { created_at } | null
 * @returns {Promise<object|null>} the materialized row, or null if not an inbound message.
 */
async function backfillLifecycle(messageId, opts = {}) {
    if (!pool || !messageId) return null;
    const { fetchInbound, findReply, findNearestOutbound } = opts;

    // Already materialized? Return it (idempotent backfill).
    const existing = await fetchRow(messageId).catch(() => null);
    if (existing) return existing;

    if (typeof fetchInbound !== 'function') return null;
    const inbound = await fetchInbound(messageId);
    if (!inbound || inbound.is_from_user === false) return null; // not an inbound user message

    // Always derivable: inbound_seen.
    await transition({
        messageId,
        targetState: 'inbound_seen',
        eventAt: inbound.created_at,
        source: 'backfill',
        rowSource: 'backfill',
        create: {
            deviceId: inbound.device_id,
            entityId: inbound.entity_id,
            tenantId: inbound.device_id,
            direction: 'inbound',
        },
    });

    // Try bot_acked from explicit reply link first (high confidence).
    let reply = null;
    if (typeof findReply === 'function') {
        reply = await findReply(messageId).catch(() => null);
    }
    if (reply && reply.created_at) {
        await transition({
            messageId,
            targetState: 'bot_acked',
            eventAt: reply.created_at,
            source: 'backfill',
            rowSource: 'backfill+link',
        });
    } else if (typeof findNearestOutbound === 'function') {
        // Heuristic fallback: nearest outbound within 5min (spec §5.2 / §9.5).
        const candidate = await findNearestOutbound({
            device_id: inbound.device_id,
            entity_id: inbound.entity_id,
            after: inbound.created_at,
            withinSeconds: 300,
        }).catch(() => null);
        if (candidate && candidate.created_at) {
            await transition({
                messageId,
                targetState: 'bot_acked',
                eventAt: candidate.created_at,
                source: 'backfill',
                rowSource: 'backfill+heuristic',
            });
            // Flag heuristic-derived rows (spec §5.4) — non-null last_error.
            await pool.query(
                `UPDATE message_lifecycle
                    SET last_error = $2
                  WHERE message_id = $1 AND source = 'backfill+heuristic'`,
                [String(messageId),
                 'derived from time-proximity heuristic; not a confirmed reply']
            ).catch(() => {});
        }
    }

    // push_delivered_at and user_seen_at are NEVER derived (spec §5.1 + §11 #2).
    return fetchRow(messageId);
}

/** Record a dual-write divergence (spec §6.5 / §9.10). Best-effort. */
async function recordDivergence({ messageId, deviceId, entityId, legacyCounter, direction = 'legacy_skipped', reason }) {
    if (!pool || !legacyCounter) return;
    try {
        await pool.query(
            `INSERT INTO lifecycle_divergence_log
                (message_id, device_id, entity_id, legacy_counter, direction, reason)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [messageId ? String(messageId) : null,
             deviceId ? String(deviceId).slice(0, 64) : null,
             entityId != null ? Number(entityId) : null,
             String(legacyCounter), String(direction), reason ? String(reason).slice(0, 500) : null]
        );
    } catch (err) {
        console.error('[lifecycle] recordDivergence failed', err.message);
    }
}

/**
 * Divergence summary for the Phase 3 cutover gate (spec §6.5). Compares new
 * alert volume vs legacy alert volume over a window and flags >±10% drift.
 *
 * @param {object} opts
 * @param {number} [opts.windowHours=168]  parallel-run window (default 7d)
 * @param {number} [opts.newAlertVolume]   count of new (lifecycle) stuck alerts in window
 * @param {number} [opts.legacyAlertVolume] sum of legacy counter increments in window
 */
async function divergenceSummary(opts = {}) {
    const windowHours = Number(opts.windowHours) || 168;
    let skippedCount = 0;
    if (pool) {
        const r = await pool.query(
            `SELECT COUNT(*)::int AS n FROM lifecycle_divergence_log
              WHERE occurred_at > NOW() - ($1 || ' hours')::interval`,
            [String(windowHours)]
        ).catch(() => ({ rows: [{ n: 0 }] }));
        skippedCount = r.rows[0] ? r.rows[0].n : 0;
    }
    const newVol = Number(opts.newAlertVolume);
    const legacyVol = Number(opts.legacyAlertVolume);
    let ratio = null;
    let withinGate = null;
    if (Number.isFinite(newVol) && Number.isFinite(legacyVol) && legacyVol > 0) {
        ratio = newVol / legacyVol;
        withinGate = ratio >= 0.9 && ratio <= 1.1; // ±10% gate (spec §6.5)
    }
    return { windowHours, divergenceEvents: skippedCount, ratio, withinGate };
}

async function getLifecycle(messageId) {
    return fetchRow(messageId);
}

async function getEventLog(messageId, limit = 20) {
    if (!pool || !messageId) return [];
    const r = await pool.query(
        `SELECT message_id, attempted_state, event_at, transition_at, applied, reason, source
           FROM lifecycle_event_log
          WHERE message_id = $1
          ORDER BY transition_at DESC, id DESC
          LIMIT $2`,
        [String(messageId), Math.min(Number(limit) || 20, 100)]
    );
    return r.rows;
}

function toTs(v) {
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'number') return new Date(v).toISOString();
    if (typeof v === 'string') return v;
    return new Date().toISOString();
}

module.exports = {
    setPool,
    setWheel,
    initTable,
    transition,
    backfillLifecycle,
    recordDivergence,
    divergenceSummary,
    getLifecycle,
    getEventLog,
    getStateTimeoutMs,
    STATE_TIMEOUTS_MS,
    // exposed for tests / wiring
    syncWheel,
    fetchRow,
};
