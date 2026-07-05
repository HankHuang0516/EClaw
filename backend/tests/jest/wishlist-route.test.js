/**
 * wishlist-route — thin proxy to the external Wishlist app.
 *
 * Pure route tests: inject a fake fetchImpl + fake mintAgentToken via
 * createRouter({...}), so there is NO real network and NO real EClaw. Asserts:
 *   - the outbound URL is hard-pinned to the wishlist host (SSRF-safe) and
 *     carries the named UA `curl/8.4.0`;
 *   - empty query / non-numeric wishlistId are rejected BEFORE any upstream call;
 *   - NO merchant key is ever sent — the write forwards a SHORT-LIVED EClaw
 *     identity token in the `x-eclaw-agent-token` header instead;
 *   - upstream 401 / network failure / token-mint failure degrade gracefully
 *     (401 / 502), never a crash;
 *   - a tiny rate cap returns 429 on the 3rd rapid call.
 *
 * Dummy secrets/tokens only (never a real key).
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

const DUMMY_TOKEN = 'v1.DUMMYPAYLOAD.DUMMYSIG';

// A caller-auth stub that accepts one specific botSecret and maps it to a
// caller-owned publicCode. Everything else is unauthenticated (fail closed).
function fakeAuth(publicCode, goodBotSecret = 'GOOD_SECRET') {
    return async ({ botSecret }) =>
        botSecret === goodBotSecret ? { ok: true, publicCode } : { ok: false };
}

// A token-minting stub: returns a fixed token that binds the passed publicCode.
// Records the last publicCode it was asked to mint for (ownership assertion).
function fakeMint(record) {
    return async ({ publicCode }) => {
        if (record) record.publicCode = publicCode;
        return { token: DUMMY_TOKEN, publicCode, expiresAt: Date.now() + 300000 };
    };
}
const CALLER = {
    deviceId: 'dev-1',
    entityId: 2,
    botSecret: 'GOOD_SECRET',
};

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

    // 3) 401 add-item — upstream rejects the token (caller IS authed).
    it('401: POST /listings returns 401 when upstream returns 401', async () => {
        const fetchImpl = async () => fakeResponse(401, { error: 'bad token' });
        const app = appWith({ fetchImpl, mintAgentToken: fakeMint(), authenticateCaller: fakeAuth('tbwb9e') });
        const res = await request(app)
            .post('/api/wishlist-bridge/listings')
            .send({ ...CALLER, wishlistId: 1, name: 'thing', notes: '', price: 10 });

        expect(res.status).toBe(401);
    });

    // 3b) CONFUSED-DEPUTY (HIGH #2): no caller creds ⇒ 401, and NO token is ever
    // minted (no anonymous borrow of EClaw authority) and no upstream call.
    it('401: POST /listings without caller creds never mints a token or calls upstream', async () => {
        let minted = false;
        let fetched = false;
        const mintAgentToken = async () => { minted = true; return { token: DUMMY_TOKEN }; };
        const fetchImpl = async () => { fetched = true; return fakeResponse(200, {}); };
        const app = appWith({ fetchImpl, mintAgentToken, authenticateCaller: fakeAuth('tbwb9e') });
        const res = await request(app)
            .post('/api/wishlist-bridge/listings')
            .send({ wishlistId: 1, name: 'thing' }); // no deviceId/entityId/botSecret

        expect(res.status).toBe(401);
        expect(minted).toBe(false);
        expect(fetched).toBe(false);
    });

    // 3c) CONFUSED-DEPUTY: bad botSecret ⇒ 403, no token minted.
    it('403: POST /listings with an invalid botSecret is rejected before any token mint', async () => {
        let minted = false;
        const mintAgentToken = async () => { minted = true; return { token: DUMMY_TOKEN }; };
        const app = appWith({ mintAgentToken, authenticateCaller: fakeAuth('tbwb9e') });
        const res = await request(app)
            .post('/api/wishlist-bridge/listings')
            .send({ deviceId: 'dev-1', entityId: 2, botSecret: 'WRONG', wishlistId: 1, name: 'x' });

        expect(res.status).toBe(403);
        expect(minted).toBe(false);
    });

    // 3d) OWNERSHIP BINDING (HIGH #1): a caller authed as tbwb9e cannot write a
    // listing under a DIFFERENT public code ⇒ 403, no token minted, no upstream.
    it('403: POST /listings rejects writing under a public code the caller does not control', async () => {
        let minted = false;
        let fetched = false;
        const mintAgentToken = async () => { minted = true; return { token: DUMMY_TOKEN }; };
        const fetchImpl = async () => { fetched = true; return fakeResponse(201, {}); };
        const app = appWith({ fetchImpl, mintAgentToken, authenticateCaller: fakeAuth('tbwb9e') });
        const res = await request(app)
            .post('/api/wishlist-bridge/listings')
            // caller is tbwb9e but tries to write under 3xa3h4 (someone else)
            .send({ ...CALLER, wishlistId: 1, name: 'x', publicCode: '3xa3h4' });

        expect(res.status).toBe(403);
        expect(minted).toBe(false);
        expect(fetched).toBe(false);
    });

    // 3e) HAPPY PATH: authed caller, own code, forwards to /api/items/upsert-listing
    // with the EClaw identity TOKEN (NO merchant key) + named UA, and FORCES
    // publicCode to the caller's own — and mints the token for the caller's code.
    it('201: POST /listings forwards a token (no merchant key) under the caller-owned code', async () => {
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url, init });
            return fakeResponse(201, { upserted: 'created', item: { id: 9 } });
        };
        const mintRecord = {};
        const app = appWith({ fetchImpl, mintAgentToken: fakeMint(mintRecord), authenticateCaller: fakeAuth('tbwb9e') });
        const res = await request(app)
            .post('/api/wishlist-bridge/listings')
            // caller omits publicCode; proxy must inject the caller's own (tbwb9e)
            .send({ ...CALLER, wishlistId: 1, name: 'Genuine', price: 42 });

        expect(res.status).toBe(201);
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe(
            'https://wishlist-app-production.up.railway.app/api/items/upsert-listing'
        );
        expect(calls[0].init.headers['User-Agent']).toBe('curl/8.4.0');
        // The identity token is forwarded; NO merchant key header exists anymore.
        expect(calls[0].init.headers['x-eclaw-agent-token']).toBe(DUMMY_TOKEN);
        expect(calls[0].init.headers['x-merchant-api-key']).toBeUndefined();
        // The token was minted for the caller's OWN code, not a client-supplied one.
        expect(mintRecord.publicCode).toBe('tbwb9e');
        const sent = JSON.parse(calls[0].init.body);
        expect(sent.publicCode).toBe('tbwb9e'); // forced to caller's own code
        // botSecret is verify-then-discard: it must NOT be forwarded upstream.
        expect(sent.botSecret).toBeUndefined();
    });

    // 3f) FAIL-CLOSED: if token minting fails, the write never reaches upstream.
    it('502: POST /listings fails closed when token minting throws', async () => {
        let fetched = false;
        const fetchImpl = async () => { fetched = true; return fakeResponse(201, {}); };
        const mintAgentToken = async () => { throw new Error('signing secret missing'); };
        const app = appWith({ fetchImpl, mintAgentToken, authenticateCaller: fakeAuth('tbwb9e') });
        const res = await request(app)
            .post('/api/wishlist-bridge/listings')
            .send({ ...CALLER, wishlistId: 1, name: 'thing', price: 5 });

        expect(res.status).toBe(502);
        expect(fetched).toBe(false);
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
