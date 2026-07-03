// Waiting-state classifier (phases 2-3 of card_76b073959c279d6204d9fd42).
//
// Generalizes the owner-decision classifier into a "who is this card waiting
// on?" verdict so the 需要你 (action-request) inbox can auto-surface EVERY
// situation that is genuinely waiting on the OWNER (Hank), who only monitors
// that inbox and never opens task cards.
//
// classifyCardWaitingState(card, ctx) → 'owner' | 'entity' | 'commander' | null
//
// Design rules (conservative / VETO-style — mirrors owner-decision-classifier):
//   * DEFAULT is null (unknown → NOT surfaced). This is fail-safe: the #1 risk
//     is flooding the inbox, so we only ever return 'owner' when there is a
//     REAL owner-gate signal.
//   * 'owner' is the only verdict the surfacer acts on. 'entity'/'commander'
//     are classified (they feed the phase-1 census) but never create inbox
//     items in this MVP.
//   * Pure function, no DB/network, never throws on a malformed card.
//
// Reuses the existing owner-decision keyword classifier (irreversible data /
// spend / product direction / legal-PII / security / strategic tradeoff /
// explicit owner flag) so the "owner-only reason" test is consistent with the
// move-hook that already ships.

'use strict';

const { classifyCardOwnerDecision } = require('./agent-improvement/owner-decision-classifier');

// Narrow, DELIBERATE await-owner markers for the in_progress case. We do NOT
// infer "waiting on owner" loosely from an in_progress card (that would flood
// the inbox). Only an explicit marker in the latest comment OR an explicit
// config flag counts. Case-insensitive; EN + 繁中.
const AWAIT_OWNER_MARKER_RE = /\[\s*(?:等\s*hank|await[-\s]?owner|等老闆|待老闆|owner[-\s]?decision)\s*\]/i;

/**
 * Safely read a string field, returning '' for anything non-string.
 * @param {*} v
 * @returns {string}
 */
function str(v) {
    return typeof v === 'string' ? v : '';
}

/**
 * Classify which party a kanban card is waiting on.
 *
 * @param {object} card  A kanban card row (snake_case DB shape tolerated).
 *   Recognized fields: status, title, description, gate_reason/gateReason,
 *   requires_screenshot_review/requiresScreenshotReview, painTags,
 *   config (JSONB object; may carry { waitingOn, awaitOwner }),
 *   parent_card_id/parentCardId.
 * @param {object} [ctx]  Optional context.
 *   ctx.latestComment {string}  — text of the latest (non-system) comment.
 *   ctx.decisionContext {object}— decision_context blob (e.g. { ownerOnly }).
 *   ctx.painTags {string[]}     — pre-computed pain taxonomy tags.
 * @returns {'owner'|'entity'|'commander'|null}
 */
function classifyCardWaitingState(card, ctx = {}) {
    try {
        if (!card || typeof card !== 'object') return null;

        const context = (ctx && typeof ctx === 'object') ? ctx : {};
        const status = str(card.status).toLowerCase();
        const config = (card.config && typeof card.config === 'object') ? card.config : {};
        const decisionContext = (context.decisionContext && typeof context.decisionContext === 'object')
            ? context.decisionContext
            : ((card.decision_context && typeof card.decision_context === 'object') ? card.decision_context : {});
        const latestComment = str(context.latestComment);
        const gateReason = str(card.gate_reason || card.gateReason);

        // ── OWNER signals (VETO-style; any one is sufficient) ──

        // (1) Explicit config flag: card.config.waitingOn === 'owner'.
        if (str(config.waitingOn).toLowerCase() === 'owner') return 'owner';

        // (2) Explicit config flag: card.config.awaitOwner === true.
        if (config.awaitOwner === true) return 'owner';

        // (3) review + decision_context.ownerOnly (the move-hook's own marker).
        if (status === 'review' && decisionContext.ownerOnly === true) return 'owner';

        // (4) blocked with an owner-only reason (keyword classifier on the
        //     card text + gate reason). A plain "blocked, waiting on a peer"
        //     card without an owner-only keyword returns null here → not owner.
        if (status === 'blocked') {
            const verdict = classifyCardOwnerDecision({
                title: str(card.title),
                description: str(card.description),
                latestComment,
                gateReason,
                requiresScreenshotReview: (card.requires_screenshot_review === true || card.requiresScreenshotReview === true),
                painTags: Array.isArray(context.painTags) ? context.painTags
                    : (Array.isArray(card.painTags) ? card.painTags : []),
            });
            if (verdict.ownerOnly === true) return 'owner';
        }

        // (5) in_progress with a NARROW, explicit await-owner marker in the
        //     latest comment. Deliberately does NOT run the loose keyword
        //     classifier on in_progress cards — that would flood the inbox with
        //     every card whose description happens to mention e.g. "billing".
        if (status === 'in_progress' && AWAIT_OWNER_MARKER_RE.test(latestComment)) return 'owner';

        // ── Non-owner classification (census only; NOT surfaced in this MVP) ──
        // blocked (no owner reason) / review (no ownerOnly) → waiting on an
        // entity or the commander to unblock/review. We keep this coarse: a
        // review card is waiting on the commander/reviewer; a blocked card is
        // waiting on an entity. Neither creates an inbox item.
        if (status === 'review') return 'commander';
        if (status === 'blocked') return 'entity';

        // Everything else (todo / in_progress without a marker / done / etc.)
        // is not in a waiting state we track → null (fail-safe: not surfaced).
        return null;
    } catch (_) {
        // Never throw on a malformed card — fail-safe to "not surfaced".
        return null;
    }
}

module.exports = {
    AWAIT_OWNER_MARKER_RE,
    classifyCardWaitingState,
};
