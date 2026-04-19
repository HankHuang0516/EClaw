/**
 * Google Play acknowledge retry sweep — P2 revenue-leak backstop.
 *
 * Problem: `/api/wallet/topup/verify-google` (wallet.js) credits the ledger
 * then fire-and-forgets Google's `:acknowledge`. If that ack silently fails
 * for >3 days Google auto-refunds the purchase, but our ledger still holds
 * the credit — silent revenue leak.
 *
 * Design:
 *   - Credit path sets topup_orders.ack_state='pending' (default) and
 *     ack_attempts=0 on insert; on ack success → 'acked'; on ack failure
 *     → bump attempts (see wallet.js verify-google route).
 *   - This sweep runs hourly, retries every google_play row where
 *     ack_state NOT IN ('acked','failed') AND created_at within last 72h
 *     (Google's auto-refund window). On success → mark 'acked'. On 3
 *     consecutive failures → mark 'failed' (terminal: no further retries)
 *     and emit an audit warn so ops can investigate before the refund lands.
 *
 * The sweep is idempotent: :acknowledge on an already-acked purchase is a
 * no-op on Google's side (they return 200 or 'already acknowledged' — both
 * treated as success here).
 *
 * Cron registration: see index.js — registered via setInterval at startup,
 * following the existing pattern (e.g. subscription.processRecurringCharges,
 * device-cleanup). Cadence: `0 * * * *` (hourly). Opt-out via
 * `GOOGLE_PLAY_ACK_SWEEP_DISABLED=1` for emergency rollback.
 */

'use strict';

// Retry ceiling. After the 3rd consecutive failure we stop and flag the row
// as 'failed' so the ack-cron doesn't keep hammering a dead endpoint.
const MAX_ATTEMPTS = 3;

// Google auto-refunds un-acked purchases after ~3 days. We scan the 72h
// window (with a small buffer); anything older is past the point of no
// return and should be investigated manually.
const REFUND_WINDOW_MS = 72 * 60 * 60 * 1000;

// Hard cap on rows processed per run — avoids unbounded work if the queue
// grows. A healthy system should have near-zero pending rows.
const BATCH_LIMIT = 100;

/**
 * Run one sweep pass.
 *
 * @param {Object} deps
 * @param {Object} deps.pool        — pg pool (required)
 * @param {Function} deps.audit     — serverLog-style (level, tag, msg, meta)
 * @param {Function} deps.acknowledgeGooglePurchase — wallet.js export
 * @param {string} deps.packageName — GOOGLE_PACKAGE_NAME fallback
 * @returns {Promise<{scanned, acked, failed, exhausted, skipped}>}
 */
async function runAckRetrySweep({
    pool,
    audit = () => {},
    acknowledgeGooglePurchase,
    packageName,
} = {}) {
    if (!pool || typeof pool.query !== 'function') {
        throw new Error('pool_required');
    }
    if (typeof acknowledgeGooglePurchase !== 'function') {
        throw new Error('acknowledgeGooglePurchase_required');
    }

    const stats = { scanned: 0, acked: 0, failed: 0, exhausted: 0, skipped: 0 };

    // Pull candidate rows. We need external_raw to get purchaseToken +
    // packageName + productId (credit path stashes them there).
    const windowStart = new Date(Date.now() - REFUND_WINDOW_MS);
    let rows;
    try {
        const res = await pool.query(
            `SELECT id, user_id, external_txn_id, external_raw, ack_attempts
             FROM topup_orders
             WHERE channel = 'google_play'
               AND ack_state <> 'acked'
               AND ack_state <> 'failed'
               AND status = 'paid'
               AND created_at >= $1
             ORDER BY created_at ASC
             LIMIT $2`,
            [windowStart, BATCH_LIMIT]
        );
        rows = res.rows;
    } catch (err) {
        audit('error', 'wallet', `ack_sweep query failed: ${err.message}`, {
            action: 'ack_sweep', result: 'query_failed',
        });
        return stats;
    }

    stats.scanned = rows.length;
    if (rows.length === 0) return stats;

    for (const row of rows) {
        const raw = row.external_raw || {};
        const productId = raw.productId;
        const purchaseToken = raw.purchaseToken;
        const pkg = raw.packageName || packageName;

        // Rows created before this feature shipped won't have packageName /
        // purchaseToken in external_raw. We can't retry those — flag as
        // skipped so ops knows to ignore them (or backfill manually).
        if (!productId || !purchaseToken || !pkg) {
            stats.skipped += 1;
            audit('warn', 'wallet', `ack_sweep skipped order=${row.id} — missing ack fields in external_raw`, {
                action: 'ack_sweep', resource: row.id, result: 'missing_fields',
                metadata: {
                    hasProductId: !!productId,
                    hasPurchaseToken: !!purchaseToken,
                    hasPackageName: !!pkg,
                },
            });
            continue;
        }

        let ackRes;
        try {
            ackRes = await acknowledgeGooglePurchase(pkg, productId, purchaseToken);
        } catch (err) {
            // acknowledgeGooglePurchase is documented as never-throws, but
            // belt-and-braces: treat as failure.
            ackRes = { ok: false, error: err && err.message ? err.message : 'ack_threw' };
        }

        if (ackRes && ackRes.ok) {
            try {
                await pool.query(
                    `UPDATE topup_orders
                     SET ack_state = 'acked',
                         ack_at = NOW(),
                         ack_attempts = ack_attempts + 1
                     WHERE id = $1 AND ack_state <> 'acked'`,
                    [row.id]
                );
                stats.acked += 1;
                audit('info', 'wallet', `ack_sweep succeeded order=${row.id}`, {
                    userId: row.user_id, action: 'ack_sweep', resource: row.id, result: 'acked',
                });
            } catch (err) {
                audit('error', 'wallet', `ack_sweep state-update failed order=${row.id}: ${err.message}`, {
                    action: 'ack_sweep', resource: row.id, result: 'state_update_failed',
                });
            }
            continue;
        }

        // Failure path — bump attempts and decide whether to mark failed.
        const nextAttempts = (row.ack_attempts || 0) + 1;
        const shouldFail = nextAttempts >= MAX_ATTEMPTS;
        try {
            await pool.query(
                `UPDATE topup_orders
                 SET ack_attempts = ack_attempts + 1,
                     ack_state = CASE WHEN $2::boolean THEN 'failed' ELSE ack_state END
                 WHERE id = $1 AND ack_state <> 'acked'`,
                [row.id, shouldFail]
            );
        } catch (err) {
            audit('error', 'wallet', `ack_sweep failure-update failed order=${row.id}: ${err.message}`, {
                action: 'ack_sweep', resource: row.id, result: 'state_update_failed',
            });
            continue;
        }

        if (shouldFail) {
            stats.exhausted += 1;
            // Audit warn + speakTo-style alert. Ops-facing: Google will auto-
            // refund within 72h of createdAt and our ledger is still credited.
            // Finance must reconcile before the refund lands.
            audit('warn', 'wallet', `ack_sweep EXHAUSTED order=${row.id} — Google will auto-refund; reconcile ledger manually`, {
                userId: row.user_id,
                action: 'ack_sweep',
                resource: row.id,
                result: 'exhausted',
                metadata: {
                    external_txn_id: row.external_txn_id,
                    attempts: nextAttempts,
                    last_error: ackRes && ackRes.error,
                    product_id: productId,
                },
            });
        } else {
            stats.failed += 1;
            audit('warn', 'wallet', `ack_sweep retry failed order=${row.id} attempts=${nextAttempts}`, {
                userId: row.user_id,
                action: 'ack_sweep',
                resource: row.id,
                result: 'retry_failed',
                metadata: {
                    attempts: nextAttempts,
                    last_error: ackRes && ackRes.error,
                },
            });
        }
    }

    return stats;
}

/**
 * Register the hourly sweep on an existing interval handle. Returns a
 * function that clears the timer (for tests / shutdown). No-op if
 * GOOGLE_PLAY_ACK_SWEEP_DISABLED=1.
 */
function startAckRetrySweep({
    pool,
    audit,
    acknowledgeGooglePurchase,
    packageName,
    intervalMs = 60 * 60 * 1000, // hourly
    initialDelayMs = 5 * 60 * 1000, // 5min after boot — let DB + wallet schema settle
} = {}) {
    if (process.env.GOOGLE_PLAY_ACK_SWEEP_DISABLED === '1') {
        console.log('[AckSweep] disabled via GOOGLE_PLAY_ACK_SWEEP_DISABLED=1');
        return () => {};
    }

    const tick = async () => {
        try {
            const stats = await runAckRetrySweep({
                pool, audit, acknowledgeGooglePurchase, packageName,
            });
            if (stats.scanned > 0) {
                console.log(
                    `[AckSweep] scanned=${stats.scanned} acked=${stats.acked} `
                    + `failed=${stats.failed} exhausted=${stats.exhausted} skipped=${stats.skipped}`
                );
            }
        } catch (err) {
            console.error('[AckSweep] tick error:', err && err.message);
        }
    };

    const initial = setTimeout(tick, initialDelayMs);
    const interval = setInterval(tick, intervalMs);
    return () => {
        clearTimeout(initial);
        clearInterval(interval);
    };
}

module.exports = {
    runAckRetrySweep,
    startAckRetrySweep,
    MAX_ATTEMPTS,
    REFUND_WINDOW_MS,
    BATCH_LIMIT,
};
