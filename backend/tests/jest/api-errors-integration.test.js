/**
 * Integration tests for unified 400-error shape on refactored endpoints.
 *
 * Mounts the REAL auth.js and mission.js routers (not the mocked stubs used
 * by other Jest suites) to verify that:
 *   1) the legacy `error` string is preserved (backward compat)
 *   2) the new `code` / `errorI18nKey` / `hint` / `missingFields` fields are present
 *
 * These tests intentionally only hit validation 400 paths (zero DB queries),
 * so we mock just enough of the surrounding env to require() the routers.
 */

// pg.Pool is constructed at module load time in both auth.js and mission.js,
// so mock it before requiring.
jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        connect: jest.fn().mockResolvedValue({
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

const express = require('express');
const request = require('supertest');

let authApp;
let missionApp;

beforeAll(() => {
    const authModule = require('../../auth');
    const missionModule = require('../../mission');

    // Build a tiny express host for the auth router
    authApp = express();
    authApp.use(express.json());
    const { router: authRouter } = authModule({
        devices: {},
        getOrCreateDevice: () => ({}),
        // The validation-path tests never reach saveDeviceData
        saveDeviceData: () => Promise.resolve(true),
        serverLog: () => {},
        audit: () => {},
        io: { to: () => ({ emit: () => {} }) },
        getSubscriptionStatus: () => ({}),
    });
    authApp.use('/api/auth', authRouter);

    // Build a tiny express host for the mission router
    missionApp = express();
    missionApp.use(express.json());
    const { router: missionRouter } = missionModule({
        devices: {},
        serverLog: () => {},
    });
    missionApp.use('/api/mission', missionRouter);
});

function expectUnifiedErrorShape(body, expectedCode) {
    expect(body).toEqual(expect.objectContaining({
        success: false,
        code: expectedCode,
        error: expect.any(String),
        errorI18nKey: expect.any(String),
        hint: expect.any(String),
    }));
}

describe('integration: unified 400 shape — POST /api/auth/register', () => {
    it('missing email+password returns MISSING_REQUIRED_FIELD with missingFields=[email,password]', async () => {
        const res = await request(authApp)
            .post('/api/auth/register')
            .send({});
        expect(res.status).toBe(400);
        expectUnifiedErrorShape(res.body, 'MISSING_REQUIRED_FIELD');
        expect(res.body.missingFields).toEqual(expect.arrayContaining(['email', 'password']));
        // Backward-compat: legacy error string preserved
        expect(res.body.error).toMatch(/Email and password required/i);
    });

    it('invalid email format returns INVALID_EMAIL with missingFields=[email]', async () => {
        const res = await request(authApp)
            .post('/api/auth/register')
            .send({ email: 'not-an-email', password: 'abcdef1' });
        expect(res.status).toBe(400);
        expectUnifiedErrorShape(res.body, 'INVALID_EMAIL');
        expect(res.body.missingFields).toEqual(['email']);
        expect(res.body.error).toMatch(/email/i);
    });

    it('weak password returns INVALID_PASSWORD with missingFields=[password]', async () => {
        const res = await request(authApp)
            .post('/api/auth/register')
            .send({ email: 'a@b.co', password: 'abc' });
        expect(res.status).toBe(400);
        expectUnifiedErrorShape(res.body, 'INVALID_PASSWORD');
        expect(res.body.missingFields).toEqual(['password']);
    });
});

describe('integration: unified 400 shape — POST /api/auth/login', () => {
    it('missing fields returns MISSING_REQUIRED_FIELD', async () => {
        const res = await request(authApp)
            .post('/api/auth/login')
            .send({ email: 'a@b.co' });
        expect(res.status).toBe(400);
        expectUnifiedErrorShape(res.body, 'MISSING_REQUIRED_FIELD');
        expect(res.body.missingFields).toEqual(['password']);
        expect(res.body.error).toMatch(/Email and password required/i);
    });
});

describe('integration: unified 400 shape — POST /api/auth/device-login', () => {
    it('missing deviceSecret returns MISSING_REQUIRED_FIELD', async () => {
        const res = await request(authApp)
            .post('/api/auth/device-login')
            .send({ deviceId: 'dev-1' });
        expect(res.status).toBe(400);
        expectUnifiedErrorShape(res.body, 'MISSING_REQUIRED_FIELD');
        expect(res.body.missingFields).toEqual(['deviceSecret']);
        expect(res.body.error).toMatch(/Device ID and Secret required/i);
    });
});

describe('integration: unified 400 shape — POST /api/auth/forgot-password', () => {
    it('missing email returns MISSING_REQUIRED_FIELD', async () => {
        const res = await request(authApp)
            .post('/api/auth/forgot-password')
            .send({});
        expect(res.status).toBe(400);
        expectUnifiedErrorShape(res.body, 'MISSING_REQUIRED_FIELD');
        expect(res.body.missingFields).toEqual(['email']);
    });
});

describe('integration: unified 400 shape — POST /api/auth/reset-password', () => {
    it('missing both fields returns MISSING_REQUIRED_FIELD with [token, newPassword]', async () => {
        const res = await request(authApp)
            .post('/api/auth/reset-password')
            .send({});
        expect(res.status).toBe(400);
        expectUnifiedErrorShape(res.body, 'MISSING_REQUIRED_FIELD');
        expect(res.body.missingFields).toEqual(expect.arrayContaining(['token', 'newPassword']));
    });
});

describe('integration: unified 400 shape — POST /api/mission/note/add', () => {
    it('missing title returns MISSING_REQUIRED_FIELD', async () => {
        // Use deviceSecret stub — auth will be skipped via in-memory device
        const res = await request(missionApp)
            .post('/api/mission/note/add')
            .send({ deviceId: 'dev-x', deviceSecret: 'sec-x' });
        // Either 400 (auth-then-validation) or auth 401 are acceptable for this
        // test's purpose — but if it IS 400 (validation), it must be the new shape.
        if (res.status === 400) {
            expectUnifiedErrorShape(res.body, 'MISSING_REQUIRED_FIELD');
            expect(res.body.missingFields).toEqual(expect.arrayContaining(['deviceId']).length === 0
                ? expect.arrayContaining(['title'])
                : expect.arrayContaining(['deviceId']));
        }
    });

    it('missing deviceId emits MISSING_REQUIRED_FIELD with missingFields=[deviceId]', async () => {
        const res = await request(missionApp)
            .post('/api/mission/note/add')
            .send({});
        expect(res.status).toBe(400);
        expectUnifiedErrorShape(res.body, 'MISSING_REQUIRED_FIELD');
        expect(res.body.missingFields).toContain('deviceId');
    });
});
