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
// 計畫E ratify-loop (card_e9d01b6e): the fail-CLOSED green-light predicate that
// decides whether an agent-consensus decision may be armed for *passive
// default-agree* (silence ⇒ the decided option ships). NEVER trust an agent's
// claimed mode — the server recomputes it here (PUT) and again at fire time
// (worker). See ratify-reversibility.js for the design invariant.
const { classifyRatifyMode } = require('./agent-improvement/ratify-reversibility');

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

// 計畫E ratify-loop (card_e9d01b6e). N-cap: after this many *armed* default_agree
// rounds for one request, the server refuses to re-arm (forces hold) — a redo
// loop can't silently auto-merge forever. Server-enforced via the audit trail
// (not agent self-report). Default grace window before a default_agree row is
// auto-resolved by silence reuses the 24h (1440-min) timeout default.
const MAX_RATIFY_RETRIES = 2;
const RATIFY_DEFAULT_GRACE_MINUTES = 1440;

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

    // ── Idempotent column migration: related_card_id (計畫D, card_df646877) ──
    // Optional kanban-card reference an agent can attach to a request so the inbox
    // can render a "🗂 任務卡" deep-link chip. The prod table already exists, so the
    // CREATE TABLE above is a no-op; this ALTER adds the column to the live table.
    // ADD COLUMN IF NOT EXISTS is a no-op once present. Best-effort: never throws.
    try {
        await pool.query(
            `ALTER TABLE agent_action_requests
                ADD COLUMN IF NOT EXISTS related_card_id VARCHAR(64) DEFAULT NULL`
        );
    } catch (err) {
        console.error('[AgentActionRequests] related_card_id migration skipped:', err.message);
    }

    // ── Idempotent column migration: decision_context (owner-decision classifier) ──
    // JSONB blob the server attaches when it auto-surfaces an owner-only
    // review/blocked child card: {whatWasDone, recommendation, evidence, recommended
    // OptionIndex}. The prod table already exists, so the CREATE TABLE above is a
    // no-op; this ALTER adds the column to the live table. ADD COLUMN IF NOT EXISTS
    // is a no-op once present. Best-effort: never throws/crashes init.
    try {
        await pool.query(
            `ALTER TABLE agent_action_requests
                ADD COLUMN IF NOT EXISTS decision_context JSONB DEFAULT NULL`
        );
    } catch (err) {
        console.error('[AgentActionRequests] decision_context migration skipped:', err.message);
    }
}

// ── Helpers ──
function normalizeAnchor(value) {
    if (typeof value === 'string' && UUID_RE.test(value.trim())) return value.trim();
    return null;
}

// Optional related_card_id (計畫D, card_df646877): a kanban card reference.
// Shared by the create (POST /) and edit (PUT /:id) paths so the rule is stated
// once. Returns { ok, value }: value is a trimmed non-empty string or null.
//   undefined | null            → { ok: true,  value: null }   (none / clear)
//   string ≤ 64 chars           → { ok: true,  value: <trim|null> }
//   non-string | string > 64    → { ok: false }
function validateRelatedCardId(value) {
    if (value === undefined || value === null) return { ok: true, value: null };
    if (typeof value !== 'string' || value.length > 64) return { ok: false, value: null };
    return { ok: true, value: value.trim() || null };
}

// Optional decision_context (owner-decision classifier): a JSONB blob the server
// attaches when it auto-surfaces an owner-only review/blocked card. Shape:
//   {whatWasDone, recommendation, evidence:[{label,url,kind}], recommendedOptionIndex}
// Shared by the create (POST /) and edit (PUT /:id) paths. Returns { ok, value }
// where `value` is a JSON STRING (ready for a ::jsonb cast) or null:
//   undefined | null              → { ok: true,  value: null }   (none / clear)
//   plain object, JSON ≤ 8192     → { ok: true,  value: <json-string> }
//   non-object | JSON > 8192      → { ok: false }
function validateDecisionContext(value) {
    if (value === undefined || value === null) return { ok: true, value: null };
    if (typeof value !== 'object' || Array.isArray(value)) return { ok: false, value: null };
    let json;
    try { json = JSON.stringify(value); } catch (_) { return { ok: false, value: null }; }
    if (json == null || json.length > 8192) return { ok: false, value: null };
    return { ok: true, value: json };
}

// 計畫E ratify-loop (card_e9d01b6e). Build the RatifyInput the green-light
// predicate expects from a request's prompt + its decisionContext.ratify block.
function ratifyInputFrom(prompt, ratify) {
    const r = (ratify && typeof ratify === 'object') ? ratify : {};
    return {
        proposalText: typeof prompt === 'string' ? prompt : '',
        decidedOptionLabel: typeof r.decidedOptionLabel === 'string' ? r.decidedOptionLabel : '',
        reversibilityClass: r.reversibilityClass,
        changedFiles: Array.isArray(r.changedFiles) ? r.changedFiles : undefined,
        diffSummary: typeof r.diffSummary === 'string' ? r.diffSummary : undefined,
        prUrl: r.prUrl,
        relatedCardText: typeof r.relatedCardText === 'string' ? r.relatedCardText : '',
    };
}

// 計畫E ratify-loop (card_e9d01b6e). SERVER-AUTHORITATIVE recompute of a ratify
// block's mode. NEVER trusts the agent-supplied `mode` — recomputes it via the
// fail-closed green-light predicate, then applies the N-cap from the AUDIT trail
// (how many prior default_agree arms this request already has). Returns a NEW
// ratify object with server-stamped {mode, holdReasons, serverComputed, armedAt}.
// `armedAt` is refreshed only when the new mode is default_agree (it anchors the
// silence-grace window in the worker); a hold clears it.
//   - mode='default_agree' ONLY when classifyRatifyMode says so AND prior arms < N
//   - any predicate hold, classifier veto, or retry-cap → mode='hold'
async function recomputeRatifyMode(client, requestId, prompt, ratify, nowMs) {
    const r = (ratify && typeof ratify === 'object') ? { ...ratify } : {};
    const verdict = classifyRatifyMode(ratifyInputFrom(prompt, r));
    let mode = verdict.mode;
    const holdReasons = [...(verdict.holdReasons || [])];

    // N-cap (server-enforced, reconstructed from the immutable audit trail — not
    // the agent's self-reported attempt counter). Count how many prior PUTs armed
    // a default_agree ratify on THIS request; if we are at/over the cap, refuse.
    let priorArms = 0;
    try {
        const c = await client.query(
            `SELECT COUNT(*)::int AS n FROM agent_action_request_audit
              WHERE request_id = $1
                AND changes #>> '{decisionContext,new,ratify,mode}' = 'default_agree'`,
            [requestId]
        );
        priorArms = (c.rows[0] && c.rows[0].n) || 0;
    } catch (_) {
        // Fail-closed: if we cannot establish the count, do not arm.
        priorArms = MAX_RATIFY_RETRIES;
        holdReasons.push('retry_count_unavailable');
    }
    if (mode === 'default_agree' && priorArms >= MAX_RATIFY_RETRIES) {
        mode = 'hold';
        holdReasons.push(`retry_cap_reached:${priorArms}/${MAX_RATIFY_RETRIES}`);
    }

    r.mode = mode;
    r.holdReasons = holdReasons;
    r.serverComputed = true;
    r.priorArms = priorArms;
    r.armedAt = mode === 'default_agree' ? nowMs : null;
    return r;
}

function rowToApi(row) {
    return {
        id: row.id,
        fromEntityId: row.from_entity_id,
        anchorMessageId: row.anchor_message_id || null,
        type: row.type,
        prompt: row.prompt,
        options: row.options || null,
        relatedCardId: row.related_card_id || null,
        decisionContext: row.decision_context || null,
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
    //                               | 'consensus_triggered' | 'edited'
    //                requestId    : the agent_action_requests row UUID (string)
    //                fromEntityId : the emitting entity id (integer)
    //              NEW kind 'edited' (card_cd4f323c): an agent edited the
    //              request's content (prompt/options/type) via PUT. The inbox
    //              should re-fetch to show the updated text.
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

    // Core create: insert ONE request row + emit 'emitted'. Shared by the HTTP
    // POST / route AND the kanban owner-decision auto-surface hook (子3/子4) so
    // there is exactly one INSERT code path. INPUT VALIDATION IS THE CALLER'S
    // JOB: the HTTP route validates + caps every field; the kanban hook passes
    // already-shaped server-built values. `options`/`decisionContext` may be a
    // JS value (stringified here) or an already-serialized JSON string.
    // Returns the created row in rowToApi() shape. Throws only on DB error.
    async function createActionRequest({
        deviceId, fromEntityId, type, prompt, options,
        anchorMessageId, relatedCardId, decisionContext,
    } = {}) {
        const anchor = normalizeAnchor(anchorMessageId);
        const optionsJson = options != null
            ? (typeof options === 'string' ? options : JSON.stringify(options))
            : null;
        const decisionJson = decisionContext != null
            ? (typeof decisionContext === 'string' ? decisionContext : JSON.stringify(decisionContext))
            : null;
        const result = await pool.query(
            `INSERT INTO agent_action_requests
                (device_id, from_entity_id, anchor_message_id, type, prompt, options, related_card_id, decision_context)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)
             RETURNING *`,
            [deviceId, fromEntityId, anchor, type, prompt, optionsJson, relatedCardId != null ? relatedCardId : null, decisionJson]
        );
        const row = result.rows[0];
        emitChanged(deviceId, 'emitted', row.id, row.from_entity_id);
        return rowToApi(row);
    }

    // Owner-decision lifecycle (子6a): when a kanban card leaves review/blocked,
    // dismiss any still-pending OWNER-DECISION request(s) for it. We only touch
    // rows the move-hook created — decision_context IS NOT NULL — so an agent's
    // ordinary request that merely references the same card is left untouched.
    // Device-scoped; emits 'dismissed' per row on the SAME socket contract as the
    // HTTP dismiss so the inbox live-refreshes. Returns the dismissed rows.
    // Throws only on a DB error (the kanban hook wraps the call in try/catch).
    async function dismissActionRequestsForCard(deviceId, cardId) {
        if (!deviceId || !cardId) return [];
        const upd = await pool.query(
            `UPDATE agent_action_requests
                SET status = 'dismissed', resolved_at = NOW()
              WHERE device_id = $1 AND related_card_id = $2
                AND status = 'pending' AND decision_context IS NOT NULL
            RETURNING *`,
            [deviceId, cardId]
        );
        for (const row of (upd.rows || [])) {
            emitChanged(deviceId, 'dismissed', row.id, row.from_entity_id);
        }
        return upd.rows || [];
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
    // ══════════════════════════════════════════════════════════════════════
    // 計畫E RATIFY PASS (card_e9d01b6e) — passive default-agree on silence.
    // ──────────────────────────────────────────────────────────────────────
    // DARK-LAUNCH: runs ONLY when a device has explicitly set the new pref
    // `action_request_ratify_enabled === true` (default undefined/false ⇒ no-op).
    //
    // For each pending request whose decision_context.ratify was armed
    // default_agree (server-stamped — see recomputeRatifyMode) and whose silence
    // grace window has elapsed, this RE-RUNS the fail-closed green-light at fire
    // time and, only if it still says default_agree, resolves the request with the
    // decided option as the answer (silence ⇒ agree → the emitting agent merges
    // its PR). If anything drifted (class/path/diff/veto), it HOLDS — never
    // resolves. This is a SEPARATE pass from the timeout-policy worker so it is not
    // skipped by 'keep' and not blocked by the decision_context pin (which keeps
    // every OTHER owner-decision row waiting for Hank).
    //
    // Stacked safety: dark-default-off; matches ratify.mode==='default_agree'
    // EXACTLY; re-derives the verdict at fire time; the N-cap already capped how
    // many times it could be armed (PUT handler); grace anchored to armedAt.
    // ══════════════════════════════════════════════════════════════════════
    async function runRatifyPass(deviceId, prefs, device) {
        if (!prefs || prefs.action_request_ratify_enabled !== true) return; // dark launch
        const graceRaw = prefs.action_request_ratify_grace_minutes;
        const graceMin = Number.isFinite(Number(graceRaw)) ? Number(graceRaw) : RATIFY_DEFAULT_GRACE_MINUTES;
        const graceMs = graceMin * 60 * 1000;
        const nowMs = Date.now();

        let rows = [];
        try {
            const r = await pool.query(
                `SELECT * FROM agent_action_requests
                  WHERE device_id = $1 AND status = 'pending'
                    AND decision_context #>> '{ratify,planE}' = 'true'
                    AND decision_context #>> '{ratify,mode}' = 'default_agree'
                  ORDER BY created_at ASC LIMIT ${MAX_LIST_LIMIT}`,
                [deviceId]
            );
            rows = r.rows || [];
        } catch (err) {
            console.error(`[AgentActionRequests] ratify pass query failed device=${deviceId}:`, err.message);
            return;
        }

        for (const row of rows) {
            try {
                const dc = row.decision_context || {};
                const ratify = (dc && typeof dc === 'object' && dc.ratify) || {};
                // Silence grace anchored to when default_agree was armed, not emit time.
                const armedAt = Number(ratify.armedAt);
                if (!Number.isFinite(armedAt) || (nowMs - armedAt) < graceMs) continue;
                // RE-RUN the fail-closed green-light at fire time. Any drift ⇒ HOLD,
                // never resolve (the whole point of double fail-closed).
                const verdict = classifyRatifyMode(ratifyInputFrom(row.prompt, ratify));
                if (verdict.mode !== 'default_agree') {
                    log('info', `ratify fire-time gate HOLD id=${row.id}: ${verdict.holdReasons.join(';')}`, { deviceId });
                    continue;
                }
                const answer = typeof ratify.decidedOptionLabel === 'string' ? ratify.decidedOptionLabel : '';
                // Resolve via the shared path → notifies the emitter + emits
                // kind='resolved' identically to a human answer; the agent merges.
                await resolveActionRequest(
                    deviceId, row.id,
                    { text: `[計畫E 追認] 靜默逾時視同同意，依追認決定續跑：${answer}`, auto: true, reason: 'ratify_default_agree' },
                    device
                );
                log('info', `ratify default_agree resolved id=${row.id} from=${row.from_entity_id}`, { deviceId });
            } catch (rowErr) {
                console.error(`[AgentActionRequests] ratify resolve failed id=${row.id}:`, rowErr.message);
            }
        }
    }

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
                // 計畫E (card_e9d01b6e): run the independent ratify pass FIRST — it is
                // gated on its own dark-launch pref (action_request_ratify_enabled),
                // must not be skipped by 'keep', and must run before the
                // decision_context pin below (which keeps every OTHER owner-decision
                // row waiting for Hank). Failure-isolated so it never aborts the sweep.
                try { await runRatifyPass(deviceId, prefs, devices && devices[deviceId]); }
                catch (e) { console.error(`[AgentActionRequests] ratify pass failed device=${deviceId}:`, e.message); }
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
                        // 子6(b): owner-decision items (decision_context non-null) are
                        // PINNED to 'keep' semantics — they wait for Hank and must
                        // NEVER be auto_dismissed / safe_defaulted / consensus-routed
                        // by the timeout worker, regardless of the device's policy.
                        if (row.decision_context != null) continue;
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
        // Optional kanban-card reference (計畫D): string ≤64 chars or null.
        const relCard = validateRelatedCardId(req.body.relatedCardId);
        if (!relCard.ok) {
            return res.status(400).json({ success: false, error: 'relatedCardId must be a string of max 64 chars or null' });
        }
        // Optional owner-decision context: a plain object whose JSON is ≤8192
        // bytes, or null (mirrors the related_card_id validation + the 8KB cap on
        // options). Returns a ready-to-cast JSON string or null.
        const decCtx = validateDecisionContext(req.body.decisionContext);
        if (!decCtx.ok) {
            return res.status(400).json({ success: false, error: 'decisionContext must be an object whose JSON is at most 8192 bytes, or null' });
        }

        try {
            // Shared INSERT path (子3) — same code the kanban hook calls.
            const apiRow = await createActionRequest({
                deviceId,
                fromEntityId,
                type,
                prompt,
                options: options != null ? options : null,
                anchorMessageId,
                relatedCardId: relCard.value,
                decisionContext: decCtx.value,
            });
            log('info', `emit id=${apiRow.id} from=${fromEntityId} type=${type}`, { deviceId });
            return res.json({ success: true, request: apiRow });
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

    // ════════════════════════════════════════
    // PUT /:id — edit a pending request's CONTENT (card_cd4f323c)
    // ──────────────────────────────────────────────────────────────────────
    // Hank's decisions 2026-06-26:
    //   opt1 編輯語意: an agent may edit the prompt text, options/choices, and
    //                 type of an EXISTING request (partial — send any subset).
    //   opt2 權限範圍: CROSS-AGENT. ANY valid agent on the device may edit ANY
    //                 request — we deliberately do NOT restrict to from_entity_id
    //                 (unlike resolve/dismiss, which gate botSecret holders to
    //                 their own requests via restrictToEntityId). That cross-
    //                 agent power is a tampering risk, so EVERY successful edit
    //                 writes one agent_action_request_audit row (editorEntityId +
    //                 per-field old→new) in the SAME transaction as the UPDATE.
    // Only 'pending' requests are editable (mirrors the resolve/dismiss guard).
    // Validation of each provided field reuses the create-path rules verbatim.
    // ════════════════════════════════════════
    router.put('/:id', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId } = auth;
        const { id } = req.params;
        if (!UUID_RE.test(String(id))) {
            return res.status(400).json({ success: false, error: 'Invalid id' });
        }

        const body = req.body || {};
        const hasType = Object.prototype.hasOwnProperty.call(body, 'type');
        const hasPrompt = Object.prototype.hasOwnProperty.call(body, 'prompt');
        const hasOptions = Object.prototype.hasOwnProperty.call(body, 'options');
        const hasRelatedCardId = Object.prototype.hasOwnProperty.call(body, 'relatedCardId');
        const hasDecisionContext = Object.prototype.hasOwnProperty.call(body, 'decisionContext');
        if (!hasType && !hasPrompt && !hasOptions && !hasRelatedCardId && !hasDecisionContext) {
            return res.status(400).json({ success: false, error: 'Provide at least one editable field: prompt, options, type, relatedCardId, decisionContext' });
        }
        // Validate each PROVIDED field with the exact same rules as POST / (create).
        if (hasType && (typeof body.type !== 'string' || !VALID_TYPES.has(body.type))) {
            return res.status(400).json({ success: false, error: `type must be one of: ${[...VALID_TYPES].join('|')}` });
        }
        if (hasPrompt && (typeof body.prompt !== 'string' || body.prompt.length < 1 || body.prompt.length > MAX_PROMPT_LEN)) {
            return res.status(400).json({ success: false, error: `prompt must be a string of length 1..${MAX_PROMPT_LEN}` });
        }
        if (hasOptions) {
            if (body.options !== null && !Array.isArray(body.options)) {
                return res.status(400).json({ success: false, error: 'options must be an array or null' });
            }
            if (Array.isArray(body.options) && (body.options.length > 50 || JSON.stringify(body.options).length > 8192)) {
                return res.status(400).json({ success: false, error: 'options too large (max 50 items / 8KB)' });
            }
        }
        // related_card_id (計畫D): string ≤64 or null (null clears the link).
        let relatedCardIdNew = null;
        if (hasRelatedCardId) {
            const relCard = validateRelatedCardId(body.relatedCardId);
            if (!relCard.ok) {
                return res.status(400).json({ success: false, error: 'relatedCardId must be a string of max 64 chars or null' });
            }
            relatedCardIdNew = relCard.value;
        }
        // decision_context (owner-decision classifier): object ≤8192 JSON or null
        // (null clears it). Lets the commander refine the surfaced context.
        let decisionContextNew = null; // JSON string or null
        if (hasDecisionContext) {
            const decCtx = validateDecisionContext(body.decisionContext);
            if (!decCtx.ok) {
                return res.status(400).json({ success: false, error: 'decisionContext must be an object whose JSON is at most 8192 bytes, or null' });
            }
            decisionContextNew = decCtx.value;
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            // Lock the target row; device-scoped. Cross-agent (opt2): NO
            // from_entity_id filter — any agent on the device may edit it.
            const cur = await client.query(
                `SELECT * FROM agent_action_requests
                  WHERE id = $1 AND device_id = $2
                  FOR UPDATE`,
                [id, deviceId]
            );
            if (cur.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ success: false, error: 'Not found' });
            }
            const before = cur.rows[0];
            if (before.status !== 'pending') {
                await client.query('ROLLBACK');
                return res.status(409).json({ success: false, error: 'Only pending requests can be edited' });
            }

            // 計畫E ratify-loop (card_e9d01b6e): if this edit arms a ratify block
            // (decisionContext.ratify.planE), the server RE-DERIVES its mode here —
            // the agent's claimed mode is never trusted. classifyRatifyMode is
            // fail-closed and the N-cap is read from the audit trail (same txn, row
            // already locked). The recomputed block (with server-stamped mode /
            // holdReasons / armedAt) replaces what the agent sent.
            if (hasDecisionContext && decisionContextNew != null) {
                let dcObj = null;
                try { dcObj = JSON.parse(decisionContextNew); } catch (_) { dcObj = null; }
                if (dcObj && dcObj.ratify && typeof dcObj.ratify === 'object' && dcObj.ratify.planE === true) {
                    const nowMs = Date.now();
                    dcObj.ratify = await recomputeRatifyMode(client, id, before.prompt, dcObj.ratify, nowMs);
                    decisionContextNew = JSON.stringify(dcObj);
                    // Re-check the 8KB cap after the server stamp (holdReasons grow it).
                    if (decisionContextNew.length > 8192) {
                        await client.query('ROLLBACK');
                        return res.status(400).json({ success: false, error: 'decisionContext too large after server ratify stamp' });
                    }
                }
            }

            // Build the partial UPDATE + the per-field old→new change set. Only
            // fields whose value ACTUALLY changes are written / audited.
            const sets = [];
            const params = [];
            const changes = {};
            if (hasType && body.type !== before.type) {
                params.push(body.type); sets.push(`type = $${params.length}`);
                changes.type = { old: before.type, new: body.type };
            }
            if (hasPrompt && body.prompt !== before.prompt) {
                params.push(body.prompt); sets.push(`prompt = $${params.length}`);
                changes.prompt = { old: before.prompt, new: body.prompt };
            }
            if (hasOptions) {
                const newOpts = body.options != null ? JSON.stringify(body.options) : null;
                const oldOpts = before.options != null ? JSON.stringify(before.options) : null;
                if (newOpts !== oldOpts) {
                    params.push(newOpts); sets.push(`options = $${params.length}::jsonb`);
                    changes.options = { old: before.options ?? null, new: body.options ?? null };
                }
            }
            if (hasRelatedCardId) {
                const oldRel = before.related_card_id ?? null;
                if (relatedCardIdNew !== oldRel) {
                    params.push(relatedCardIdNew); sets.push(`related_card_id = $${params.length}`);
                    changes.relatedCardId = { old: oldRel, new: relatedCardIdNew };
                }
            }
            if (hasDecisionContext) {
                const oldDc = before.decision_context != null ? JSON.stringify(before.decision_context) : null;
                if (decisionContextNew !== oldDc) {
                    params.push(decisionContextNew); sets.push(`decision_context = $${params.length}::jsonb`);
                    changes.decisionContext = {
                        old: before.decision_context ?? null,
                        new: decisionContextNew != null ? JSON.parse(decisionContextNew) : null,
                    };
                }
            }

            // No effective change → 200 with the row, no audit row written.
            if (sets.length === 0) {
                await client.query('COMMIT');
                return res.json({ success: true, request: rowToApi(before), changed: false });
            }

            params.push(id);
            const upd = await client.query(
                `UPDATE agent_action_requests SET ${sets.join(', ')}
                  WHERE id = $${params.length}
                RETURNING *`,
                params
            );
            const after = upd.rows[0];

            // Audit row — SAME transaction as the UPDATE (opt2 mitigation).
            // editor_entity_id is the bot's entity id, or NULL for a human edit.
            await client.query(
                `INSERT INTO agent_action_request_audit
                    (request_id, device_id, editor_entity_id, changes)
                 VALUES ($1, $2, $3, $4::jsonb)`,
                [id, deviceId, auth.entityId, JSON.stringify(changes)]
            );
            await client.query('COMMIT');

            log('info', `edit id=${id} editor=${auth.entityId ?? 'user'} fields=${Object.keys(changes).join(',')}`, { deviceId });
            emitChanged(deviceId, 'edited', after.id, after.from_entity_id);
            return res.json({ success: true, request: rowToApi(after), changed: true });
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            console.error('[AgentActionRequests] edit failed:', err.message);
            log('error', `edit failed id=${id}: ${err.message}`, { deviceId });
            return res.status(500).json({ success: false, error: 'Internal error' });
        } finally {
            client.release();
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
        // Shared create path (子3) so the kanban move-hook can auto-surface an
        // owner-only review/blocked card into this inbox via the SAME INSERT +
        // 'emitted' socket emit the HTTP route uses. Caller validates inputs.
        createActionRequest,
        // Owner-decision lifecycle (子6a): kanban calls this when a card leaves
        // review/blocked to auto-dismiss its pending owner-decision request(s) +
        // emit the 'dismissed' socket event.
        dismissActionRequestsForCard,
        _pool: pool,
    };
};

module.exports.initAgentActionRequestsDatabase = initAgentActionRequestsDatabase;
// 計畫E (card_e9d01b6e): exported for unit tests — the SERVER-authoritative ratify
// recompute (fail-closed mode + audit-trail N-cap) and its input builder.
module.exports.recomputeRatifyMode = recomputeRatifyMode;
module.exports.ratifyInputFrom = ratifyInputFrom;
module.exports.MAX_RATIFY_RETRIES = MAX_RATIFY_RETRIES;
