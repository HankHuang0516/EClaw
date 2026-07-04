/**
 * wishlist-route — thin proxy to the external Wishlist app.
 *
 * Pure route tests: inject a fake fetchImpl + fake getVaultValue via
 * createRouter({...}), so there is NO real network and NO real vault. Asserts:
 *   - the outbound URL is hard-pinned to the wishlist host (SSRF-safe) and
 *     carries the named UA `curl/8.4.0`;
 *   - empty query / non-numeric wishlistId are rejected BEFORE any upstream call;
 *   - upstream 401 / network failure / vault-missing / vault-locked all degrade
 *     gracefully (401 / 502 / 502+reason), never a crash;
 *   - a tiny rate cap returns 429 on the 3rd rapid call.
 *
 * Dummy secrets only (never a real key).
 */

const express = require('express');
const request = require('supertest');
const { createRouter } = require('../../wishlist-route');

// Minimal fetch-Response stand-in. `.ok` is computed from status like WHATWG.
function fakeResponse(status, jsonBody) {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => jsonBody,
    };
}

// Build an app mounting the router with the given injectables.
function appWith(opts = {}) {
    const app = express();
    app.use(express.json());
    app.use('/api/wishlist-bridge', createRouter(opts));
    return app;
}

const DUMMY_KEY = 'DUMMY_KEY';

describe('wishlist-route proxy', () => {
    // 1) 200 search — passes body through, pins the URL + named UA.
    it('200: GET /search proxies to the wishlist host with UA curl/8.4.0', async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, init });
            return fakeResponse(200, [{ id: 1, name: 'Sony WH-1000XM5' }]);
        };
        const app = appWith({ fetchImpl });
        const res = await request(app).get('/api/wishlist-bridge/search?q=sony');

        expect(res.status).toBe(200);
        expect(res.body).toEqual([{ id: 1, name: 'Sony WH-1000XM5' }]);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toMatch(
            /^https:\/\/wishlist-app-production\.up\.railway\.app\/api\/items\/search/
        );
        expect(calls[0].init.headers['User-Agent']).toBe('curl/8.4.0');
    });

    // 2) 400 empty q — no upstream call.
    it('400: GET /search with no q returns 400 and never calls upstream', async () => {
        let called = false;
        const fetchImpl = async () => {
            called = true;
            return fakeResponse(200, []);
        };
        const app = appWith({ fetchImpl });
        const res = await request(app).get('/api/wishlist-bridge/search');

        expect(res.status).toBe(400);
        expect(called).toBe(false);
    });

    // 3) 401 add-item — upstream rejects a bad merchant key.
    it('401: POST add-item returns 401 when upstream returns 401', async () => {
        const fetchImpl = async () => fakeResponse(401, { error: 'bad key' });
        const getVaultValue = async () => DUMMY_KEY;
        const app = appWith({ fetchImpl, getVaultValue });
        const res = await request(app)
            .post('/api/wishlist-bridge/wishlists/1/items')
            .send({ proxy_end_user_id: 'u1', name: 'thing', notes: '', price: 10 });

        expect(res.status).toBe(401);
    });

    // 4) 502 upstream network failure.
    it('502: GET /search returns 502 when upstream fetch throws', async () => {
        const fetchImpl = async () => {
            throw new Error('ECONNRESET');
        };
        const app = appWith({ fetchImpl });
        const res = await request(app).get('/api/wishlist-bridge/search?q=x');

        expect(res.status).toBe(502);
        expect(res.body).toEqual({ error: 'upstream error' });
    });

    // 5) empty result passes through untouched.
    it('200: GET /search with no matches returns []', async () => {
        const fetchImpl = async () => fakeResponse(200, []);
        const app = appWith({ fetchImpl });
        const res = await request(app).get('/api/wishlist-bridge/search?q=nomatch');

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    // 6) locked-vault (403) and missing-key both degrade to 502 + distinct reason.
    it('502 reason:locked when the vault read throws a "locked" error (403)', async () => {
        const getVaultValue = async () => {
            throw new Error('vault locked: cannot read WISHLIST_MERCHANT_KEY (locked)');
        };
        let called = false;
        const fetchImpl = async () => {
            called = true;
            return fakeResponse(200, {});
        };
        const app = appWith({ fetchImpl, getVaultValue });
        const res = await request(app)
            .post('/api/wishlist-bridge/wishlists/1/items')
            .send({ proxy_end_user_id: 'u1', name: 'thing', price: 5 });

        expect(res.status).toBe(502);
        expect(res.body).toEqual({ error: 'wishlist merchant key unavailable', reason: 'locked' });
        expect(called).toBe(false); // never reached upstream without a key
    });

    it('502 reason:"missing key" when the vault has no such key', async () => {
        const getVaultValue = async () => {
            throw new Error('vault has no value for WISHLIST_MERCHANT_KEY: missing key');
        };
        const app = appWith({ getVaultValue });
        const res = await request(app)
            .post('/api/wishlist-bridge/wishlists/1/items')
            .send({ proxy_end_user_id: 'u1', name: 'thing', price: 5 });

        expect(res.status).toBe(502);
        expect(res.body).toEqual({
            error: 'wishlist merchant key unavailable',
            reason: 'missing key',
        });
    });

    // 7) SSRF/validation — non-numeric wishlistId rejected, no upstream, no vault read.
    it('400: POST /wishlists/abc/items (non-numeric) rejected before any upstream/vault call', async () => {
        let fetched = false;
        let vaultRead = false;
        const fetchImpl = async () => {
            fetched = true;
            return fakeResponse(200, {});
        };
        const getVaultValue = async () => {
            vaultRead = true;
            return DUMMY_KEY;
        };
        const app = appWith({ fetchImpl, getVaultValue });
        const res = await request(app)
            .post('/api/wishlist-bridge/wishlists/abc/items')
            .send({ proxy_end_user_id: 'u1', name: 'thing', price: 5 });

        expect(res.status).toBe(400);
        expect(fetched).toBe(false);
        expect(vaultRead).toBe(false);
    });

    // 7b) SSRF bonus — the request cannot select the upstream host; it is always pinned.
    it('SSRF: the upstream host is always the pinned literal regardless of query', async () => {
        const calls = [];
        const fetchImpl = async (url) => {
            calls.push(url);
            return fakeResponse(200, []);
        };
        const app = appWith({ fetchImpl });
        // Attempt to smuggle a host via the query — it must be treated as a
        // search term, never as a host, so the outbound host stays pinned.
        await request(app).get(
            '/api/wishlist-bridge/search?q=' + encodeURIComponent('http://evil.example.com/x')
        );
        expect(calls).toHaveLength(1);
        expect(new URL(calls[0]).host).toBe('wishlist-app-production.up.railway.app');
    });

    // 8) throttle — a tiny cap returns 429 on the 3rd rapid call from the same ip.
    it('429: rate limit of 2/min returns 429 on the 3rd rapid call', async () => {
        const fetchImpl = async () => fakeResponse(200, []);
        const app = appWith({ fetchImpl, rateLimit: { max: 2, windowMs: 60000 } });

        const r1 = await request(app).get('/api/wishlist-bridge/search?q=x');
        const r2 = await request(app).get('/api/wishlist-bridge/search?q=x');
        const r3 = await request(app).get('/api/wishlist-bridge/search?q=x');

        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
        expect(r3.status).toBe(429);
        expect(r3.body).toEqual({ error: 'rate limited' });
    });
});
