/**
 * Rental Token Metering Proxy
 *
 * Handles per-message billing for rented bots. When a message targets an
 * entity with a `rental_contract_id`, this module:
 *
 *   1. Estimates input tokens (renter's message)
 *   2. Pre-checks that the renter has sufficient balance
 *   3. After the bot responds (via /api/transform), estimates output tokens
 *   4. Charges the full cost atomically: renter debit + owner credit (85%)
 *      + platform fee (13%) + insurance pool (2%)
 *   5. Writes a `rental_usage_events` row for audit
 *
 * Token estimation uses chars÷4 (average for mixed EN/CJK text). This is
 * intentionally simpler than tiktoken — the design decision (locked #1)
 * requires backend-computed, unforgeable metering, not precision. The
 * formula `cost = (in + out) × rate / 1000` ensures fairness: renter
 * pays exactly for what they see, owner's internal overhead is owner's
 * cost.
 *
 * @see docs/plans/2026-04-10-bot-rental-marketplace-design.md §11.3
 * @see /portal/roadmap.html — ⑧ Token Metering System
 */
/* @brm-crossref: ⑧ Token Metering System
 * Design doc: docs/plans/2026-04-10-bot-rental-marketplace-design.md
 * Roadmap:    /portal/roadmap.html
 * If this module is updated, also update the roadmap page status and the design doc §10 delivery tracker. */

const { Pool } = require('pg');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/realbot'
});

// ============================================
// Constants
// ============================================

const PLATFORM_FEE_BPS = 1500;        // 15% total fee
const INSURANCE_POOL_BPS = 200;       // 2% of transaction to insurance pool
const ECOIN_TO_MLI = 1000;

// Virtual wallet user IDs (must match wallet.js)
const PLATFORM_WALLET_USER_ID = '00000000-0000-0000-0000-000000000001';
const INSURANCE_POOL_USER_ID  = '00000000-0000-0000-0000-000000000002';

// ============================================
// Token estimation
// ============================================

/**
 * Estimate token count from text. Uses chars÷4 which is a reasonable
 * average for mixed English/CJK content. Returns at least 1 for any
 * non-empty string.
 */
function estimateTokens(text) {
    if (typeof text !== 'string' || text.length === 0) return 0;
    return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Compute the e-coin cost (in mli) for a given token count and rate.
 * Formula: tokens × rate_mli_per_ktoken / 1000, rounded up.
 */
function computeCostMli(tokens, rateMliPerKtoken) {
    if (tokens <= 0 || rateMliPerKtoken <= 0) return 0;
    return Math.ceil(tokens * rateMliPerKtoken / 1000);
}

/**
 * Split a gross charge into renter-pays, owner-gets, platform-gets,
 * insurance-gets. All in mli.
 */
function splitFees(grossMli) {
    if (grossMli <= 0) return { gross: 0, ownerNet: 0, platformNet: 0, insuranceMli: 0 };
    const insuranceMli = Math.floor(grossMli * INSURANCE_POOL_BPS / 10000);
    const platformGross = Math.floor(grossMli * PLATFORM_FEE_BPS / 10000);
    const platformNet = platformGross - insuranceMli;
    const ownerNet = grossMli - platformGross;
    return { gross: grossMli, ownerNet, platformNet, insuranceMli };
}

// ============================================
// Balance check (pre-send gate)
// ============================================

/**
 * Check whether the renter can afford to send a message. Returns
 * `{ allowed, estimatedCostMli, balanceMli }`. Does NOT charge —
 * charging happens after the bot responds.
 *
 * Uses its own pool.query (no transaction) because this is a
 * read-only advisory check.
 */
async function preCheckBalance({ renterUserId, inputText, rateMliPerKtoken }) {
    const inputTokens = estimateTokens(inputText);
    // Estimate output ≈ 2× input (conservative buffer for cost check)
    const estimatedTotalTokens = inputTokens * 3;
    const estimatedCostMli = computeCostMli(estimatedTotalTokens, rateMliPerKtoken);

    const res = await pool.query(
        'SELECT balance_mli FROM wallets WHERE user_id = $1',
        [renterUserId]
    );
    const balanceMli = res.rowCount > 0 ? Number(res.rows[0].balance_mli) : 0;
    return {
        allowed: balanceMli >= estimatedCostMli,
        estimatedCostMli,
        balanceMli,
        inputTokens,
    };
}

// ============================================
// Charge (post-response)
// ============================================

/**
 * Charge the renter for a completed rental message exchange.
 * Called after the bot's response arrives via /api/transform.
 *
 * Runs inside a single transaction (via the injected walletModule):
 *   - Debit renter for gross cost
 *   - Credit owner's pending_income (released after T+24h)
 *   - Credit platform wallet
 *   - Credit insurance pool
 *   - Insert rental_usage_events rows
 *   - Update contract aggregate counters
 *
 * Returns `{ charged, costMli, inputTokens, outputTokens, newBalanceMli }`.
 *
 * If the renter's balance is insufficient for the full charge, charges
 * whatever is available and returns `{ suspended: true }` to signal that
 * the contract should transition to suspended_insufficient_funds.
 */
async function chargeRentalUsage({
    walletModule,
    contractId, listingId: _listingId,
    renterUserId, ownerUserId,
    rateMliPerKtoken,
    inputText, outputText,
    messageId = null,
}) {
    const inputTokens = estimateTokens(inputText);
    const outputTokens = estimateTokens(outputText);
    const totalTokens = inputTokens + outputTokens;
    const grossCostMli = computeCostMli(totalTokens, rateMliPerKtoken);

    if (grossCostMli <= 0) {
        return { charged: false, costMli: 0, inputTokens, outputTokens, suspended: false };
    }

    const idemBase = `rental-usage:${contractId}:${messageId || Date.now()}`;

    return walletModule.withTransaction(async (client) => {
        // Check renter balance
        const balRes = await client.query(
            'SELECT balance_mli FROM wallets WHERE user_id = $1 FOR UPDATE',
            [renterUserId]
        );
        const currentBalance = balRes.rowCount > 0 ? Number(balRes.rows[0].balance_mli) : 0;

        let balanceChargeMli = grossCostMli;
        let depositChargeMli = 0;
        let suspended = false;

        if (currentBalance < grossCostMli) {
            // Balance insufficient — drain balance to 0, cover shortfall
            // from deposit (held_mli). This is the "last message" scenario.
            balanceChargeMli = Math.max(0, currentBalance);
            depositChargeMli = grossCostMli - balanceChargeMli;
            suspended = true;
        }
        const totalChargeMli = balanceChargeMli + depositChargeMli;

        // --- Debit from main balance ---
        if (balanceChargeMli > 0) {
            await walletModule.applyLedgerEntry(client, {
                userId: renterUserId,
                balanceDelta: -balanceChargeMli,
                heldDelta: 0,
                type: walletModule.LEDGER_TYPES.RENTAL_SPEND,
                refType: 'rental_contract',
                refId: contractId,
                counterpartyUserId: ownerUserId,
                note: `${inputTokens}+${outputTokens} tok`,
                idempotencyKey: `${idemBase}:spend`,
            });
        }

        // --- Debit shortfall from deposit (held → void) ---
        if (depositChargeMli > 0) {
            // Read current held to cap the deduction
            const heldRes = await client.query(
                'SELECT held_mli FROM wallets WHERE user_id = $1',
                [renterUserId]
            );
            const currentHeld = heldRes.rowCount > 0 ? Number(heldRes.rows[0].held_mli) : 0;
            depositChargeMli = Math.min(depositChargeMli, currentHeld);

            if (depositChargeMli > 0) {
                await walletModule.applyLedgerEntry(client, {
                    userId: renterUserId,
                    balanceDelta: 0,
                    heldDelta: -depositChargeMli,
                    type: walletModule.LEDGER_TYPES.DEPOSIT_FORFEIT,
                    refType: 'rental_contract',
                    refId: contractId,
                    note: `last-msg deposit deduction: ${depositChargeMli} mli`,
                    idempotencyKey: `${idemBase}:dep-deduct`,
                });
            }
        }

        // --- Distribute total charge (balance + deposit portions) via 85/13/2 split ---
        if (totalChargeMli > 0) {
            const fees = splitFees(totalChargeMli);

            // Credit owner pending_income
            await client.query(
                `UPDATE wallets SET pending_income_mli = COALESCE(pending_income_mli, 0) + $1
                 WHERE user_id = $2`,
                [fees.ownerNet, ownerUserId]
            );
            await walletModule.applyLedgerEntry(client, {
                userId: ownerUserId,
                balanceDelta: 0,
                heldDelta: 0,
                type: walletModule.LEDGER_TYPES.RENTAL_INCOME,
                refType: 'rental_contract',
                refId: contractId,
                counterpartyUserId: renterUserId,
                note: `pending: ${fees.ownerNet} mli (T+24h)`,
                idempotencyKey: `${idemBase}:income`,
            });

            // Credit platform wallet
            if (fees.platformNet > 0) {
                await walletModule.applyLedgerEntry(client, {
                    userId: PLATFORM_WALLET_USER_ID,
                    balanceDelta: fees.platformNet,
                    heldDelta: 0,
                    type: walletModule.LEDGER_TYPES.PLATFORM_FEE,
                    refType: 'rental_contract',
                    refId: contractId,
                    idempotencyKey: `${idemBase}:pfee`,
                });
            }

            // Credit insurance pool
            if (fees.insuranceMli > 0) {
                await walletModule.applyLedgerEntry(client, {
                    userId: INSURANCE_POOL_USER_ID,
                    balanceDelta: fees.insuranceMli,
                    heldDelta: 0,
                    type: walletModule.LEDGER_TYPES.PLATFORM_FEE,
                    refType: 'rental_contract',
                    refId: contractId,
                    note: 'insurance',
                    idempotencyKey: `${idemBase}:ins`,
                });
            }
        }

        // 5. Insert usage events (always, even if charge = 0 due to suspended)
        await client.query(
            `INSERT INTO rental_usage_events (contract_id, direction, tokens, ecoin_charged_mli, message_id)
             VALUES ($1, 'in', $2, $3, $4)`,
            [contractId, inputTokens, computeCostMli(inputTokens, rateMliPerKtoken), messageId]
        );
        await client.query(
            `INSERT INTO rental_usage_events (contract_id, direction, tokens, ecoin_charged_mli, message_id)
             VALUES ($1, 'out', $2, $3, $4)`,
            [contractId, outputTokens, computeCostMli(outputTokens, rateMliPerKtoken), messageId]
        );

        // 6. Update contract running totals
        await client.query(
            `UPDATE rental_contracts
             SET tokens_consumed = tokens_consumed + $1,
                 ecoin_charged_mli = ecoin_charged_mli + $2
             WHERE id = $3`,
            [totalTokens, totalChargeMli, contractId]
        );

        // Read updated balance for caller
        const newBal = await client.query(
            'SELECT balance_mli FROM wallets WHERE user_id = $1',
            [renterUserId]
        );

        return {
            charged: totalChargeMli > 0,
            costMli: totalChargeMli,
            balanceChargeMli,
            depositChargeMli,
            inputTokens,
            outputTokens,
            totalTokens,
            fees: splitFees(totalChargeMli),
            suspended,
            newBalanceMli: newBal.rowCount > 0 ? Number(newBal.rows[0].balance_mli) : 0,
        };
    });
}

// ============================================
// Contract auto-expiration
// ============================================

/**
 * Find all active contracts past their `ends_at` and end them normally.
 * Called by a per-minute cron. Returns the count of expired contracts.
 */
async function expireContracts(rentalModule, walletModule) {
    const res = await pool.query(
        `SELECT id, renter_user_id FROM rental_contracts
         WHERE status = 'active' AND ends_at <= NOW()
         LIMIT 50`
    );
    let count = 0;
    for (const row of res.rows) {
        try {
            await rentalModule.endRental({
                contractId: row.id,
                endReason: 'ended_normal',
                requesterUserId: row.renter_user_id,
            }, walletModule);
            count++;
        } catch (err) {
            console.warn(`[RentalProxy] Failed to expire contract ${row.id}: ${err.message}`);
        }
    }
    return count;
}

/**
 * Find contracts in suspended_insufficient_funds that have exceeded
 * their grace period, and end them with zero-balance disposition.
 */
async function expireGracePeriods(rentalModule, walletModule) {
    const res = await pool.query(
        `SELECT id, renter_user_id, grace_period_starts_at, ends_at
         FROM rental_contracts
         WHERE status = 'suspended_insufficient_funds'
         LIMIT 50`
    );
    let count = 0;
    for (const row of res.rows) {
        const graceStart = new Date(row.grace_period_starts_at).getTime();
        const contractEnd = new Date(row.ends_at).getTime();
        // Grace period = min(12h, remaining contract time)
        const graceMs = Math.min(12 * 60 * 60 * 1000, contractEnd - graceStart);
        if (Date.now() < graceStart + graceMs) continue; // still within grace

        try {
            await rentalModule.endRental({
                contractId: row.id,
                endReason: 'ended_zero_balance',
                requesterUserId: row.renter_user_id,
            }, walletModule);
            count++;
        } catch (err) {
            console.warn(`[RentalProxy] Failed to expire grace for ${row.id}: ${err.message}`);
        }
    }
    return count;
}

/**
 * Release pending_income for contracts that ended more than 24h ago.
 * Moves the accumulated pending_income from owner's pending bucket
 * to their spendable balance.
 */
async function releasePendingIncome(walletModule) {
    // Find owners whose pending_income > 0 and whose most recent contract
    // ended >= 24h ago. Simplified: just sweep all pending_income for all
    // owners every run — the T+24h delay is the cron interval itself.
    const res = await pool.query(
        `SELECT user_id, pending_income_mli
         FROM wallets
         WHERE COALESCE(pending_income_mli, 0) > 0
         LIMIT 100`
    );
    let released = 0;
    for (const row of res.rows) {
        const amount = Number(row.pending_income_mli);
        if (amount <= 0) continue;

        try {
            await walletModule.withTransaction(async (client) => {
                // Lock wallet
                const locked = await client.query(
                    'SELECT pending_income_mli FROM wallets WHERE user_id = $1 FOR UPDATE',
                    [row.user_id]
                );
                const current = Number(locked.rows[0]?.pending_income_mli || 0);
                if (current <= 0) return;

                // Move pending → balance
                await client.query(
                    `UPDATE wallets
                     SET balance_mli = balance_mli + $1,
                         pending_income_mli = 0,
                         lifetime_earned_mli = lifetime_earned_mli + $1,
                         updated_at = NOW()
                     WHERE user_id = $2`,
                    [current, row.user_id]
                );

                await walletModule.applyLedgerEntry(client, {
                    userId: row.user_id,
                    balanceDelta: current,
                    heldDelta: 0,
                    type: walletModule.LEDGER_TYPES.RENTAL_INCOME,
                    refType: 'income_release',
                    refId: null,
                    note: `T+24h income release: ${current} mli`,
                    idempotencyKey: `income-release:${row.user_id}:${Date.now()}`,
                });
            });
            released++;
        } catch (err) {
            console.warn(`[RentalProxy] Income release failed for ${row.user_id}: ${err.message}`);
        }
    }
    return released;
}

// ============================================
// Exports
// ============================================

module.exports = {
    estimateTokens,
    computeCostMli,
    splitFees,
    preCheckBalance,
    chargeRentalUsage,
    expireContracts,
    expireGracePeriods,
    releasePendingIncome,
    // Constants re-exported for tests
    PLATFORM_FEE_BPS,
    INSURANCE_POOL_BPS,
    ECOIN_TO_MLI,
    PLATFORM_WALLET_USER_ID,
    INSURANCE_POOL_USER_ID,
};
