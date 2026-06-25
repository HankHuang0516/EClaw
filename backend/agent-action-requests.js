/**
 * Agent Action Requests — the "需要你" Human-in-the-Loop inbox.
 *
 * Mounted at: /api/action-requests
 *
 * An autonomous agent (entity) that gets blocked needing the user EMITS a
 * request here. The chat-page "需要你" inbox LISTS pending requests; the user
 * RESOLVES or DISMISSES them, and (if dispatch callbacks are wired) the answer
 * is pushed back to the emitting agent so it can unblock and continue.
 *
 * Endpoints:
 *   POST   /            — emit a request        (agent action → botSecret+entityId, or deviceSecret+fromEntityId)
 *   GET    /            — list requests          (deviceSecret OR botSecret; default status=pending)
 *   POST   /:id/resolve — answer a request       (user action → deviceSecret, or botSecret)
 *   POST   /:id/dismiss — drop a request         (user action → deviceSecret, or botSecret)
 *
 * `anchorMessageId` pins the originating chat message (a chat_messages UUID,
 * surfaced in chat as his_<uuid>) so the inbox item routes back to that
 * message and a smart-quote reply can be correlated to the exact request.
 * The full smart-quote round-trip wiring lives in child card_b51598b7; this
 * module is the model + emit/list/resolve API (child card_edeb190b).
 *
 * Parent spec: card_a03d9d09.
 */

const express = require('express');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const safeEqual = require('./safe-equal');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

const MAX_PROMPT_LEN = 2000;
const MAX_LIST_LIMIT = 500;
const VALID_TYPES = new Set(['decision', 'approval', 'input', 'credential', 'review', 'clarify']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function initAgentActionRequestsDatabase() {
    try {
        const schemaPath = path.join(__dirname, 'agent_action_requests_schema.sql');
        const schema = fs.readFileSync(schemaPath, 'utf8');
        const cleaned = schema.replace(/--[^\n]*/g, '').replace(/\n\s*\n/g, '\n');
        const statements = cleaned.split(';').map(s => s.trim()).filter(s => s.length > 5);
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
                    console.error('[AgentActionRequests] Schema failed:', err.message, '\n  stmt:', stmt.slice(0, 80));
                }
            }
        }
        console.log(`[AgentActionRequests] Database initialized: ${ok} OK, ${skipped} skipped, ${failed} failed`);
    } catch (error) {
        console.error('[AgentActionRequests] Failed to init database:', error.message);
    }
}

// ── Helpers ──
function normalizeAnchor(value) {
    if (typeof value === 'string' && UUID_RE.test(value.trim())) return value.trim();
    return null;
}

function rowToApi(row) {
    return {
        id: row.id,
        fromEntityId: row.from_entity_id,
        anchorMessageId: row.anchor_message_id || null,
        type: row.type,
        prompt: row.prompt,
        options: row.options || null,
        status: row.status,
        answer: row.answer || null,
        createdAt: new Date(row.created_at).getTime(),
        resolvedAt: row.resolved_at ? new Date(row.resolved_at).getTime() : null,
    };
}

/**
 * Factory. Matches the kanban/scheduled-messages module style so index.js wires it the same way.
 */
module.exports = function (devices, { pushToBot, unifiedPush, serverLog } = {}) {
    const router = express.Router();

    function log(level, msg, meta) {
        if (typeof serverLog === 'function') {
            try { serverLog(level, 'agent_action_requests', msg, meta || {}); } catch (_) {}
        }
    }

    // Best-effort: notify the emitting agent that its request was answered.
    // Extracted so both POST /:id/resolve and the /api/client/speak smart-quote
    // auto-resolve path push back identically (card_b51598b7). Never throws.
    function notifyAgentResolved(deviceId, device, row, answer) {
        try {
            const entity = device && device.entities && device.entities[row.from_entity_id];
            if (!entity || !entity.isBound) return;
            const note = `[需要你 RESOLVED] "${row.prompt}" → ${JSON.stringify(answer ?? null)} (request ${row.id}${row.anchor_message_id ? `, anchor ${row.anchor_message_id}` : ''})`;
            if (entity.bindingType === 'channel' && typeof unifiedPush === 'function') {
                unifiedPush(entity, deviceId, 'action_request_resolved', { message: note, requestId: row.id, anchorMessageId: row.anchor_message_id, answer: answer ?? null }, { event: 'message', from: 'action_request' }).catch(() => {});
            } else if (entity.webhook && typeof pushToBot === 'function') {
                pushToBot(entity, deviceId, 'action_request_resolved', { message: note }).catch(() => {});
            }
        } catch (_) {}
    }

    // Core resolve: guarded UPDATE (pending-only, device-scoped) + best-effort
    // agent push-back. Shared by POST /:id/resolve and the /api/client/speak
    // smart-quote auto-resolve loop (card_b51598b7).
    // Returns the resolved row, or null if nothing pending matched / id invalid.
    // Throws only on a DB error so the HTTP endpoint can 500; the speak path
    // wraps the call in try/catch and treats any failure as a no-op.
    async function resolveActionRequest(deviceId, requestId, answer, device) {
        if (!deviceId || !UUID_RE.test(String(requestId))) return null;
        const result = await pool.query(
            `UPDATE agent_action_requests
                SET status = 'resolved', answer = $1::jsonb, resolved_at = NOW()
              WHERE id = $2 AND device_id = $3 AND status = 'pending'
            RETURNING *`,
            [answer !== undefined ? JSON.stringify(answer) : null, requestId, deviceId]
        );
        if (result.rows.length === 0) return null;
        const row = result.rows[0];
        notifyAgentResolved(deviceId, device, row, answer);
        return row;
    }

    // ── Dual auth: deviceSecret (user) OR botSecret+entityId (agent) ──
    // Returns { device, deviceId, entityId|null, isUser } or null (after sending the error response).
    function authenticate(req, res) {
        const params = { ...req.query, ...req.body };
        const { deviceId, deviceSecret, botSecret, entityId } = params;
        if (!deviceId) {
            res.status(400).json({ success: false, error: 'Missing deviceId' });
            return null;
        }
        const device = devices && devices[deviceId];
        if (deviceSecret) {
            if (device && safeEqual(device.deviceSecret, deviceSecret)) {
                return { device, deviceId, entityId: null, isUser: true };
            }
            res.status(401).json({ success: false, error: 'Invalid credentials' });
            return null;
        }
        if (botSecret) {
            const eid = parseInt(entityId, 10);
            const entity = device && device.entities && device.entities[eid];
            if (entity && entity.isBound && safeEqual(entity.botSecret, botSecret)) {
                return { device, deviceId, entityId: eid, isUser: false };
            }
            res.status(401).json({ success: false, error: 'Invalid credentials' });
            return null;
        }
        res.status(400).json({ success: false, error: 'Missing deviceSecret or botSecret' });
        return null;
    }

    // ════════════════════════════════════════
    // POST / — emit an action request
    // ════════════════════════════════════════
    router.post('/', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId } = auth;
        const { type, prompt, options, anchorMessageId } = req.body || {};

        // from_entity_id: a bot emits as itself; a user (deviceSecret) must name the agent.
        let fromEntityId = auth.isUser ? parseInt(req.body.fromEntityId, 10) : auth.entityId;
        if (!Number.isInteger(fromEntityId) || fromEntityId < 0) {
            return res.status(400).json({ success: false, error: 'fromEntityId required (integer)' });
        }
        if (typeof type !== 'string' || !VALID_TYPES.has(type)) {
            return res.status(400).json({ success: false, error: `type must be one of: ${[...VALID_TYPES].join('|')}` });
        }
        if (typeof prompt !== 'string' || prompt.length < 1 || prompt.length > MAX_PROMPT_LEN) {
            return res.status(400).json({ success: false, error: `prompt must be a string of length 1..${MAX_PROMPT_LEN}` });
        }
        if (options !== undefined && options !== null && !Array.isArray(options)) {
            return res.status(400).json({ success: false, error: 'options must be an array when provided' });
        }
        const anchor = normalizeAnchor(anchorMessageId);

        try {
            const result = await pool.query(
                `INSERT INTO agent_action_requests
                    (device_id, from_entity_id, anchor_message_id, type, prompt, options)
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb)
                 RETURNING *`,
                [deviceId, fromEntityId, anchor, type, prompt, options != null ? JSON.stringify(options) : null]
            );
            const row = result.rows[0];
            log('info', `emit id=${row.id} from=${fromEntityId} type=${type}`, { deviceId });
            return res.json({ success: true, request: rowToApi(row) });
        } catch (err) {
            console.error('[AgentActionRequests] POST failed:', err.message);
            log('error', `POST failed: ${err.message}`, { deviceId });
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
    });

    // ════════════════════════════════════════
    // GET / — list requests (default pending) for the device
    // ════════════════════════════════════════
    router.get('/', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId } = auth;
        const statusFilter = (req.query.status || 'pending');
        if (!['pending', 'resolved', 'dismissed', 'all'].includes(statusFilter)) {
            return res.status(400).json({ success: false, error: 'status must be pending|resolved|dismissed|all' });
        }
        const fromEntityId = req.query.fromEntityId;

        try {
            const params = [deviceId];
            let sql = `SELECT * FROM agent_action_requests WHERE device_id = $1`;
            if (statusFilter !== 'all') {
                params.push(statusFilter);
                sql += ` AND status = $${params.length}`;
            }
            if (fromEntityId != null && fromEntityId !== '') {
                params.push(parseInt(fromEntityId, 10));
                sql += ` AND from_entity_id = $${params.length}`;
            }
            sql += ` ORDER BY created_at ASC LIMIT ${MAX_LIST_LIMIT}`;
            const result = await pool.query(sql, params);
            return res.json({ success: true, requests: result.rows.map(rowToApi) });
        } catch (err) {
            console.error('[AgentActionRequests] GET failed:', err.message);
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
    });

    // ════════════════════════════════════════
    // POST /:id/resolve — answer a pending request (notifies the agent if wired)
    // ════════════════════════════════════════
    router.post('/:id/resolve', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { device, deviceId } = auth;
        const { id } = req.params;
        if (!UUID_RE.test(String(id))) {
            return res.status(400).json({ success: false, error: 'Invalid id' });
        }
        const { answer } = req.body || {};

        try {
            const row = await resolveActionRequest(deviceId, id, answer, device);
            if (!row) {
                return res.status(404).json({ success: false, error: 'Not found or already resolved/dismissed' });
            }
            log('info', `resolve id=${row.id} from=${row.from_entity_id}`, { deviceId });
            return res.json({ success: true, request: rowToApi(row) });
        } catch (err) {
            console.error('[AgentActionRequests] resolve failed:', err.message);
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
    });

    // ════════════════════════════════════════
    // POST /:id/dismiss — drop a pending request without answering
    // ════════════════════════════════════════
    router.post('/:id/dismiss', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId } = auth;
        const { id } = req.params;
        if (!UUID_RE.test(String(id))) {
            return res.status(400).json({ success: false, error: 'Invalid id' });
        }
        try {
            const result = await pool.query(
                `UPDATE agent_action_requests
                    SET status = 'dismissed', resolved_at = NOW()
                  WHERE id = $1 AND device_id = $2 AND status = 'pending'
                RETURNING *`,
                [id, deviceId]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Not found or already resolved/dismissed' });
            }
            log('info', `dismiss id=${id}`, { deviceId });
            return res.json({ success: true, request: rowToApi(result.rows[0]) });
        } catch (err) {
            console.error('[AgentActionRequests] dismiss failed:', err.message);
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
    });

    return {
        router,
        initDatabase: initAgentActionRequestsDatabase,
        // Shared resolve so /api/client/speak can auto-resolve a request a
        // smart-quote reply answers (card_b51598b7). Device-scoped, pending-only,
        // + best-effort agent push-back. Returns the row, or null on no-match.
        resolveActionRequest,
        _pool: pool,
    };
};

module.exports.initAgentActionRequestsDatabase = initAgentActionRequestsDatabase;
