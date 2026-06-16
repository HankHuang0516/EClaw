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

let pool = null;
let devicesRef = null;
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
              )`,
            params
        );
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
            `SELECT id, device_id, recipient_entity_id, axis
               FROM outbound_msg_pending
              WHERE expires_at <= NOW()
              LIMIT 500`
        );
        if (!expired.rows.length) return { tickedCount: 0 };
        for (const row of expired.rows) {
            try {
                await pool.query(`
                    INSERT INTO entity_error_counters (device_id, entity_id, axis, count, last_event_at)
                    VALUES ($1, $2, $3, 1, NOW())
                    ON CONFLICT (device_id, entity_id, axis) DO UPDATE
                    SET count = entity_error_counters.count + 1,
                        last_event_at = NOW(),
                        updated_at = NOW()
                `, [row.device_id, row.recipient_entity_id, row.axis]);
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
        `SELECT axis, count, last_event_at
           FROM entity_error_counters
          WHERE device_id = $1 AND entity_id = $2`,
        [deviceId, entityId]
    );
    // Currently-open events per axis: rows still sitting in outbound_msg_pending
    // for this entity-as-recipient. These are the events the panel's drill-down
    // will surface. `count` (cumulative) stays for backward-compat with any
    // existing chart/badge; `openCount` is the live health number Hank's spec
    // is built around — drops as the entity replies.
    const openRows = await pool.query(
        `SELECT axis, COUNT(*)::int AS open_count
           FROM outbound_msg_pending
          WHERE device_id = $1 AND recipient_entity_id = $2
          GROUP BY axis`,
        [deviceId, entityId]
    );
    const openByAxis = new Map(openRows.rows.map(r => [r.axis, Number(r.open_count)]));
    const byAxis = new Map(result.rows.map(r => [r.axis, r]));
    // Always surface canonical axes even when count = 0, so the UI can render
    // a stable row order. Extra non-canonical axes (forward-compat) appear after.
    const ordered = [];
    for (const axis of CANONICAL_AXES) {
        const row = byAxis.get(axis);
        ordered.push({
            axis,
            count: row ? Number(row.count) : 0,
            openCount: openByAxis.get(axis) || 0,
            lastEventAt: row && row.last_event_at ? row.last_event_at.toISOString() : null,
        });
        byAxis.delete(axis);
        openByAxis.delete(axis);
    }
    for (const [axis, row] of byAxis) {
        ordered.push({
            axis,
            count: Number(row.count),
            openCount: openByAxis.get(axis) || 0,
            lastEventAt: row.last_event_at ? row.last_event_at.toISOString() : null,
        });
        openByAxis.delete(axis);
    }
    // Axes with open pending but no cumulative row yet (fresh counter — sweeper
    // hasn't fired since first dispatch). Surface them so the drill-down lists
    // line up even before the cumulative row is created.
    for (const [axis, openCount] of openByAxis) {
        ordered.push({ axis, count: 0, openCount, lastEventAt: null });
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
                // mission_notes has no entity_id column; per-entity attribution
                // is via created_by = 'entity_<N>' (see mindmap-graph-projection.js
                // parseNumericCreatedBy). Prior query referenced a non-existent
                // column and was swallowed by the per-axis catch — visible in
                // Railway prod log as `column "entity_id" does not exist` spam.
                const r = await pool.query(
                    `SELECT COUNT(*)::int AS c, MAX(created_at) AS ts
                       FROM mission_notes
                      WHERE device_id = $1 AND created_by = $2`,
                    [deviceId, `entity_${eid}`]
                );
                count = Number(r.rows[0]?.c || 0);
                lastEventAt = r.rows[0]?.ts || null;
            }
            // prs_merged: skipped in backend (would need GH API or per-entity
            // commit-author mapping that we don't store); always 0 until v2.
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
            const r = await pool.query(
                `SELECT id, title, created_at
                   FROM mission_notes
                  WHERE device_id = $1 AND entity_id = $2
                  ORDER BY created_at DESC LIMIT $3`,
                [deviceId, eid, lim]
            );
            return r.rows.map(row => ({
                ts: row.created_at ? row.created_at.toISOString() : null,
                chip: { kind: 'note', noteId: row.id, label: row.title },
            }));
        }
        // prs_merged: empty until v2 (see getAchievements comment)
        return [];
    } catch (err) {
        console.warn(`[Achievements] events axis=${axis} failed:`, err && err.message);
        return [];
    }
}

async function incrementCounter(deviceId, entityId, axis) {
    if (!pool) return;
    await pool.query(`
        INSERT INTO entity_error_counters (device_id, entity_id, axis, count, last_event_at)
        VALUES ($1, $2, $3, 1, NOW())
        ON CONFLICT (device_id, entity_id, axis) DO UPDATE
        SET count = entity_error_counters.count + 1,
            last_event_at = NOW(),
            updated_at = NOW()
    `, [deviceId, entityId, axis]);
}

function authDeviceOrBot(req) {
    let deviceId = req.query.deviceId || req.body?.deviceId;
    const deviceSecret = req.query.deviceSecret || req.body?.deviceSecret;
    const botSecret = req.query.botSecret || req.body?.botSecret;
    const callerEntityId = parseInt(req.query.entityId || req.body?.entityId) || 0;

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
    router,
    CANONICAL_AXES,
    CANONICAL_ACHIEVEMENTS,
    getAchievements,
    getAchievementEvents,
};
