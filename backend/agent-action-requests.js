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
// Singleton device-preferences module (its internal pool is wired once by
// index.js via initTable). The timeout worker reads each device's policy +
// timeout-minutes from here. Tests may inject a `getDevicePrefs` override on the
// factory options to avoid touching it.
const devicePrefs = require('./device-preferences');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

const MAX_PROMPT_LEN = 2000;
const MAX_LIST_LIMIT = 500;
// 'consensus' = 與其他實體討論取得共識 (added card_8151054f). NOTE: if you add a
// type here you MUST also extend the aar_type_valid CHECK constraint — both in
// agent_action_requests_schema.sql AND the idempotent migration in
// initAgentActionRequestsDatabase() below (the prod table already exists, so a
// plain schema re-run won't change the constraint).
const VALID_TYPES = new Set(['decision', 'approval', 'input', 'credential', 'review', 'clarify', 'consensus']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Timeout-policy worker (card_ce0d685b): sweep cadence + a process-level guard so
// re-requiring / re-instantiating the factory never stacks intervals.
const TIMEOUT_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
let timeoutSweepTimer = null;

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

    // ── Idempotent, transactional constraint migration (card_8151054f; hardened) ──
    // The table already exists in prod, so the CREATE TABLE above is a no-op and
    // the freshened aar_type_valid CHECK (with 'consensus') in the schema file is
    // NOT applied to the live table. We must drop + recreate the constraint so the
    // new 'consensus' type becomes insertable on the existing table.
    //
    // Hardening (PR#3732 follow-up findings #1 + #2):
    //   - GUARD first: if the live constraint already lists 'consensus', skip ALL
    //     DDL. ACCESS EXCLUSIVE lock + full-table re-validation on every boot is
    //     wasteful, and re-running on each restart is pointless once current.
    //   - TRANSACTIONAL: when DDL is needed, run DROP+ADD inside a single
    //     transaction on ONE pooled client, so there is never a *committed*
    //     bare-constraint window (the old code committed the DROP, leaving the
    //     table unconstrained until the separate ADD committed — and a multi-
    //     instance race could DROP after a peer ADDed).
    //   - ADVISORY LOCK: a transaction-scoped advisory lock serializes concurrent
    //     instances doing the migration (cheap, auto-released on COMMIT/ROLLBACK).
    // Best-effort throughout: any failure logs and never throws/crashes init.
    try {
        const existing = await pool.query(
            `SELECT pg_get_constraintdef(oid) AS def
               FROM pg_constraint
              WHERE conname = 'aar_type_valid'
                AND conrelid = 'agent_action_requests'::regclass`
        );
        const curDef = existing.rows.length ? existing.rows[0].def : null;
        if (curDef && curDef.includes('consensus')) {
            console.log('[AgentActionRequests] aar_type_valid already current');
        } else {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                // 8151054f → numeric advisory-lock key (card id, transaction-scoped).
                await client.query('SELECT pg_advisory_xact_lock(8151054)');
                await client.query('ALTER TABLE agent_action_requests DROP CONSTRAINT IF EXISTS aar_type_valid');
                await client.query(
                    `ALTER TABLE agent_action_requests
                        ADD CONSTRAINT aar_type_valid
                        CHECK (type IN ('decision','approval','input','credential','review','clarify','consensus'))`
                );
                await client.query('COMMIT');
                console.log('[AgentActionRequests] aar_type_valid constraint migrated (includes consensus)');
            } catch (e) {
                await client.query('ROLLBACK').catch(() => {});
                throw e;
            } finally {
                client.release();
            }
        }
    } catch (err) {
        console.error('[AgentActionRequests] aar_type_valid migration skipped:', err.message);
    }

    // ── Idempotent column migration: consensus_triggered_at (card_ce0d685b) ──
    // The timeout worker's 'consensus' policy leaves a request 'pending' (the
    // emitting agent resolves it after synthesis), so without a marker the worker
    // would re-fire a consensus round every 5-min tick. This column is set once
    // when a round is triggered. ADD COLUMN IF NOT EXISTS is a no-op on a table
    // that already has it. Best-effort: never throws/crashes init.
    try {
        await pool.query(
            `ALTER TABLE agent_action_requests
                ADD COLUMN IF NOT EXISTS consensus_triggered_at TIMESTAMPTZ DEFAULT NULL`
        );
    } catch (err) {
        console.error('[AgentActionRequests] consensus_triggered_at migration skipped:', err.message);
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
module.exports = function (devices, { pushToBot, unifiedPush, serverLog, io, getDevicePrefs } = {}) {
    const router = express.Router();

    // How the worker reads a device's timeout policy + minutes. Defaults to the
    // singleton device-preferences module; tests inject a stub so they never
    // touch real PG. Always returns an object (falls back to {} on error).
    const readDevicePrefs = typeof getDevicePrefs === 'function'
        ? getDevicePrefs
        : (deviceId) => devicePrefs.getPrefs(deviceId);

    function log(level, msg, meta) {
        if (typeof serverLog === 'function') {
            try { serverLog(level, 'agent_action_requests', msg, meta || {}); } catch (_) {}
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    // SOCKET EVENT CONTRACT (card_8151054f) — frontend integration point for #6
    // ──────────────────────────────────────────────────────────────────────
    // Event name : 'action_request:changed'
    // Room       : 'device:<deviceId>'   (same room convention as chat:message)
    // Payload    : { kind, requestId, fromEntityId }
    //                kind         : 'emitted' | 'resolved' | 'dismissed'
    //                               | 'consensus_triggered'
    //                requestId    : the agent_action_requests row UUID (string)
    //                fromEntityId : the emitting entity id (integer)
    //              NEW kind 'consensus_triggered' (card_ce0d685b): the timeout
    //              worker opened a bot-to-bot consensus round for a still-pending
    //              request (consensus policy). The request stays 'pending' until
    //              the emitting agent synthesizes + resolves it; the frontend can
    //              render a "協商中 / In consensus" badge on this event.
    // Semantics  : fired AFTER the DB write commits, best-effort. The frontend
    //              "需要你" inbox listens on this event to live-refresh (it should
    //              re-fetch GET /api/action-requests rather than trust the payload
    //              as the full row). A socket failure here NEVER affects the HTTP
    //              response. This name + shape is the stable contract — do not
    //              rename without coordinating with the frontend.
    // ══════════════════════════════════════════════════════════════════════
    function emitChanged(deviceId, kind, requestId, fromEntityId) {
        try {
            if (io && deviceId) {
                io.to(`device:${deviceId}`).emit('action_request:changed', {
                    kind,
                    requestId,
                    fromEntityId,
                });
            }
        } catch (_) { /* socket failure must never break the HTTP response */ }
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
    //
    // `restrictToEntityId` (PR#3732 follow-up finding #3): when non-null, the
    // UPDATE also requires from_entity_id = that id, so a botSecret holder can
    // only resolve a request IT emitted — never another entity's request on the
    // same device (which would also forge a push-back to that other entity). The
    // human/deviceSecret (isUser) path and the /api/client/speak USER auto-resolve
    // path pass null (default) — the user owns the whole device inbox.
    async function resolveActionRequest(deviceId, requestId, answer, device, restrictToEntityId = null) {
        if (!deviceId || !UUID_RE.test(String(requestId))) return null;
        const params = [answer !== undefined ? JSON.stringify(answer) : null, requestId, deviceId];
        let sql = `UPDATE agent_action_requests
                SET status = 'resolved', answer = $1::jsonb, resolved_at = NOW()
              WHERE id = $2 AND device_id = $3 AND status = 'pending'`;
        if (restrictToEntityId != null) {
            params.push(restrictToEntityId);
            sql += ` AND from_entity_id = $${params.length}`;
        }
        sql += ` RETURNING *`;
        const result = await pool.query(sql, params);
        if (result.rows.length === 0) return null;
        const row = result.rows[0];
        notifyAgentResolved(deviceId, device, row, answer);
        // Live-refresh the inbox. Lives here (not only in the endpoint) so the
        // /api/client/speak smart-quote auto-resolve path emits identically.
        emitChanged(deviceId, 'resolved', row.id, row.from_entity_id);
        return row;
    }

    // Best-effort: push a free-text message to one bound entity (channel or
    // webhook). Mirrors notifyAgentResolved's transport selection. Never throws.
    function pushTextToEntity(deviceId, entity, eventType, message, extra = {}) {
        try {
            if (!entity || !entity.isBound) return;
            if (entity.bindingType === 'channel' && typeof unifiedPush === 'function') {
                unifiedPush(entity, deviceId, eventType, { message, ...extra }, { event: 'message', from: 'action_request' }).catch(() => {});
            } else if (entity.webhook && typeof pushToBot === 'function') {
                pushToBot(entity, deviceId, eventType, { message, ...extra }).catch(() => {});
            }
        } catch (_) {}
    }

    // ══════════════════════════════════════════════════════════════════════
    // TIMEOUT-POLICY WORKER (card_ce0d685b)
    // ──────────────────────────────────────────────────────────────────────
    // Periodically (every 5 min) enforces each device's
    // `action_request_timeout_policy` on its pending "需要你" requests older than
    // `action_request_timeout_minutes` (read from device-preferences):
    //
    //   keep         → no-op (device skipped entirely; this is the default).
    //   auto_dismiss → mark the request dismissed + tell the emitting agent its
    //                  request timed out and was auto-skipped; emit
    //                  'action_request:changed' kind='dismissed'.
    //   safe_default → call resolveActionRequest with a safe-default answer, so it
    //                  resolves + notifies the emitter + emits kind='resolved'
    //                  identically to a human answer; the agent continues.
    //   consensus    → trigger ONE bot-to-bot consensus round (does NOT resolve):
    //                    1. stamp consensus_triggered_at (so it never re-fires);
    //                    2. broadcast a zh consensus prompt to every bound entity
    //                       on the device (the emitter included);
    //                    3. emit 'action_request:changed' kind='consensus_triggered'
    //                       (a NEW socket kind — frontend shows "協商中").
    //
    // AUTO-EXECUTE CONTRACT (Hank's decision — no user confirmation):
    //   The server worker's job is detect-timeout → trigger-round → mark. The
    //   *synthesis + resolution* is the agent layer: the emitting agent
    //   (#from_entity_id), on seeing the consensus prompt, collects the other
    //   entities' replies, synthesizes the consensus decision, and calls
    //   POST /api/action-requests/:id/resolve with that answer. Because resolve
    //   has no user gate, that auto-executes the decision. The worker never
    //   resolves a consensus request itself — it only opens the round once.
    //
    // Resilience: each device + each request is wrapped in try/catch so one bad
    // row never aborts the sweep. Exported for direct test invocation. The
    // periodic timer is registered once at module init (NODE_ENV !== 'test').
    // ══════════════════════════════════════════════════════════════════════
    async function enforceActionRequestTimeouts() {
        let deviceIds = [];
        try {
            const r = await pool.query(
                `SELECT DISTINCT device_id FROM agent_action_requests WHERE status = 'pending'`
            );
            deviceIds = r.rows.map(row => row.device_id).filter(Boolean);
        } catch (err) {
            console.error('[AgentActionRequests] timeout sweep: device scan failed:', err.message);
            return;
        }

        for (const deviceId of deviceIds) {
            try {
                let prefs = {};
                try { prefs = (await readDevicePrefs(deviceId)) || {}; } catch (_) { prefs = {}; }
                const policy = prefs.action_request_timeout_policy || 'keep';
                if (policy === 'keep') continue; // default: never auto-act
                const minutesRaw = prefs.action_request_timeout_minutes;
                const minutes = Number.isFinite(Number(minutesRaw)) ? Number(minutesRaw) : 1440;

                // Pending requests older than the timeout. For consensus, also skip
                // ones we've already opened a round for (consensus_triggered_at set).
                let sql = `SELECT * FROM agent_action_requests
                            WHERE device_id = $1 AND status = 'pending'
                              AND created_at < NOW() - ($2 * interval '1 minute')`;
                if (policy === 'consensus') sql += ` AND consensus_triggered_at IS NULL`;
                sql += ` ORDER BY created_at ASC LIMIT ${MAX_LIST_LIMIT}`;
                const res = await pool.query(sql, [deviceId, minutes]);
                const rows = res.rows || [];
                if (rows.length === 0) continue;

                const device = devices && devices[deviceId];

                for (const row of rows) {
                    try {
                        if (policy === 'auto_dismiss') {
                            const upd = await pool.query(
                                `UPDATE agent_action_requests
                                    SET status = 'dismissed', resolved_at = NOW()
                                  WHERE id = $1 AND status = 'pending'
                                RETURNING *`,
                                [row.id]
                            );
                            if (upd.rows.length === 0) continue; // raced/already acted
                            emitChanged(deviceId, 'dismissed', row.id, row.from_entity_id);
                            const emitter = device && device.entities && device.entities[row.from_entity_id];
                            pushTextToEntity(
                                deviceId, emitter, 'action_request_timeout_dismissed',
                                `[逾時自動略過] 你的請求逾時未回覆，已自動略過：「${row.prompt}」(request ${row.id})`,
                                { requestId: row.id }
                            );
                            log('info', `timeout auto_dismiss id=${row.id} from=${row.from_entity_id}`, { deviceId });
                        } else if (policy === 'safe_default') {
                            // Reuse the shared resolve path so it resolves + notifies
                            // the emitter + emits kind='resolved' exactly like a human.
                            await resolveActionRequest(
                                deviceId, row.id,
                                { text: '[安全預設] 逾時未回覆，agent 以安全預設續跑', auto: true, reason: 'timeout_safe_default' },
                                device
                            );
                            log('info', `timeout safe_default id=${row.id} from=${row.from_entity_id}`, { deviceId });
                        } else if (policy === 'consensus') {
                            // 1. Stamp the marker first (guarded) so it never re-fires.
                            const stamp = await pool.query(
                                `UPDATE agent_action_requests
                                    SET consensus_triggered_at = NOW()
                                  WHERE id = $1 AND status = 'pending' AND consensus_triggered_at IS NULL
                                RETURNING *`,
                                [row.id]
                            );
                            if (stamp.rows.length === 0) continue; // raced / already opened
                            // 2. Broadcast the consensus prompt to all bound entities.
                            const consensusMsg =
                                `[協商共識] 請求逾時需多方共識：「${row.prompt}」` +
                                `(發起：#${row.from_entity_id})。請各實體表態，` +
                                `由 #${row.from_entity_id} 綜合後直接 resolve 此請求` +
                                `(requestId=${row.id}) 以自動執行決定。`;
                            const entities = (device && device.entities) || {};
                            for (const ent of Object.values(entities)) {
                                pushTextToEntity(deviceId, ent, 'action_request_consensus', consensusMsg, { requestId: row.id });
                            }
                            // 3. New socket kind so the frontend can show "協商中".
                            emitChanged(deviceId, 'consensus_triggered', row.id, row.from_entity_id);
                            log('info', `timeout consensus_triggered id=${row.id} from=${row.from_entity_id}`, { deviceId });
                        }
                    } catch (rowErr) {
                        console.error(`[AgentActionRequests] timeout enforce failed id=${row.id}:`, rowErr.message);
                    }
                }
            } catch (devErr) {
                console.error(`[AgentActionRequests] timeout sweep failed device=${deviceId}:`, devErr.message);
            }
        }
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
        // The bot path's auth.entityId is already vetted by authenticate(); only the
        // user (deviceSecret) path names an arbitrary fromEntityId, so confirm it is
        // a real bound entity on THIS device (finding #5). device.entities keys may
        // be string- or int-typed — check both forms.
        if (auth.isUser) {
            const ents = auth.device && auth.device.entities;
            const known = ents && (
                Object.prototype.hasOwnProperty.call(ents, String(fromEntityId)) ||
                Object.prototype.hasOwnProperty.call(ents, fromEntityId)
            );
            if (!known) {
                return res.status(400).json({ success: false, error: 'fromEntityId is not a known entity on this device' });
            }
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
        // Bound the options payload (finding #4). prompt is already capped at
        // MAX_PROMPT_LEN; this mirrors that with a clearer error than the global
        // body-parser cap. Defense-in-depth.
        if (Array.isArray(options) && (options.length > 50 || JSON.stringify(options).length > 8192)) {
            return res.status(400).json({ success: false, error: 'options too large (max 50 items / 8KB)' });
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
            emitChanged(deviceId, 'emitted', row.id, row.from_entity_id);
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
            // A botSecret holder may only resolve its OWN emitted requests; the
            // human (isUser/deviceSecret) owns the whole device inbox (finding #3).
            const restrictToEntityId = auth.isUser ? null : auth.entityId;
            const row = await resolveActionRequest(deviceId, id, answer, device, restrictToEntityId);
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
            // A botSecret holder may only dismiss its OWN emitted requests; the
            // human (isUser/deviceSecret) owns the whole device inbox (finding #3).
            const params = [id, deviceId];
            let sql = `UPDATE agent_action_requests
                    SET status = 'dismissed', resolved_at = NOW()
                  WHERE id = $1 AND device_id = $2 AND status = 'pending'`;
            if (!auth.isUser) {
                params.push(auth.entityId);
                sql += ` AND from_entity_id = $${params.length}`;
            }
            sql += ` RETURNING *`;
            const result = await pool.query(sql, params);
            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Not found or already resolved/dismissed' });
            }
            const row = result.rows[0];
            log('info', `dismiss id=${id}`, { deviceId });
            emitChanged(deviceId, 'dismissed', row.id, row.from_entity_id);
            return res.json({ success: true, request: rowToApi(row) });
        } catch (err) {
            console.error('[AgentActionRequests] dismiss failed:', err.message);
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
    });

    // Register the periodic timeout sweep ONCE per process (card_ce0d685b).
    // Skipped under test (jest calls enforceActionRequestTimeouts directly). The
    // module-level guard stops a re-`require` / multi-factory-call from stacking
    // intervals. Failures are swallowed so the timer never crashes the process.
    if (process.env.NODE_ENV !== 'test' && !timeoutSweepTimer) {
        timeoutSweepTimer = setInterval(() => {
            enforceActionRequestTimeouts().catch(() => {});
        }, TIMEOUT_SWEEP_INTERVAL_MS);
        if (typeof timeoutSweepTimer.unref === 'function') timeoutSweepTimer.unref();
    }

    return {
        router,
        initDatabase: initAgentActionRequestsDatabase,
        // Shared resolve so /api/client/speak can auto-resolve a request a
        // smart-quote reply answers (card_b51598b7). Device-scoped, pending-only,
        // + best-effort agent push-back. Returns the row, or null on no-match.
        resolveActionRequest,
        // Timeout-policy worker (card_ce0d685b). Exported so tests + an external
        // scheduler can invoke a sweep directly.
        enforceActionRequestTimeouts,
        _pool: pool,
    };
};

module.exports.initAgentActionRequestsDatabase = initAgentActionRequestsDatabase;
