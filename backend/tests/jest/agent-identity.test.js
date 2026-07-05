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

    it('fails closed when authenticateCaller is not wired at all', async () => {
        const app = express();
        app.use(express.json());
        app.use('/api/agent-identity', createRouter({ getSecret: () => SECRET })); // no authenticateCaller
        const res = await request(app).post('/api/agent-identity/verify').send(CALLER);
        expect(res.body.valid).toBe(false);
    });
});
