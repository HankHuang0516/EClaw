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
// 計畫E adjustable params (card_c3d48c4607ee753b2c98e04b). The N-cap and the
// silence grace are device prefs (action_request_ratify_max_attempts /
// action_request_ratify_grace_minutes). These bounds are the worker-side
// DEFENSIVE re-clamp so a junk/out-of-range pref can never disable the cap or
// make the auto-ratify timer fire too eagerly. The cap default reuses
// MAX_RATIFY_RETRIES; the grace default reuses RATIFY_DEFAULT_GRACE_MINUTES.
const RATIFY_MAX_ATTEMPTS_MIN = 1;
const RATIFY_MAX_ATTEMPTS_MAX = 5;
const RATIFY_GRACE_MINUTES_MIN = 60;     // never auto-ratify faster than 1h
const RATIFY_GRACE_MINUTES_MAX = 10080;  // 7 days

// ══════════════════════════════════════════════════════════════════════════
// 需要你 NEGOTIATION / CONSENSUS WORKFLOW (owner-approved build)
// ──────────────────────────────────────────────────────────────────────────
// A 需要你 item with options (and the device on the consensus policy + enough
// bound entities) opens a bot-to-bot negotiation round: entities VOTE → the
// task-owner entity (from_entity_id) SYNTHESIZES a best answer → it is written
// back to the inbox item (SURFACED, never auto-executed) → the owner disposes.
// Never hangs (server fallback after a grace window); never auto-executes an
// owner-only item (the owner-veto applies only at DISPOSITION).
//
// All tunables are device-prefs (clamped here so a junk pref never breaks the
// clock math). Defaults mirror device-preferences.js DEFAULTS.
const CONSENSUS_WINDOW_MIN_DEFAULT = 30;        // collect window (minutes)
const CONSENSUS_WINDOW_MIN_MIN = 1;
const CONSENSUS_WINDOW_MIN_MAX = 1440;
const CONSENSUS_SYNTH_GRACE_DEFAULT = 360;      // owner-synth grace (minutes)
const CONSENSUS_SYNTH_GRACE_MIN = 5;
const CONSENSUS_SYNTH_GRACE_MAX = 43200;
const CONSENSUS_MIN_ENTITIES_DEFAULT = 2;       // min bound entities to negotiate
const CONSENSUS_MIN_ENTITIES_MIN = 2;
const CONSENSUS_MIN_ENTITIES_MAX = 20;

function clampInt(raw, def, lo, hi) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return def;
    return Math.max(lo, Math.min(hi, n));
}
function clampWindowMinutes(raw) {
    return clampInt(raw, CONSENSUS_WINDOW_MIN_DEFAULT, CONSENSUS_WINDOW_MIN_MIN, CONSENSUS_WINDOW_MIN_MAX);
}
function clampSynthGraceMinutes(raw) {
    return clampInt(raw, CONSENSUS_SYNTH_GRACE_DEFAULT, CONSENSUS_SYNTH_GRACE_MIN, CONSENSUS_SYNTH_GRACE_MAX);
}
function clampMinEntities(raw) {
    return clampInt(raw, CONSENSUS_MIN_ENTITIES_DEFAULT, CONSENSUS_MIN_ENTITIES_MIN, CONSENSUS_MIN_ENTITIES_MAX);
}
// 計畫E adjustable params (card_c3d48c4607ee753b2c98e04b). Defensive runtime
// re-clamp of the two ratify tunables; junk/undefined → the safe default.
function clampRatifyMaxAttempts(raw) {
    return clampInt(raw, MAX_RATIFY_RETRIES, RATIFY_MAX_ATTEMPTS_MIN, RATIFY_MAX_ATTEMPTS_MAX);
}
function clampRatifyGraceMinutes(raw) {
    return clampInt(raw, RATIFY_DEFAULT_GRACE_MINUTES, RATIFY_GRACE_MINUTES_MIN, RATIFY_GRACE_MINUTES_MAX);
}

// Count entities bound on a device (the N in the k/N vote progress + the
// min-entities trigger gate). Tolerates a missing/odd device shape.
function countBoundEntities(device) {
    if (!device || !device.entities) return 0;
    let n = 0;
    for (const e of Object.values(device.entities)) {
        if (e && e.isBound) n++;
    }
    return n;
}

// Render one option to a human label. options[] may be strings or objects.
function optionLabel(o) {
    if (o == null) return '';
    if (typeof o === 'string') return o;
    if (typeof o === 'object') {
        if (typeof o.label === 'string') return o.label;
        if (typeof o.text === 'string') return o.text;
        if (typeof o.value === 'string') return o.value;
        try { return JSON.stringify(o); } catch (_) { return String(o); }
    }
    return String(o);
}

// TRIGGER predicate (encapsulated per the design). A row is negotiable when ALL
// hold: (1) device pref policy === 'consensus'; (2) options is an array len>=2;
// (3) device has >= consensus_min_entities bound entities; (4) status='pending'
// AND consensus_triggered_at IS NULL. decision_context does NOT block opening —
// owner-only items DO deliberate; the owner-veto applies only at DISPOSITION.
// An OWNER-decision request (decision_context.ownerOnly === true) is for Hank to
// resolve in the 需要你 inbox — it must NOT open a bot-to-bot consensus round.
// (Opening one buzzed every bound entity with a vote prompt the instant such an
// item was created — the flood Hank flagged.) decision_context arrives as a jsonb
// object off a DB row, but tolerate a raw string. (DELIVERY fix — owner reminders.)
function isOwnerOnlyDecision(decisionContext) {
    if (decisionContext == null) return false;
    let dc = decisionContext;
    if (typeof dc === 'string') {
        try { dc = JSON.parse(dc); } catch (_) { return false; }
    }
    return !!(dc && typeof dc === 'object' && dc.ownerOnly === true);
}

function isNegotiable(row, prefs, boundEntityCount) {
    if (!row || !prefs) return false;
    if (prefs.action_request_timeout_policy !== 'consensus') return false;
    if (row.status !== 'pending') return false;
    if (row.consensus_triggered_at != null) return false;
    // Owner decisions wait for Hank, never a bot vote (DELIVERY fix).
    if (isOwnerOnlyDecision(row.decision_context)) return false;
    const opts = row.options;
    if (!Array.isArray(opts) || opts.length < 2) return false;
    if (Number(boundEntityCount) < clampMinEntities(prefs.consensus_min_entities)) return false;
    return true;
}

// Deterministic plurality tally of vote rows. Returns {bestOptionIndex,count,total}.
//   - only votes carrying an integer option_index contribute to the option tally;
//     free-text-only votes still count toward `total`.
//   - tie → recommendedOptionIndex if it is among the tied set, else the LOWEST index.
//   - zero option-votes → bestOptionIndex = recommendedOptionIndex ?? null, count 0.
function tallyVotes(voteRows, optionsLen, recommendedOptionIndex) {
    const rows = Array.isArray(voteRows) ? voteRows : [];
    const total = rows.length;
    const recIdx = Number.isInteger(recommendedOptionIndex) ? recommendedOptionIndex : null;
    const counts = new Map();
    for (const v of rows) {
        const oi = v.option_index;
        if (Number.isInteger(oi)) counts.set(oi, (counts.get(oi) || 0) + 1);
    }
    if (counts.size === 0) {
        return { bestOptionIndex: recIdx, count: 0, total };
    }
    let max = -1;
    for (const c of counts.values()) if (c > max) max = c;
    const tied = [...counts.entries()].filter(([, c]) => c === max).map(([oi]) => oi);
    let bestOptionIndex;
    if (tied.length === 1) bestOptionIndex = tied[0];
    else if (recIdx != null && tied.includes(recIdx)) bestOptionIndex = recIdx;
    else bestOptionIndex = Math.min(...tied);
    return { bestOptionIndex, count: max, total };
}

// Shape vote rows for the API / negotiation.perEntity blob.
function votesToPerEntity(voteRows) {
    return (voteRows || []).map(v => ({
        entityId: v.entity_id,
        optionIndex: Number.isInteger(v.option_index) ? v.option_index : null,
        freeText: v.free_text || null,
        rationale: v.rationale || null,
    }));
}

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

    // ── Idempotent migration: negotiation/consensus workflow (需要你 negotiation) ──
    // consensus_collect_at = the collection window closed / owner prompted to
    // synthesize (S1→S2). negotiation = the TERMINAL synthesized conclusion blob
    // (non-null ⇒ concluded + surfaced, status STILL 'pending' until disposition).
    // Both additive + reversible; the committed migration lives in
    // migrations/20260627_action_request_negotiation.{up,down}.sql. ADD COLUMN IF
    // NOT EXISTS is a no-op once present. Best-effort: never throws/crashes init.
    try {
        await pool.query(
            `ALTER TABLE agent_action_requests
                ADD COLUMN IF NOT EXISTS consensus_collect_at TIMESTAMPTZ DEFAULT NULL`
        );
        await pool.query(
            `ALTER TABLE agent_action_requests
                ADD COLUMN IF NOT EXISTS negotiation JSONB DEFAULT NULL`
        );
    } catch (err) {
        console.error('[AgentActionRequests] negotiation columns migration skipped:', err.message);
    }

    // ── Idempotent: per-entity negotiation votes child table ──
    // One vote per (request, entity); last-write-wins via the UNIQUE constraint.
    try {
        await pool.query(
            `CREATE TABLE IF NOT EXISTS agent_action_request_votes (
                id BIGSERIAL PRIMARY KEY,
                request_id UUID NOT NULL,
                entity_id INTEGER NOT NULL,
                option_index INTEGER DEFAULT NULL,
                free_text TEXT DEFAULT NULL,
                rationale TEXT DEFAULT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                CONSTRAINT aar_votes_unique UNIQUE (request_id, entity_id)
            )`
        );
        await pool.query(
            `CREATE INDEX IF NOT EXISTS idx_aar_votes_request ON agent_action_request_votes(request_id)`
        );
    } catch (err) {
        console.error('[AgentActionRequests] votes table migration skipped:', err.message);
    }

    // ── Idempotent: owner-decision morning-digest dedup (DELIVERY fix) ──
    // One digest per (device, device-local-date). The 5-min sweep fires up to 12×
    // inside the digest hour and may run on multiple instances; the PK makes the
    // "send today's digest" decision win exactly once per day per device.
    try {
        await pool.query(
            `CREATE TABLE IF NOT EXISTS owner_decision_digest_sent (
                device_id TEXT NOT NULL,
                sent_date TEXT NOT NULL,
                sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                item_count INTEGER DEFAULT NULL,
                CONSTRAINT owner_digest_pk PRIMARY KEY (device_id, sent_date)
            )`
        );
    } catch (err) {
        console.error('[AgentActionRequests] owner_decision_digest_sent migration skipped:', err.message);
    }
}

// ── Helpers ──
function normalizeAnchor(value) {
    if (typeof value === 'string' && UUID_RE.test(value.trim())) return value.trim();
    return null;
}

// ── Cross-target integrity (需要你 inbox independence) ──
// The requestId an answer was COMPOSED FOR. The chat composer embeds the source
// request inside the answer payload (answer.replyContext.requestId; a top-level
// answer.requestId is also honored). resolveActionRequest + the /:id/resolve
// route use this to REFUSE writing one inbox item's answer onto a DIFFERENT
// request — one reply resolves exactly the item it targeted, never a neighbour.
// Returns a normalized (lower-cased) id string, or null when the answer carries
// no self-described target (worker safe-defaults, ratify decisions, option
// clicks, and plain-string answers → unguarded; they resolve normally).
function extractReplyTargetId(answer) {
    if (!answer || typeof answer !== 'object') return null;
    const rc = answer.replyContext;
    const cand = (rc && typeof rc === 'object' && rc.requestId) || answer.requestId || null;
    if (cand == null) return null;
    const s = String(cand).trim();
    return s ? s.toLowerCase() : null;
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
// The N-cap is now a device pref (action_request_ratify_max_attempts): the caller
// passes `maxAttempts`, defensively re-clamped here ([1,5], junk/undefined →
// MAX_RATIFY_RETRIES) so an out-of-range pref can never widen or disable the cap.
async function recomputeRatifyMode(client, requestId, prompt, ratify, nowMs, maxAttempts) {
    const cap = clampRatifyMaxAttempts(maxAttempts);
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
        priorArms = cap;
        holdReasons.push('retry_count_unavailable');
    }
    if (mode === 'default_agree' && priorArms >= cap) {
        mode = 'hold';
        holdReasons.push(`retry_cap_reached:${priorArms}/${cap}`);
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
        // Negotiation marker (card_ce0d685b): the timeout worker stamps this when
        // it opens a consensus round. Exposed (ms, matching the timestamps above;
        // null when the request was never negotiated) so clients can tell which
        // resolved rows were the product of a negotiation vs a plain human resolve.
        consensusTriggeredAt: row.consensus_triggered_at ? new Date(row.consensus_triggered_at).getTime() : null,
        // Negotiation workflow markers (需要你 negotiation). consensusCollectAt = the
        // collection window closed / owner was prompted to synthesize (ms or null).
        // negotiation = the TERMINAL conclusion blob; non-null ⇒ "協商完成 — 待裁決"
        // (status STILL 'pending' until the owner disposes / ratify auto-resolves).
        consensusCollectAt: row.consensus_collect_at ? new Date(row.consensus_collect_at).getTime() : null,
        negotiation: row.negotiation || null,
    };
}

/**
 * Factory. Matches the kanban/scheduled-messages module style so index.js wires it the same way.
 */
module.exports = function (devices, { pushToBot, unifiedPush, notifyDevice, serverLog, io, getDevicePrefs } = {}) {
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
    //                               | 'vote' | 'consensus_collecting'
    //                               | 'negotiation_concluded'
    //                requestId    : the agent_action_requests row UUID (string)
    //                fromEntityId : the emitting entity id (integer)
    //              需要你 negotiation kinds: 'vote' (an entity voted; payload also
    //              carries { votes:{count,total} } k/N), 'consensus_collecting'
    //              (collection window closed → owner prompted to synthesize),
    //              'negotiation_concluded' (a conclusion was written back; payload
    //              carries { fallback } — true=server tally, false=owner synth).
    //              The inbox should re-fetch on any of these.
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
    // `extra` (optional): additional fields merged into the payload — used by the
    // negotiation flow's kind='vote' to carry { votes: { count, total } } (k/N).
    // When omitted the payload is the exact { kind, requestId, fromEntityId } shape
    // the original contract guarantees (…{} spreads nothing).
    function emitChanged(deviceId, kind, requestId, fromEntityId, extra) {
        try {
            if (io && deviceId) {
                io.to(`device:${deviceId}`).emit('action_request:changed', {
                    kind,
                    requestId,
                    fromEntityId,
                    ...(extra || {}),
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
        // Cross-target integrity guard: never write an answer that was composed for
        // a DIFFERENT request onto this one. If the answer self-describes a target
        // (answer.replyContext.requestId / answer.requestId) that disagrees with
        // `requestId`, the targeting is ambiguous / mis-bound → resolve NONE. This
        // is the single chokepoint EVERY resolve path funnels through (HTTP
        // /:id/resolve, /api/client/speak auto-resolve, timeout + ratify workers),
        // so one reply can never overwrite a neighbouring pending item. Answers
        // with no embedded target (workers, plain text) pass straight through.
        const embeddedTarget = extractReplyTargetId(answer);
        if (embeddedTarget && embeddedTarget !== String(requestId).toLowerCase()) {
            log('warn', `cross-target reply rejected: answer bound to ${embeddedTarget} but resolving ${requestId}`, { deviceId });
            return null;
        }
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
    // NEGOTIATION ENGINE (需要你 negotiation workflow)
    // ──────────────────────────────────────────────────────────────────────
    // State machine (markers on agent_action_requests; status STAYS 'pending'
    // through S0→S3 — only T4 disposition flips status):
    //   consensus_triggered_at  → round OPENED (S1 collecting)
    //   consensus_collect_at    → window CLOSED / owner prompted (S2 synthesizing)
    //   negotiation (JSONB)     → TERMINAL conclusion (S3 concluded + surfaced)
    // Socket kinds emitted: consensus_triggered → vote → consensus_collecting →
    // negotiation_concluded. None of these resolve; disposition is a separate act.
    // ══════════════════════════════════════════════════════════════════════

    // T1 OPEN (idempotent, CAS-guarded). Stamps consensus_triggered_at, broadcasts
    // a STRUCTURED vote prompt (options + requestId + the from_entity_id synthesizer)
    // to ALL bound entities, and emits kind='consensus_triggered'. Returns the won
    // row, or null when another tick already opened it (CAS lost). Shared by the
    // on-arrival path and the worker backstop.
    async function openNegotiationRound(row, device) {
        const stamp = await pool.query(
            `UPDATE agent_action_requests SET consensus_triggered_at = NOW()
               WHERE id = $1 AND status = 'pending' AND consensus_triggered_at IS NULL
             RETURNING *`,
            [row.id]
        );
        if (stamp.rows.length === 0) return null; // raced — another tick opened it
        const won = stamp.rows[0];
        const deviceId = won.device_id;
        const opts = Array.isArray(won.options) ? won.options : [];
        const optionsList = opts.map((o, i) => `  [${i}] ${optionLabel(o)}`).join('\n');
        // NOTE: keeps the substrings 「協商共識」/「發起：#N」/「requestId=…」 the legacy
        // consensus prompt used, now extended with the explicit options + /vote call.
        const msg =
            `[協商共識] 需多方表決：「${won.prompt}」\n` +
            `發起：#${won.from_entity_id}（由其綜整最佳解 best solution）\n` +
            `選項:\n${optionsList}\n` +
            `請各實體投票：POST /api/action-requests/${won.id}/vote ` +
            `{optionIndex 或 freeText, rationale}（requestId=${won.id}）。`;
        const entities = (device && device.entities) || {};
        for (const ent of Object.values(entities)) {
            pushTextToEntity(deviceId, ent, 'action_request_consensus', msg,
                { requestId: won.id, options: opts, synthesizerEntityId: won.from_entity_id });
        }
        emitChanged(deviceId, 'consensus_triggered', won.id, won.from_entity_id);
        log('info', `negotiation round opened id=${won.id} from=${won.from_entity_id}`, { deviceId });
        return won;
    }

    // T3b FALLBACK conclusion (NEVER-HANG). Deterministic plurality tally of votes;
    // writes a server_fallback negotiation blob (fallback:true) — NEVER resolves,
    // NEVER arms ratify. CAS-guarded on negotiation IS NULL. Returns the row or null.
    async function concludeByFallback(row) {
        const deviceId = row.device_id;
        const opts = Array.isArray(row.options) ? row.options : [];
        const dc = (row.decision_context && typeof row.decision_context === 'object') ? row.decision_context : {};
        const recIdx = Number.isInteger(dc.recommendedOptionIndex) ? dc.recommendedOptionIndex : null;
        let voteRows = [];
        try {
            const vr = await pool.query(
                `SELECT entity_id, option_index, free_text, rationale
                   FROM agent_action_request_votes WHERE request_id = $1 ORDER BY created_at ASC`,
                [row.id]
            );
            voteRows = vr.rows || [];
        } catch (_) { voteRows = []; }
        const tally = tallyVotes(voteRows, opts.length, recIdx);
        const hasVotes = tally.count > 0 && Number.isInteger(tally.bestOptionIndex);
        const bestOptionIndex = Number.isInteger(tally.bestOptionIndex) ? tally.bestOptionIndex : null;
        const bestSolution = (bestOptionIndex != null && bestOptionIndex >= 0 && bestOptionIndex < opts.length)
            ? optionLabel(opts[bestOptionIndex]) : '';
        const conclusion = hasVotes
            ? `伺服器後援統計：多數選項 [${bestOptionIndex}]（${tally.count}/${tally.total} 票）。請您裁決。`
            : '收集期內無共識/agent 未綜整，請您裁決';
        const negotiation = {
            conclusion,
            bestSolution,
            bestOptionIndex,
            votes: { count: tally.count, total: tally.total },
            perEntity: votesToPerEntity(voteRows),
            synthesizedBy: 'server_fallback',
            synthesizedAt: Date.now(),
            fallback: true,
        };
        const upd = await pool.query(
            `UPDATE agent_action_requests SET negotiation = $2::jsonb
               WHERE id = $1 AND status = 'pending'
                 AND consensus_triggered_at IS NOT NULL
                 AND consensus_collect_at IS NOT NULL
                 AND negotiation IS NULL
             RETURNING *`,
            [row.id, JSON.stringify(negotiation)]
        );
        if (upd.rows.length === 0) return null; // raced (owner synthesized first)
        emitChanged(deviceId, 'negotiation_concluded', row.id, row.from_entity_id, { fallback: true });
        log('info', `negotiation fallback concluded id=${row.id} best=${bestOptionIndex} votes=${tally.count}/${tally.total}`, { deviceId });
        return upd.rows[0];
    }

    // ADVANCE pass (T2 CLOSE + T3b FALLBACK) — POLICY-INDEPENDENT, keyed only on
    // markers + clock. Invoked by the worker BEFORE the policy/keep gate so an
    // in-flight round always finishes even if the device is on 'keep'.
    async function advanceNegotiations(deviceId, prefs, device) {
        const windowMin = clampWindowMinutes(prefs && prefs.consensus_window_minutes);
        const synthGraceMin = clampSynthGraceMinutes(prefs && prefs.consensus_synthesis_grace_minutes);

        // ── T2 CLOSE: collection window elapsed; stamp consensus_collect_at + prompt OWNER. ──
        let closeRows = [];
        try {
            const r = await pool.query(
                `SELECT * FROM agent_action_requests
                  WHERE device_id = $1 AND status = 'pending'
                    AND consensus_triggered_at IS NOT NULL
                    AND consensus_collect_at IS NULL
                    AND negotiation IS NULL
                    AND consensus_triggered_at < NOW() - ($2 * interval '1 minute')
                  ORDER BY created_at ASC LIMIT ${MAX_LIST_LIMIT}`,
                [deviceId, windowMin]
            );
            closeRows = r.rows || [];
        } catch (err) {
            console.error(`[AgentActionRequests] negotiation T2 select failed device=${deviceId}:`, err.message);
        }
        for (const row of closeRows) {
            try {
                const upd = await pool.query(
                    `UPDATE agent_action_requests SET consensus_collect_at = NOW()
                       WHERE id = $1 AND status = 'pending'
                         AND consensus_triggered_at IS NOT NULL
                         AND consensus_collect_at IS NULL
                         AND negotiation IS NULL
                     RETURNING *`,
                    [row.id]
                );
                if (upd.rows.length === 0) continue; // raced
                const owner = device && device.entities && device.entities[row.from_entity_id];
                const synthMsg =
                    `[協商綜整] 收集期結束，請你（#${row.from_entity_id}）綜整各實體投票並提交最佳解：` +
                    `先 GET /api/action-requests/${row.id}/votes 看票，再 ` +
                    `POST /api/action-requests/${row.id}/negotiation-result ` +
                    `{conclusion, bestSolution, bestOptionIndex}（requestId=${row.id}）。`;
                pushTextToEntity(deviceId, owner, 'action_request_consensus', synthMsg,
                    { requestId: row.id, phase: 'synthesize' });
                emitChanged(deviceId, 'consensus_collecting', row.id, row.from_entity_id);
                log('info', `negotiation collect-closed id=${row.id} owner=${row.from_entity_id}`, { deviceId });
            } catch (e) {
                console.error(`[AgentActionRequests] negotiation T2 close failed id=${row.id}:`, e.message);
            }
        }

        // ── T3b FALLBACK: owner-synth grace elapsed with no result → server tally. ──
        let fbRows = [];
        try {
            const r = await pool.query(
                `SELECT * FROM agent_action_requests
                  WHERE device_id = $1 AND status = 'pending'
                    AND consensus_collect_at IS NOT NULL
                    AND negotiation IS NULL
                    AND consensus_collect_at < NOW() - ($2 * interval '1 minute')
                  ORDER BY created_at ASC LIMIT ${MAX_LIST_LIMIT}`,
                [deviceId, synthGraceMin]
            );
            fbRows = r.rows || [];
        } catch (err) {
            console.error(`[AgentActionRequests] negotiation T3b select failed device=${deviceId}:`, err.message);
        }
        for (const row of fbRows) {
            try { await concludeByFallback(row); }
            catch (e) { console.error(`[AgentActionRequests] negotiation T3b fallback failed id=${row.id}:`, e.message); }
        }
    }

    // OPEN backstop (consensus policy only). Opens rounds for eligible pending rows
    // with NO created_at age clause — so a row whose on-arrival open failed (push/
    // prefs hiccup) is picked up on the very next tick rather than waiting out a
    // timeout. Eligibility re-checked via isNegotiable.
    async function openNegotiationBackstop(deviceId, prefs, device) {
        const boundCount = countBoundEntities(device);
        if (boundCount < clampMinEntities(prefs && prefs.consensus_min_entities)) return;
        let rows = [];
        try {
            const r = await pool.query(
                `SELECT * FROM agent_action_requests
                  WHERE device_id = $1 AND status = 'pending'
                    AND consensus_triggered_at IS NULL
                    AND options IS NOT NULL
                    AND jsonb_typeof(options) = 'array'
                    AND jsonb_array_length(options) >= 2
                  ORDER BY created_at ASC LIMIT ${MAX_LIST_LIMIT}`,
                [deviceId]
            );
            rows = r.rows || [];
        } catch (err) {
            console.error(`[AgentActionRequests] negotiation backstop select failed device=${deviceId}:`, err.message);
            return;
        }
        for (const row of rows) {
            try {
                if (!isNegotiable(row, prefs, boundCount)) continue;
                await openNegotiationRound(row, device);
            } catch (e) {
                console.error(`[AgentActionRequests] negotiation backstop open failed id=${row.id}:`, e.message);
            }
        }
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
        // OWNER-DECISION PUSH (DELIVERY fix): an ownerOnly item must actively REACH
        // Hank's device (socket + Web Push + FCM fan-out via notifyDevice), not just
        // sit in a collapsed inbox where it died silently. Gated on
        // decision_context.ownerOnly so bot-to-bot requests never buzz the owner's
        // phone, and on an opt-out pref. Best-effort: a push error must NEVER fail
        // request creation (fully wrapped).
        if (typeof notifyDevice === 'function' && isOwnerOnlyDecision(decisionContext)) {
            try {
                let prefsPush = {};
                try { prefsPush = (await readDevicePrefs(deviceId)) || {}; } catch (_) { prefsPush = {}; }
                if (prefsPush.owner_decision_push_enabled !== false) {
                    let dc = decisionContext;
                    if (typeof dc === 'string') { try { dc = JSON.parse(dc); } catch (_) { dc = null; } }
                    Promise.resolve(notifyDevice(deviceId, {
                        type: 'owner_decision',
                        category: 'action_request',
                        title: '需要你拍板',
                        body: prompt,
                        link: '/',
                        metadata: {
                            kind: 'owner_decision_created',
                            requestId: row.id,
                            relatedCardId: relatedCardId != null ? relatedCardId : null,
                            recommendedOptionIndex: (dc && typeof dc === 'object') ? dc.recommendedOptionIndex : undefined,
                        },
                    })).catch((e) => log('error', `owner-decision push failed id=${row.id}: ${e.message}`, { deviceId }));
                    log('info', `owner-decision push id=${row.id}`, { deviceId });
                }
            } catch (e) {
                log('error', `owner-decision push wrap failed id=${row.id}: ${e.message}`, { deviceId });
            }
        }
        // ON-ARRIVAL negotiation open (需要你 negotiation): best-effort, AFTER the
        // committed INSERT + 'emitted'. A prefs/push error here must NOT fail request
        // creation — fully wrapped in try/catch. Only fires when isNegotiable (device
        // on consensus policy + options>=2 + enough bound entities). The worker
        // backstop re-attempts any open that this best-effort path missed.
        try {
            let prefs = {};
            try { prefs = (await readDevicePrefs(deviceId)) || {}; } catch (_) { prefs = {}; }
            const device = devices && devices[deviceId];
            if (isNegotiable(row, prefs, countBoundEntities(device))) {
                const won = await openNegotiationRound(row, device);
                if (won) row.consensus_triggered_at = won.consensus_triggered_at;
            }
        } catch (e) {
            console.error('[AgentActionRequests] on-arrival negotiation open failed:', e.message);
        }
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
    // Stacked safety: the worker enable-gate is the ONLY thing default-ON changes
    // (card_c3d48c4607ee753b2c98e04b) — WHAT may auto-ratify is unchanged. It still
    // matches ratify.mode==='default_agree' EXACTLY; re-derives the fail-closed
    // verdict at fire time; the N-cap already capped how many times it could be
    // armed (PUT handler); grace anchored to armedAt.
    // ══════════════════════════════════════════════════════════════════════
    async function runRatifyPass(deviceId, prefs, device) {
        // default-ON (card_c3d48c4607ee753b2c98e04b): an UNSET/true pref RUNS the
        // pass; only an explicit `false` disables it. (Was dark-launch:
        // enabled !== true ⇒ skip.) This flips WHETHER the worker runs, never the
        // fail-closed green-light predicate below that gates WHAT it may resolve.
        if (prefs && prefs.action_request_ratify_enabled === false) return;
        const graceMin = clampRatifyGraceMinutes(prefs && prefs.action_request_ratify_grace_minutes);
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

    // ══════════════════════════════════════════════════════════════════════
    // OWNER-DECISION MORNING DIGEST (DELIVERY fix)
    // ──────────────────────────────────────────────────────────────────────
    // Once per day, on/after the configured digest hour (device-local), if the
    // device still has pending ownerOnly items, push ONE summary to the owner's
    // device (notifyDevice → socket + Web Push + FCM fan-out). Without this an
    // owner-decision created overnight would sit unseen in a collapsed inbox.
    // Idempotent per (device, local-date) via owner_decision_digest_sent.
    //   opt-out: owner_decision_digest_enabled === false
    //   hour:    owner_decision_digest_hour (0..23, default 8)
    //   tz:      owner_decision_digest_tz   (IANA, default 'Asia/Taipei')
    // Never resolves or mutates requests; failure-isolated by the caller.
    // ══════════════════════════════════════════════════════════════════════
    function localDateAndHour(tz) {
        try {
            const parts = new Intl.DateTimeFormat('en-CA', {
                timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', hour12: false,
            }).formatToParts(new Date());
            const get = (t) => (parts.find(p => p.type === t) || {}).value;
            let hour = parseInt(get('hour'), 10);
            if (hour === 24) hour = 0; // some ICU builds emit '24' at midnight
            return { date: `${get('year')}-${get('month')}-${get('day')}`, hour };
        } catch (_) {
            const d = new Date(); // bad tz → server-local fallback
            return { date: d.toISOString().slice(0, 10), hour: d.getHours() };
        }
    }

    async function runOwnerDigestPass(deviceId, prefs, device) {
        if (prefs && prefs.owner_decision_digest_enabled === false) return;
        if (typeof notifyDevice !== 'function') return;

        const tz = (prefs && typeof prefs.owner_decision_digest_tz === 'string' && prefs.owner_decision_digest_tz)
            || 'Asia/Taipei';
        const hourPref = Number(prefs && prefs.owner_decision_digest_hour);
        const digestHour = Number.isFinite(hourPref) ? Math.min(23, Math.max(0, Math.trunc(hourPref))) : 8;
        const { date: localDate, hour: localHour } = localDateAndHour(tz);
        if (localHour < digestHour) return; // not yet the morning window

        let items = [];
        try {
            const r = await pool.query(
                `SELECT id, prompt FROM agent_action_requests
                  WHERE device_id = $1 AND status = 'pending'
                    AND decision_context ->> 'ownerOnly' = 'true'
                  ORDER BY created_at ASC LIMIT 50`,
                [deviceId]
            );
            items = r.rows || [];
        } catch (err) {
            log('error', `owner digest query failed: ${err.message}`, { deviceId });
            return;
        }
        if (items.length === 0) return;

        // Win the once-per-day race (multi-instance safe): only the inserter sends.
        let won = false;
        try {
            const ins = await pool.query(
                `INSERT INTO owner_decision_digest_sent (device_id, sent_date, item_count)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (device_id, sent_date) DO NOTHING
                 RETURNING device_id`,
                [deviceId, localDate, items.length]
            );
            won = (ins.rowCount || 0) > 0;
        } catch (err) {
            log('error', `owner digest dedup insert failed: ${err.message}`, { deviceId });
            return;
        }
        if (!won) return;

        const n = items.length;
        const preview = items.slice(0, 3)
            .map(it => `• ${String(it.prompt || '').replace(/\s+/g, ' ').slice(0, 60)}`)
            .join('\n');
        try {
            await notifyDevice(deviceId, {
                type: 'owner_decision_digest',
                category: 'action_request',
                title: `需要你：${n} 項待拍板`,
                body: preview + (n > 3 ? `\n…還有 ${n - 3} 項` : ''),
                link: '/',
                metadata: {
                    kind: 'owner_decision_digest',
                    count: n,
                    requestIds: items.map(it => it.id),
                },
            });
            log('info', `owner digest sent device=${deviceId} count=${n} date=${localDate}`, { deviceId });
        } catch (err) {
            log('error', `owner digest push failed: ${err.message}`, { deviceId });
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
                const device = devices && devices[deviceId];
                // 計畫E (card_e9d01b6e): run the independent ratify pass FIRST — it is
                // gated on its own dark-launch pref (action_request_ratify_enabled),
                // must not be skipped by 'keep', and must run before the
                // decision_context pin below (which keeps every OTHER owner-decision
                // row waiting for Hank). Failure-isolated so it never aborts the sweep.
                try { await runRatifyPass(deviceId, prefs, device); }
                catch (e) { console.error(`[AgentActionRequests] ratify pass failed device=${deviceId}:`, e.message); }

                // 需要你 negotiation — ADVANCE in-flight rounds (T2 CLOSE + T3b
                // FALLBACK). POLICY-INDEPENDENT, keyed only on markers + clock, so it
                // runs BEFORE the keep gate: a round opened on-arrival must always
                // finish even if the device is now on 'keep'. Failure-isolated.
                try { await advanceNegotiations(deviceId, prefs, device); }
                catch (e) { console.error(`[AgentActionRequests] negotiation advance failed device=${deviceId}:`, e.message); }

                // OWNER-DECISION MORNING DIGEST (DELIVERY fix): runs BEFORE the keep
                // gate so default-policy ('keep') devices — i.e. almost everyone —
                // still get their once-a-day reminder of pending owner decisions.
                try { await runOwnerDigestPass(deviceId, prefs, device); }
                catch (e) { console.error(`[AgentActionRequests] owner digest pass failed device=${deviceId}:`, e.message); }

                const policy = prefs.action_request_timeout_policy || 'keep';
                if (policy === 'keep') continue; // default: never auto-act

                // 需要你 negotiation — consensus policy OPENS rounds (backstop, no
                // created_at age clause). It does NOT auto_dismiss/safe_default, so we
                // open eligible rows and move to the next device.
                if (policy === 'consensus') {
                    try { await openNegotiationBackstop(deviceId, prefs, device); }
                    catch (e) { console.error(`[AgentActionRequests] negotiation backstop failed device=${deviceId}:`, e.message); }
                    continue;
                }

                const minutesRaw = prefs.action_request_timeout_minutes;
                const minutes = Number.isFinite(Number(minutesRaw)) ? Number(minutesRaw) : 1440;

                // Pending requests older than the timeout (auto_dismiss / safe_default).
                const sql = `SELECT * FROM agent_action_requests
                            WHERE device_id = $1 AND status = 'pending'
                              AND created_at < NOW() - ($2 * interval '1 minute')
                            ORDER BY created_at ASC LIMIT ${MAX_LIST_LIMIT}`;
                const res = await pool.query(sql, [deviceId, minutes]);
                const rows = res.rows || [];
                if (rows.length === 0) continue;

                for (const row of rows) {
                    try {
                        // 子6(b): owner-decision items (decision_context non-null) are
                        // PINNED to 'keep' semantics — they wait for Hank and must
                        // NEVER be auto_dismissed / safe_defaulted by the timeout
                        // worker, regardless of the device's policy.
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
        // Negotiation-history filter (card_ce0d685b): when set, restrict to rows
        // the timeout worker opened a consensus round on (consensus_triggered_at
        // IS NOT NULL). Purely additive — composes with status, so callers fetch
        // negotiation history via ?status=resolved&negotiatedOnly=true (or
        // ?status=all&negotiatedOnly=true to include in-flight rounds).
        const negotiatedOnly = String(req.query.negotiatedOnly) === 'true';

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
            if (negotiatedOnly) {
                sql += ` AND consensus_triggered_at IS NOT NULL`;
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

        // Cross-target integrity: a reply composed for a DIFFERENT request must not
        // resolve this one. Surface the ambiguity explicitly (409) rather than
        // silently no-op'ing it as the generic 404 the null path returns.
        // resolveActionRequest enforces the SAME rule as a deep chokepoint for the
        // non-HTTP callers (speak / workers).
        const embeddedTarget = extractReplyTargetId(answer);
        if (embeddedTarget && embeddedTarget !== String(id).toLowerCase()) {
            log('warn', `resolve target mismatch: answer bound to ${embeddedTarget} but url id=${id}`, { deviceId });
            return res.status(409).json({ success: false, error: 'reply target mismatch: this answer is bound to a different request' });
        }

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
    // POST /:id/vote — cast/update one entity's negotiation vote (需要你 negotiation)
    // ──────────────────────────────────────────────────────────────────────
    // Auth: botSecret + entityId (the vote is cast BY that entity). One vote per
    // (request, entity); last-write-wins (ON CONFLICT DO UPDATE). Accepted ONLY
    // while S1 COLLECTING (round open, not yet closed/concluded). Body:
    //   { optionIndex?: int, freeText?: string, rationale?: string } — at least one
    //   of optionIndex/freeText. optionIndex must index into the request's options.
    // ════════════════════════════════════════
    router.post('/:id/vote', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId } = auth;
        const { id } = req.params;
        if (!UUID_RE.test(String(id))) {
            return res.status(400).json({ success: false, error: 'Invalid id' });
        }
        // A vote is attributed to the voting entity → require bot auth.
        if (auth.isUser || !Number.isInteger(auth.entityId)) {
            return res.status(400).json({ success: false, error: 'vote requires botSecret + entityId (the voting entity)' });
        }
        const body = req.body || {};
        const hasOption = body.optionIndex !== undefined && body.optionIndex !== null;
        const hasFree = typeof body.freeText === 'string' && body.freeText.trim().length > 0;
        if (!hasOption && !hasFree) {
            return res.status(400).json({ success: false, error: 'provide optionIndex (integer) or freeText (non-empty string)' });
        }
        let optionIndex = null;
        if (hasOption) {
            optionIndex = parseInt(body.optionIndex, 10);
            if (!Number.isInteger(optionIndex) || optionIndex < 0) {
                return res.status(400).json({ success: false, error: 'optionIndex must be a non-negative integer' });
            }
        }
        const freeText = hasFree ? String(body.freeText).slice(0, MAX_PROMPT_LEN) : null;
        const rationale = typeof body.rationale === 'string' ? body.rationale.slice(0, MAX_PROMPT_LEN) : null;

        try {
            const cur = await pool.query(
                `SELECT * FROM agent_action_requests WHERE id = $1 AND device_id = $2`,
                [id, deviceId]
            );
            if (cur.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Not found' });
            }
            const row = cur.rows[0];
            // Accept votes ONLY while S1 COLLECTING.
            const inS1 = row.status === 'pending'
                && row.consensus_triggered_at != null
                && row.consensus_collect_at == null
                && row.negotiation == null;
            if (!inS1) {
                return res.status(409).json({ success: false, error: 'voting is closed (no open collection round)' });
            }
            if (optionIndex != null) {
                const opts = Array.isArray(row.options) ? row.options : [];
                if (optionIndex >= opts.length) {
                    return res.status(400).json({ success: false, error: `optionIndex out of range (0..${Math.max(0, opts.length - 1)})` });
                }
            }
            await pool.query(
                `INSERT INTO agent_action_request_votes (request_id, entity_id, option_index, free_text, rationale)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (request_id, entity_id) DO UPDATE
                    SET option_index = EXCLUDED.option_index,
                        free_text = EXCLUDED.free_text,
                        rationale = EXCLUDED.rationale,
                        created_at = NOW()`,
                [id, auth.entityId, optionIndex, freeText, rationale]
            );
            const cnt = await pool.query(
                `SELECT COUNT(*)::int AS total FROM agent_action_request_votes WHERE request_id = $1`,
                [id]
            );
            const cast = (cnt.rows[0] && cnt.rows[0].total) || 0;
            const boundCount = countBoundEntities(auth.device);
            // emit kind='vote' carrying k/N progress.
            emitChanged(deviceId, 'vote', id, row.from_entity_id, { votes: { count: cast, total: boundCount } });
            log('info', `vote id=${id} by=${auth.entityId} option=${optionIndex} cast=${cast}`, { deviceId });
            return res.json({
                success: true,
                vote: { requestId: id, entityId: auth.entityId, optionIndex, freeText, rationale },
                tally: { count: cast, total: boundCount },
            });
        } catch (err) {
            console.error('[AgentActionRequests] vote failed:', err.message);
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
    });

    // ════════════════════════════════════════
    // GET /:id/votes — list the votes + plurality tally (device-scoped read)
    // ════════════════════════════════════════
    router.get('/:id/votes', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId } = auth;
        const { id } = req.params;
        if (!UUID_RE.test(String(id))) {
            return res.status(400).json({ success: false, error: 'Invalid id' });
        }
        try {
            const cur = await pool.query(
                `SELECT options, decision_context FROM agent_action_requests WHERE id = $1 AND device_id = $2`,
                [id, deviceId]
            );
            if (cur.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Not found' });
            }
            const opts = Array.isArray(cur.rows[0].options) ? cur.rows[0].options : [];
            const dc = (cur.rows[0].decision_context && typeof cur.rows[0].decision_context === 'object') ? cur.rows[0].decision_context : {};
            const recIdx = Number.isInteger(dc.recommendedOptionIndex) ? dc.recommendedOptionIndex : null;
            const vr = await pool.query(
                `SELECT entity_id, option_index, free_text, rationale, created_at
                   FROM agent_action_request_votes WHERE request_id = $1 ORDER BY created_at ASC`,
                [id]
            );
            const voteRows = vr.rows || [];
            const tally = tallyVotes(voteRows, opts.length, recIdx);
            return res.json({
                success: true,
                requestId: id,
                votes: votesToPerEntity(voteRows),
                tally: { bestOptionIndex: tally.bestOptionIndex, count: tally.count, total: tally.total },
            });
        } catch (err) {
            console.error('[AgentActionRequests] votes list failed:', err.message);
            return res.status(500).json({ success: false, error: 'Internal error' });
        }
    });

    // ════════════════════════════════════════
    // POST /:id/negotiation-result — owner (from_entity_id) synthesizes (T3a)
    // ──────────────────────────────────────────────────────────────────────
    // Auth: botSecret restricted to from_entity_id (the synthesizer), OR human
    // deviceSecret. Writes the TERMINAL negotiation blob — does NOT resolve;
    // status stays 'pending' until disposition. Body:
    //   { conclusion?: string, bestSolution?: string, bestOptionIndex?: int,
    //     perEntity?: array } — conclusion OR bestSolution required.
    // ════════════════════════════════════════
    router.post('/:id/negotiation-result', async (req, res) => {
        const auth = authenticate(req, res);
        if (!auth) return;
        const { deviceId } = auth;
        const { id } = req.params;
        if (!UUID_RE.test(String(id))) {
            return res.status(400).json({ success: false, error: 'Invalid id' });
        }
        const body = req.body || {};
        const conclusion = typeof body.conclusion === 'string' ? body.conclusion.slice(0, MAX_PROMPT_LEN) : '';
        const bestSolution = typeof body.bestSolution === 'string' ? body.bestSolution.slice(0, MAX_PROMPT_LEN) : '';
        if (!conclusion && !bestSolution) {
            return res.status(400).json({ success: false, error: 'conclusion or bestSolution required' });
        }
        let bestOptionIndex = null;
        if (body.bestOptionIndex !== undefined && body.bestOptionIndex !== null) {
            bestOptionIndex = parseInt(body.bestOptionIndex, 10);
            if (!Number.isInteger(bestOptionIndex) || bestOptionIndex < 0) {
                return res.status(400).json({ success: false, error: 'bestOptionIndex must be a non-negative integer or null' });
            }
        }
        let perEntityProvided = null;
        if (Array.isArray(body.perEntity)) {
            if (JSON.stringify(body.perEntity).length > 8192) {
                return res.status(400).json({ success: false, error: 'perEntity too large (max 8KB)' });
            }
            perEntityProvided = body.perEntity;
        }
        try {
            // A botSecret holder may only synthesize ITS OWN (from_entity_id) request.
            const restrictToEntityId = auth.isUser ? null : auth.entityId;
            const cur = await pool.query(
                `SELECT * FROM agent_action_requests WHERE id = $1 AND device_id = $2`,
                [id, deviceId]
            );
            if (cur.rows.length === 0) {
                return res.status(404).json({ success: false, error: 'Not found' });
            }
            const row = cur.rows[0];
            if (restrictToEntityId != null && row.from_entity_id !== restrictToEntityId) {
                return res.status(403).json({ success: false, error: 'only the synthesizer (from_entity_id) may submit the result' });
            }
            const eligible = row.status === 'pending' && row.consensus_triggered_at != null && row.negotiation == null;
            if (!eligible) {
                return res.status(409).json({ success: false, error: 'no open negotiation round to conclude' });
            }
            const opts = Array.isArray(row.options) ? row.options : [];
            if (bestOptionIndex != null && bestOptionIndex >= opts.length) {
                return res.status(400).json({ success: false, error: `bestOptionIndex out of range (0..${Math.max(0, opts.length - 1)})` });
            }
            let voteRows = [];
            try {
                const vr = await pool.query(
                    `SELECT entity_id, option_index, free_text, rationale
                       FROM agent_action_request_votes WHERE request_id = $1 ORDER BY created_at ASC`,
                    [id]
                );
                voteRows = vr.rows || [];
            } catch (_) { voteRows = []; }
            const total = voteRows.length;
            const count = Number.isInteger(bestOptionIndex)
                ? voteRows.filter(v => v.option_index === bestOptionIndex).length : 0;
            const negotiation = {
                conclusion,
                bestSolution,
                bestOptionIndex: Number.isInteger(bestOptionIndex) ? bestOptionIndex : null,
                votes: { count, total },
                perEntity: perEntityProvided != null ? perEntityProvided : votesToPerEntity(voteRows),
                synthesizedBy: auth.isUser ? 'human' : auth.entityId,
                synthesizedAt: Date.now(),
                fallback: false,
            };
            const negJson = JSON.stringify(negotiation);
            if (negJson.length > 16384) {
                return res.status(400).json({ success: false, error: 'negotiation result too large' });
            }
            // Guarded write — does NOT resolve (status stays 'pending').
            const params = [negJson, id];
            let sql = `UPDATE agent_action_requests SET negotiation = $1::jsonb
                         WHERE id = $2 AND status = 'pending'
                           AND consensus_triggered_at IS NOT NULL
                           AND negotiation IS NULL`;
            if (restrictToEntityId != null) {
                params.push(restrictToEntityId);
                sql += ` AND from_entity_id = $${params.length}`;
            }
            sql += ` RETURNING *`;
            const upd = await pool.query(sql, params);
            if (upd.rows.length === 0) {
                return res.status(409).json({ success: false, error: 'no open negotiation round to conclude (raced)' });
            }
            const after = upd.rows[0];
            emitChanged(deviceId, 'negotiation_concluded', after.id, after.from_entity_id, { fallback: false });
            log('info', `negotiation concluded id=${id} by=${auth.entityId ?? 'user'} best=${negotiation.bestOptionIndex}`, { deviceId });
            return res.json({ success: true, request: rowToApi(after) });
        } catch (err) {
            console.error('[AgentActionRequests] negotiation-result failed:', err.message);
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
                    // N-cap from the device pref (clamped inside recomputeRatifyMode);
                    // a prefs read failure → undefined → safe default cap.
                    let ratifyPrefs = {};
                    try { ratifyPrefs = (await readDevicePrefs(deviceId)) || {}; } catch (_) { ratifyPrefs = {}; }
                    dcObj.ratify = await recomputeRatifyMode(
                        client, id, before.prompt, dcObj.ratify, nowMs,
                        ratifyPrefs.action_request_ratify_max_attempts,
                    );
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
        // Owner-decision morning digest (DELIVERY fix). Exported for direct test
        // invocation of the once-per-day reminder pass.
        runOwnerDigestPass,
        // Shared create path (子3) so the kanban move-hook can auto-surface an
        // owner-only review/blocked card into this inbox via the SAME INSERT +
        // 'emitted' socket emit the HTTP route uses. Caller validates inputs.
        createActionRequest,
        // Owner-decision lifecycle (子6a): kanban calls this when a card leaves
        // review/blocked to auto-dismiss its pending owner-decision request(s) +
        // emit the 'dismissed' socket event.
        dismissActionRequestsForCard,
        // 需要你 negotiation: exported for direct test invocation of the engine.
        openNegotiationRound,
        advanceNegotiations,
        openNegotiationBackstop,
        concludeByFallback,
        _pool: pool,
    };
};

module.exports.initAgentActionRequestsDatabase = initAgentActionRequestsDatabase;
// 計畫E (card_e9d01b6e): exported for unit tests — the SERVER-authoritative ratify
// recompute (fail-closed mode + audit-trail N-cap) and its input builder.
module.exports.recomputeRatifyMode = recomputeRatifyMode;
module.exports.ratifyInputFrom = ratifyInputFrom;
// DELIVERY fix: exported for unit tests — the ownerOnly predicate that both
// suppresses bot consensus on owner decisions and gates the owner-device push,
// and the negotiability gate it feeds.
module.exports.isOwnerOnlyDecision = isOwnerOnlyDecision;
module.exports.isNegotiable = isNegotiable;
module.exports.MAX_RATIFY_RETRIES = MAX_RATIFY_RETRIES;
// 計畫E adjustable params (card_c3d48c4607ee753b2c98e04b): defensive clamps for
// the two ratify tunables — exported for unit tests.
module.exports.clampRatifyMaxAttempts = clampRatifyMaxAttempts;
module.exports.clampRatifyGraceMinutes = clampRatifyGraceMinutes;
// 需要你 negotiation: pure helpers exported for unit testing without a pool.
module.exports.isNegotiable = isNegotiable;
module.exports.tallyVotes = tallyVotes;
module.exports.countBoundEntities = countBoundEntities;
module.exports.optionLabel = optionLabel;
module.exports.clampWindowMinutes = clampWindowMinutes;
module.exports.clampSynthGraceMinutes = clampSynthGraceMinutes;
module.exports.clampMinEntities = clampMinEntities;
module.exports.CONSENSUS_WINDOW_MIN_DEFAULT = CONSENSUS_WINDOW_MIN_DEFAULT;
module.exports.CONSENSUS_SYNTH_GRACE_DEFAULT = CONSENSUS_SYNTH_GRACE_DEFAULT;
module.exports.CONSENSUS_MIN_ENTITIES_DEFAULT = CONSENSUS_MIN_ENTITIES_DEFAULT;
