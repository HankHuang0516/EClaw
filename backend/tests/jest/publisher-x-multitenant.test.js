/**
 * Phase-1 multi-tenant X publisher tests.
 *
 * Covers the credential-resolution order for POST /api/publisher/x/tweet:
 *   A. Vault returns all 4 keys  → publish uses vault creds (OAuth header signed with vault Consumer Key)
 *   B. Vault returns nothing     → falls back to process.env.X_*
 *   C. Vault returns 3 of 4 keys → atomic: treated as not-set → returns
 *                                  { error: 'X credentials not set for this device', setup_url: '/portal/publisher-setup.html' }
 *
 * We exercise `resolveXCreds` directly (unit) for deterministic assertions,
 * then drive the HTTP route with a stubbed global fetch to prove the creds
 * flow all the way through to the outbound OAuth header.
 */

const articlePublisher = require('../../article-publisher');
const { resolveXCreds, setDeviceVarResolver, X_CREDS_MISSING } = articlePublisher;

const CONSUMER_KEY_VAULT   = 'vault-ck';
const CONSUMER_SECRET_VAULT = 'vault-cs';
const ACCESS_TOKEN_VAULT   = 'vault-at';
const ACCESS_SECRET_VAULT  = 'vault-ats';

const CONSUMER_KEY_ENV     = 'env-ck';
const CONSUMER_SECRET_ENV  = 'env-cs';
const ACCESS_TOKEN_ENV     = 'env-at';
const ACCESS_SECRET_ENV    = 'env-ats';

const ALL_VAULT = {
    X_CONSUMER_KEY:        CONSUMER_KEY_VAULT,
    X_CONSUMER_SECRET:     CONSUMER_SECRET_VAULT,
    X_ACCESS_TOKEN:        ACCESS_TOKEN_VAULT,
    X_ACCESS_TOKEN_SECRET: ACCESS_SECRET_VAULT,
};

const PARTIAL_VAULT = {
    X_CONSUMER_KEY:        CONSUMER_KEY_VAULT,
    X_CONSUMER_SECRET:     CONSUMER_SECRET_VAULT,
    X_ACCESS_TOKEN:        ACCESS_TOKEN_VAULT,
    // X_ACCESS_TOKEN_SECRET deliberately missing → atomic "not-set"
};

function makeResolver(store) {
    return async (deviceId, varName) => {
        if (!store) return null;
        return Object.prototype.hasOwnProperty.call(store, varName) ? store[varName] : null;
    };
}

// ─────────────────────────────────────────────────────────────
// resolveXCreds — unit tests (deterministic, no HTTP)
// ─────────────────────────────────────────────────────────────

describe('resolveXCreds — credential resolution order (Phase 1)', () => {
    const savedEnv = {};
    beforeEach(() => {
        for (const k of ['X_CONSUMER_KEY', 'X_CONSUMER_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET']) {
            savedEnv[k] = process.env[k];
            delete process.env[k];
        }
        setDeviceVarResolver(null);
    });
    afterEach(() => {
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
        setDeviceVarResolver(null);
    });

    it('Case A: vault has all 4 keys → resolves from vault (env ignored even if set)', async () => {
        // Set env to different values — vault must win, never leak into result.
        process.env.X_CONSUMER_KEY        = CONSUMER_KEY_ENV;
        process.env.X_CONSUMER_SECRET     = CONSUMER_SECRET_ENV;
        process.env.X_ACCESS_TOKEN        = ACCESS_TOKEN_ENV;
        process.env.X_ACCESS_TOKEN_SECRET = ACCESS_SECRET_ENV;

        setDeviceVarResolver(makeResolver(ALL_VAULT));
        const out = await resolveXCreds('dev-1');
        expect(out.source).toBe('vault');
        expect(out.creds).toEqual({
            consumer_key:        CONSUMER_KEY_VAULT,
            consumer_secret:     CONSUMER_SECRET_VAULT,
            access_token:        ACCESS_TOKEN_VAULT,
            access_token_secret: ACCESS_SECRET_VAULT,
        });
    });

    it('Case B: vault returns empty → falls back to process.env.X_*', async () => {
        process.env.X_CONSUMER_KEY        = CONSUMER_KEY_ENV;
        process.env.X_CONSUMER_SECRET     = CONSUMER_SECRET_ENV;
        process.env.X_ACCESS_TOKEN        = ACCESS_TOKEN_ENV;
        process.env.X_ACCESS_TOKEN_SECRET = ACCESS_SECRET_ENV;

        setDeviceVarResolver(makeResolver({}));
        const out = await resolveXCreds('dev-1');
        expect(out.source).toBe('env');
        expect(out.creds).toEqual({
            consumer_key:        CONSUMER_KEY_ENV,
            consumer_secret:     CONSUMER_SECRET_ENV,
            access_token:        ACCESS_TOKEN_ENV,
            access_token_secret: ACCESS_SECRET_ENV,
        });
    });

    it('Case B-no-deviceId: no deviceId supplied → skips vault, uses env', async () => {
        process.env.X_CONSUMER_KEY        = CONSUMER_KEY_ENV;
        process.env.X_CONSUMER_SECRET     = CONSUMER_SECRET_ENV;
        process.env.X_ACCESS_TOKEN        = ACCESS_TOKEN_ENV;
        process.env.X_ACCESS_TOKEN_SECRET = ACCESS_SECRET_ENV;

        // Vault resolver set but deviceId=null → resolver must not be consulted
        const spy = jest.fn().mockResolvedValue(null);
        setDeviceVarResolver(spy);

        const out = await resolveXCreds(null);
        expect(out.source).toBe('env');
        expect(spy).not.toHaveBeenCalled();
    });

    it('Case C: vault returns 3 of 4 keys → partial treated as not-set, falls through (atomic)', async () => {
        // No env configured → partial vault triggers the structured "missing" response
        setDeviceVarResolver(makeResolver(PARTIAL_VAULT));
        const out = await resolveXCreds('dev-1');
        expect(out.source).toBe('missing');
        expect(out.creds).toBeNull();
    });

    it('Case C-partial-with-env: 3-of-4 vault still falls through to env if env is configured', async () => {
        // Regression guard: partial vault must NOT poison the env fallback.
        process.env.X_CONSUMER_KEY        = CONSUMER_KEY_ENV;
        process.env.X_CONSUMER_SECRET     = CONSUMER_SECRET_ENV;
        process.env.X_ACCESS_TOKEN        = ACCESS_TOKEN_ENV;
        process.env.X_ACCESS_TOKEN_SECRET = ACCESS_SECRET_ENV;

        setDeviceVarResolver(makeResolver(PARTIAL_VAULT));
        const out = await resolveXCreds('dev-1');
        expect(out.source).toBe('env');
        expect(out.creds.consumer_key).toBe(CONSUMER_KEY_ENV);
    });

    it('Case D: neither vault nor env → returns missing sentinel', async () => {
        setDeviceVarResolver(makeResolver({}));
        const out = await resolveXCreds('dev-1');
        expect(out.source).toBe('missing');
        expect(out.creds).toBeNull();
    });

    it('X_CREDS_MISSING payload shape includes setup_url', () => {
        expect(X_CREDS_MISSING).toEqual({
            error: 'X credentials not set for this device',
            setup_url: '/portal/publisher-setup.html'
        });
    });
});

// ─────────────────────────────────────────────────────────────
// POST /api/publisher/x/tweet — integration: creds flow into OAuth
// ─────────────────────────────────────────────────────────────
//
// We mount only the publisher router (not full index.js) to keep the test
// fast and avoid the chain of module mocks. Outbound fetch is stubbed so we
// can inspect the OAuth Authorization header and assert the Consumer Key that
// actually got signed into the request.

describe('POST /api/publisher/x/tweet — credential flow (integration)', () => {
    let app, request, originalFetch;
    let savedEnv = {};

    beforeAll(() => {
        const express = require('express');
        request = require('supertest');
        app = express();
        app.use('/api/publisher', articlePublisher.router);
        originalFetch = global.fetch;
    });

    afterAll(() => {
        global.fetch = originalFetch;
    });

    beforeEach(() => {
        for (const k of ['X_CONSUMER_KEY', 'X_CONSUMER_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET']) {
            savedEnv[k] = process.env[k];
            delete process.env[k];
        }
        setDeviceVarResolver(null);
        // Stub fetch: always return a successful tweet payload
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: async () => JSON.stringify({ data: { id: '1234567890', text: 'hi' } })
        });
    });

    afterEach(() => {
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
        setDeviceVarResolver(null);
    });

    it('Case A (vault wins): OAuth header contains the vault Consumer Key', async () => {
        // env intentionally set to the "wrong" key to prove vault takes priority
        process.env.X_CONSUMER_KEY        = CONSUMER_KEY_ENV;
        process.env.X_CONSUMER_SECRET     = CONSUMER_SECRET_ENV;
        process.env.X_ACCESS_TOKEN        = ACCESS_TOKEN_ENV;
        process.env.X_ACCESS_TOKEN_SECRET = ACCESS_SECRET_ENV;

        setDeviceVarResolver(makeResolver(ALL_VAULT));

        const res = await request(app)
            .post('/api/publisher/x/tweet')
            .send({ text: 'hello from vault', deviceId: 'dev-1' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, opts] = global.fetch.mock.calls[0];
        expect(url).toBe('https://api.x.com/2/tweets');
        const authHeader = opts.headers.Authorization || opts.headers.authorization;
        expect(authHeader).toBeTruthy();
        // Vault key must be in the OAuth header; env key must not.
        expect(authHeader).toContain(`oauth_consumer_key="${CONSUMER_KEY_VAULT}"`);
        expect(authHeader).not.toContain(CONSUMER_KEY_ENV);
        // And the oauth_token uses the vault access token, not env.
        expect(authHeader).toContain(`oauth_token="${ACCESS_TOKEN_VAULT}"`);
    });

    it('Case B (env fallback): no vault match → OAuth header uses env Consumer Key', async () => {
        process.env.X_CONSUMER_KEY        = CONSUMER_KEY_ENV;
        process.env.X_CONSUMER_SECRET     = CONSUMER_SECRET_ENV;
        process.env.X_ACCESS_TOKEN        = ACCESS_TOKEN_ENV;
        process.env.X_ACCESS_TOKEN_SECRET = ACCESS_SECRET_ENV;

        setDeviceVarResolver(makeResolver({})); // empty vault

        const res = await request(app)
            .post('/api/publisher/x/tweet')
            .send({ text: 'hello from env', deviceId: 'dev-1' });

        expect(res.status).toBe(200);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const authHeader = global.fetch.mock.calls[0][1].headers.Authorization
            || global.fetch.mock.calls[0][1].headers.authorization;
        expect(authHeader).toContain(`oauth_consumer_key="${CONSUMER_KEY_ENV}"`);
        expect(authHeader).toContain(`oauth_token="${ACCESS_TOKEN_ENV}"`);
    });

    it('Case C (partial vault, no env): returns structured error with setup_url and does NOT call X', async () => {
        setDeviceVarResolver(makeResolver(PARTIAL_VAULT));

        const res = await request(app)
            .post('/api/publisher/x/tweet')
            .send({ text: 'should not send', deviceId: 'dev-1' });

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: 'X credentials not set for this device',
            setup_url: '/portal/publisher-setup.html'
        });
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
