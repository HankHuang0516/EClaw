'use strict';

// Server-side idempotency-key dedupe for /api/transform.
// Card: card_47ed9a0c (OODA-R Phase 2 #5 offline delivery queue).
// Spec: docs/offline-delivery-queue-spec.md.
//
// Express middleware that caches the (status, response body) of the FIRST
// call for a given (deviceId, Idempotency-Key) pair, then short-circuits
// subsequent calls within 24h to return the cached response.
//
// Design rules:
// - Raw client key never lands in the DB — only sha256(deviceId|key).
// - Missing header → no-op (legacy clients keep working).
// - DB lookup error → fall through to handler (availability > perfect dedupe).
// - First-write insert is async + ON CONFLICT DO NOTHING (race-safe).

const crypto = require('crypto');

const TTL_HOURS = 24;
const MIN_KEY_LEN = 8;
const MAX_KEY_LEN = 128;

function hashKey(deviceId, key) {
    return crypto.createHash('sha256').update(`${deviceId}|${key}`).digest('hex');
}

function isValidClientKey(key) {
    if (typeof key !== 'string') return false;
    if (key.length < MIN_KEY_LEN || key.length > MAX_KEY_LEN) return false;
    return /^[\w.\-]+$/.test(key);
}

function makeMiddleware(pool, { ttlHours = TTL_HOURS } = {}) {
    return async function idempotencyMiddleware(req, res, next) {
        const clientKey = req.get('Idempotency-Key') || req.get('idempotency-key');
        const deviceId = req.body && req.body.deviceId;
        if (!clientKey || !deviceId || !isValidClientKey(clientKey)) {
            return next();
        }
        const hash = hashKey(deviceId, clientKey);

        try {
            const cached = await pool.query(
                'SELECT response_blob, status_code FROM idempotency_keys WHERE hash = $1 AND expires_at > NOW()',
                [hash]
            );
            if (cached.rows.length > 0) {
                res.set('X-Idempotent-Hit', '1');
                return res.status(cached.rows[0].status_code).json(cached.rows[0].response_blob);
            }
        } catch (err) {
            console.warn('[idem] cache lookup failed:', err && err.message);
            return next();
        }

        const origJson = res.json.bind(res);
        res.json = (body) => {
            const status = res.statusCode || 200;
            pool.query(
                `INSERT INTO idempotency_keys (hash, response_blob, status_code, expires_at)
                 VALUES ($1, $2::jsonb, $3, NOW() + ($4 || ' hours')::interval)
                 ON CONFLICT (hash) DO NOTHING`,
                [hash, JSON.stringify(body), status, String(ttlHours)]
            ).catch((err) => {
                console.warn('[idem] insert failed:', err && err.message);
            });
            return origJson(body);
        };

        next();
    };
}

module.exports = {
    makeMiddleware,
    hashKey,
    isValidClientKey,
    TTL_HOURS,
    MIN_KEY_LEN,
    MAX_KEY_LEN,
};
