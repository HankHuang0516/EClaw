'use strict';

/**
 * OODA-R Phase 2 #6 — auth/session persistence + refresh diagnostics.
 * Card: card_214d48e395e812b3e909e5ca. Addresses pain 4 (帳號莫名要重新登入).
 *
 * Exercises the auth router in isolation with a stub express app — no DB
 * needed for the token paths under test (refresh + middleware reasons).
 */

const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const request = require('supertest');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-jest';
const JWT_SECRET = process.env.JWT_SECRET;

const devices = {
    'dev-1': { deviceSecret: 'sec-1' },
};

const authFactory = require('../../auth');

function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    const mod = authFactory(devices, () => devices['dev-1'], () => {});
    app.use('/api/auth', mod.router);
    // Tiny protected probe using the same middleware
    app.get('/probe', mod.authMiddleware, (req, res) => res.json({ ok: true, user: req.user }));
    return app;
}

function tokenFor({ deviceId = 'dev-1', userId = null, expiresIn = '7d' } = {}) {
    return jwt.sign({ userId, deviceId }, JWT_SECRET, { expiresIn });
}

describe('401 reason codes (pain 4: no silent kick)', () => {
    const app = buildApp();

    test('no token → reason no_token', async () => {
        const res = await request(app).get('/probe');
        expect(res.status).toBe(401);
        expect(res.body.reason).toBe('no_token');
    });

    test('expired token → reason token_expired', async () => {
        // expired well beyond the 30s clock tolerance
        const expired = tokenFor({ expiresIn: '-120s' });
        const res = await request(app).get('/probe').set('Authorization', `Bearer ${expired}`);
        expect(res.status).toBe(401);
        expect(res.body.reason).toBe('token_expired');
        expect(res.body.error).toMatch(/expired/i);
    });

    test('garbage token → reason token_invalid', async () => {
        const res = await request(app).get('/probe').set('Authorization', 'Bearer not.a.jwt');
        expect(res.status).toBe(401);
        expect(res.body.reason).toBe('token_invalid');
    });

    test('clock-skew guard: token expired <30s ago still accepted', async () => {
        const justExpired = tokenFor({ expiresIn: '-5s' });
        const res = await request(app).get('/probe').set('Authorization', `Bearer ${justExpired}`);
        expect(res.status).toBe(200);
    });
});

describe('POST /api/auth/refresh (sliding session)', () => {
    const app = buildApp();

    test('valid token → fresh token + new cookie + expiresAt', async () => {
        const valid = tokenFor();
        const res = await request(app)
            .post('/api/auth/refresh')
            .set('Authorization', `Bearer ${valid}`);
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(typeof res.body.token).toBe('string');
        expect(res.body.expiresAt).toBeGreaterThan(Date.now());
        const setCookie = res.headers['set-cookie'] || [];
        expect(setCookie.some(c => c.startsWith('eclaw_session='))).toBe(true);
        // fresh token decodes to same identity
        const decoded = jwt.verify(res.body.token, JWT_SECRET);
        expect(decoded.deviceId).toBe('dev-1');
    });

    test('expired token cannot refresh itself → 401 token_expired', async () => {
        const expired = tokenFor({ expiresIn: '-120s' });
        const res = await request(app)
            .post('/api/auth/refresh')
            .set('Authorization', `Bearer ${expired}`);
        expect(res.status).toBe(401);
        expect(res.body.reason).toBe('token_expired');
    });

    test('no token cannot refresh → 401 no_token', async () => {
        const res = await request(app).post('/api/auth/refresh');
        expect(res.status).toBe(401);
        expect(res.body.reason).toBe('no_token');
    });
});
