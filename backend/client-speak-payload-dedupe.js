'use strict';

// Short-window payload-hash dedupe for /api/client/speak.
//
// Background: card_51eb9991e76821f4cd8f7a1e (Hank 2026-06-10 12:08 TW).
// Some clients (e.g., the claude.ai web_chat embedding) auto-retry a slow
// /api/client/speak request after 5-10s. Each retry generates a NEW
// Idempotency-Key, so the existing header-keyed middleware (idempotency-keys.js)
// can't dedupe. Result: same user-typed message lands twice in chat_messages
// and the bot receives 2 push notifications.
//
// This middleware adds a second dedupe gate keyed on a sha256 of the
// payload itself (deviceId|entityId|text|source|mediaUrl), with a 10s
// rolling window. First call processes normally; calls within the window
// short-circuit with the cached response and X-Client-Speak-Dedupe: hit.
//
// Design rules:
// - Payload-only hashing (no per-call key needed from client)
// - 10s window (matches observed retry cadence; smaller risks legit repeat-sends)
// - Per-process in-memory map (across replicas is best-effort; a duplicate
//   between two replicas within 10s is rare and acceptable as a follow-up)
// - GC sweeps every 30s
// - Wraps res.json to cache the actual response payload (status + body)

const crypto = require('crypto');

const DEFAULT_WINDOW_MS = 10_000;
const GC_INTERVAL_MS = 30_000;

function hashPayload(parts) {
    return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function makeMiddleware(options = {}) {
    const windowMs = options.windowMs || DEFAULT_WINDOW_MS;
    const cache = new Map();  // key -> { ts, status, body }

    function gc() {
        const cutoff = Date.now() - windowMs * 3;
        for (const [k, v] of cache) {
            if (v.ts < cutoff) cache.delete(k);
        }
    }

    const gcTimer = setInterval(gc, GC_INTERVAL_MS);
    if (gcTimer.unref) gcTimer.unref();

    function middleware(req, res, next) {
        const { deviceId, entityId, text, source, mediaUrl } = req.body || {};
        if (!deviceId || (!text && !mediaUrl)) {
            return next();  // let handler emit its own validation error
        }

        // Normalize entityId since it can be number, array, "all", etc.
        const normalizedEid = Array.isArray(entityId)
            ? [...entityId].sort().join(',')
            : String(entityId == null ? '' : entityId);

        const key = hashPayload([
            deviceId,
            normalizedEid,
            String(text || ''),
            String(source || ''),
            String(mediaUrl || ''),
        ]);

        const cached = cache.get(key);
        if (cached && Date.now() - cached.ts < windowMs) {
            res.set('X-Client-Speak-Dedupe', 'hit');
            return res.status(cached.status).json(cached.body);
        }

        const origJson = res.json.bind(res);
        res.json = (body) => {
            const status = res.statusCode || 200;
            // Only cache 2xx (success) and 4xx (client error) — never 5xx,
            // so a transient server failure doesn't replay for 10s.
            if (status < 500) {
                cache.set(key, { ts: Date.now(), status, body });
            }
            return origJson(body);
        };

        next();
    }

    middleware._cache = cache;       // exposed for tests
    middleware._gc = gc;
    middleware._stop = () => clearInterval(gcTimer);
    return middleware;
}

module.exports = { makeMiddleware, hashPayload, DEFAULT_WINDOW_MS };
