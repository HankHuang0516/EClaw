/**
 * Scheduled Messages — user-scheduled chat messages dispatched at a future time.
 *
 * Mounted at: /api/scheduled-messages
 *
 * Endpoints (all deviceSecret-authenticated — this is a user action, never a bot action):
 *   POST   /           — Create a scheduled message
 *   GET    /           — List pending scheduled messages for a chat
 *   PUT    /:id        — Update content / scheduledAt / targetEntityIds (pre-send only)
 *   DELETE /:id        — Cancel (pre-send only; sets cancelled_at)
 *
 * Background poller (started at module load unless NODE_ENV=test):
 *   Every 5s, atomically claim rows where scheduled_at <= NOW() and
 *   dispatch them as user messages via the injected saveChatMessage /
 *   pushToBot / unifiedPush callbacks.
 *
 * Dispatch is fire-once: sent_at is stamped inside the claim UPDATE, so a
 * concurrent poller tick cannot double-send. Delivery failures are captured
 * in last_error but do not un-set sent_at — the spec opts for observable-
 * once semantics over infinite retry.
 */

const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const safeEqual = require('./safe-equal');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

const MAX_CONTENT_LEN = 10000;
const MAX_SCHEDULE_AHEAD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const POLLER_INTERVAL_MS = 5000;
const POLLER_BATCH_SIZE = 50;

// ── Schema init ──
async function initScheduledMessagesDatabase() {
    try {
        const schemaPath = path.join(__dirname, 'scheduled_messages_schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        const cleaned = schema.replace(/--[^\n]*/g, '').replace(/\n\s*\n/g, '\n');
        const statements = cleaned
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 5);
        let ok = 0, skipped = 0, failed = 0;
        for (const stmt of statements) {
            try {
                await pool.query(stmt);
                ok++;
            } catch (err) {
                if (err.message.includes('already exists') || err.message.includes('duplicate key')) {
                    skipped++;
                } else {
                    failed++;
                    console.error('[ScheduledMessages] Schema failed:', err.message, '\n  stmt:', stmt.slice(0, 80));
                }
            }
        }
        console.log(`[ScheduledMessages] Database initialized: ${ok} OK, ${skipped} skipped, ${failed} failed`);
    } catch (error) {
        console.error('[ScheduledMessages] Failed to init database:', error.message);
    }
}

// ── Helpers ──
function parseTimestamp(input) {
    if (input == null) return null;
    if (typeof input === 'number') {
        return Number.isFinite(input) ? new Date(input) : null;
    }
    if (typeof input === 'string') {
        const d = new Date(input);
        return Number.isNaN(d.getTime()) ? null : d;
    }
    if (input instanceof Date) {
        return Number.isNaN(input.getTime()) ? null : input;
    }
    return null;
}

function validateTargetEntityIds(targetEntityIds, device) {
    if (!Array.isArray(targetEntityIds) || targetEntityIds.length === 0) {
        return { valid: false, error: 'targetEntityIds must be a non-empty array' };
    }
    const entities = (device && device.entities) || {};
    const cleaned = [];
    for (const raw of targetEntityIds) {
        const id = parseInt(raw, 10);
        if (!Number.isInteger(id) || id < 0) {
            return { valid: false, error: `Invalid entity id: ${raw}` };
        }
        // id 0 is always the owner/default slot. For other ids, the slot must
        // exist on the device (bound or not — user can schedule for a slot
        // they intend to bind later, but the slot must at least be present).
        if (id !== 0 && !entities.hasOwnProperty(id)) {
            return { valid: false, error: `Entity ${id} not found on device` };
        }
        cleaned.push(id);
    }
    return { valid: true, ids: Array.from(new Set(cleaned)) };
}

function rowToApi(row) {
    return {
        id: row.id,
        chatEntityId: row.chat_entity_id,
        userEntityId: row.user_entity_id,
        targetEntityIds: row.target_entity_ids,
        content: row.content,
        scheduledAt: new Date(row.scheduled_at).getTime(),
        createdAt: new Date(row.created_at).getTime(),
        sentAt: row.sent_at ? new Date(row.sent_at).getTime() : null,
        cancelledAt: row.cancelled_at ? new Date(row.cancelled_at).getTime() : null,
    };
}

/**
 * Factory. Matches the kanban/mission module style so index.js wires it the same way.
 */
module.exports = function (devices, { saveChatMessage, pushToBot, unifiedPush, serverLog } = {}) {
    const router = express.Router();

    // ── Auth (deviceSecret only — scheduling is a user action) ──
    function findDeviceByCredentials(deviceId, deviceSecret) {
        const device = devices && devices[deviceId];
        if (!device || !safeEqual(device.deviceSecret, deviceSecret)) return null;
        return device;
    }

    function authenticate(req, res) {
        const params = { ...req.query, ...req.body };
        const { deviceId, deviceSecret } = params;
        if (!deviceId) {
            res.status(400).json({ success: false, error: 'Missing deviceId' });
            return null;
        }
        if (!deviceSecret) {
            res.status(400).json({ success: false, error: 'Missing deviceSecret' });
            return null;
        }
        const device = findDeviceByCredentials(deviceId, deviceSecret);
        if (!device) {
            res.status(401).json({ success: false, error: 'Invalid credentials' });
            return null;
        }
        return { device, deviceId };
    }

    function log(level, msg, meta) {
        if (typeof serverLog === 'function') {
            try { serverLog(level, 'scheduled_messages', msg, meta || {}); } catch (_) {}
        }
    }

    // ════════════════════════════════════════
    // POST / — create a scheduled message
    // ════════════════════════════════════════
    router.post('/', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { device, deviceId } = auth;
        const { chatEntityId, userEntityId, targetEntityIds, content, scheduledAt } = req.body || {};

        if (chatEntityId == null || !Number.isInteger(parseInt(chatEntityId, 10))) {
            return res.status(400).json({ success: false, error: 'chatEntityId required (integer)' });
        }
        if (userEntityId == null || !Number.isInteger(parseInt(userEntityId, 10))) {
            return res.status(400).json({ success: false, error: 'userEntityId required (integer)' });
        }
        if (typeof content !== 'string' || content.length < 1 || content.length > MAX_CONTENT_LEN) {
            return res.status(400).json({
                success: false,
                error: `content must be a string of length 1..${MAX_CONTENT_LEN}`,
            });
        }
        const when = parseTimestamp(scheduledAt);
        if (!when) {
            return res.status(400).json({ success: false, error: 'scheduledAt must be a valid timestamp (ms or ISO string)' });
        }
        const nowMs = Date.now();
        if (when.getTime() <= nowMs) {
            return res.status(400).json({ success: false, error: 'scheduledAt must be in the future' });
        }
        if (when.getTime() > nowMs + MAX_SCHEDULE_AHEAD_MS) {
            return res.status(400).json({ success: false, error: 'scheduledAt cannot be more than 7 days ahead' });
        }
        const targetCheck = validateTargetEntityIds(targetEntityIds, device);
        if (!targetCheck.valid) {
            return res.status(400).json({ success: false, error: targetCheck.error });
        }

        try {
            const result = await pool.query(
                `INSERT INTO scheduled_messages
                    (device_id, chat_entity_id, user_entity_id, target_entity_ids, content, scheduled_at)
                 VALUES ($1, $2, $3, $4::jsonb, $5, $6)
                 RETURNING id, scheduled_at`,
                [
                    deviceId,
                    parseInt(chatEntityId, 10),
                    parseInt(userEntityId, 10),
                    JSON.stringify(targetCheck.ids),
                    content,
                    when.toISOString(),
                ]
            );
            const row = result.rows[0];
            log('info', `created id=${row.id} targets=${targetCheck.ids.join(',')} at=${when.toISOString()}`, { deviceId });
            return res.json({
                success: true,
                id: row.id,
                scheduledAt: new Date(row.scheduled_at).getTime(),
            });
        } catch (err) {
            console.error('[ScheduledMessages] POST failed:', err.message);
            log('error', `POST failed: ${err.message}`, { deviceId });
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
    });

    // ════════════════════════════════════════
    // GET / — list pending (unsent, uncancelled) messages for a chat
    // ════════════════════════════════════════
    router.get('/', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId } = auth;
        const { chatEntityId } = req.query;

        try {
            let sql = `SELECT id, chat_entity_id, user_entity_id, target_entity_ids, content,
                              scheduled_at, created_at, sent_at, cancelled_at
                       FROM scheduled_messages
                       WHERE device_id = $1
                         AND sent_at IS NULL
                         AND cancelled_at IS NULL`;
            const params = [deviceId];
            if (chatEntityId != null && chatEntityId !== '') {
                params.push(parseInt(chatEntityId, 10));
                sql += ` AND chat_entity_id = $${params.length}`;
            }
            sql += ' ORDER BY scheduled_at ASC LIMIT 500';
            const result = await pool.query(sql, params);
            return res.json({
                success: true,
                messages: result.rows.map(rowToApi),
            });
        } catch (err) {
            console.error('[ScheduledMessages] GET failed:', err.message);
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
    });

    // ════════════════════════════════════════
    // PUT /:id — update content / scheduledAt / targetEntityIds (pre-send only)
    // ════════════════════════════════════════
    router.put('/:id', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { device, deviceId } = auth;
        const { id } = req.params;
        const { content, scheduledAt, targetEntityIds } = req.body || {};

        const updates = [];
        const params = [];

        if (content !== undefined) {
            if (typeof content !== 'string' || content.length < 1 || content.length > MAX_CONTENT_LEN) {
                return res.status(400).json({
                    success: false,
                    error: `content must be a string of length 1..${MAX_CONTENT_LEN}`,
                });
            }
            params.push(content);
            updates.push(`content = $${params.length}`);
        }

        if (scheduledAt !== undefined) {
            const when = parseTimestamp(scheduledAt);
            if (!when) {
                return res.status(400).json({ success: false, error: 'scheduledAt must be a valid timestamp' });
            }
            const nowMs = Date.now();
            if (when.getTime() <= nowMs) {
                return res.status(400).json({ success: false, error: 'scheduledAt must be in the future' });
            }
            if (when.getTime() > nowMs + MAX_SCHEDULE_AHEAD_MS) {
                return res.status(400).json({ success: false, error: 'scheduledAt cannot be more than 7 days ahead' });
            }
            params.push(when.toISOString());
            updates.push(`scheduled_at = $${params.length}`);
        }

        if (targetEntityIds !== undefined) {
            const targetCheck = validateTargetEntityIds(targetEntityIds, device);
            if (!targetCheck.valid) {
                return res.status(400).json({ success: false, error: targetCheck.error });
            }
            params.push(JSON.stringify(targetCheck.ids));
            updates.push(`target_entity_ids = $${params.length}::jsonb`);
        }

        if (updates.length === 0) {
            return res.status(400).json({ success: false, error: 'No updatable fields provided' });
        }

        params.push(id, deviceId);
        const idIdx = params.length - 1;
        const devIdx = params.length;
        try {
            const result = await pool.query(
                `UPDATE scheduled_messages
                    SET ${updates.join(', ')}
                  WHERE id = $${idIdx}
                    AND device_id = $${devIdx}
                    AND sent_at IS NULL
                    AND cancelled_at IS NULL
                RETURNING id, chat_entity_id, user_entity_id, target_entity_ids, content,
                          scheduled_at, created_at, sent_at, cancelled_at`,
                params
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Not found or already sent/cancelled' });
            }
            return res.json({ success: true, message: rowToApi(result.rows[0]) });
        } catch (err) {
            console.error('[ScheduledMessages] PUT failed:', err.message);
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
    });

    // ════════════════════════════════════════
    // DELETE /:id — cancel (pre-send only)
    // ════════════════════════════════════════
    router.delete('/:id', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId } = auth;
        const { id } = req.params;
        try {
            const result = await pool.query(
                `UPDATE scheduled_messages
                    SET cancelled_at = NOW()
                  WHERE id = $1
                    AND device_id = $2
                    AND sent_at IS NULL
                    AND cancelled_at IS NULL
                RETURNING id, cancelled_at`,
                [id, deviceId]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Not found or already sent/cancelled' });
            }
            log('info', `cancelled id=${id}`, { deviceId });
            return res.json({
                success: true,
                id: result.rows[0].id,
                cancelledAt: new Date(result.rows[0].cancelled_at).getTime(),
            });
        } catch (err) {
            console.error('[ScheduledMessages] DELETE failed:', err.message);
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
    });

    // ════════════════════════════════════════
    // Dispatch a single claimed row → save chat + push to bots
    // ════════════════════════════════════════
    async function dispatchRow(row) {
        const deviceId = row.device_id;
        const device = devices && devices[deviceId];
        if (!device) {
            await pool.query(
                `UPDATE scheduled_messages SET last_error = $1 WHERE id = $2`,
                ['device_not_found', row.id]
            );
            return;
        }
        const targetIds = Array.isArray(row.target_entity_ids) ? row.target_entity_ids : [];
        const errors = [];
        for (const eId of targetIds) {
            const entity = device.entities && device.entities[eId];
            try {
                if (typeof saveChatMessage === 'function') {
                    await saveChatMessage(
                        deviceId,
                        eId,
                        row.content,
                        'scheduled',
                        true,   // is_from_user: user-scheduled message counts as a user message
                        false,  // is_from_bot
                        null, null, null,
                        'scheduled' // schedule_label
                    );
                }
                if (!entity || !entity.isBound) continue;
                if (entity.bindingType === 'channel' && typeof unifiedPush === 'function') {
                    await unifiedPush(entity, deviceId, 'new_message', {
                        message: row.content,
                        from: 'scheduled',
                    }, { event: 'message', from: 'scheduled' }).catch(err => {
                        errors.push(`entity=${eId} channel_push_failed: ${err.message}`);
                    });
                } else if (entity.webhook && typeof pushToBot === 'function') {
                    await pushToBot(entity, deviceId, 'new_message', {
                        message: `[SCHEDULED MESSAGE]\n${row.content}`,
                    }).catch(err => {
                        errors.push(`entity=${eId} webhook_push_failed: ${err.message}`);
                    });
                }
            } catch (err) {
                errors.push(`entity=${eId}: ${err.message}`);
            }
        }
        if (errors.length > 0) {
            try {
                await pool.query(
                    `UPDATE scheduled_messages SET last_error = $1 WHERE id = $2`,
                    [errors.join(' | ').slice(0, 2000), row.id]
                );
            } catch (_) {}
            log('warn', `dispatch id=${row.id} errors: ${errors.join(' | ')}`, { deviceId });
        } else {
            log('info', `dispatch id=${row.id} ok targets=${targetIds.length}`, { deviceId });
        }
    }

    // ════════════════════════════════════════
    // Poller — atomically claim due rows and dispatch
    // ════════════════════════════════════════
    async function pollAndFire() {
        let claimed;
        try {
            const result = await pool.query(
                `UPDATE scheduled_messages
                    SET sent_at = NOW()
                  WHERE id IN (
                      SELECT id FROM scheduled_messages
                       WHERE sent_at IS NULL
                         AND cancelled_at IS NULL
                         AND scheduled_at <= NOW()
                       ORDER BY scheduled_at ASC
                       LIMIT ${POLLER_BATCH_SIZE}
                       FOR UPDATE SKIP LOCKED
                  )
                RETURNING id, device_id, chat_entity_id, user_entity_id,
                          target_entity_ids, content, scheduled_at, sent_at`
            );
            claimed = result.rows;
        } catch (err) {
            console.error('[ScheduledMessages] poller claim failed:', err.message);
            return { claimed: 0, dispatched: 0 };
        }
        if (!claimed || claimed.length === 0) return { claimed: 0, dispatched: 0 };
        let dispatched = 0;
        for (const row of claimed) {
            try {
                await dispatchRow(row);
                dispatched++;
            } catch (err) {
                console.error(`[ScheduledMessages] dispatch failed for ${row.id}:`, err.message);
            }
        }
        return { claimed: claimed.length, dispatched };
    }

    let pollerTimer = null;
    function startPoller() {
        if (pollerTimer) return;
        pollerTimer = setInterval(() => {
            pollAndFire().catch(err => console.error('[ScheduledMessages] poller tick:', err.message));
        }, POLLER_INTERVAL_MS);
        if (pollerTimer.unref) pollerTimer.unref();
        console.log(`[ScheduledMessages] Poller started (every ${POLLER_INTERVAL_MS}ms)`);
    }
    function stopPoller() {
        if (pollerTimer) {
            clearInterval(pollerTimer);
            pollerTimer = null;
        }
    }

    return {
        router,
        initDatabase: initScheduledMessagesDatabase,
        pollAndFire,
        startPoller,
        stopPoller,
        // exposed for tests
        _pool: pool,
    };
};

module.exports.initScheduledMessagesDatabase = initScheduledMessagesDatabase;
