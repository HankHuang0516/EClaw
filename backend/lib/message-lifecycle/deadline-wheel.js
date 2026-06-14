/**
 * MessageLifecycle deadline wheel (spec §4.2).
 *
 * Card: card_545ce5986b9c1332315ba303 (Phase 2 Step 2 — Redis deadline wheel).
 * Spec: docs/specs/message-lifecycle-spec.md §4 (Redis schema + wheel API).
 *
 * Purpose: a Redis-sorted-set-backed deadline queue. Each message_id is stored
 * with a score equal to its next "stuck" deadline in epoch ms. The sweeper
 * (see ./sweeper.js) pops every entry whose score is <= now and either advances
 * its lifecycle row or fires a stuck alert.
 *
 * Redis is cache + deadline wheel, NOT source of truth (spec §4 preamble).
 * If the Redis instance is lost, cold-start (./cold-start.js) repopulates the
 * wheel from the message_lifecycle table on the next boot.
 *
 * Client interface contract
 * -------------------------
 * createWheel({ redisClient }) accepts ANY object with these async methods:
 *
 *   zadd(key, score, member)            -> add or update a member's score
 *   zrem(key, ...members)               -> remove members; returns removed count
 *   zrangebyscore(key, min, max, opts?) -> returns members with min <= score <= max
 *                                          opts = { limit: { offset, count } }
 *   zremrangebyscore(key, min, max)     -> removes members in score range
 *
 * Names are lowercase to match ioredis. The redis@v4 package uses camelCase
 * (zAdd/zRangeByScore) — callers using v4 should wrap their client first
 * (helper not provided in Step 2 to avoid pulling in a hard dependency).
 *
 * If redisClient is null/undefined, createWheel returns a disabled wheel:
 * every method resolves to a no-op (popDue returns []). A single warning is
 * logged at construction time so operators see exactly one line per boot
 * instead of one per request.
 */

const DEFAULT_KEY_PREFIX = 'ml';
const DEFAULT_MAX_BATCH = 500;

function deadlinesKey(prefix) {
    return `${prefix}:deadlines`;
}

function makeDisabledWheel(reason) {
    if (reason) {
        console.warn(`[WARN] LIFECYCLE: ${reason} — deadline wheel disabled, timeouts will not auto-advance. Set REDIS_URL env var.`);
    }
    return {
        enabled: false,
        async schedule() {},
        async cancel() { return 0; },
        async popDue() { return []; },
        async requeue() {},
        async size() { return 0; },
    };
}

/**
 * Create a deadline wheel.
 *
 * @param {object} [options]
 * @param {object} [options.redisClient] Redis client implementing the interface
 *   above. If omitted, returns a disabled wheel with all ops as no-ops.
 * @param {string} [options.keyPrefix='ml'] Key namespace, e.g. 'ml' yields
 *   'ml:deadlines'.
 * @param {number} [options.maxBatch=500] Default batch cap for popDue.
 * @returns {object} wheel with schedule/cancel/popDue/requeue methods.
 */
function createWheel(options = {}) {
    const {
        redisClient = null,
        keyPrefix = DEFAULT_KEY_PREFIX,
        maxBatch: defaultMaxBatch = DEFAULT_MAX_BATCH,
    } = options;

    if (!redisClient) {
        return makeDisabledWheel('REDIS_URL not set');
    }

    const key = deadlinesKey(keyPrefix);

    return {
        enabled: true,

        /**
         * Insert or refresh a deadline (spec §4.2 wheel.schedule).
         * ZADD ml:deadlines <deadline> <message_id>
         */
        async schedule(messageId, deadlineMs) {
            assertMessageId(messageId);
            assertDeadline(deadlineMs);
            await redisClient.zadd(key, Number(deadlineMs), String(messageId));
        },

        /**
         * Remove a deadline (spec §4.2 wheel.cancel).
         * ZREM ml:deadlines <message_id>
         * Returns the count of members removed (0 if the wheel did not have it).
         */
        async cancel(messageId) {
            assertMessageId(messageId);
            const removed = await redisClient.zrem(key, String(messageId));
            return Number(removed) || 0;
        },

        /**
         * Pop all deadlines whose score is <= now (spec §4.2 wheel.popDue).
         * The ZRANGEBYSCORE + ZREMRANGEBYSCORE pair is the at-least-once
         * dispatch primitive — duplicates are absorbed by the sweeper's
         * alert dedup (spec §4.3).
         *
         * @param {number} nowMs Epoch ms cutoff.
         * @param {number} [maxBatch] Override the construction-time cap.
         * @returns {Promise<string[]>} message_ids that were due.
         */
        async popDue(nowMs, maxBatch) {
            assertDeadline(nowMs);
            const count = Number.isInteger(maxBatch) && maxBatch > 0 ? maxBatch : defaultMaxBatch;
            const dueIds = await redisClient.zrangebyscore(
                key,
                '-inf',
                Number(nowMs),
                { limit: { offset: 0, count } }
            );
            if (!Array.isArray(dueIds) || dueIds.length === 0) {
                return [];
            }
            // Remove exactly the ids we returned. Using ZREM (not ZREMRANGEBYSCORE)
            // because between the ZRANGEBYSCORE and a hypothetical ZREMRANGEBYSCORE
            // a new id could land in the same score window and be deleted without
            // ever being returned. Per-id ZREM is the at-least-once contract that
            // the spec §4.2 popDue requires.
            await redisClient.zrem(key, ...dueIds);
            return dueIds.map(String);
        },

        /**
         * Refresh a deadline to a later time (spec §4.2 wheel.requeue).
         * Used by the sweeper after firing a stuck alert to schedule the next
         * re-alert past the cooldown window.
         */
        async requeue(messageId, newDeadlineMs) {
            assertMessageId(messageId);
            assertDeadline(newDeadlineMs);
            await redisClient.zadd(key, Number(newDeadlineMs), String(messageId));
        },

        /**
         * Current wheel population — for /api/debug/message-lifecycle health
         * surfaces (Step 5) and for tests. Not in the spec but cheap.
         */
        async size() {
            if (typeof redisClient.zcard === 'function') {
                const n = await redisClient.zcard(key);
                return Number(n) || 0;
            }
            return null;
        },
    };
}

function assertMessageId(messageId) {
    if (messageId === null || messageId === undefined || messageId === '') {
        throw new TypeError('deadline-wheel: messageId is required');
    }
}

function assertDeadline(ms) {
    if (!Number.isFinite(Number(ms))) {
        throw new TypeError('deadline-wheel: deadline must be a finite number (epoch ms)');
    }
}

/**
 * In-memory Redis-ZSET stub satisfying the wheel's client contract.
 *
 * Exposed because:
 *   - Jest tests need it to exercise the wheel without a live Redis.
 *   - Step 3 dual-write tests can use it to assert wheel state transitions.
 *   - It documents the exact client contract by being a working reference.
 *
 * NOT for production use. Single-process, no persistence, no atomicity.
 */
function createInMemoryClient() {
    const stores = new Map(); // key -> Map<member, score>

    function getOrCreate(key) {
        if (!stores.has(key)) stores.set(key, new Map());
        return stores.get(key);
    }

    return {
        async zadd(key, score, member) {
            const z = getOrCreate(key);
            const isNew = !z.has(member);
            z.set(member, Number(score));
            return isNew ? 1 : 0;
        },
        async zrem(key, ...members) {
            const z = stores.get(key);
            if (!z) return 0;
            let removed = 0;
            for (const m of members) {
                if (z.delete(m)) removed++;
            }
            return removed;
        },
        async zrangebyscore(key, min, max, opts = {}) {
            const z = stores.get(key);
            if (!z) return [];
            const lo = min === '-inf' ? -Infinity : Number(min);
            const hi = max === '+inf' ? Infinity : Number(max);
            const out = [];
            for (const [member, score] of z.entries()) {
                if (score >= lo && score <= hi) out.push([member, score]);
            }
            // ZRANGEBYSCORE returns members in ascending score order;
            // ties broken lexicographically by member.
            out.sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
            const offset = opts?.limit?.offset || 0;
            const count = opts?.limit?.count;
            const sliced = Number.isInteger(count)
                ? out.slice(offset, offset + count)
                : out.slice(offset);
            return sliced.map(([m]) => m);
        },
        async zremrangebyscore(key, min, max) {
            const z = stores.get(key);
            if (!z) return 0;
            const lo = min === '-inf' ? -Infinity : Number(min);
            const hi = max === '+inf' ? Infinity : Number(max);
            let removed = 0;
            for (const [member, score] of [...z.entries()]) {
                if (score >= lo && score <= hi) {
                    z.delete(member);
                    removed++;
                }
            }
            return removed;
        },
        async zcard(key) {
            const z = stores.get(key);
            return z ? z.size : 0;
        },
        _flushall() {
            stores.clear();
        },
    };
}

module.exports = {
    createWheel,
    createInMemoryClient,
    // Exposed for tests + downstream modules (e.g. cold-start.js needs to
    // share the same prefix when it repopulates the wheel).
    DEFAULT_KEY_PREFIX,
    deadlinesKey,
};
