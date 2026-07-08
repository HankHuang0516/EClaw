/**
 * agent-identity — cross-service "prove you are a real EClaw agent" primitive.
 *
 * WHY THIS EXISTS
 *   The external Wishlist app used to gate its write path on a SHARED merchant
 *   secret (`x-merchant-api-key` / `WISHLIST_MERCHANT_KEY`). Owner directive:
 *   NO merchant key. Instead an EClaw agent proves its OWN EClaw identity and the
 *   wishlist backend verifies that identity against EClaw before allowing a write.
 *   Nothing shared, nothing long-lived crosses the wire to be stored.
 *
 * TWO VERIFY PATHS (both resolve to the caller's OWN publicCode, never a
 * client-supplied one):
 *
 *   1. TOKEN (preferred). The agent first calls (through the wishlist-bridge)
 *      `mintAgentToken(...)` — its long-lived botSecret is checked ONCE, in
 *      EClaw, and swapped for a SHORT-LIVED, HMAC-signed, single-purpose token
 *      that carries only { publicCode, exp }. The wishlist backend then presents
 *      that token to `verifyAgentToken(...)`, which returns { valid, publicCode }
 *      and NOTHING sensitive. The raw long-lived botSecret is therefore never
 *      sent to (or seen by) the wishlist service.
 *
 *   2. BOT-SECRET TRANSIENT (fallback). The wishlist backend forwards the
 *      caller's { deviceId, entityId, botSecret } and EClaw verifies it in one
 *      shot via `verifyAgentBotSecret(...)`. The secret is verify-then-DISCARD:
 *      it is never persisted or logged by either side. Used only when a token
 *      round-trip isn't available.
 *
 * DESIGN NOTES
 *   - The token is an opaque, URL-safe string `v1.<b64u(payloadJson)>.<b64u(hmac)>`.
 *     HMAC-SHA256 over the payload with a server secret. This is deliberately NOT
 *     a JWT: it is single-audience, single-claim, and must never be mistaken for
 *     an EClaw session token. Verification is constant-time and rejects any token
 *     whose version/format/signature/expiry is off.
 *   - `authEntityAccess` (the existing entity/botSecret gate) is INJECTED so this
 *     module has no hard dependency on index.js internals and is unit-testable
 *     with no network and no DB (mirrors wishlist-route.js / petdx-route.js).
 *   - Default TTL is short (5 min) so a leaked token has a tiny blast radius.
 *   - The verify response is intentionally minimal: { valid, publicCode } (+ a
 *     machine reason on failure). It never echoes botSecret, deviceId, name, PII,
 *     or the token itself.
 */

const express = require('express');
const crypto = require('crypto');

// Short-lived by design: a minted token is only meant to survive one write
// round-trip. 5 minutes covers clock skew + a slow upstream without lingering.
const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000;

// The token wire prefix. Bumping this invalidates every previously-issued token
// (e.g. after a secret rotation or a format change) — verification pins it.
const TOKEN_VERSION = 'v1';

// Dedicated secret only. Do not silently reuse JWT_SECRET: these tokens are a
// separate cross-service trust plane and should fail loud when not configured.
const SIGNING_SECRET_ENV = 'AGENT_IDENTITY_SECRET';

const DEFAULT_BOT_SECRET_RATE_LIMIT = {
    max: 10,
    windowMs: 60 * 1000,
};

// Public codes are 6 lowercase-alnum chars (channel-api generatePublicCode).
const PUBLIC_CODE_PATTERN = /^[a-z0-9]{6}$/;

function b64uEncode(buf) {
    return Buffer.from(buf)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function b64uDecodeToBuf(str) {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/**
 * Mint a short-lived identity token binding a publicCode. Pure/crypto only —
 * the CALLER is responsible for having authenticated the entity first (so the
 * publicCode passed in is the caller's OWN, resolved via authEntityAccess).
 *
 * @param {object}  opts
 * @param {string}  opts.publicCode   the caller's own verified 6-char code
 * @param {string}  opts.secret       HMAC signing secret (server-side)
 * @param {number} [opts.ttlMs]       token lifetime (default 5 min)
 * @param {number} [opts.now]         current epoch ms (injectable for tests)
 * @returns {{ token:string, publicCode:string, expiresAt:number }}
 */
function signAgentToken({ publicCode, secret, ttlMs = DEFAULT_TOKEN_TTL_MS, now = Date.now() }) {
    if (!PUBLIC_CODE_PATTERN.test(String(publicCode || ''))) {
        throw new Error('signAgentToken: invalid publicCode');
    }
    if (typeof secret !== 'string' || secret.trim().length === 0) {
        throw new Error('signAgentToken: signing secret required');
    }
    const exp = now + ttlMs;
    // Only the two claims we need. No PII, no device/entity ids, no secret.
    const payload = { pc: String(publicCode), exp, v: TOKEN_VERSION };
    const payloadJson = JSON.stringify(payload);
    const payloadB64 = b64uEncode(payloadJson);
    const sig = crypto.createHmac('sha256', secret).update(`${TOKEN_VERSION}.${payloadB64}`).digest();
    const token = `${TOKEN_VERSION}.${payloadB64}.${b64uEncode(sig)}`;
    return { token, publicCode: String(publicCode), expiresAt: exp };
}

/**
 * Verify a short-lived identity token. Constant-time signature check; rejects a
 * bad version, malformed shape, tampered signature, or expired token.
 *
 * @returns {{ ok:boolean, publicCode?:string, reason?:string }}
 *   reason ∈ 'bad_format' | 'bad_version' | 'bad_signature' | 'expired' | 'bad_claim'
 */
function verifyAgentTokenSig({ token, secret, now = Date.now() }) {
    if (typeof token !== 'string' || typeof secret !== 'string' || secret.trim().length === 0) {
        return { ok: false, reason: 'bad_format' };
    }
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'bad_format' };
    const [ver, payloadB64, sigB64] = parts;
    if (ver !== TOKEN_VERSION) return { ok: false, reason: 'bad_version' };

    // Recompute the signature and compare in constant time.
    const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(`${TOKEN_VERSION}.${payloadB64}`)
        .digest();
    let givenSig;
    try {
        givenSig = b64uDecodeToBuf(sigB64);
    } catch {
        return { ok: false, reason: 'bad_format' };
    }
    if (givenSig.length !== expectedSig.length || !crypto.timingSafeEqual(givenSig, expectedSig)) {
        return { ok: false, reason: 'bad_signature' };
    }

    let payload;
    try {
        payload = JSON.parse(b64uDecodeToBuf(payloadB64).toString('utf8'));
    } catch {
        return { ok: false, reason: 'bad_format' };
    }
    if (!payload || payload.v !== TOKEN_VERSION || !PUBLIC_CODE_PATTERN.test(String(payload.pc || ''))) {
        return { ok: false, reason: 'bad_claim' };
    }
    if (typeof payload.exp !== 'number' || now >= payload.exp) {
        return { ok: false, reason: 'expired' };
    }
    return { ok: true, publicCode: String(payload.pc) };
}

function readSigningSecretFromEnv(env = process.env) {
    const secret = env && env[SIGNING_SECRET_ENV];
    const trimmedSecret = typeof secret === 'string' ? secret.trim() : '';
    if (!trimmedSecret) return null;
    // Fail loud if an operator wires this trust plane to the general session JWT
    // secret. agent-identity tokens must have their own HMAC key.
    if (typeof env.JWT_SECRET === 'string' && trimmedSecret === env.JWT_SECRET.trim()) return null;
    return secret;
}

function normalizeRateLimitConfig(config) {
    if (config === false) return { disabled: true };
    const source = config || {};
    const max = Number.isFinite(Number(source.max))
        ? Math.max(1, Number(source.max))
        : DEFAULT_BOT_SECRET_RATE_LIMIT.max;
    const windowMs = Number.isFinite(Number(source.windowMs))
        ? Math.max(1000, Number(source.windowMs))
        : DEFAULT_BOT_SECRET_RATE_LIMIT.windowMs;
    return { disabled: false, max, windowMs };
}

function clientIp(req) {
    return req.ip
        || (req.socket && req.socket.remoteAddress)
        || (req.connection && req.connection.remoteAddress)
        || 'unknown';
}

function createBotSecretLimiter({ config, now }) {
    const settings = normalizeRateLimitConfig(config);
    const hits = new Map();
    const clock = typeof now === 'function' ? now : () => Date.now();

    function prune(key) {
        const t = clock();
        const windowStart = t - settings.windowMs;
        const arr = (hits.get(key) || []).filter((ts) => ts > windowStart);
        hits.set(key, arr);
        return arr;
    }

    function keysFor(req, body) {
        const keys = [`ip:${clientIp(req)}`];
        if (body && body.deviceId && body.entityId !== undefined && body.entityId !== null) {
            keys.push(`entity:${String(body.deviceId)}:${String(body.entityId)}`);
        }
        return keys;
    }

    function overKey(key) {
        const arr = prune(key);
        return arr.length >= settings.max;
    }

    function recordKey(key) {
        const arr = prune(key);
        if (arr.length >= settings.max) {
            return true;
        }
        arr.push(clock());
        hits.set(key, arr);
        return false;
    }

    return {
        isLimited(req, body) {
            if (settings.disabled) return false;
            return keysFor(req, body).some(overKey);
        },
        recordFailure(req, body) {
            if (settings.disabled) return false;
            const keys = keysFor(req, body);
            return keys.some(recordKey);
        },
        settings,
    };
}

/**
 * Build the agent-identity router.
 *
 * Injectables:
 *   - authenticateCaller({ deviceId, entityId, botSecret }) → { ok, publicCode } |
 *       { ok:false, reason }.  Wired in index.js to authEntityAccess + the live
 *       devices map. This is the ONLY place a long-lived botSecret is checked;
 *       it is never stored or logged here.
 *   - getSecret() → dedicated HMAC signing secret (defaults to
 *       AGENT_IDENTITY_SECRET; never falls back to JWT_SECRET).
 *   - ttlMs / now — token lifetime + clock (injectable for tests).
 *   - log — serverLog-style (level, tag, msg). Never receives a secret/token.
 *
 * Routes:
 *   POST /token   body { deviceId, entityId, botSecret }
 *                 → 200 { valid:true, token, publicCode, expiresAt }  (mint)
 *                 The agent (or the wishlist-bridge on its behalf) exchanges its
 *                 long-lived botSecret for a short-lived token, ONCE, inside EClaw.
 *
 *   POST /verify  body { token }  OR  { deviceId, entityId, botSecret }
 *                 → 200 { valid:true, publicCode }  (token or transient botSecret)
 *                 → 200 { valid:false, reason }      (never a real entity)
 *                 The wishlist backend calls BACK here to check an agent identity
 *                 before a write. Response carries { valid, publicCode } only.
 */
function createRouter({ authenticateCaller, getSecret, ttlMs, now, log, botSecretRateLimit } = {}) {
    const router = express.Router();
    const logger = typeof log === 'function' ? log : () => {};
    const clock = typeof now === 'function' ? now : () => Date.now();
    const botSecretLimiter = createBotSecretLimiter({ config: botSecretRateLimit, now: clock });
    const tokenTtl = Number.isFinite(ttlMs) ? ttlMs : DEFAULT_TOKEN_TTL_MS;
    const authCaller =
        typeof authenticateCaller === 'function'
            ? authenticateCaller
            // Fail CLOSED if not wired: no auth ⇒ nobody can mint/verify a secret.
            : async () => ({ ok: false, reason: 'no_auth_configured' });
    const readSecret =
        typeof getSecret === 'function'
            ? getSecret
            : () => readSigningSecretFromEnv();

    function rateLimited(res) {
        res.set('Retry-After', String(Math.ceil(botSecretLimiter.settings.windowMs / 1000)));
        return res.status(429).json({ valid: false, reason: 'rate_limited' });
    }

    // Mint a short-lived token for an already-authenticated caller.
    router.post('/token', async (req, res) => {
        const { deviceId, entityId, botSecret } = req.body || {};
        if (!deviceId || entityId === undefined || entityId === null || !botSecret) {
            return res.status(400).json({ valid: false, reason: 'missing_credentials' });
        }
        const secret = readSecret();
        if (!secret) {
            logger('error', 'agent-identity', '[agent-identity] no signing secret configured');
            return res.status(500).json({ valid: false, reason: 'server_misconfigured' });
        }
        if (botSecretLimiter.isLimited(req, req.body || {})) {
            return rateLimited(res);
        }
        let caller;
        try {
            caller = await authCaller({ deviceId, entityId, botSecret });
        } catch (err) {
            logger('warn', 'agent-identity', `[agent-identity] token auth error: ${err.message}`);
            return res.status(502).json({ valid: false, reason: 'auth_unavailable' });
        }
        if (!caller || !caller.ok || !caller.publicCode) {
            botSecretLimiter.recordFailure(req, req.body || {});
            return res.status(403).json({ valid: false, reason: 'not_verified' });
        }
        let minted;
        try {
            minted = signAgentToken({
                publicCode: String(caller.publicCode),
                secret,
                ttlMs: tokenTtl,
                now: clock(),
            });
        } catch (err) {
            logger('error', 'agent-identity', `[agent-identity] mint failed: ${err.message}`);
            return res.status(500).json({ valid: false, reason: 'mint_failed' });
        }
        // The botSecret is verify-then-DISCARD: never persisted, never logged.
        return res.status(200).json({
            valid: true,
            token: minted.token,
            publicCode: minted.publicCode,
            expiresAt: minted.expiresAt,
        });
    });

    // Verify an agent identity — token (preferred) or a transient botSecret triple.
    router.post('/verify', async (req, res) => {
        const body = req.body || {};

        // --- Token path (preferred) ---
        if (typeof body.token === 'string' && body.token.length > 0) {
            const secret = readSecret();
            if (!secret) {
                logger('error', 'agent-identity', '[agent-identity] no verify secret configured');
                return res.status(500).json({ valid: false, reason: 'server_misconfigured' });
            }
            const result = verifyAgentTokenSig({ token: body.token, secret, now: clock() });
            if (!result.ok) {
                return res.status(200).json({ valid: false, reason: result.reason });
            }
            return res.status(200).json({ valid: true, publicCode: result.publicCode });
        }

        // --- Transient botSecret path (fallback) ---
        const { deviceId, entityId, botSecret } = body;
        if (!deviceId || entityId === undefined || entityId === null || !botSecret) {
            return res.status(400).json({ valid: false, reason: 'missing_credentials' });
        }
        if (botSecretLimiter.isLimited(req, body)) {
            return rateLimited(res);
        }
        let caller;
        try {
            caller = await authCaller({ deviceId, entityId, botSecret });
        } catch (err) {
            logger('warn', 'agent-identity', `[agent-identity] verify auth error: ${err.message}`);
            return res.status(502).json({ valid: false, reason: 'auth_unavailable' });
        }
        if (!caller || !caller.ok || !caller.publicCode) {
            botSecretLimiter.recordFailure(req, body);
            return res.status(200).json({ valid: false, reason: 'not_verified' });
        }
        // Secret verified → discarded. Only the resolved public code is returned.
        return res.status(200).json({ valid: true, publicCode: String(caller.publicCode) });
    });

    return router;
}

module.exports = {
    createRouter,
    signAgentToken,
    verifyAgentTokenSig,
    readSigningSecretFromEnv,
    DEFAULT_TOKEN_TTL_MS,
    TOKEN_VERSION,
    SIGNING_SECRET_ENV,
    PUBLIC_CODE_PATTERN,
};
