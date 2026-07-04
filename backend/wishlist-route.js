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

function createRouter({ log, fetchImpl, getVaultValue, rateLimit, now } = {}) {
    const router = express.Router();
    const logger = typeof log === 'function' ? log : () => {};
    const doFetch = fetchImpl || globalThis.fetch;
    const readVaultValue =
        typeof getVaultValue === 'function' ? getVaultValue : defaultGetVaultValue(doFetch);
    const clock = typeof now === 'function' ? now : () => Date.now();

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

    // POST /wishlists/:wishlistId/items — add an item; needs the merchant key.
    router.post('/wishlists/:wishlistId/items', async (req, res) => {
        if (overRateLimit(callerId(req))) {
            return res.status(429).json({ error: 'rate limited' });
        }
        const { wishlistId } = req.params;
        // Validate BEFORE any vault read or upstream call (no SSRF, no wasted key read).
        if (!/^\d+$/.test(wishlistId)) {
            return res.status(400).json({ error: 'wishlistId must be numeric' });
        }

        // Read the merchant key from the vault by NAME. Degrade gracefully:
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

        const body = req.body || {};
        const payload = {
            proxy_end_user_id: body.proxy_end_user_id,
            name: body.name,
            notes: body.notes,
            price: body.price,
        };
        const upstreamUrl = `${WISHLIST_BASE}/api/wishlists/${wishlistId}/items`;
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
            });
            if (resp.status === 401) {
                // Bad/expired merchant key at upstream — surface as 401.
                return res.status(401).json({ error: 'unauthorized' });
            }
            if (!resp.ok) {
                logger('warn', 'wishlist-route', `[wishlist] add-item upstream HTTP ${resp.status}`);
                return res.status(502).json({ error: 'upstream error' });
            }
            let data = null;
            try {
                data = await resp.json();
            } catch (_e) {
                data = null;
            }
            // Pass through the upstream success status (201 created / 200).
            return res.status(resp.status === 201 ? 201 : 200).json(data == null ? {} : data);
        } catch (err) {
            logger('warn', 'wishlist-route', `[wishlist] add-item fetch failed: ${err.message}`);
            return res.status(502).json({ error: 'upstream error' });
        }
    });

    return router;
}

module.exports = { createRouter, WISHLIST_HOST, MERCHANT_KEY_NAME };
