'use strict';

// ============================================================================
// Server-authoritative entity ACTIVITY state machine
// ----------------------------------------------------------------------------
// Replaces the legacy "5 min no update → Math.random() > 0.7 → SLEEPING" decay
// coin-flip (backend/index.js). That random rule is why bound entities wrongly
// went to sleep even with pending work — which blocked walking-emulator QA.
//
// This module is PURE (no I/O, no timers, no randomness) so it is trivially
// testable: calling the evaluator a thousand times for the same inputs returns
// the same canonical state every time.
//
// Canonical activity states map onto the EXISTING wire CharacterState enum so
// the Android client needs no change (the strings below are all parsed by
// AgentStatus.fromWireValue — see app/.../data/model/AgentStatus.kt):
//   ACTIVE   -> 'BUSY'      (running)
//   IDLE     -> 'IDLE'
//   SLEEPING -> 'SLEEPING'
//   REVIEW   -> 'REVIEW'    (agent waiting at a confirm/prompt — purple)
//   FAILED   -> 'FAILED'    (agent crashed / rate-limited / errored — red)
//
// Stage 1/2 (real-activity-driven): the agent runtime reports its OWN live
// state via the heartbeat (`runtimeState`: busy|stuck|crashed|idle). A FRESH,
// trusted runtimeState is the PRIMARY signal; when it is absent/stale the
// evaluator gracefully degrades to the lastSend / kanban-floor heuristics.
//
// Expressive states (EXCITED/HAPPY/WAVING/JUMPING/REVIEW/FAILED) ALSO stay
// agent-declared transient OVERLAYS with a server TTL that reverts to the
// activity-derived base, so an agent can never leave an entity stuck mid-pose.
// ============================================================================

// Canonical activity states -> wire CharacterState values.
const ACTIVITY = Object.freeze({
    ACTIVE: 'BUSY',
    IDLE: 'IDLE',
    SLEEPING: 'SLEEPING',
    REVIEW: 'REVIEW',
    FAILED: 'FAILED',
});

// Allow-list of agent runtime self-reports accepted on POST /api/entity/heartbeat
// (Stage 1/2). Anything outside this set is ignored (never stamped) so a bad
// client can't wedge an entity into an arbitrary state.
const RUNTIME_STATES = new Set(['busy', 'stuck', 'crashed', 'idle']);

// runtimeState -> canonical activity state (only the "hard override" mappings;
// 'idle' deliberately has NO hard mapping — it just means "not busy", so the
// entity falls through to the timestamp/floor heuristics below).
const RUNTIME_STATE_TO_ACTIVITY = Object.freeze({
    busy: ACTIVITY.ACTIVE,
    stuck: ACTIVITY.REVIEW,
    crashed: ACTIVITY.FAILED,
});

// Agent-declared busy-family states all map to ACTIVE. Mirrors the
// `kanbanBusyStates` set already used in /api/transform (index.js).
const BUSY_FAMILY = new Set(['BUSY', 'PROCESSING', 'WORKING', 'IN_PROGRESS', 'IN-PROGRESS']);

// Agent-declared transient expressive poses rendered as TTL overlays.
const EXPRESSIVE = new Set(['EXCITED', 'HAPPY', 'WAVING', 'JUMPING', 'REVIEW', 'FAILED']);

// Kanban statuses that count as UNFINISHED assigned work for activity purposes.
// Canonical enum (public/shared/kanban-status.js): backlog, todo, in_progress,
// review, done, blocked. Only 'todo' + 'in_progress' mean "the bot has work it
// must act on NOW" → it must stay awake. Excluded: 'backlog' (not yet pulled
// onto the board), 'review'/'done' (handed off for sign-off / finished),
// 'blocked' (cannot act — waiting on a dependency). Mirrors the org-forward
// task-check status filter in index.js.
const UNFINISHED_KANBAN_STATUSES = new Set(['todo', 'in_progress']);

// How long an expressive overlay shows before reverting to the activity base.
const OVERLAY_TTL_MS = 30 * 1000;

// Threshold fallbacks (mirror device-preferences.js DEFAULTS, in canonical units).
const DEFAULT_IDLE_AFTER_MS = 60 * 1000;        // entity_idle_after_seconds = 60
const DEFAULT_SLEEP_AFTER_MS = 20 * 60 * 1000;  // entity_sleep_after_minutes = 20
// How long a heartbeat-reported runtimeState is TRUSTED before it is treated as
// stale and ignored (mirror device-preferences.js entity_runtime_state_stale_seconds = 45).
const DEFAULT_RUNTIME_STALE_MS = 45 * 1000;

function isBusyFamilyState(state) {
    return BUSY_FAMILY.has(String(state || '').trim().toUpperCase());
}

function isExpressiveState(state) {
    return EXPRESSIVE.has(String(state || '').trim().toUpperCase());
}

// pendingWork = the entity has LIVE work-in-progress and is genuinely ACTIVE.
// Sources, cheapest first:
//   1. unacked inbound in messageQueue — in-process; covers /api/client/speak
//      AND A2A speakTo (both enqueue here). Drained when the daemon polls.
//   2. entity._pendingScheduled — OPTIONAL precomputed boolean: any queued
//      scheduled message for the entity (DB-backed; see wiring note in index.js).
// (2) is read as an already-resolved flag so the 5 s loop never issues a DB
// query per tick. It defaults to false when not wired.
//
// NOTE (Stage 0): entity._pendingKanban (open assigned cards) is DELIBERATELY
// NOT a pendingWork source any more. Having a card on the board is NOT proof the
// agent is doing anything right now — treating it as ACTIVE made #1/#5 show a
// permanent false-BUSY on the wallpaper. Open cards are now only an IDLE FLOOR
// (see hasKanbanFloor + evaluateActivityState): they keep the entity awake
// (never SLEEPING) but never fake BUSY.
function computePendingWork(entity) {
    if (!entity) return false;
    if (Array.isArray(entity.messageQueue) && entity.messageQueue.length > 0) return true;
    if (entity._pendingScheduled === true) return true;
    return false;
}

// IDLE FLOOR signal (Stage 0): the entity has ≥1 OPEN assigned kanban card
// (todo/in_progress). This forbids SLEEPING (work is outstanding, the bot must
// stay reachable) but does NOT imply BUSY — an entity with open cards and no
// real activity is IDLE ("Waiting..."), never "Zzz" and never a fake "running".
function hasKanbanFloor(entity) {
    return !!(entity && entity._pendingKanban === true);
}

// Return the entity's FRESH, trusted runtimeState (lowercased) or null. The
// self-report is only honored while entity.lastRuntimeStateAt is within
// staleMs of `now`; a stale (or absent / out-of-allow-list) value returns null
// so the evaluator falls through to the timestamp/floor heuristics.
function freshRuntimeState(entity, now, staleMs = DEFAULT_RUNTIME_STALE_MS) {
    if (!entity) return null;
    const rt = String(entity.runtimeState || '').trim().toLowerCase();
    if (!RUNTIME_STATES.has(rt)) return null;
    const at = Number(entity.lastRuntimeStateAt) || 0;
    if (!at) return null;
    if (now - at >= staleMs) return null; // stale → ignore
    return rt;
}

// PURE bucketing helper for the kanban pendingWork signal. Given kanban_cards
// rows ({ device_id, status, archived, assigned_bots }), return
// Map<deviceId, Set<entityId>> of entities that have ≥1 UNFINISHED, non-archived
// assigned card. The DB query (index.js) already filters status/archived for
// efficiency; this re-applies the same policy so the filter is unit-testable and
// the helper is robust to an unfiltered or malformed feed. No I/O — the caller
// runs the single grouped query and passes the rows in.
function bucketPendingKanban(rows) {
    const byDevice = new Map();
    if (!Array.isArray(rows)) return byDevice;
    for (const row of rows) {
        if (!row) continue;
        if (row.archived === true) continue;
        if (!UNFINISHED_KANBAN_STATUSES.has(String(row.status || '').trim())) continue;
        let ids = row.assigned_bots;
        // assigned_bots is JSONB (array of entity IDs); some drivers return it as
        // a string — parse defensively and skip anything that isn't an array.
        if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch (_) { ids = null; } }
        if (!Array.isArray(ids)) continue;
        let set = byDevice.get(row.device_id);
        if (!set) { set = new Set(); byDevice.set(row.device_id, set); }
        for (const raw of ids) {
            const id = Number(raw);
            if (Number.isFinite(id)) set.add(id);
        }
    }
    return byDevice;
}

// DETERMINISTIC activity evaluator — NO randomness, NO side effects.
// Returns a canonical wire state ('BUSY' | 'REVIEW' | 'FAILED' | 'IDLE' |
// 'SLEEPING') derived purely from the entity's runtimeState + timestamps + the
// kanban IDLE floor.
//
// Priority (real-activity first, then graceful degradation):
//   (1) FRESH trusted runtimeState — busy→BUSY, stuck→REVIEW, crashed→FAILED.
//       (A fresh 'idle' is NOT a hard override; it just means "not busy" and
//        falls through.) Stale/absent → ignored (graceful degradation).
//   (2) Recently active grace — last message SEND or last runtime "busy" beat
//       within idleAfter → BUSY. This is the fallback that keeps #5/#6 (no
//       busy-probe) working, just less precisely.
//   (2b) Live work-in-progress (unacked inbound / queued scheduled) → BUSY.
//   (3) IDLE FLOOR — open assigned kanban cards keep the entity awake (never
//       SLEEPING) but never fake-BUSY → IDLE.
//   (4) Past the long inactivity window with nothing pending → SLEEPING.
//   (5) Otherwise → IDLE.
function evaluateActivityState(entity, now, opts = {}) {
    const idleAfterMs = Number.isFinite(opts.idleAfterMs) ? opts.idleAfterMs : DEFAULT_IDLE_AFTER_MS;
    const sleepAfterMs = Number.isFinite(opts.sleepAfterMs) ? opts.sleepAfterMs : DEFAULT_SLEEP_AFTER_MS;
    const runtimeStaleMs = Number.isFinite(opts.runtimeStaleMs) ? opts.runtimeStaleMs : DEFAULT_RUNTIME_STALE_MS;

    // (1) PRIMARY: fresh, trusted runtimeState reported by the agent's own runtime.
    const rt = freshRuntimeState(entity, now, runtimeStaleMs);
    if (rt && RUNTIME_STATE_TO_ACTIVITY[rt]) return RUNTIME_STATE_TO_ACTIVITY[rt];
    // rt === 'idle' (or stale/absent) → fall through to the heuristics below.

    // (2) Recently active grace: a delivered message OR a recent runtime "busy"
    //     heartbeat keeps the entity BUSY for idleAfter (graceful fallback when
    //     no current/fresh runtimeState is present).
    const lastSendAt = Number(entity && entity.lastSendAt) || 0;
    const lastRuntimeBusyAt = Number(entity && entity.lastRuntimeBusyAt) || 0;
    const lastActiveAnchor = Math.max(lastSendAt, lastRuntimeBusyAt);
    if (now - lastActiveAnchor < idleAfterMs) return ACTIVITY.ACTIVE;

    // (2b) Live work-in-progress (unacked inbound / queued scheduled send) → BUSY.
    if (computePendingWork(entity)) return ACTIVITY.ACTIVE;

    // (3) IDLE FLOOR: open assigned cards → never SLEEPING, but only IDLE.
    if (hasKanbanFloor(entity)) return ACTIVITY.IDLE;

    // Sleep anchor falls back to lastUpdated for legacy entities that predate
    // lastActivityAt (loaded from DB without it) so they don't sleep instantly.
    const lastActivityAt = Number(entity && entity.lastActivityAt)
        || Number(entity && entity.lastUpdated) || 0;

    // (4) Past the long inactivity window with nothing pending → SLEEPING.
    if (now - lastActivityAt >= sleepAfterMs) return ACTIVITY.SLEEPING;

    // (5) Otherwise IDLE.
    return ACTIVITY.IDLE;
}

// Is an agent-declared expressive overlay still within its TTL?
function overlayActive(entity, now) {
    return !!(entity && entity.overlayState && entity.overlayUntil && entity.overlayUntil > now);
}

// Default bubble text per canonical base state (preserves legacy strings). Only
// applied by the loop when it transitions the base state into IDLE/SLEEPING;
// agent messages are preserved while ACTIVE.
function defaultMessageForState(state) {
    if (state === ACTIVITY.SLEEPING) return 'Zzz...';
    if (state === ACTIVITY.IDLE) return 'Waiting...';
    return null;
}

module.exports = {
    ACTIVITY,
    BUSY_FAMILY,
    EXPRESSIVE,
    RUNTIME_STATES,
    RUNTIME_STATE_TO_ACTIVITY,
    UNFINISHED_KANBAN_STATUSES,
    OVERLAY_TTL_MS,
    DEFAULT_IDLE_AFTER_MS,
    DEFAULT_SLEEP_AFTER_MS,
    DEFAULT_RUNTIME_STALE_MS,
    isBusyFamilyState,
    isExpressiveState,
    computePendingWork,
    hasKanbanFloor,
    freshRuntimeState,
    bucketPendingKanban,
    evaluateActivityState,
    overlayActive,
    defaultMessageForState,
};
