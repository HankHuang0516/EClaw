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
// the Android client needs no change (Stage 3 / separate PR):
//   ACTIVE   -> 'BUSY'
//   IDLE     -> 'IDLE'
//   SLEEPING -> 'SLEEPING'
//
// Expressive states (EXCITED/HAPPY/WAVING/JUMPING/REVIEW/FAILED) stay
// agent-declared transient OVERLAYS with a server TTL that reverts to the
// activity-derived base, so an agent can never leave an entity stuck mid-pose.
// ============================================================================

// Canonical activity states -> wire CharacterState values.
const ACTIVITY = Object.freeze({
    ACTIVE: 'BUSY',
    IDLE: 'IDLE',
    SLEEPING: 'SLEEPING',
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

function isBusyFamilyState(state) {
    return BUSY_FAMILY.has(String(state || '').trim().toUpperCase());
}

function isExpressiveState(state) {
    return EXPRESSIVE.has(String(state || '').trim().toUpperCase());
}

// pendingWork = the entity has unfinished work and MUST stay awake.
// Sources, cheapest first:
//   1. unacked inbound in messageQueue — in-process; covers /api/client/speak
//      AND A2A speakTo (both enqueue here). Drained when the daemon polls.
//   2. entity._pendingKanban  — OPTIONAL precomputed boolean: any kanban card
//      in_progress assigned to the entity (DB-backed; see wiring note in index.js).
//   3. entity._pendingScheduled — OPTIONAL precomputed boolean: any queued
//      scheduled message for the entity (DB-backed; see wiring note in index.js).
// (2)/(3) are read as already-resolved flags so the 5 s loop never issues a DB
// query per tick. They default to false when not wired.
function computePendingWork(entity) {
    if (!entity) return false;
    if (Array.isArray(entity.messageQueue) && entity.messageQueue.length > 0) return true;
    if (entity._pendingKanban === true) return true;
    if (entity._pendingScheduled === true) return true;
    return false;
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
// Returns a canonical wire state ('BUSY' | 'IDLE' | 'SLEEPING') derived purely
// from timestamps + pendingWork. Pending work forbids IDLE/SLEEPING.
function evaluateActivityState(entity, now, opts = {}) {
    const idleAfterMs = Number.isFinite(opts.idleAfterMs) ? opts.idleAfterMs : DEFAULT_IDLE_AFTER_MS;
    const sleepAfterMs = Number.isFinite(opts.sleepAfterMs) ? opts.sleepAfterMs : DEFAULT_SLEEP_AFTER_MS;

    // pendingWork → always ACTIVE (IDLE + SLEEPING forbidden while work is open).
    if (computePendingWork(entity)) return ACTIVITY.ACTIVE;

    const lastSendAt = Number(entity && entity.lastSendAt) || 0;
    // Sleep anchor falls back to lastUpdated for legacy entities that predate
    // lastActivityAt (loaded from DB without it) so they don't sleep instantly.
    const lastActivityAt = Number(entity && entity.lastActivityAt)
        || Number(entity && entity.lastUpdated) || 0;

    // Recently delivered a message / declared busy → ACTIVE.
    if (now - lastSendAt < idleAfterMs) return ACTIVITY.ACTIVE;

    // Past the idle grace with no pending work: sleep only after the longer
    // inactivity window; otherwise IDLE.
    if (now - lastActivityAt >= sleepAfterMs) return ACTIVITY.SLEEPING;
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
    UNFINISHED_KANBAN_STATUSES,
    OVERLAY_TTL_MS,
    DEFAULT_IDLE_AFTER_MS,
    DEFAULT_SLEEP_AFTER_MS,
    isBusyFamilyState,
    isExpressiveState,
    computePendingWork,
    bucketPendingKanban,
    evaluateActivityState,
    overlayActive,
    defaultMessageForState,
};
