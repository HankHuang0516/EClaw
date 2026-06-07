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

let pool = null;
let devicesRef = null;

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
    `);
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

async function getCounters(deviceId, entityId) {
    if (!pool) return [];
    const result = await pool.query(
        `SELECT axis, count, last_event_at
           FROM entity_error_counters
          WHERE device_id = $1 AND entity_id = $2`,
        [deviceId, entityId]
    );
    const byAxis = new Map(result.rows.map(r => [r.axis, r]));
    // Always surface canonical axes even when count = 0, so the UI can render
    // a stable row order. Extra non-canonical axes (forward-compat) appear after.
    const ordered = [];
    for (const axis of CANONICAL_AXES) {
        const row = byAxis.get(axis);
        ordered.push({
            axis,
            count: row ? Number(row.count) : 0,
            lastEventAt: row && row.last_event_at ? row.last_event_at.toISOString() : null,
        });
        byAxis.delete(axis);
    }
    for (const [axis, row] of byAxis) {
        ordered.push({
            axis,
            count: Number(row.count),
            lastEventAt: row.last_event_at ? row.last_event_at.toISOString() : null,
        });
    }
    return ordered;
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
    const deviceId = req.query.deviceId || req.body?.deviceId;
    const deviceSecret = req.query.deviceSecret || req.body?.deviceSecret;
    const botSecret = req.query.botSecret || req.body?.botSecret;
    const callerEntityId = parseInt(req.query.entityId || req.body?.entityId) || 0;
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
    getCounters,
    incrementCounter,
    logOperation,
    getOperationLog,
    getLogRowById,
    router,
    CANONICAL_AXES,
};
