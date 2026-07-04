/**
 * wishlist-route — thin, SSRF-safe proxy to the external Wishlist app
 * (wishlist-app-production.up.railway.app). Mirrors petdex-route.js:
 *   - createRouter({ ...injectables }) → express.Router()
 *   - upstream host is a HARD-CODED literal; no host/scheme/path is ever taken
 *     from the request, so it cannot be coerced into SSRF.
 *   - every outbound fetch sets a named User-Agent `curl/8.4.0` (an empty/default
 *     UA trips the Cloudflare edge UA filter — CF error 1010).
 *
 * The merchant API key required by write calls is read from the EClaw vault BY
 * NAME (`WISHLIST_MERCHANT_KEY`) at request time via an injectable
 * getVaultValue(name). That key is currently ABSENT from the vault, so the proxy
 * degrades gracefully: a missing key surfaces as 502 {error, reason:'missing
 * key'}, and a locked vault (HTTP 403) surfaces as reason:'locked' — never a
 * crash, and the secret is never logged or echoed.
 *
 * CONFUSED-DEPUTY GUARD (security-review HIGH #2): the proxy holds the merchant
 * key, so an UNAUTHENTICATED write endpoint would let any anonymous caller
 * borrow merchant authority. Therefore the write path REQUIRES the caller to
 * prove they are a real EClaw entity (deviceId + entityId + botSecret) via the
 * injected `authenticateCaller`, and the listing is ALWAYS written under the
 * caller's OWN resolved publicCode — a caller can never write under a code they
 * do not control. The write is routed to the wishlist `/api/items/upsert-listing`
 * endpoint (which independently re-verifies the code), NOT the blind createItem
 * path (security-review HIGH #1). Read endpoints (search/items/public) stay open.
 */

const express = require('express');

// SSRF guard: the upstream host/base are fixed literals. Only fixed path shapes
// are built server-side; nothing from the request selects a host/scheme/path.
const WISHLIST_HOST = 'wishlist-app-production.up.railway.app';
const WISHLIST_BASE = 'https://' + WISHLIST_HOST;

// Named UA — a default/empty UA can trip the CDN edge UA filter (CF 1010).
const OUTBOUND_UA = 'curl/8.4.0';

// The vault key NAME the proxy reads at request time (never its value here).
const MERCHANT_KEY_NAME = 'WISHLIST_MERCHANT_KEY';

// Default vault reader: GET https://eclawbot.com/api/device-vars with the
// mission bot creds from process.env (read at call time; NEVER hardcoded).
// Returns the string value for `name`, or throws a distinct error:
//   - message contains 'locked'      when the HTTP status was 403
//   - message contains 'missing key' when success:false or the key is absent
function defaultGetVaultValue(doFetch) {
    return async function getVaultValue(name) {
        const deviceId = process.env.ECLAW_WISHLIST_DEVICE_ID;
        const botSecret = process.env.ECLAW_WISHLIST_BOT_SECRET;
        const entityId = process.env.ECLAW_WISHLIST_ENTITY_ID;
        if (!deviceId || !botSecret || !entityId) {
            throw new Error('vault creds not configured');
        }
        const params = new URLSearchParams({
            deviceId,
            botSecret,
            entityId: String(entityId),
        });
        const resp = await doFetch(`https://eclawbot.com/api/device-vars?${params.toString()}`, {
            method: 'GET',
            headers: {
                'User-Agent': OUTBOUND_UA,
                'Accept': 'application/json',
            },
        });
        let body = null;
        try {
            body = await resp.json();
        } catch (_e) {
            body = null;
        }
        if (resp.status === 403) {
            throw new Error(`vault locked: cannot read ${name} (locked)`);
        }
        if (!resp.ok || !body || body.success === false) {
            throw new Error(`vault read failed for ${name}: missing key`);
        }
        const vars = body.vars || {};
        if (vars[name] == null || vars[name] === '') {
            throw new Error(`vault has no value for ${name}: missing key`);
        }
        return vars[name];
    };
}

function createRouter({ log, fetchImpl, getVaultValue, authenticateCaller, rateLimit, now } = {}) {
    const router = express.Router();
    const logger = typeof log === 'function' ? log : () => {};
    const doFetch = fetchImpl || globalThis.fetch;
    const readVaultValue =
        typeof getVaultValue === 'function' ? getVaultValue : defaultGetVaultValue(doFetch);
    const clock = typeof now === 'function' ? now : () => Date.now();

    // Caller authentication for the write path. Must resolve { ok, publicCode }
    // ONLY when the (deviceId, entityId, botSecret) triple proves a real, bound
    // EClaw entity; otherwise { ok:false }. Injected at mount (wired to the live
    // devices map + authEntityAccess) and faked in tests. If not provided, the
    // write path fails CLOSED (no auth = no merchant-key borrow).
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

        // (1) Authenticate the caller as a real EClaw entity BEFORE any vault
        // read or upstream call. No creds ⇒ 401; bad creds ⇒ 403; fail closed.
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

        // (3) Read the merchant key from the vault by NAME. Degrade gracefully:
        // missing key / locked vault → 502 with a distinct reason (never crash).
        let merchantKey;
        try {
            merchantKey = await readVaultValue(MERCHANT_KEY_NAME);
        } catch (err) {
            const msg = (err && err.message) || '';
            const reason = /locked/i.test(msg) ? 'locked' : 'missing key';
            logger('warn', 'wishlist-route', `[wishlist] merchant key unavailable (${reason})`);
            return res.status(502).json({ error: 'wishlist merchant key unavailable', reason });
        }

        // Forward ONLY the safe listing fields; force publicCode to callerCode so
        // the upstream verifier binds the write to the authenticated identity.
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
                    'x-merchant-api-key': merchantKey,
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

module.exports = { createRouter, WISHLIST_HOST, MERCHANT_KEY_NAME, extractClaimedCode };
