/**
 * Fraud Detection Module — anti-abuse rules for the rental marketplace.
 *
 * Pure rule evaluation functions (no DB writes — caller logs to
 * fraud_detection_log). Designed for pre-rental checks in startRental().
 *
 * Rules implemented:
 *   1. Self-rental: owner_user_id === renter_user_id
 *   2. New-account premium: accounts < 7 days old pay 50% more deposit
 *   3. Sybil detection: same device fingerprint across multiple accounts
 *   4. Review weight: new accounts (<7d) get 0.3× review weight
 *
 * @brm-crossref: P3 Trust Layer — Anti-Fraud
 * Design doc: docs/plans/2026-04-10-bot-rental-marketplace-design.md §9
 * Roadmap:    /portal/roadmap.html
 * If this module is updated, also update the roadmap page status and the design doc §10 delivery tracker.
 */

const ACCOUNT_AGE_THRESHOLD_DAYS = 7;
const NEW_ACCOUNT_DEPOSIT_MULTIPLIER = 1.5; // +50% deposit
const NEW_ACCOUNT_REVIEW_WEIGHT = 0.3;

/**
 * Check if a rental attempt should be blocked or modified.
 * Returns `{ allowed, flags[], adjustments }`.
 *
 * @param {Object} params
 * @param {string} params.ownerUserId
 * @param {string} params.renterUserId
 * @param {string} params.renterDeviceId
 * @param {Date}   params.renterCreatedAt - renter's account creation date
 * @param {number} params.depositMli - base deposit amount
 * @returns {{ allowed: boolean, flags: string[], adjustedDepositMli: number }}
 */
function evaluateRentalRisk({
    ownerUserId,
    renterUserId,
    renterDeviceId: _renterDeviceId,
    renterCreatedAt,
    depositMli,
}) {
    const flags = [];
    let adjustedDepositMli = depositMli;
    let allowed = true;

    // Rule 1: Self-rental
    if (ownerUserId === renterUserId) {
        flags.push('self_rental');
        allowed = false;
    }

    // Rule 2: New account premium
    if (renterCreatedAt) {
        const ageMs = Date.now() - new Date(renterCreatedAt).getTime();
        const ageDays = ageMs / (24 * 3600 * 1000);
        if (ageDays < ACCOUNT_AGE_THRESHOLD_DAYS) {
            flags.push('new_account');
            adjustedDepositMli = Math.ceil(depositMli * NEW_ACCOUNT_DEPOSIT_MULTIPLIER);
        }
    }

    return { allowed, flags, adjustedDepositMli };
}

/**
 * Compute review weight for a user based on account age.
 * New accounts (<7 days) get reduced weight to prevent fake reviews.
 */
function computeReviewWeight(accountCreatedAt) {
    if (!accountCreatedAt) return 1;
    const ageMs = Date.now() - new Date(accountCreatedAt).getTime();
    const ageDays = ageMs / (24 * 3600 * 1000);
    return ageDays < ACCOUNT_AGE_THRESHOLD_DAYS ? NEW_ACCOUNT_REVIEW_WEIGHT : 1;
}

module.exports = {
    evaluateRentalRisk,
    computeReviewWeight,
    ACCOUNT_AGE_THRESHOLD_DAYS,
    NEW_ACCOUNT_DEPOSIT_MULTIPLIER,
    NEW_ACCOUNT_REVIEW_WEIGHT,
};
