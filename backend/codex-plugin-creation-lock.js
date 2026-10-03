'use strict';

const crypto = require('crypto');
const { performance } = require('perf_hooks');

/**
 * Serialize Codex creation for one owner across application instances.
 *
 * Keep the checked-out session for the entire callback: a transaction/row lock
 * would not cover its pool queries and HTTP side effects. The callback must
 * re-read creation state after acquiring the lock. Requires session-affine
 * PostgreSQL connections and spare pool capacity for callback queries.
 *
 * This prevents concurrent creation; it cannot reconcile a provisioning request
 * whose side effect succeeded but whose response/persistence was lost.
 */
async function withCreationLock(pool, deviceId, fn, { timeoutMs = 5000, retryIntervalMs = 50 } = {}) {
    if (!pool || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool is required');
    if (typeof deviceId !== 'string' || !deviceId.length) throw new TypeError('An owner device ID is required');
    if (typeof fn !== 'function') throw new TypeError('A creation callback is required');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60000) throw new TypeError('Invalid creation lock timeout');
    if (!Number.isInteger(retryIntervalMs) || retryIntervalMs < 1 || retryIntervalMs > 1000) throw new TypeError('Invalid creation lock retry interval');

    // A namespaced, signed 64-bit key is stable across processes. Passing a
    // decimal string preserves all bigint bits through node-postgres.
    const key = crypto.createHash('sha256').update('eclawbot:codex-plugin:creation\0')
        .update(deviceId).digest().readBigInt64BE(0).toString();
    const client = await pool.connect();
    let acquired = false;
    let callbackFailed = false;
    let discardError;
    try {
        const deadline = performance.now() + timeoutMs;
        while (!acquired) {
            try {
                const result = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [key]);
                const held = result.rows[0]?.acquired;
                if (typeof held !== 'boolean') throw new Error('Invalid creation advisory lock response');
                acquired = held;
            } catch (error) {
                // The server may have acquired the lock before the response failed.
                // Destroy this session instead of returning a possible lock to pool.
                discardError = error;
                throw error;
            }
            if (acquired) break;
            const remaining = deadline - performance.now();
            if (remaining <= 0) throw Object.assign(new Error('Another creation is in progress; retry with the same request_id'), {
                status: 409, code: 'creation_busy'
            });
            await new Promise(resolve => setTimeout(resolve, Math.min(retryIntervalMs, remaining)));
        }
        return await fn();
    } catch (error) {
        callbackFailed = true;
        throw error;
    } finally {
        try {
            if (acquired) {
                try {
                    const result = await client.query('SELECT pg_advisory_unlock($1::bigint) AS unlocked', [key]);
                    if (result.rows[0]?.unlocked !== true) throw new Error('Creation advisory lock was not held at release');
                } catch (error) {
                    discardError = error;
                    // Preserve the original creation error when cleanup also fails.
                    if (!callbackFailed) throw error;
                }
            }
        } finally {
            if (discardError) client.release(discardError);
            else client.release();
        }
    }
}

module.exports = { withCreationLock };
