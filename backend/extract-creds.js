/**
 * extract-creds.js — centralized device/bot credential extraction.
 *
 * SECURITY (secret-leakage hardening): historically these endpoints read the
 * deviceSecret / botSecret from the URL query string. Secrets in a GET query
 * leak into browser history, server access logs, Cloudflare logs and the
 * `Referer` header. This helper ADDITIVELY accepts the secret from request
 * HEADERS so callers can stop putting it in the URL — without breaking the
 * existing query/body callers (that removal is a later, breaking Stage 3).
 *
 * Header convention (matches the existing one already used by
 * index.js handleVisibility / interview-arena.js / index.js:7939):
 *   X-Device-Id      → deviceId   (not secret, but accepted for symmetry)
 *   X-Device-Secret  → deviceSecret
 *   X-Bot-Secret     → botSecret
 *   X-Entity-Id      → entityId
 * `Authorization: Bearer <secret>` is also accepted: the bearer token is
 * surfaced as BOTH a deviceSecret and a botSecret candidate so existing
 * device-or-bot auth logic can match it against either (it only validates a
 * value it can verify, so the unused one is harmless).
 *
 * Precedence (purely additive — query/body keep winning so behavior is
 * unchanged for current callers): query/body  >  X-* header  >  Bearer.
 */
'use strict';

function bearerToken(req) {
    const h = (req && req.headers) || {};
    const raw = h.authorization || h.Authorization;
    if (typeof raw === 'string' && /^Bearer\s+/i.test(raw)) {
        const tok = raw.replace(/^Bearer\s+/i, '').trim();
        return tok || undefined;
    }
    return undefined;
}

/**
 * Extract { deviceId, deviceSecret, botSecret, entityId } from a request,
 * sourcing from query/body first, then X-* headers, then a Bearer token.
 * Never logs or echoes any value.
 *
 * @param {object} req Express request
 * @returns {{deviceId:any, deviceSecret:any, botSecret:any, entityId:any}}
 */
function extractCreds(req) {
    const query = (req && req.query) || {};
    const body = (req && req.body && typeof req.body === 'object') ? req.body : {};
    const headers = (req && req.headers) || {};
    // Body overrides query (preserves the existing `{ ...query, ...body }`
    // precedence used across the codebase); headers are a lower-priority
    // fallback so current query/body callers are completely unaffected.
    const merged = { ...query, ...body };
    const bearer = bearerToken(req);

    const pick = (mergedKey, headerKey) =>
        (merged[mergedKey] != null ? merged[mergedKey] : headers[headerKey]);

    return {
        deviceId: pick('deviceId', 'x-device-id'),
        deviceSecret: pick('deviceSecret', 'x-device-secret') != null
            ? pick('deviceSecret', 'x-device-secret')
            : bearer,
        botSecret: pick('botSecret', 'x-bot-secret') != null
            ? pick('botSecret', 'x-bot-secret')
            : bearer,
        entityId: pick('entityId', 'x-entity-id'),
    };
}

module.exports = extractCreds;
module.exports.extractCreds = extractCreds;
module.exports.bearerToken = bearerToken;
