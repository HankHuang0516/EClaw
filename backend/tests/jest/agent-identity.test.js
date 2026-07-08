/**
 * agent-identity — cross-service "prove you are a real EClaw agent".
 *
 * Pure tests: inject a fake authenticateCaller + a fixed secret + a fake clock
 * via createRouter({...}) / signAgentToken({...}). NO real network, NO real DB.
 * Asserts:
 *   - a minted token verifies back to the SAME publicCode (round-trip);
 *   - a tampered / wrong-secret / wrong-version / expired token is rejected;
 *   - POST /token requires a real caller (fail closed) and never returns/logs a
 *     secret; POST /verify accepts a token (preferred) or a transient botSecret;
 *   - a spoofed identity → { valid:false }, and an outage → 502 (fail closed).
 *
 * Dummy secrets/tokens only.
 */

const express = require('express');
const request = require('supertest');
const {
    createRouter,
    signAgentToken,
    verifyAgentTokenSig,
    SIGNING_SECRET_ENV,
    TOKEN_VERSION,
} = require('../../agent-identity');

const SECRET = 'test-signing-secret';
const OTHER_SECRET = 'a-different-secret';

// Caller-auth stub: one good botSecret → a caller-owned publicCode; else closed.
function fakeAuth(publicCode, goodBotSecret = 'GOOD_SECRET') {
    return async ({ botSecret }) =>
        botSecret === goodBotSecret ? { ok: true, publicCode } : { ok: false, reason: 'not_verified' };
}

function appWith(opts = {}) {
    const app = express();
    app.use(express.json());
    app.use('/api/agent-identity', createRouter({ getSecret: () => SECRET, ...opts }));
    return app;
}

const CALLER = { deviceId: 'dev-1', entityId: 2, botSecret: 'GOOD_SECRET' };

describe('agent-identity token crypto', () => {
    it('round-trips: a signed token verifies back to the same publicCode', () => {
        const now = 1_000_000;
        const { token, publicCode, expiresAt } = signAgentToken({ publicCode: 'tbwb9e', secret: SECRET, now });
        expect(publicCode).toBe('tbwb9e');
        expect(expiresAt).toBeGreaterThan(now);
        const v = verifyAgentTokenSig({ token, secret: SECRET, now: now + 1000 });
        expect(v).toEqual({ ok: true, publicCode: 'tbwb9e' });
    });

    it('rejects a token signed with a DIFFERENT secret (bad_signature)', () => {
        const { token } = signAgentToken({ publicCode: 'tbwb9e', secret: SECRET });
        const v = verifyAgentTokenSig({ token, secret: OTHER_SECRET });
        expect(v.ok).toBe(false);
        expect(v.reason).toBe('bad_signature');
    });

    it('rejects a tampered payload (bad_signature)', () => {
        const { token } = signAgentToken({ publicCode: 'tbwb9e', secret: SECRET });
        const parts = token.split('.');
        // Flip the payload to claim a different code but keep the old signature.
        const forged = signAgentToken({ publicCode: 'zzzzzz', secret: OTHER_SECRET }).token.split('.')[1];
        const tampered = `${parts[0]}.${forged}.${parts[2]}`;
        const v = verifyAgentTokenSig({ token: tampered, secret: SECRET });
        expect(v.ok).toBe(false);
    });

    it('rejects an expired token (expired)', () => {
        const now = 1_000_000;
        const { token, expiresAt } = signAgentToken({ publicCode: 'tbwb9e', secret: SECRET, ttlMs: 1000, now });
        const v = verifyAgentTokenSig({ token, secret: SECRET, now: expiresAt + 1 });
        expect(v).toEqual({ ok: false, reason: 'expired' });
    });

    it('rejects a wrong-version token (bad_version)', () => {
        const { token } = signAgentToken({ publicCode: 'tbwb9e', secret: SECRET });
        const bumped = token.replace(new RegExp('^' + TOKEN_VERSION), 'v9');
        const v = verifyAgentTokenSig({ token: bumped, secret: SECRET });
        expect(v.ok).toBe(false);
        expect(v.reason).toBe('bad_version');
    });

    it('rejects a malformed token (bad_format)', () => {
        expect(verifyAgentTokenSig({ token: 'not-a-token', secret: SECRET }).ok).toBe(false);
        expect(verifyAgentTokenSig({ token: '', secret: SECRET }).ok).toBe(false);
        expect(verifyAgentTokenSig({ token: 12345, secret: SECRET }).ok).toBe(false);
    });

    it('signAgentToken refuses an invalid publicCode', () => {
        expect(() => signAgentToken({ publicCode: 'BADCODE', secret: SECRET })).toThrow();
        expect(() => signAgentToken({ publicCode: 'tbwb9e', secret: '' })).toThrow();
    });
});

describe('POST /token (mint)', () => {
    it('mints a token for a verified caller; response has no secret and verifies', async () => {
        const app = appWith({ authenticateCaller: fakeAuth('tbwb9e') });
        const res = await request(app).post('/api/agent-identity/token').send(CALLER);
        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(true);
        expect(res.body.publicCode).toBe('tbwb9e');
        expect(typeof res.body.token).toBe('string');
        // The mint must NEVER echo the caller's secret back.
        expect(JSON.stringify(res.body)).not.toContain('GOOD_SECRET');
        // And the minted token is genuinely valid.
        expect(verifyAgentTokenSig({ token: res.body.token, secret: SECRET }).ok).toBe(true);
    });

    it('403 when the caller is not a real entity (fail closed)', async () => {
        const app = appWith({ authenticateCaller: fakeAuth('tbwb9e') });
        const res = await request(app)
            .post('/api/agent-identity/token')
            .send({ ...CALLER, botSecret: 'WRONG' });
        expect(res.status).toBe(403);
        expect(res.body.valid).toBe(false);
    });

    it('400 when credentials are missing', async () => {
        const app = appWith({ authenticateCaller: fakeAuth('tbwb9e') });
        const res = await request(app).post('/api/agent-identity/token').send({ name: 'x' });
        expect(res.status).toBe(400);
    });

    it('502 (fail closed) when the auth backend throws', async () => {
        const app = appWith({ authenticateCaller: async () => { throw new Error('devices map down'); } });
        const res = await request(app).post('/api/agent-identity/token').send(CALLER);
        expect(res.status).toBe(502);
        expect(res.body.valid).toBe(false);
    });

    it('500 when the dedicated signing secret is missing, even if JWT_SECRET exists', async () => {
        const originalAgentSecret = process.env[SIGNING_SECRET_ENV];
        const originalJwtSecret = process.env.JWT_SECRET;
        try {
            delete process.env[SIGNING_SECRET_ENV];
            process.env.JWT_SECRET = 'jwt-secret-must-not-be-used';

            const app = express();
            app.use(express.json());
            app.use('/api/agent-identity', createRouter({ authenticateCaller: fakeAuth('tbwb9e') }));
            const res = await request(app).post('/api/agent-identity/token').send(CALLER);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ valid: false, reason: 'server_misconfigured' });
        } finally {
            if (originalAgentSecret === undefined) delete process.env[SIGNING_SECRET_ENV];
            else process.env[SIGNING_SECRET_ENV] = originalAgentSecret;
            if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
            else process.env.JWT_SECRET = originalJwtSecret;
        }
    });

    it('500 before caller auth when signing secret is missing, so misconfig is not a botSecret oracle', async () => {
        const originalAgentSecret = process.env[SIGNING_SECRET_ENV];
        const originalJwtSecret = process.env.JWT_SECRET;
        let authCalls = 0;
        try {
            delete process.env[SIGNING_SECRET_ENV];
            process.env.JWT_SECRET = 'jwt-secret-must-not-be-used';

            const app = express();
            app.use(express.json());
            app.use('/api/agent-identity', createRouter({
                authenticateCaller: async () => {
                    authCalls += 1;
                    return { ok: false, reason: 'not_verified' };
                },
            }));
            const res = await request(app)
                .post('/api/agent-identity/token')
                .send({ ...CALLER, botSecret: 'WRONG' });

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ valid: false, reason: 'server_misconfigured' });
            expect(authCalls).toBe(0);
        } finally {
            if (originalAgentSecret === undefined) delete process.env[SIGNING_SECRET_ENV];
            else process.env[SIGNING_SECRET_ENV] = originalAgentSecret;
            if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
            else process.env.JWT_SECRET = originalJwtSecret;
        }
    });

    it('500 when AGENT_IDENTITY_SECRET is explicitly reused from JWT_SECRET', async () => {
        const originalAgentSecret = process.env[SIGNING_SECRET_ENV];
        const originalJwtSecret = process.env.JWT_SECRET;
        try {
            process.env[SIGNING_SECRET_ENV] = 'shared-secret-is-not-dedicated';
            process.env.JWT_SECRET = 'shared-secret-is-not-dedicated';

            const app = express();
            app.use(express.json());
            app.use('/api/agent-identity', createRouter({ authenticateCaller: fakeAuth('tbwb9e') }));
            const res = await request(app).post('/api/agent-identity/token').send(CALLER);

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ valid: false, reason: 'server_misconfigured' });
        } finally {
            if (originalAgentSecret === undefined) delete process.env[SIGNING_SECRET_ENV];
            else process.env[SIGNING_SECRET_ENV] = originalAgentSecret;
            if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
            else process.env.JWT_SECRET = originalJwtSecret;
        }
    });

    it('does not consume the botSecret oracle limiter on successful token mints', async () => {
        const app = appWith({
            authenticateCaller: fakeAuth('tbwb9e'),
            botSecretRateLimit: { max: 1, windowMs: 60000 },
        });

        const r1 = await request(app).post('/api/agent-identity/token').send(CALLER);
        const r2 = await request(app).post('/api/agent-identity/token').send(CALLER);

        expect(r1.status).toBe(200);
        expect(r2.status).toBe(200);
    });

    it('429: rate-limits repeated botSecret mint attempts to defang oracle probing', async () => {
        const app = appWith({
            authenticateCaller: fakeAuth('tbwb9e'),
            botSecretRateLimit: { max: 2, windowMs: 60000 },
        });

        const r1 = await request(app).post('/api/agent-identity/token').send({ ...CALLER, botSecret: 'WRONG1' });
        const r2 = await request(app).post('/api/agent-identity/token').send({ ...CALLER, botSecret: 'WRONG2' });
        const r3 = await request(app).post('/api/agent-identity/token').send({ ...CALLER, botSecret: 'WRONG3' });

        expect(r1.status).toBe(403);
        expect(r2.status).toBe(403);
        expect(r3.status).toBe(429);
        expect(r3.body).toEqual({ valid: false, reason: 'rate_limited' });
    });

    it('429: does not re-check authenticateCaller once botSecret probing is limited', async () => {
        let authCalls = 0;
        const app = appWith({
            authenticateCaller: async () => {
                authCalls += 1;
                return { ok: false, reason: 'not_verified' };
            },
            botSecretRateLimit: { max: 1, windowMs: 60000 },
        });

        const r1 = await request(app).post('/api/agent-identity/token').send({ ...CALLER, botSecret: 'WRONG1' });
        const r2 = await request(app).post('/api/agent-identity/token').send({ ...CALLER, botSecret: 'WRONG2' });

        expect(r1.status).toBe(403);
        expect(r2.status).toBe(429);
        expect(authCalls).toBe(1);
    });
});

describe('POST /verify', () => {
    it('token path: a valid token → { valid:true, publicCode } and nothing else', async () => {
        const { token } = signAgentToken({ publicCode: 'tbwb9e', secret: SECRET });
        const app = appWith({ authenticateCaller: fakeAuth('tbwb9e') });
        const res = await request(app).post('/api/agent-identity/verify').send({ token });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ valid: true, publicCode: 'tbwb9e' });
    });

    it('token path: an invalid/spoofed token → { valid:false } and never a write', async () => {
        const app = appWith({ authenticateCaller: fakeAuth('tbwb9e') });
        const res = await request(app).post('/api/agent-identity/verify').send({ token: 'v1.forged.sig' });
        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
    });

    it('500 when token verification has no dedicated signing secret, even if JWT_SECRET exists', async () => {
        const originalAgentSecret = process.env[SIGNING_SECRET_ENV];
        const originalJwtSecret = process.env.JWT_SECRET;
        try {
            delete process.env[SIGNING_SECRET_ENV];
            process.env.JWT_SECRET = 'jwt-secret-must-not-be-used';

            const app = express();
            app.use(express.json());
            app.use('/api/agent-identity', createRouter({ authenticateCaller: fakeAuth('tbwb9e') }));
            const res = await request(app).post('/api/agent-identity/verify').send({ token: 'v1.forged.sig' });

            expect(res.status).toBe(500);
            expect(res.body).toEqual({ valid: false, reason: 'server_misconfigured' });
        } finally {
            if (originalAgentSecret === undefined) delete process.env[SIGNING_SECRET_ENV];
            else process.env[SIGNING_SECRET_ENV] = originalAgentSecret;
            if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
            else process.env.JWT_SECRET = originalJwtSecret;
        }
    });

    it('botSecret path (fallback): a good triple → { valid:true, publicCode }', async () => {
        const app = appWith({ authenticateCaller: fakeAuth('tbwb9e') });
        const res = await request(app).post('/api/agent-identity/verify').send(CALLER);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ valid: true, publicCode: 'tbwb9e' });
    });

    it('botSecret path: a spoofed identity → { valid:false }', async () => {
        const app = appWith({ authenticateCaller: fakeAuth('tbwb9e') });
        const res = await request(app)
            .post('/api/agent-identity/verify')
            .send({ ...CALLER, botSecret: 'WRONG' });
        expect(res.status).toBe(200);
        expect(res.body.valid).toBe(false);
    });

    it('botSecret path: auth backend outage → 502 (fail closed)', async () => {
        const app = appWith({ authenticateCaller: async () => { throw new Error('down'); } });
        const res = await request(app).post('/api/agent-identity/verify').send(CALLER);
        expect(res.status).toBe(502);
        expect(res.body.valid).toBe(false);
    });

    it('429: rate-limits repeated transient botSecret verify attempts', async () => {
        const app = appWith({
            authenticateCaller: fakeAuth('tbwb9e'),
            botSecretRateLimit: { max: 1, windowMs: 60000 },
        });

        const r1 = await request(app).post('/api/agent-identity/verify').send({ ...CALLER, botSecret: 'WRONG1' });
        const r2 = await request(app).post('/api/agent-identity/verify').send({ ...CALLER, botSecret: 'WRONG2' });

        expect(r1.status).toBe(200);
        expect(r1.body.valid).toBe(false);
        expect(r2.status).toBe(429);
        expect(r2.body).toEqual({ valid: false, reason: 'rate_limited' });
    });

    it('does not consume the botSecret oracle limiter on successful transient verifies', async () => {
        const app = appWith({
            authenticateCaller: fakeAuth('tbwb9e'),
            botSecretRateLimit: { max: 1, windowMs: 60000 },
        });

        const r1 = await request(app).post('/api/agent-identity/verify').send(CALLER);
        const r2 = await request(app).post('/api/agent-identity/verify').send(CALLER);

        expect(r1.status).toBe(200);
        expect(r1.body).toEqual({ valid: true, publicCode: 'tbwb9e' });
        expect(r2.status).toBe(200);
        expect(r2.body).toEqual({ valid: true, publicCode: 'tbwb9e' });
    });

    it('fails closed when authenticateCaller is not wired at all', async () => {
        const app = express();
        app.use(express.json());
        app.use('/api/agent-identity', createRouter({ getSecret: () => SECRET })); // no authenticateCaller
        const res = await request(app).post('/api/agent-identity/verify').send(CALLER);
        expect(res.body.valid).toBe(false);
    });
});
