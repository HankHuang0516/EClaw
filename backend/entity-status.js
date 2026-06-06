// ============================================
// Entity Status Module
// Per-entity cumulative error counters surfaced in the avatar status drawer.
// Auth: same shape as /api/entities — deviceId+deviceSecret OR deviceId+botSecret
// (cross-entity observation per Hank 2026-06-06 19:55 TW directive).
//
// P0 scope (card_dbe18b333ac98076cc213055):
//   GET /api/entity-status/:eId → { counters: [{axis,count,lastEventAt}] }
// P1 (separate PR): operation log section, smart chip, smart quote.
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
    `);
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

module.exports = {
    initTable,
    bindDevicesRef,
    getCounters,
    incrementCounter,
    router,
    CANONICAL_AXES,
};
