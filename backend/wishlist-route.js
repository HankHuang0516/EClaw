/**
 * wishlist-route — thin, SSRF-safe proxy to the external Wishlist app
 * (wishlist-app-production.up.railway.app). Mirrors petdex-route.js:
 *   - createRouter({ ...injectables }) → express.Router()
 *   - upstream host is a HARD-CODED literal; no host/scheme/path is ever taken
 *     from the request, so it cannot be coerced into SSRF.
 *   - every outbound fetch sets a named User-Agent `curl/8.4.0` (an empty/default
 *     UA trips the Cloudflare edge UA filter — CF error 1010).
 *
 * NO MERCHANT KEY (owner directive, card_e30cf03d). The write path no longer
 * reads a shared `WISHLIST_MERCHANT_KEY` from the vault. Instead the proxy proves
 * the caller's EClaw identity and forwards a SHORT-LIVED, single-purpose EClaw
 * identity token; the wishlist backend calls BACK to EClaw to verify that token
 * before it writes. Nothing shared and nothing long-lived crosses to the wishlist
 * service — the caller's long-lived botSecret is swapped for the token INSIDE
 * EClaw (via the injected `mintAgentToken`) and only the token is forwarded.
 *
 * CONFUSED-DEPUTY GUARD (security-review HIGH #2): an UNAUTHENTICATED write
 * endpoint would let any anonymous caller borrow EClaw's authority. Therefore the
 * write path REQUIRES the caller to prove they are a real EClaw entity
 * (deviceId + entityId + botSecret) via the injected `authenticateCaller`, and
 * the listing is ALWAYS written under the caller's OWN resolved publicCode — a
 * caller can never write under a code they do not control. The write is routed to
 * the wishlist `/api/items/upsert-listing` endpoint (which independently
 * verifies the identity token AND re-verifies the code), NOT the blind createItem
 * path (security-review HIGH #1). Read endpoints (search/items/public) stay open.
 */

const express = require('express');

// SSRF guard: the upstream host/base are fixed literals. Only fixed path shapes
// are built server-side; nothing from the request selects a host/scheme/path.
const WISHLIST_HOST = 'wishlist-app-production.up.railway.app';
const WISHLIST_BASE = 'https://' + WISHLIST_HOST;

// Named UA — a default/empty UA can trip the CDN edge UA filter (CF 1010).
const OUTBOUND_UA = 'curl/8.4.0';

// Header the wishlist backend reads to verify the forwarded EClaw identity token.
const AGENT_TOKEN_HEADER = 'x-eclaw-agent-token';

function createRouter({ log, fetchImpl, mintAgentToken, authenticateCaller, rateLimit, now } = {}) {
    const router = express.Router();
    const logger = typeof log === 'function' ? log : () => {};
    const doFetch = fetchImpl || globalThis.fetch;
    // Mint a short-lived EClaw identity token for an ALREADY-authenticated caller
    // (publicCode → token). Injected at mount (wired to agent-identity.signAgentToken
    // + the process signing secret) and faked in tests. If not provided the write
    // path fails CLOSED (no token = no cross-service write). The token is what the
    // wishlist backend calls back to EClaw to verify — the long-lived botSecret is
    // NEVER forwarded off-box.
    const mintToken =
        typeof mintAgentToken === 'function'
            ? mintAgentToken
            : async () => { throw new Error('token minting not configured'); };
    const clock = typeof now === 'function' ? now : () => Date.now();

    // Caller authentication for the write path. Must resolve { ok, publicCode }
    // ONLY when the (deviceId, entityId, botSecret) triple proves a real, bound
    // EClaw entity; otherwise { ok:false }. Injected at mount (wired to the live
    // devices map + authEntityAccess) and faked in tests. If not provided, the
    // write path fails CLOSED (no auth = no authority borrow).
    const authCaller =
        typeof authenticateCaller === 'function'
            ? authenticateCaller
            : async () => ({ ok: false, reason: 'no_auth_configured' });

    // Minimal but real fixed-window throttle keyed by caller id (req.ip). A Map
    // of id -> array of request timestamps within the current window. Defaults
    // to 60/min; tests inject a low cap + a clock.
    const rl = {
        max: (rateLimit && Number(rateLimit.max)) || 60,
        windowMs: (rateLimit && Number(rateLimit.windowMs)) || 60000,
    };
    const hits = new Map();

    function overRateLimit(id) {
        const t = clock();
        const windowStart = t - rl.windowMs;
        const arr = (hits.get(id) || []).filter((ts) => ts > windowStart);
        if (arr.length >= rl.max) {
            hits.set(id, arr); // persist the pruned list; do not add this hit
            return true;
        }
        arr.push(t);
        hits.set(id, arr);
        return false;
    }

    function callerId(req) {
        return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
    }

    // GET /search?q=&limit=&offset= — public item search, no merchant key.
    router.get('/search', async (req, res) => {
        if (overRateLimit(callerId(req))) {
            return res.status(429).json({ error: 'rate limited' });
        }
        const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
        if (!q) {
            return res.status(400).json({ error: 'q (search query) is required' });
        }
        const params = new URLSearchParams({ q });
        if (req.query.limit != null && req.query.limit !== '') params.set('limit', String(req.query.limit));
        if (req.query.offset != null && req.query.offset !== '') params.set('offset', String(req.query.offset));
        const upstreamUrl = `${WISHLIST_BASE}/api/items/search?${params.toString()}`;
        try {
            const resp = await doFetch(upstreamUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': OUTBOUND_UA,
                    'Accept': 'application/json',
                },
                // Never follow a redirect off the pinned host (defense in depth).
                redirect: 'manual',
            });
            if (!resp.ok) {
                logger('warn', 'wishlist-route', `[wishlist] search upstream HTTP ${resp.status}`);
                return res.status(502).json({ error: 'upstream error' });
            }
            const data = await resp.json();
            return res.status(200).json(data);
        } catch (err) {
            logger('warn', 'wishlist-route', `[wishlist] search fetch failed: ${err.message}`);
            return res.status(502).json({ error: 'upstream error' });
        }
    });

    // GET /items/public — public item list, no merchant key.
    router.get('/items/public', async (req, res) => {
        if (overRateLimit(callerId(req))) {
            return res.status(429).json({ error: 'rate limited' });
        }
        const upstreamUrl = `${WISHLIST_BASE}/api/items/public`;
        try {
            const resp = await doFetch(upstreamUrl, {
                method: 'GET',
                headers: {
                    'User-Agent': OUTBOUND_UA,
                    'Accept': 'application/json',
                },
                redirect: 'manual',
            });
            if (!resp.ok) {
                logger('warn', 'wishlist-route', `[wishlist] items/public upstream HTTP ${resp.status}`);
                return res.status(502).json({ error: 'upstream error' });
            }
            const data = await resp.json();
            return res.status(200).json(data);
        } catch (err) {
            logger('warn', 'wishlist-route', `[wishlist] items/public fetch failed: ${err.message}`);
            return res.status(502).json({ error: 'upstream error' });
        }
    });

    // POST /listings — create/update a wishlist listing under the CALLER'S OWN
    // verified EClaw public code. This is the ONLY write path.
    //
    // Security (review HIGH #1 + #2):
    //   1. The caller MUST prove they are a real EClaw entity by supplying their
    //      own { deviceId, entityId, botSecret }. authCaller resolves this to the
    //      caller's own publicCode, or fails closed. No auth ⇒ no merchant-key
    //      borrow (fixes the confused-deputy).
    //   2. The listing is ALWAYS written under the caller's OWN publicCode. Any
    //      publicCode / proxy_end_user_id in the body that names a DIFFERENT code
    //      is rejected (403) — a caller can never write under a code they do not
    //      control (fixes the spoof/ownership gap).
    //   3. The write is routed to the wishlist `/api/items/upsert-listing`
    //      endpoint, which independently re-verifies the code — NOT the blind
    //      createItem path that trusts proxy_end_user_id.
    router.post('/listings', async (req, res) => {
        if (overRateLimit(callerId(req))) {
            return res.status(429).json({ error: 'rate limited' });
        }

        const body = req.body || {};
        const { deviceId, entityId, botSecret } = body;

        // (1) Authenticate the caller as a real EClaw entity BEFORE minting a
        // token or making an upstream call. No creds ⇒ 401; bad creds ⇒ 403;
        // fail closed.
        if (!deviceId || entityId === undefined || entityId === null || !botSecret) {
            return res.status(401).json({
                error: 'caller authentication required (deviceId, entityId, botSecret)',
            });
        }
        let caller;
        try {
            caller = await authCaller({ deviceId, entityId, botSecret });
        } catch (err) {
            logger('warn', 'wishlist-route', `[wishlist] caller auth error: ${err.message}`);
            return res.status(502).json({ error: 'caller auth unavailable' });
        }
        if (!caller || !caller.ok || !caller.publicCode) {
            return res.status(403).json({ error: 'caller is not a verified EClaw entity' });
        }
        const callerCode = String(caller.publicCode).toLowerCase();

        // (2) Ownership binding: if the body names a public code (bare or as an
        // eclaw:<code> proxy id), it MUST equal the caller's own code. We ignore
        // whatever else and always write under callerCode.
        const claimed = extractClaimedCode(body.publicCode) || extractClaimedCode(body.proxy_end_user_id);
        if (claimed && claimed !== callerCode) {
            return res.status(403).json({
                error: 'cannot write a listing under a public code you do not control',
            });
        }

        // (3) Swap the (already-verified) caller identity for a SHORT-LIVED EClaw
        // identity token, INSIDE EClaw. This is what gets forwarded — the caller's
        // long-lived botSecret never leaves the box. The wishlist backend calls
        // BACK to EClaw to verify this token before it writes. NO merchant key.
        let agentToken;
        try {
            const minted = await mintToken({ publicCode: callerCode });
            agentToken = minted && minted.token;
            if (!agentToken) throw new Error('empty token');
        } catch (err) {
            logger('warn', 'wishlist-route', `[wishlist] identity token mint failed: ${err.message}`);
            return res.status(502).json({ error: 'identity token unavailable' });
        }

        // Forward ONLY the safe listing fields; force publicCode to callerCode so
        // the upstream verifier binds the write to the authenticated identity. The
        // token is sent in a header (verify-then-discard on the wishlist side).
        const payload = {
            publicCode: callerCode,
            wishlistId: body.wishlistId,
            itemId: body.itemId,
            name: body.name,
            notes: body.notes,
            price: body.price,
        };
        const upstreamUrl = `${WISHLIST_BASE}/api/items/upsert-listing`;
        try {
            const resp = await doFetch(upstreamUrl, {
                method: 'POST',
                headers: {
                    'User-Agent': OUTBOUND_UA,
                    'Content-Type': 'application/json',
                    [AGENT_TOKEN_HEADER]: agentToken,
                    'Accept': 'application/json',
                },
                body: JSON.stringify(payload),
                redirect: 'manual',
            });
            if (resp.status === 401) {
                return res.status(401).json({ error: 'unauthorized' });
            }
            if (resp.status === 403) {
                // Upstream re-verification rejected the code (defense in depth).
                return res.status(403).json({ error: 'listing rejected by upstream verifier' });
            }
            if (!resp.ok) {
                logger('warn', 'wishlist-route', `[wishlist] upsert upstream HTTP ${resp.status}`);
                return res.status(502).json({ error: 'upstream error' });
            }
            let data = null;
            try {
                data = await resp.json();
            } catch (_e) {
                data = null;
            }
            return res.status(resp.status === 201 ? 201 : 200).json(data == null ? {} : data);
        } catch (err) {
            logger('warn', 'wishlist-route', `[wishlist] upsert fetch failed: ${err.message}`);
            return res.status(502).json({ error: 'upstream error' });
        }
    });

    return router;
}

// Extract a bare 6-char public code from either a raw code or an `eclaw:<code>`
// envelope. Returns null if the shape is not a valid code. Used for the
// ownership-binding check on the write path.
function extractClaimedCode(raw) {
    if (typeof raw !== 'string') return null;
    let v = raw.trim().toLowerCase();
    if (v.startsWith('eclaw:')) v = v.slice('eclaw:'.length).trim();
    return /^[a-z0-9]{6}$/.test(v) ? v : null;
}

module.exports = { createRouter, WISHLIST_HOST, AGENT_TOKEN_HEADER, extractClaimedCode };
