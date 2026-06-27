// ============================================
// Entity Status Module
// Per-entity cumulative error counters + operation log + quote payload,
// surfaced in the avatar status drawer.
// Auth: same shape as /api/entities — deviceId+deviceSecret OR deviceId+botSecret
// (cross-entity observation per Hank 2026-06-06 19:55 TW directive).
//
// Endpoints (card_dbe18b333ac98076cc213055):
//   GET  /api/entity-status/:eId           → { counters }
//   GET  /api/entity-status/:eId/log       → { items: [...], nextCursor }
//   POST /api/entity-status/:eId/quote     → { quote: {...} } for chat-textbox inject
// ============================================

const express = require('express');
const safeEqual = require('./safe-equal');
const extractCreds = require('./extract-creds');
const { entityGitEmail } = require('./scripts/entity-git-author');

const CANONICAL_AXES = [
    'chat_no_reply',
    'a2a_no_reply',
    'kanban_nudge_no_reply',
    'system_msg_no_reply',
];

// card_8ca0b6acb1fb3d7a0b650dfd — Achievement axes (Hank 2026-06-10 09:04 TW).
// 3 Hank-flagged (tasks_done / chat_upvotes / chat_downvotes) + 3 self-added
// (prs_merged / cards_reviewed / notes_authored). Same regex/whitelist
// hardening pattern as CANONICAL_AXES per card_f20e3635 fix.
const CANONICAL_ACHIEVEMENTS = [
    'tasks_done',
    'chat_upvotes',
    'chat_downvotes',
    'prs_merged',
    'cards_reviewed',
    'notes_authored',
];

// card_errctr: hard upper bound on retained error-event history rows per
// (device, entity). pruneErrorEventsFor() trims to the newest N after each
// append, so the 歷史紀錄 timeline is reviewable but never unbounded.
const ERROR_EVENT_CAP = 1000;

let pool = null;
let devicesRef = null;
// MessageLifecycle dual-write (spec §7, card_1b1c1322). Lazily required to
// avoid a require cycle at module-load. Every legacy counter site below ALSO
// calls into this so the new state machine runs in parallel. Lifecycle writes
// are best-effort: a failure here NEVER blocks the legacy counter path (legacy
// stays authoritative for reads during parallel run).
let _lifecycle = null;
function lifecycle() {
    if (_lifecycle === null) {
        try { _lifecycle = require('./lib/message-lifecycle'); }
        catch (_) { _lifecycle = false; }
    }
    return _lifecycle || null;
}
// Synthesize a stable lifecycle message_id from the legacy tracking tuple when
// the real chat message_id is not threaded through this path. Deterministic so
// trackOutbound + markReplyReceived + the sweeper converge on the SAME row.
function synthMessageId(deviceId, recipientEntityId, axis, dispatchedAtMs) {
    // Round dispatched time to the second so the inbound + its bot_acked +
    // its stuck-tick all resolve to one lifecycle row.
    const bucket = Math.floor((dispatchedAtMs || Date.now()) / 1000);
    return `lc:${deviceId}:${recipientEntityId}:${axis}:${bucket}`;
}
// Shared with index.js so we verify cookies against the same secret. Set via
// bindJwtSecret() at bootstrap. Falling back to process.env.JWT_SECRET works
// only when that env var is present (i.e. when the secret survives restarts);
// without the explicit handoff, index.js may generate a per-process random
// fallback that this module would never match.
let jwtSecret = null;

function initTable(chatPool) {
    pool = chatPool;
    return pool.query(`
        CREATE TABLE IF NOT EXISTS entity_error_counters (
            id BIGSERIAL PRIMARY KEY,
            device_id VARCHAR(64) NOT NULL,
            entity_id INT NOT NULL,
            axis VARCHAR(64) NOT NULL,
            count INT NOT NULL DEFAULT 0,
            last_event_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE(device_id, entity_id, axis)
        );
        CREATE INDEX IF NOT EXISTS idx_eec_lookup
            ON entity_error_counters(device_id, entity_id);

        -- card_errctr (current-vs-historical split, owner P0 2026-06-27):
        -- \`count\` is REDEFINED as the resettable "current cumulative" (當下累計).
        -- \`historical_count\` is the all-time monotonic total (歷史累計) that the
        -- reset path NEVER touches; \`current_reset_at\` records when \`count\` was
        -- last cleared so the UI can show "since <time>". Both are additive
        -- (ADD COLUMN IF NOT EXISTS = metadata-only, no table rewrite on PG11+).
        ALTER TABLE entity_error_counters
            ADD COLUMN IF NOT EXISTS historical_count INT NOT NULL DEFAULT 0;
        ALTER TABLE entity_error_counters
            ADD COLUMN IF NOT EXISTS current_reset_at TIMESTAMPTZ;
        -- One-time, invariant-preserving backfill: existing \`count\` rows were
        -- never resettable before this change, so count == all-time total today.
        -- Seed historical_count from count, but ONLY when historical is behind
        -- (historical_count < count). This fires exactly once (just-migrated rows
        -- start at historical_count=0) and is a SAFE no-op on every later boot —
        -- after a real reset count=0 <= historical so the WHERE never matches and
        -- the historical total is preserved.
        UPDATE entity_error_counters
            SET historical_count = count
          WHERE historical_count < count;

        CREATE TABLE IF NOT EXISTS entity_operation_log (
            id BIGSERIAL PRIMARY KEY,
            device_id VARCHAR(64) NOT NULL,
            entity_id INT NOT NULL,
            event_type VARCHAR(64) NOT NULL,
            event_summary TEXT NOT NULL,
            event_payload JSONB DEFAULT '{}'::jsonb,
            occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_eol_lookup
            ON entity_operation_log(device_id, entity_id, occurred_at DESC);
        CREATE INDEX IF NOT EXISTS idx_eol_event_type
            ON entity_operation_log(device_id, entity_id, event_type, occurred_at DESC);

        -- card_errctr: 歷史紀錄 / error-event history. Every counter tick (silent
        -- recipient swept past its grace window, or a direct push-failure) appends
        -- ONE row here so the timeline survives a current-counter reset and stays
        -- reviewable. Bounded per (device, entity) by pruneErrorEventsFor() — kept
        -- to ERROR_EVENT_CAP newest rows — so it can never grow without limit.
        CREATE TABLE IF NOT EXISTS entity_error_events (
            id BIGSERIAL PRIMARY KEY,
            device_id VARCHAR(64) NOT NULL,
            entity_id INT NOT NULL,
            axis VARCHAR(64) NOT NULL,
            event_type VARCHAR(64),
            sender_entity_id INT,
            payload_snippet TEXT,
            occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_eee_lookup
            ON entity_error_events(device_id, entity_id, id DESC);
        CREATE INDEX IF NOT EXISTS idx_eee_axis
            ON entity_error_events(device_id, entity_id, axis, id DESC);

        CREATE TABLE IF NOT EXISTS outbound_msg_pending (
            id BIGSERIAL PRIMARY KEY,
            device_id VARCHAR(64) NOT NULL,
            sender_entity_id INT NOT NULL,
            recipient_entity_id INT NOT NULL,
            event_type VARCHAR(64) NOT NULL,
            axis VARCHAR(64) NOT NULL,
            dispatched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            expires_at TIMESTAMPTZ NOT NULL,
            payload_snippet TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_omp_expires_at
            ON outbound_msg_pending(expires_at);
        CREATE INDEX IF NOT EXISTS idx_omp_match
            ON outbound_msg_pending(device_id, sender_entity_id, recipient_entity_id, axis);
    `);
}

// Axis selection mirrors the buckets the drawer surfaces; pushToBot eventType
// → which counter ticks when the recipient stays silent. Keep these in sync
// with the legacy push-failure hook in backend/index.js — both should agree on
// which axis a given eventType belongs to.
function axisForEventType(eventType) {
    if (eventType === 'cross_device_message'
        || eventType === 'entity_message'
        || eventType === 'entity_broadcast') return 'a2a_no_reply';
    if (eventType === 'system_message'
        || eventType === 'model_healthcheck'
        || eventType === 'kanban_nudge') return 'system_msg_no_reply';
    return 'chat_no_reply';
}

// Per-axis grace window before a pending row counts as unanswered. Tuned to
// the rough p99 reply latency for each channel — chat users expect quick
// turnaround; bot-to-bot routing through transform takes longer; system
// probes are async by design.
function expiryMsForAxis(axis) {
    if (axis === 'chat_no_reply') return 90 * 1000;          // 90s
    if (axis === 'a2a_no_reply') return 5 * 60 * 1000;       // 5 min
    if (axis === 'system_msg_no_reply') return 10 * 60 * 1000; // 10 min
    return 5 * 60 * 1000;
}

// Track an outbound message that succeeded at the push layer (HTTP 200). The
// recipient still owes a reply within the axis-specific grace window; if it
// arrives we delete the row (markReplyReceived), otherwise the sweeper ticks
// the counter. Fire-and-forget — never await on the hot push path.
async function trackOutbound(deviceId, senderEntityId, recipientEntityId, eventType, payloadSnippet) {
    if (!pool || deviceId == null || recipientEntityId == null) return;
    const axis = axisForEventType(eventType);
    const expiryMs = expiryMsForAxis(axis);
    try {
        await pool.query(
            `INSERT INTO outbound_msg_pending
                (device_id, sender_entity_id, recipient_entity_id, event_type, axis, expires_at, payload_snippet)
             VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' milliseconds')::interval, $7)`,
            [
                String(deviceId).slice(0, 64),
                Number(senderEntityId) || 0,
                Number(recipientEntityId),
                String(eventType || 'other').slice(0, 64),
                axis,
                String(expiryMs),
                payloadSnippet ? String(payloadSnippet).slice(0, 240) : null,
            ]
        );
    } catch (err) {
        console.error('[EntityStatus] trackOutbound error:', err.message);
    }

    // Dual-write (spec §7): a message was routed to recipientEntityId who now
    // owes a reply — that is the inbound_seen of the recipient's lifecycle. We
    // only dual-write the chat axis (chat_no_reply replacement, spec §6.5); the
    // a2a / system axes get their own lifecycle direction in a later phase.
    if (axis === 'chat_no_reply') {
        const lc = lifecycle();
        if (lc) {
            const messageId = synthMessageId(deviceId, recipientEntityId, axis, Date.now());
            Promise.resolve(lc.transition({
                messageId,
                targetState: 'inbound_seen',
                eventAt: new Date(),
                source: 'trackOutbound',
                create: {
                    deviceId,
                    entityId: Number(recipientEntityId),
                    tenantId: String(deviceId),
                    direction: 'inbound',
                },
            })).catch(err => console.error('[lifecycle] trackOutbound dual-write failed:', err.message));
        }
    }
}

// Called when an incoming transform/speak from `senderEntityId` arrives. Match
// the oldest pending row where the recipient (the bot that owed us a reply)
// matches our incoming sender. Delete it so the sweeper doesn't tick.
//
// Heuristic: match by (device, recipient = incoming sender). Optional eventType
// filter for same-channel matching; pass null to match any pending row.
async function markReplyReceived(deviceId, replyFromEntityId, eventType) {
    if (!pool || deviceId == null || replyFromEntityId == null) return 0;
    try {
        const params = [deviceId, Number(replyFromEntityId)];
        let extra = '';
        if (eventType) {
            params.push(axisForEventType(eventType));
            extra = `AND axis = $${params.length}`;
        }
        const result = await pool.query(
            `DELETE FROM outbound_msg_pending
              WHERE id IN (
                SELECT id FROM outbound_msg_pending
                 WHERE device_id = $1
                   AND recipient_entity_id = $2
                   ${extra}
                 ORDER BY dispatched_at ASC
                 LIMIT 1
              )
              RETURNING recipient_entity_id, axis, dispatched_at`,
            params
        );

        // Dual-write (spec §7): the recipient produced a reply → bot_acked for
        // the inbound it answered. Reconstruct the same synthesized message_id
        // trackOutbound used so the transition lands on the right row. Only the
        // chat axis is dual-written (chat_no_reply replacement, spec §6.5).
        const matched = result.rows && result.rows[0];
        if (matched && matched.axis === 'chat_no_reply') {
            const lc = lifecycle();
            if (lc) {
                const dispatchedMs = matched.dispatched_at
                    ? new Date(matched.dispatched_at).getTime() : Date.now();
                const messageId = synthMessageId(deviceId, matched.recipient_entity_id, matched.axis, dispatchedMs);
                Promise.resolve(lc.transition({
                    messageId,
                    targetState: 'bot_acked',
                    eventAt: new Date(),
                    source: 'markReplyReceived',
                })).catch(err => console.error('[lifecycle] markReplyReceived dual-write failed:', err.message));
            }
        }
        return result.rowCount || 0;
    } catch (err) {
        console.error('[EntityStatus] markReplyReceived error:', err.message);
        return 0;
    }
}

// Sweeper: pick up every row whose expires_at has passed, tick the matching
// counter, and remove the row. Runs once per minute on a setInterval registered
// at bootstrap. Idempotent — the COUNT increment uses UPSERT, the DELETE
// targets the exact ids we just promoted, so a duplicate run is a no-op.
async function sweepExpired() {
    if (!pool) return { tickedCount: 0 };
    try {
        const expired = await pool.query(
            `SELECT id, device_id, recipient_entity_id, axis,
                    event_type, sender_entity_id, payload_snippet
               FROM outbound_msg_pending
              WHERE expires_at <= NOW()
              LIMIT 500`
        );
        if (!expired.rows.length) return { tickedCount: 0 };
        for (const row of expired.rows) {
            try {
                // card_errctr: bump BOTH the resettable current total and the
                // never-reset historical total in one upsert.
                await pool.query(`
                    INSERT INTO entity_error_counters (device_id, entity_id, axis, count, historical_count, last_event_at)
                    VALUES ($1, $2, $3, 1, 1, NOW())
                    ON CONFLICT (device_id, entity_id, axis) DO UPDATE
                    SET count = entity_error_counters.count + 1,
                        historical_count = entity_error_counters.historical_count + 1,
                        last_event_at = NOW(),
                        updated_at = NOW()
                `, [row.device_id, row.recipient_entity_id, row.axis]);

                // card_errctr: this expiry IS an error event (recipient stayed
                // silent past its grace window) — append it to the reviewable
                // 歷史紀錄 timeline with the pending row's full context.
                await recordErrorEvent(row.device_id, row.recipient_entity_id, row.axis, {
                    eventType: row.event_type || 'no_reply',
                    senderEntityId: row.sender_entity_id,
                    payloadSnippet: row.payload_snippet,
                });

                // Dual-write divergence guard (spec §6.5 / §9.10): the legacy
                // chat_no_reply counter just ticked because the bot stayed
                // silent past its grace window. The matching lifecycle row
                // should still be at inbound_seen (never advanced to bot_acked).
                // If there is NO lifecycle row at all, dual-write was skipped on
                // the inbound path — record a divergence so the Phase 3 cutover
                // gate surfaces it rather than silently passing.
                if (row.axis === 'chat_no_reply') {
                    const lc = lifecycle();
                    if (lc) {
                        Promise.resolve((async () => {
                            // We cannot reconstruct the exact dispatched-second
                            // bucket here (the pending row is being deleted), so
                            // we check for ANY recent inbound_seen lifecycle row
                            // for this (device, entity) that is still stuck.
                            const probe = await pool.query(
                                `SELECT message_id FROM message_lifecycle
                                  WHERE device_id = $1 AND entity_id = $2
                                    AND state = 'inbound_seen'
                                    AND inbound_seen_at > NOW() - INTERVAL '1 hour'
                                  LIMIT 1`,
                                [row.device_id, row.recipient_entity_id]
                            ).catch(() => ({ rows: [] }));
                            if (!probe.rows.length) {
                                await lc.recordDivergence({
                                    deviceId: row.device_id,
                                    entityId: row.recipient_entity_id,
                                    legacyCounter: 'chat_no_reply',
                                    direction: 'lifecycle_skipped',
                                    reason: 'legacy counter ticked but no stuck inbound_seen lifecycle row found',
                                });
                            }
                        })()).catch(() => {});
                    }
                }
            } catch (err) {
                console.error('[EntityStatus] sweepExpired upsert error:', err.message);
            }
        }
        const ids = expired.rows.map(r => r.id);
        await pool.query(
            `DELETE FROM outbound_msg_pending WHERE id = ANY($1::bigint[])`,
            [ids]
        );
        return { tickedCount: ids.length };
    } catch (err) {
        console.error('[EntityStatus] sweepExpired error:', err.message);
        return { tickedCount: 0 };
    }
}

// Bootstrap the sweeper so the production process ticks counters without
// needing an external cron. Returns the interval handle for tests that want
// to stop it. Single-instance only — if multiple replicas come up, dedup later
// with a row-level lock; today we run single-replica on Railway.
function startSweeper(intervalMs) {
    const ms = Math.max(15000, parseInt(intervalMs) || 60000);
    return setInterval(() => {
        sweepExpired().catch(err => {
            console.error('[EntityStatus] sweep tick error:', err.message);
        });
    }, ms);
}

// Best-effort fire-and-forget insert into entity_operation_log. Callers should
// NOT await this on the request hot path — every kanban/chat/dashboard write
// would slow down by a synchronous DB round-trip otherwise.
async function logOperation(deviceId, entityId, eventType, eventSummary, eventPayload) {
    if (!pool || deviceId == null || entityId == null) return;
    try {
        await pool.query(
            `INSERT INTO entity_operation_log
                (device_id, entity_id, event_type, event_summary, event_payload)
             VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [
                String(deviceId).slice(0, 64),
                Number(entityId),
                String(eventType || 'other').slice(0, 64),
                String(eventSummary || '').slice(0, 2048),
                JSON.stringify(eventPayload || {}),
            ]
        );
    } catch (err) {
        console.error('[EntityStatus] logOperation error:', err.message);
    }
}

async function getOperationLog(deviceId, entityId, opts) {
    if (!pool) return { items: [], nextCursor: null };
    opts = opts || {};
    const limit = Math.min(Math.max(parseInt(opts.limit) || 20, 1), 100);
    const beforeId = parseInt(opts.beforeId) || null;
    const params = [deviceId, entityId];
    let cursorClause = '';
    if (beforeId) {
        params.push(beforeId);
        cursorClause = `AND id < $${params.length}`;
    }
    params.push(limit);
    const result = await pool.query(
        `SELECT id, event_type, event_summary, event_payload, occurred_at
           FROM entity_operation_log
          WHERE device_id = $1 AND entity_id = $2
          ${cursorClause}
          ORDER BY id DESC
          LIMIT $${params.length}`,
        params
    );
    const items = result.rows.map(r => ({
        id: String(r.id),
        eventType: r.event_type,
        eventSummary: r.event_summary,
        eventPayload: r.event_payload || {},
        occurredAt: r.occurred_at ? r.occurred_at.toISOString() : null,
    }));
    return {
        items,
        nextCursor: items.length === limit ? items[items.length - 1].id : null,
    };
}

async function getLogRowById(deviceId, entityId, logId) {
    if (!pool) return null;
    const result = await pool.query(
        `SELECT id, event_type, event_summary, event_payload, occurred_at
           FROM entity_operation_log
          WHERE device_id = $1 AND entity_id = $2 AND id = $3`,
        [deviceId, entityId, logId]
    );
    if (!result.rows.length) return null;
    const r = result.rows[0];
    return {
        id: String(r.id),
        eventType: r.event_type,
        eventSummary: r.event_summary,
        eventPayload: r.event_payload || {},
        occurredAt: r.occurred_at ? r.occurred_at.toISOString() : null,
    };
}

function bindDevicesRef(devices) {
    devicesRef = devices;
}

// Share the same JWT signing secret that index.js issues cookies with so
// authDeviceOrBot can fall back to cookie auth for portal sessions. Without
// this handoff, the env-only fallback fails whenever process.env.JWT_SECRET
// is unset (each process generates its own random secret).
function bindJwtSecret(secret) {
    jwtSecret = secret || null;
}

async function getCounters(deviceId, entityId) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT axis, count, historical_count, last_event_at, current_reset_at
           FROM entity_error_counters
          WHERE device_id = $1 AND entity_id = $2`,
        [deviceId, entityId]
    );
    // Currently-open events per axis: rows still sitting in outbound_msg_pending
    // for this entity-as-recipient. These are the events the panel's drill-down
    // will surface. `count` is the resettable 當下累計 / current cumulative,
    // `historicalCount` the never-reset 歷史累計 / historical cumulative, and
    // `openCount` is the live health number that drops as the entity replies.
    const openRows = await pool.query(
        `SELECT axis, COUNT(*)::int AS open_count
           FROM outbound_msg_pending
          WHERE device_id = $1 AND recipient_entity_id = $2
          GROUP BY axis`,
        [deviceId, entityId]
    );
    const openByAxis = new Map(openRows.rows.map(r => [r.axis, Number(r.open_count)]));
    const byAxis = new Map(result.rows.map(r => [r.axis, r]));
    // historical_count is additive (added after the table shipped) — fall back
    // to count when the column is absent/null so a pre-migration row never
    // surfaces a historical total BELOW its current total.
    const histOf = (row) => {
        if (!row) return 0;
        const h = row.historical_count;
        return (h == null) ? Number(row.count) || 0 : Number(h);
    };
    const resetOf = (row) => (row && row.current_reset_at)
        ? new Date(row.current_reset_at).toISOString() : null;
    // Always surface canonical axes even when count = 0, so the UI can render
    // a stable row order. Extra non-canonical axes (forward-compat) appear after.
    const ordered = [];
    for (const axis of CANONICAL_AXES) {
        const row = byAxis.get(axis);
        ordered.push({
            axis,
            count: row ? Number(row.count) : 0,
            historicalCount: histOf(row),
            openCount: openByAxis.get(axis) || 0,
            lastEventAt: row && row.last_event_at ? new Date(row.last_event_at).toISOString() : null,
            currentResetAt: resetOf(row),
        });
        byAxis.delete(axis);
        openByAxis.delete(axis);
    }
    for (const [axis, row] of byAxis) {
        ordered.push({
            axis,
            count: Number(row.count),
            historicalCount: histOf(row),
            openCount: openByAxis.get(axis) || 0,
            lastEventAt: row.last_event_at ? new Date(row.last_event_at).toISOString() : null,
            currentResetAt: resetOf(row),
        });
        openByAxis.delete(axis);
    }
    // Axes with open pending but no cumulative row yet (fresh counter — sweeper
    // hasn't fired since first dispatch). Surface them so the drill-down lists
    // line up even before the cumulative row is created.
    for (const [axis, openCount] of openByAxis) {
        ordered.push({ axis, count: 0, historicalCount: 0, openCount, lastEventAt: null, currentResetAt: null });
    }
    return ordered;
}

// Drill-down: list of currently-open pending events for a single axis.
// Each row carries enough to render a (timestamp, chip) on the panel —
// the chip is either a card chip (event_payload.card_id) or a chat-coord
// chip from message_id. Newest first. Limited to keep the panel snappy.
async function getCounterEvents(deviceId, entityId, axis, limit) {
    if (!pool) return [];
    const lim = Math.max(1, Math.min(100, Number(limit) || 30));
    const result = await pool.query(
        `SELECT id, sender_entity_id, event_type, axis, dispatched_at, expires_at, payload_snippet
           FROM outbound_msg_pending
          WHERE device_id = $1 AND recipient_entity_id = $2 AND axis = $3
          ORDER BY dispatched_at DESC
          LIMIT $4`,
        [deviceId, entityId, axis, lim]
    );
    return result.rows.map(r => ({
        id: String(r.id),
        senderEntityId: r.sender_entity_id,
        eventType: r.event_type,
        axis: r.axis,
        dispatchedAt: r.dispatched_at ? r.dispatched_at.toISOString() : null,
        expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
        payload: r.payload_snippet,
    }));
}

// ────────────────────────────────────────────────────────────────────────────
// Achievements — card_8ca0b6acb1fb3d7a0b650dfd
// Mirrors the counter pattern but cumulative-only (no openCount). Each axis
// aggregates a different domain table. Backend slice only; frontend rendering
// + i18n keys ship in a follow-up PR.
// ────────────────────────────────────────────────────────────────────────────

// GitHub PR URL → canonical dedupe key. Same PR number in different repos must
// not collapse, so the key is `owner/repo#N` (lowercased). Returns distinct keys
// found in a free-text comment body. card_13405b3448d89931665c1670.
const PR_URL_RE = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/gi;
function extractPrKeys(text) {
    const keys = new Set();
    let m;
    PR_URL_RE.lastIndex = 0;
    while ((m = PR_URL_RE.exec(String(text || ''))) !== null) {
        keys.add(`${m[1].toLowerCase()}/${m[2].toLowerCase()}#${m[3]}`);
    }
    return Array.from(keys);
}

// rework_pr_number is VARCHAR — may hold a bare number ("123"), "#123", or a
// full PR URL. Normalize to the same key space as extractPrKeys so UNION dedups.
function normalizePrKey(raw) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const fromUrl = extractPrKeys(s);
    if (fromUrl.length) return fromUrl[0];
    const num = s.match(/\d+/);
    return num ? `#${num[0]}` : null;
}

// Per-entity git author identity → prs_merged author-source (Tier 1).
// Spec: docs/specs/per-entity-git-author-spec.md (§6). The author-source counts
// distinct PRs whose commits are authored/co-authored by entity-<N>@bots.eclaw,
// UNION'd + deduped with the kanban-evidence path. Production wires this to a
// read-only GitHub query using the EXISTING GITHUB_TOKEN; tests inject a mock.
// Default is null (no author-source) so DB-only environments degrade silently to
// the evidence path. Set via setPrAuthorSource().
let _prAuthorSource = null;

// resolver: async (entityEmail, { deviceId, entityId }) => Array<{ prKey?, owner?, repo?, number?, lastEventAt? }>
// Each item must yield a normalized `owner/repo#N` (or `#N`) key — same key space
// as extractPrKeys/normalizePrKey so cross-source duplicates collapse.
function setPrAuthorSource(resolver) {
    _prAuthorSource = (typeof resolver === 'function') ? resolver : null;
}

// Best-effort: never throws. Returns [] on ANY failure (no resolver injected,
// GITHUB_TOKEN absent, GH unreachable/non-200, malformed payload, exception).
// Items are normalized to { key, lastEventAt }.
async function fetchAuthoredPrKeys(deviceId, entityId) {
    if (!_prAuthorSource) return [];
    try {
        const email = entityGitEmail(entityId);
        if (!email) return [];
        const raw = await _prAuthorSource(email, { deviceId, entityId: Number(entityId) });
        if (!Array.isArray(raw)) return [];
        const out = [];
        for (const item of raw) {
            if (!item) continue;
            let key = null;
            if (item.prKey) {
                key = String(item.prKey).toLowerCase();
            } else if (item.owner && item.repo && item.number != null) {
                key = `${String(item.owner).toLowerCase()}/${String(item.repo).toLowerCase()}#${item.number}`;
            } else if (item.number != null) {
                key = normalizePrKey(item.number);
            }
            if (key) out.push({ key, lastEventAt: item.lastEventAt || null });
        }
        return out;
    } catch (err) {
        // Graceful degrade — author-source contributes nothing, evidence path stands.
        console.warn('[Achievements] prs_merged author-source failed (degrading to evidence path):',
            err && err.message);
        return [];
    }
}

async function getAchievements(deviceId, entityId) {
    if (!pool) return [];
    const eid = Number(entityId);
    if (!Number.isFinite(eid) || eid < 0) return [];

    const results = await Promise.all(CANONICAL_ACHIEVEMENTS.map(async (axis) => {
        let count = 0;
        let lastEventAt = null;
        try {
            if (axis === 'tasks_done') {
                // assigned_bots is JSONB (not int[]) — `= ANY()` throws and the
                // per-axis catch silently zeroed this axis. jsonb containment
                // ('[2,6]' @> '2') is the correct predicate. Found via prod
                // probe: board had 215 done cards for #2, API said 0.
                const r = await pool.query(
                    `SELECT COUNT(*)::int AS c, MAX(updated_at) AS ts
                       FROM kanban_cards
                      WHERE device_id = $1 AND status = 'done'
                        AND assigned_bots @> to_jsonb($2::int)`,
                    [deviceId, eid]
                );
                count = Number(r.rows[0]?.c || 0);
                lastEventAt = r.rows[0]?.ts || null;
            } else if (axis === 'chat_upvotes' || axis === 'chat_downvotes') {
                const col = axis === 'chat_upvotes' ? 'like_count' : 'dislike_count';
                const r = await pool.query(
                    `SELECT COALESCE(SUM(${col}), 0)::int AS c, MAX(created_at) AS ts
                       FROM chat_messages
                      WHERE device_id = $1 AND entity_id = $2 AND is_from_bot = true
                        AND ${col} > 0`,
                    [deviceId, eid]
                );
                count = Number(r.rows[0]?.c || 0);
                lastEventAt = r.rows[0]?.ts || null;
            } else if (axis === 'cards_reviewed') {
                // Q1 default per Hank's spec: count all reviewer participation
                // (signed-off + bounced both count).
                const r = await pool.query(
                    `SELECT COUNT(*)::int AS c, MAX(updated_at) AS ts
                       FROM kanban_cards
                      WHERE device_id = $1 AND reviewer_entity_id = $2
                        AND status IN ('in_progress','done')`,
                    [deviceId, eid]
                );
                count = Number(r.rows[0]?.c || 0);
                lastEventAt = r.rows[0]?.ts || null;
            } else if (axis === 'notes_authored') {
                // Notes do NOT live in the legacy `mission_notes` table — that
                // table is never written to (no INSERT/UPDATE/CREATE anywhere in
                // the backend). The real source is the `notes` JSONB column on
                // mission_dashboard, where GET /api/mission/notes, /note/add and
                // friends read/write. Per-entity attribution is the JSON field
                // `createdBy = 'entity_<N>'` (set in mission.js note/add etc.).
                // Prior queries (against mission_notes.entity_id then
                // mission_notes.created_by) both hit a table with 0 rows and
                // returned 0 — the disconnect Hank saw: GET /api/mission/notes
                // shows the device's notes but achievements said 0.
                // We expand the JSONB array and count this entity's notes.
                // createdAt is a JS epoch-ms number in the JSON; convert for ts.
                const r = await pool.query(
                    `SELECT COUNT(*)::int AS c,
                            MAX((n->>'createdAt')::bigint) AS ts_ms
                       FROM mission_dashboard md
                       CROSS JOIN LATERAL jsonb_array_elements(
                            COALESCE(md.notes, '[]'::jsonb)) AS n
                      WHERE md.device_id = $1
                        AND n->>'createdBy' = $2`,
                    [deviceId, `entity_${eid}`]
                );
                count = Number(r.rows[0]?.c || 0);
                const tsMs = r.rows[0]?.ts_ms;
                lastEventAt = tsMs != null ? new Date(Number(tsMs)) : null;
            } else if (axis === 'prs_merged') {
                // v2 (card_13405b3448d89931665c1670): the only on-device PR
                // signal is GitHub PR URLs that bots paste into kanban evidence
                // comments. Pull this entity's comments that reference a PR URL,
                // regex-extract + dedupe PR numbers in JS, then UNION any
                // rework_pr_number on cards this entity owns/reviews.
                const seen = new Set();
                let last = null;
                const noteLast = (ts) => {
                    if (ts && (!last || new Date(ts) > new Date(last))) last = ts;
                };
                // 1) PR URLs in this entity's evidence comments.
                const cm = await pool.query(
                    `SELECT text, created_at
                       FROM kanban_comments
                      WHERE device_id = $1 AND from_entity_id = $2
                        AND text ~* 'github\\.com/[^/[:space:]]+/[^/[:space:]]+/pull/[0-9]+'`,
                    [deviceId, eid]
                );
                // Prefer comments that also signal a merge; fall back to ALL
                // referenced PRs if the merge-signalled set is empty (never show
                // 0 when PRs are clearly referenced — that was the bug).
                const mergeRe = /merg|squash|✅|rebased/i;
                const collect = (preferMerged) => {
                    for (const row of cm.rows) {
                        const text = String(row.text || '');
                        if (preferMerged && !mergeRe.test(text)) continue;
                        const nums = extractPrKeys(text);
                        if (!nums.length) continue;
                        for (const k of nums) seen.add(k);
                        noteLast(row.created_at);
                    }
                };
                collect(true);
                if (seen.size === 0) { last = null; collect(false); }
                // 2) UNION rework_pr_number on cards assigned to / reviewed by
                //    this entity (a non-null rework PR is a merged-PR artifact).
                const rw = await pool.query(
                    `SELECT rework_pr_number AS pr, updated_at
                       FROM kanban_cards
                      WHERE device_id = $1
                        AND rework_pr_number IS NOT NULL
                        AND (assigned_bots @> to_jsonb($2::int) OR reviewer_entity_id = $2)`,
                    [deviceId, eid]
                );
                for (const row of rw.rows) {
                    const k = normalizePrKey(row.pr);
                    if (k) { seen.add(k); noteLast(row.updated_at); }
                }
                // 3) Author-source (Tier 1, spec §6): distinct PRs authored/co-
                //    authored by entity-<N>@bots.eclaw. Best-effort — degrades to
                //    [] on any failure, so the evidence path above always stands.
                const authored = await fetchAuthoredPrKeys(deviceId, eid);
                for (const a of authored) {
                    seen.add(a.key);
                    noteLast(a.lastEventAt);
                }
                count = seen.size;
                lastEventAt = last;
            }
        } catch (err) {
            // Per-axis failure isolated: log + treat as 0 so one missing
            // table (e.g. mission_notes on a fresh device) doesn't abort all axes.
            console.warn(`[Achievements] axis=${axis} query failed:`, err && err.message);
        }
        return {
            axis,
            count,
            lastEventAt: lastEventAt ? new Date(lastEventAt).toISOString() : null,
        };
    }));
    return results;
}

async function getAchievementEvents(deviceId, entityId, axis, limit) {
    if (!pool) return [];
    if (!CANONICAL_ACHIEVEMENTS.includes(axis)) return [];
    const lim = Math.max(1, Math.min(100, Number(limit) || 30));
    const eid = Number(entityId);

    try {
        if (axis === 'tasks_done') {
            const r = await pool.query(
                `SELECT id, title, updated_at
                   FROM kanban_cards
                  WHERE device_id = $1 AND status = 'done'
                    AND assigned_bots @> to_jsonb($2::int)
                  ORDER BY updated_at DESC LIMIT $3`,
                [deviceId, eid, lim]
            );
            return r.rows.map(row => ({
                ts: row.updated_at ? row.updated_at.toISOString() : null,
                chip: { kind: 'card', cardId: row.id, label: row.title },
            }));
        }
        if (axis === 'chat_upvotes' || axis === 'chat_downvotes') {
            const col = axis === 'chat_upvotes' ? 'like_count' : 'dislike_count';
            const r = await pool.query(
                `SELECT id, text, created_at
                   FROM chat_messages
                  WHERE device_id = $1 AND entity_id = $2 AND is_from_bot = true
                    AND ${col} > 0
                  ORDER BY created_at DESC LIMIT $3`,
                [deviceId, eid, lim]
            );
            return r.rows.map(row => ({
                ts: row.created_at ? row.created_at.toISOString() : null,
                chip: { kind: 'chat', messageId: row.id, excerpt: (row.text || '').slice(0, 60) },
            }));
        }
        if (axis === 'cards_reviewed') {
            const r = await pool.query(
                `SELECT id, title, updated_at
                   FROM kanban_cards
                  WHERE device_id = $1 AND reviewer_entity_id = $2
                    AND status IN ('in_progress','done')
                  ORDER BY updated_at DESC LIMIT $3`,
                [deviceId, eid, lim]
            );
            return r.rows.map(row => ({
                ts: row.updated_at ? row.updated_at.toISOString() : null,
                chip: { kind: 'card', cardId: row.id, label: row.title },
            }));
        }
        if (axis === 'notes_authored') {
            // Mirror the count source: mission_dashboard.notes JSONB filtered by
            // createdBy = 'entity_<N>'. createdAt is JS epoch-ms in the JSON.
            const r = await pool.query(
                `SELECT n->>'id'    AS id,
                        n->>'title' AS title,
                        (n->>'createdAt')::bigint AS created_ms
                   FROM mission_dashboard md
                   CROSS JOIN LATERAL jsonb_array_elements(
                        COALESCE(md.notes, '[]'::jsonb)) AS n
                  WHERE md.device_id = $1
                    AND n->>'createdBy' = $2
                  ORDER BY (n->>'createdAt')::bigint DESC NULLS LAST
                  LIMIT $3`,
                [deviceId, `entity_${eid}`, lim]
            );
            return r.rows.map(row => ({
                ts: row.created_ms != null ? new Date(Number(row.created_ms)).toISOString() : null,
                chip: { kind: 'note', noteId: row.id, label: row.title },
            }));
        }
        if (axis === 'prs_merged') {
            // Distinct referenced PRs from this entity's evidence comments,
            // newest first. Same dedupe key space as getAchievements so the
            // event count tracks the badge count. card_13405b3448d89931665c1670.
            const r = await pool.query(
                `SELECT text, created_at
                   FROM kanban_comments
                  WHERE device_id = $1 AND from_entity_id = $2
                    AND text ~* 'github\\.com/[^/[:space:]]+/[^/[:space:]]+/pull/[0-9]+'
                  ORDER BY created_at DESC`,
                [deviceId, eid]
            );
            const seen = new Set();
            const events = [];
            for (const row of r.rows) {
                const text = String(row.text || '');
                PR_URL_RE.lastIndex = 0;
                let m;
                while ((m = PR_URL_RE.exec(text)) !== null) {
                    const owner = m[1], repo = m[2], n = m[3];
                    const key = `${owner.toLowerCase()}/${repo.toLowerCase()}#${n}`;
                    if (seen.has(key)) continue;
                    seen.add(key);
                    events.push({
                        ts: row.created_at ? new Date(row.created_at).toISOString() : null,
                        chip: {
                            kind: 'pr',
                            prNumber: Number(n),
                            url: `https://github.com/${owner}/${repo}/pull/${n}`,
                            excerpt: text.slice(0, 60),
                        },
                    });
                    if (events.length >= lim) break;
                }
                if (events.length >= lim) break;
            }
            return events;
        }
        return [];
    } catch (err) {
        console.warn(`[Achievements] events axis=${axis} failed:`, err && err.message);
        return [];
    }
}

async function incrementCounter(deviceId, entityId, axis, opts) {
    if (!pool) return;
    // card_errctr: bump BOTH the resettable current total (count) AND the
    // all-time historical total (historical_count). historical_count is never
    // touched by the reset path, so it is the monotonic 歷史累計.
    await pool.query(`
        INSERT INTO entity_error_counters (device_id, entity_id, axis, count, historical_count, last_event_at)
        VALUES ($1, $2, $3, 1, 1, NOW())
        ON CONFLICT (device_id, entity_id, axis) DO UPDATE
        SET count = entity_error_counters.count + 1,
            historical_count = entity_error_counters.historical_count + 1,
            last_event_at = NOW(),
            updated_at = NOW()
    `, [deviceId, entityId, axis]);
    // Append to the reviewable error-event history (歷史紀錄). Best-effort —
    // never let a history-write failure mask the underlying error path.
    opts = opts || {};
    await recordErrorEvent(deviceId, entityId, axis, {
        eventType: opts.eventType || 'counter_inc',
        senderEntityId: opts.senderEntityId != null ? opts.senderEntityId : null,
        payloadSnippet: opts.payloadSnippet || null,
    });
}

// card_errctr: append one error event to the bounded 歷史紀錄 timeline, then
// trim to ERROR_EVENT_CAP newest rows for this (device, entity). Fully
// best-effort — swallows every error so the caller's hot path is unaffected.
async function recordErrorEvent(deviceId, entityId, axis, opts) {
    if (!pool || deviceId == null || entityId == null) return;
    opts = opts || {};
    try {
        await pool.query(
            `INSERT INTO entity_error_events
                (device_id, entity_id, axis, event_type, sender_entity_id, payload_snippet, occurred_at)
             VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()))`,
            [
                String(deviceId).slice(0, 64),
                Number(entityId),
                String(axis || 'other').slice(0, 64),
                opts.eventType ? String(opts.eventType).slice(0, 64) : null,
                opts.senderEntityId != null ? Number(opts.senderEntityId) : null,
                opts.payloadSnippet ? String(opts.payloadSnippet).slice(0, 240) : null,
                opts.occurredAt ? new Date(opts.occurredAt).toISOString() : null,
            ]
        );
        await pruneErrorEventsFor(deviceId, entityId, ERROR_EVENT_CAP);
    } catch (err) {
        console.error('[EntityStatus] recordErrorEvent error:', err.message);
    }
}

// Bound the history table: delete every row older than the Nth-newest for this
// (device, entity). Indexed + scoped to one entity, so a no-op when the entity
// has fewer than `cap` rows. Best-effort.
async function pruneErrorEventsFor(deviceId, entityId, cap) {
    if (!pool) return;
    const keep = Math.max(1, Number(cap) || ERROR_EVENT_CAP);
    try {
        await pool.query(
            `DELETE FROM entity_error_events
              WHERE device_id = $1 AND entity_id = $2
                AND id < (
                    SELECT MIN(id) FROM (
                        SELECT id FROM entity_error_events
                         WHERE device_id = $1 AND entity_id = $2
                         ORDER BY id DESC
                         LIMIT $3
                    ) keep
                )`,
            [deviceId, Number(entityId), keep]
        );
    } catch (err) {
        console.error('[EntityStatus] pruneErrorEventsFor error:', err.message);
    }
}

// Cursor-paginated read of the 歷史紀錄 timeline (newest first). Optional axis
// filter. Mirrors getOperationLog's cursor shape (beforeId → nextCursor).
async function getErrorHistory(deviceId, entityId, opts) {
    if (!pool) return { items: [], nextCursor: null };
    opts = opts || {};
    const limit = Math.min(Math.max(parseInt(opts.limit) || 30, 1), 100);
    const beforeId = parseInt(opts.beforeId) || null;
    const axis = opts.axis && CANONICAL_AXES.includes(opts.axis) ? opts.axis : null;
    const params = [deviceId, Number(entityId)];
    let clause = '';
    if (axis) { params.push(axis); clause += ` AND axis = $${params.length}`; }
    if (beforeId) { params.push(beforeId); clause += ` AND id < $${params.length}`; }
    params.push(limit);
    const result = await pool.query(
        `SELECT id, axis, event_type, sender_entity_id, payload_snippet, occurred_at
           FROM entity_error_events
          WHERE device_id = $1 AND entity_id = $2
          ${clause}
          ORDER BY id DESC
          LIMIT $${params.length}`,
        params
    );
    const items = result.rows.map(r => ({
        id: String(r.id),
        axis: r.axis,
        eventType: r.event_type || null,
        senderEntityId: r.sender_entity_id != null ? Number(r.sender_entity_id) : null,
        payloadSnippet: r.payload_snippet || null,
        occurredAt: r.occurred_at ? new Date(r.occurred_at).toISOString() : null,
    }));
    return {
        items,
        nextCursor: items.length === limit ? items[items.length - 1].id : null,
    };
}

// card_errctr: reset the CURRENT cumulative counter only. Sets count = 0 and
// stamps current_reset_at = NOW(); historical_count and the entity_error_events
// history are left completely untouched. Optional single-axis scope (must be a
// canonical axis); omit to reset every axis for the entity. Returns the number
// of counter rows affected.
async function resetCurrentCounters(deviceId, entityId, axis) {
    if (!pool || deviceId == null || entityId == null) return 0;
    const params = [deviceId, Number(entityId)];
    let clause = '';
    if (axis) {
        if (!CANONICAL_AXES.includes(axis)) return 0;
        params.push(axis);
        clause = ` AND axis = $${params.length}`;
    }
    const result = await pool.query(
        `UPDATE entity_error_counters
            SET count = 0,
                current_reset_at = NOW(),
                updated_at = NOW()
          WHERE device_id = $1 AND entity_id = $2
          ${clause}`,
        params
    );
    return result.rowCount || 0;
}

function authDeviceOrBot(req) {
    // Accepts secrets via query/body (legacy) OR X-Device-Secret / X-Bot-Secret
    // headers (secret-leakage hardening). Additive: query/body still win so
    // existing callers are unaffected.
    const creds = extractCreds(req);
    let deviceId = creds.deviceId;
    const deviceSecret = creds.deviceSecret;
    const botSecret = creds.botSecret;
    const callerEntityId = parseInt(creds.entityId) || 0;

    // Portal sessions hit this endpoint with a JWT cookie and no explicit
    // device/bot secret in the query string. Mirror the same fallback used by
    // /api/entities and friends so the avatar drawer doesn't 403 against
    // logged-in users. The cookie carries the device the session is bound to.
    if (!deviceId && req.cookies && req.cookies.eclaw_session) {
        try {
            const jwt = require('jsonwebtoken');
            const decoded = jwt.verify(req.cookies.eclaw_session,
                jwtSecret || process.env.JWT_SECRET || '');
            if (decoded && decoded.deviceId) {
                deviceId = decoded.deviceId;
                if (devicesRef && devicesRef[deviceId]) {
                    return { deviceId, callerEntityId };
                }
            }
        } catch (_) { /* invalid/expired token — fall through to the 403 */ }
    }

    if (!deviceId || !devicesRef || !devicesRef[deviceId]) return null;
    const device = devicesRef[deviceId];
    if (deviceSecret && safeEqual(device.deviceSecret, deviceSecret)) {
        return { deviceId, callerEntityId };
    }
    if (botSecret) {
        const ents = device.entities || {};
        if (callerEntityId > 0) {
            const e = ents[callerEntityId];
            if (e && e.isBound && e.botSecret && safeEqual(e.botSecret, botSecret)) {
                return { deviceId, callerEntityId };
            }
        } else {
            const match = Object.entries(ents).find(([, e]) =>
                e && e.isBound && e.botSecret && safeEqual(e.botSecret, botSecret));
            if (match) return { deviceId, callerEntityId: Number(match[0]) };
        }
    }
    return null;
}

const router = express.Router();

// Aggregate counters across every entity bound on the caller's device.
// Powers the avatar-drawer overview, dashboards, and cross-entity admin pages
// without requiring callers to loop /:eId per entity.
router.get('/', async (req, res) => {
    const auth = authDeviceOrBot(req);
    if (!auth) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    if (!pool || !devicesRef || !devicesRef[auth.deviceId]) {
        return res.status(404).json({ success: false, error: 'device not found' });
    }
    try {
        const entIds = Object.keys(devicesRef[auth.deviceId].entities || {})
            .map(k => parseInt(k, 10))
            .filter(n => Number.isFinite(n) && n >= 0)
            .sort((a, b) => a - b);
        const entities = [];
        for (const eid of entIds) {
            entities.push({
                entityId: eid,
                counters: await getCounters(auth.deviceId, eid),
            });
        }
        res.json({
            success: true,
            deviceId: auth.deviceId,
            entities,
        });
    } catch (err) {
        console.error('[EntityStatus] aggregate getCounters error:', err.message);
        res.status(500).json({ success: false, error: 'internal' });
    }
});

// Diagnostic view into outbound_msg_pending. Lets the operator (or this
// session's E2E probe) see the in-flight rows the sweeper will tick on
// expiry. Same auth as the rest of /api/entity-status — caller must already
// have device or bot creds for this device.
router.get('/_debug/pending', async (req, res) => {
    const auth = authDeviceOrBot(req);
    if (!auth) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    if (!pool) {
        return res.status(500).json({ success: false, error: 'pool not init' });
    }
    try {
        const result = await pool.query(
            `SELECT id, device_id, sender_entity_id, recipient_entity_id,
                    event_type, axis, dispatched_at, expires_at, payload_snippet
               FROM outbound_msg_pending
              WHERE device_id = $1
              ORDER BY dispatched_at DESC
              LIMIT 50`,
            [auth.deviceId]
        );
        res.json({
            success: true,
            deviceId: auth.deviceId,
            pending: result.rows.map(r => ({
                id: String(r.id),
                senderEntityId: r.sender_entity_id,
                recipientEntityId: r.recipient_entity_id,
                eventType: r.event_type,
                axis: r.axis,
                dispatchedAt: r.dispatched_at ? r.dispatched_at.toISOString() : null,
                expiresAt: r.expires_at ? r.expires_at.toISOString() : null,
                payloadSnippet: r.payload_snippet,
            })),
        });
    } catch (err) {
        console.error('[EntityStatus] debug/pending error:', err.message);
        res.status(500).json({ success: false, error: 'internal' });
    }
});

router.get('/:eId', async (req, res) => {
    const auth = authDeviceOrBot(req);
    if (!auth) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    const targetEId = parseInt(req.params.eId);
    if (!Number.isFinite(targetEId) || targetEId < 0) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }
    try {
        const counters = await getCounters(auth.deviceId, targetEId);
        res.json({
            success: true,
            deviceId: auth.deviceId,
            entityId: targetEId,
            counters,
        });
    } catch (err) {
        console.error('[EntityStatus] getCounters error:', err.message);
        res.status(500).json({ success: false, error: 'internal' });
    }
});

// Drill-down — the (timestamp, chip) list that opens when a user clicks one of
// the four counter rows on the panel. Returns the currently-pending events for
// that axis on this entity (i.e. what the live `openCount` counts). Newest first.
router.get('/:eId/counter/:axis/events', async (req, res) => {
    const auth = authDeviceOrBot(req);
    if (!auth) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    const targetEId = parseInt(req.params.eId);
    if (!Number.isFinite(targetEId) || targetEId < 0) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }
    const axis = String(req.params.axis || '');
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(axis)) {
        return res.status(400).json({ success: false, error: 'Invalid axis' });
    }
    // card_f20e3635: tighten beyond regex to the actual canonical 4 axes so
    // arbitrary well-formed-but-unknown labels don't pass through to SQL.
    if (!CANONICAL_AXES.includes(axis)) {
        return res.status(400).json({ success: false, error: 'Invalid axis' });
    }
    try {
        const items = await getCounterEvents(auth.deviceId, targetEId, axis, req.query.limit);
        res.json({
            success: true,
            deviceId: auth.deviceId,
            entityId: targetEId,
            axis,
            items,
        });
    } catch (err) {
        console.error('[EntityStatus] getCounterEvents error:', err.message);
        res.status(500).json({ success: false, error: 'internal' });
    }
});

// Achievements panel data — card_8ca0b6acb1fb3d7a0b650dfd.
router.get('/:eId/achievements', async (req, res) => {
    const auth = authDeviceOrBot(req);
    if (!auth) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    const targetEId = parseInt(req.params.eId);
    if (!Number.isFinite(targetEId) || targetEId < 0) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }
    try {
        const items = await getAchievements(auth.deviceId, targetEId);
        res.json({
            success: true,
            deviceId: auth.deviceId,
            entityId: targetEId,
            achievements: items,
        });
    } catch (err) {
        console.error('[EntityStatus] getAchievements error:', err.message);
        res.status(500).json({ success: false, error: 'internal' });
    }
});

router.get('/:eId/achievement/:axis/events', async (req, res) => {
    const auth = authDeviceOrBot(req);
    if (!auth) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    const targetEId = parseInt(req.params.eId);
    if (!Number.isFinite(targetEId) || targetEId < 0) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }
    const axis = String(req.params.axis || '');
    // Same regex+whitelist defense-in-depth pattern as counter-events
    // (card_f20e3635 fix). The whitelist check is the load-bearing one;
    // the regex stays as belt-and-suspenders against header injection.
    if (!/^[a-z][a-z0-9_]{2,63}$/.test(axis) || !CANONICAL_ACHIEVEMENTS.includes(axis)) {
        return res.status(400).json({ success: false, error: 'Invalid axis' });
    }
    try {
        const items = await getAchievementEvents(auth.deviceId, targetEId, axis, req.query.limit);
        res.json({
            success: true,
            deviceId: auth.deviceId,
            entityId: targetEId,
            axis,
            items,
        });
    } catch (err) {
        console.error('[EntityStatus] getAchievementEvents error:', err.message);
        res.status(500).json({ success: false, error: 'internal' });
    }
});

router.get('/:eId/log', express.json(), async (req, res) => {
    const auth = authDeviceOrBot(req);
    if (!auth) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    const targetEId = parseInt(req.params.eId);
    if (!Number.isFinite(targetEId) || targetEId < 0) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }
    try {
        const data = await getOperationLog(auth.deviceId, targetEId, {
            limit: req.query.limit,
            beforeId: req.query.before,
        });
        res.json({
            success: true,
            deviceId: auth.deviceId,
            entityId: targetEId,
            items: data.items,
            nextCursor: data.nextCursor,
        });
    } catch (err) {
        console.error('[EntityStatus] getOperationLog error:', err.message);
        res.status(500).json({ success: false, error: 'internal' });
    }
});

// card_errctr: 歷史紀錄 / error-event history timeline (newest first, cursor
// paginated). Optional ?axis= filter (must be a canonical axis). This survives
// a current-counter reset — the whole point of persisting the events.
router.get('/:eId/errors', async (req, res) => {
    const auth = authDeviceOrBot(req);
    if (!auth) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    const targetEId = parseInt(req.params.eId);
    if (!Number.isFinite(targetEId) || targetEId < 0) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }
    let axis = null;
    if (req.query.axis) {
        axis = String(req.query.axis);
        if (!CANONICAL_AXES.includes(axis)) {
            return res.status(400).json({ success: false, error: 'Invalid axis' });
        }
    }
    try {
        const data = await getErrorHistory(auth.deviceId, targetEId, {
            limit: req.query.limit,
            beforeId: req.query.before,
            axis,
        });
        res.json({
            success: true,
            deviceId: auth.deviceId,
            entityId: targetEId,
            items: data.items,
            nextCursor: data.nextCursor,
        });
    } catch (err) {
        console.error('[EntityStatus] getErrorHistory error:', err.message);
        res.status(500).json({ success: false, error: 'internal' });
    }
});

// card_errctr: reset the CURRENT cumulative counter only. historical_count and
// the error-event history are untouched. Optional body { axis } restricts the
// reset to one canonical axis; omit to reset all axes for the entity.
router.post('/:eId/counter/reset', express.json(), async (req, res) => {
    const auth = authDeviceOrBot(req);
    if (!auth) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    const targetEId = parseInt(req.params.eId);
    if (!Number.isFinite(targetEId) || targetEId < 0) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }
    let axis = null;
    if (req.body && req.body.axis) {
        axis = String(req.body.axis);
        if (!CANONICAL_AXES.includes(axis)) {
            return res.status(400).json({ success: false, error: 'Invalid axis' });
        }
    }
    try {
        const affected = await resetCurrentCounters(auth.deviceId, targetEId, axis);
        const counters = await getCounters(auth.deviceId, targetEId);
        res.json({
            success: true,
            deviceId: auth.deviceId,
            entityId: targetEId,
            axis: axis || null,
            reset: affected,
            counters,
        });
    } catch (err) {
        console.error('[EntityStatus] resetCurrentCounters error:', err.message);
        res.status(500).json({ success: false, error: 'internal' });
    }
});

router.post('/:eId/quote', express.json(), async (req, res) => {
    const auth = authDeviceOrBot(req);
    if (!auth) {
        return res.status(403).json({ success: false, error: 'Invalid credentials' });
    }
    const targetEId = parseInt(req.params.eId);
    if (!Number.isFinite(targetEId) || targetEId < 0) {
        return res.status(400).json({ success: false, error: 'Invalid entityId' });
    }
    const logId = parseInt(req.body && req.body.logId);
    if (!Number.isFinite(logId) || logId <= 0) {
        return res.status(400).json({ success: false, error: 'logId required' });
    }
    try {
        const row = await getLogRowById(auth.deviceId, targetEId, logId);
        if (!row) {
            return res.status(404).json({ success: false, error: 'log row not found' });
        }
        // Build a chat-paste-ready quote: a header line + the original summary.
        // Frontend uses this as the prefix for the user's reply text.
        const ts = row.occurredAt ? row.occurredAt.replace('T', ' ').replace(/\.\d+Z$/, ' UTC') : '';
        const quoteText = `> [Entity #${targetEId} ${ts}] ${row.eventSummary}\n> (event: ${row.eventType}${row.eventPayload && row.eventPayload.card_id ? ', card: ' + row.eventPayload.card_id : ''})\n\n`;
        res.json({
            success: true,
            quote: {
                logId: row.id,
                entityId: targetEId,
                eventType: row.eventType,
                eventSummary: row.eventSummary,
                occurredAt: row.occurredAt,
                text: quoteText,
                payload: row.eventPayload,
            },
        });
    } catch (err) {
        console.error('[EntityStatus] quote error:', err.message);
        res.status(500).json({ success: false, error: 'internal' });
    }
});

module.exports = {
    initTable,
    bindDevicesRef,
    bindJwtSecret,
    getCounters,
    getCounterEvents,
    incrementCounter,
    axisForEventType,
    trackOutbound,
    markReplyReceived,
    sweepExpired,
    startSweeper,
    logOperation,
    getOperationLog,
    getLogRowById,
    recordErrorEvent,
    pruneErrorEventsFor,
    getErrorHistory,
    resetCurrentCounters,
    ERROR_EVENT_CAP,
    router,
    CANONICAL_AXES,
    CANONICAL_ACHIEVEMENTS,
    getAchievements,
    getAchievementEvents,
    setPrAuthorSource,
};
