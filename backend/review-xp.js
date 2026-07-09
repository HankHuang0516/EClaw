'use strict';

/**
 * Review-economy XP rules (card_1d071107, Hank directive 2026-07-05).
 *
 *   「審查抓出問題可以獲得五倍的經驗值」
 *
 * Make "an INDEPENDENT review that catches a REAL, verified defect" a
 * high-multiplier XP event, so the reward economy reinforces serious
 * reviewing rather than rubber-stamping.
 *
 * This module holds ONLY the pure decision logic (no DB, no I/O) so it can be
 * unit-tested in isolation. The kanban review workflow calls
 * evaluateReviewDefectAward() and, when qualified, awards
 *   base × REVIEW_VERIFIED_DEFECT_XP_MULTIPLIER
 * to the REVIEWING entity via awardEntityXP().
 */

// Base XP for a completed independent review. A review that finds nothing
// wrong still earns this; only a verified-defect review multiplies it.
const REVIEW_BASE_XP = 10;

// The reward multiplier. A verified-real-defect review pays base × 5.
// Named constant so the whole reward economy is auditable in one place and a
// future rebalance is a one-line change.
const REVIEW_VERIFIED_DEFECT_XP_MULTIPLIER = 5;

// Verdicts that, on their own, mean the review found a real, merge-blocking
// problem. Case-insensitive; hyphen/underscore/space tolerant on the caller
// side via normalizeVerdict().
const DO_NOT_MERGE_VERDICTS = new Set(['do-not-merge', 'request-changes', 'reject']);

// Finding severities that count as a "real defect" for the multiplier. LOW /
// NIT / INFO are legitimate review output but do NOT earn the 5× — the
// economy pays for catching things that would actually have shipped a bug.
const DEFECT_SEVERITIES = new Set(['high', 'med', 'medium', 'critical']);

/**
 * Normalize a free-form verdict/severity token to a lowercase, hyphenated
 * key: "DO_NOT_MERGE" / "Do Not Merge" / "do not merge" → "do-not-merge".
 * Returns '' for null/undefined/non-string.
 */
function normalizeToken(v) {
    if (typeof v !== 'string') return '';
    return v.trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/**
 * Decide whether an independent review qualifies for the verified-defect
 * multiplier, and compute the XP to award the reviewer.
 *
 * The reward requires ALL of:
 *   1. verdict is DO-NOT-MERGE (or request-changes/reject), OR the review
 *      reports at least one confirmed HIGH/MED/CRITICAL finding;
 *   2. prSentBack === true — the reviewed PR was CONSEQUENTLY sent back for
 *      changes rather than merged as-is (proves the defect had real effect);
 *   3. the review is not a self-review — reviewerEntityId must differ from
 *      authorEntityId when an author is known (an "independent" review).
 *
 * A review that is completed but does NOT qualify still earns the flat base
 * (multiplier 1). A malformed/empty input earns nothing (multiplier 0).
 *
 * @param {object} input
 * @param {string} [input.verdict]           review verdict token
 * @param {string} [input.severity]          highest confirmed finding severity
 * @param {Array}  [input.findings]          [{severity, confirmed}] optional
 * @param {boolean} [input.prSentBack]       was the PR sent back for changes
 * @param {number} [input.reviewerEntityId]  who reviewed
 * @param {number} [input.authorEntityId]    who authored the reviewed work
 * @param {number} [input.baseXp]            base XP (default REVIEW_BASE_XP)
 * @returns {{ awardXp:number, multiplier:number, qualified:boolean,
 *             reason:string }}
 */
function evaluateReviewDefectAward(input) {
    const {
        verdict,
        severity,
        findings,
        prSentBack,
        reviewerEntityId,
        authorEntityId,
        baseXp,
    } = input || {};

    const base = Number.isFinite(baseXp) ? baseXp : REVIEW_BASE_XP;

    // Nothing to reward if we can't even identify the reviewer.
    if (!Number.isInteger(reviewerEntityId) || reviewerEntityId < 0) {
        return { awardXp: 0, multiplier: 0, qualified: false, reason: 'no_reviewer' };
    }

    // Independence guard: a self-review (reviewer === author) never earns the
    // multiplier. When authorEntityId is unknown (null/undefined) we can't
    // prove independence but we DON'T block — the caller (kanban) already
    // scopes the endpoint to the assigned reviewer, and the assigned reviewer
    // is by construction independent of the assignees.
    const isSelfReview = Number.isInteger(authorEntityId)
        && authorEntityId === reviewerEntityId;

    // Does the verdict/severity/findings describe a real, verified defect?
    const verdictHit = DO_NOT_MERGE_VERDICTS.has(normalizeToken(verdict));
    const severityHit = DEFECT_SEVERITIES.has(normalizeToken(severity));
    const findingsHit = Array.isArray(findings) && findings.some(f =>
        f && f.confirmed === true && DEFECT_SEVERITIES.has(normalizeToken(f.severity)));
    const foundRealDefect = verdictHit || severityHit || findingsHit;

    const qualified = foundRealDefect && prSentBack === true && !isSelfReview;

    const multiplier = qualified ? REVIEW_VERIFIED_DEFECT_XP_MULTIPLIER : 1;
    const awardXp = base * multiplier;

    let reason;
    if (qualified) reason = 'verified_defect';
    else if (isSelfReview) reason = 'self_review_no_multiplier';
    else if (foundRealDefect && prSentBack !== true) reason = 'defect_but_pr_not_sent_back';
    else reason = 'review_completed_no_defect';

    return { awardXp, multiplier, qualified, reason };
}

module.exports = {
    REVIEW_BASE_XP,
    REVIEW_VERIFIED_DEFECT_XP_MULTIPLIER,
    DO_NOT_MERGE_VERDICTS,
    DEFECT_SEVERITIES,
    normalizeToken,
    evaluateReviewDefectAward,
};
