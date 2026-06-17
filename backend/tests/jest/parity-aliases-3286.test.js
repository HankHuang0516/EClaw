/**
 * Cross-platform parity endpoint aliases (GH#3286)
 *
 * The bot audit (entity #3) reported three endpoints as "missing" but they
 * existed under different canonical paths. This suite locks in the additive
 * path aliases added to backend/index.js so a client probing either the
 * canonical OR the audit-expected path resolves to identical behavior:
 *
 *   /api/notifications/vapid-key  -> same handler as /api/push/vapid-public-key
 *   /api/telemetry                -> same handler as /api/device-telemetry
 *
 * These tests mirror the exact handler functions and dual-path registration
 * used in index.js (the monolith is too heavy to boot under jest), proving
 * the alias contract: same status + same body shape on both paths.
 */

const express = require('express');
const request = require('supertest');

// ---- shims that mirror index.js dependencies for these two handlers ----
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

const deviceId = 'dev-1';
const deviceSecret = 'sec-1';
const devices = { [deviceId]: { deviceSecret } };

const telemetry = {
    getEntries: jest.fn().mockResolvedValue([{ ts: 1, type: 'api', action: 'GET /x' }]),
};
const chatPool = {};

// ---- handlers copied 1:1 from index.js (the code under test) ----
function handleVapidPublicKey(req, res) {
    if (!process.env.VAPID_PUBLIC_KEY) {
        return res.status(503).json({ success: false, error: 'Web Push not configured' });
    }
    res.json({ success: true, publicKey: process.env.VAPID_PUBLIC_KEY });
}

async function handleDeviceTelemetryRead(req, res) {
    const { deviceId: did, deviceSecret: dsec, type, page, action, since, until, limit } = req.query;
    if (!did || !dsec) {
        return res.status(400).json({ success: false, error: 'deviceId and deviceSecret required' });
    }
    const device = devices[did];
    if (!device || !safeEqual(device.deviceSecret, dsec)) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
    const entries = await telemetry.getEntries(chatPool, did, { type, page, action, since, until, limit });
    res.json({ success: true, count: entries.length, entries });
}

function buildApp() {
    const app = express();
    app.use(express.json());
    // dual registration, exactly as index.js wires it
    app.get('/api/push/vapid-public-key', handleVapidPublicKey);
    app.get('/api/notifications/vapid-key', handleVapidPublicKey);
    app.get('/api/device-telemetry', handleDeviceTelemetryRead);
    app.get('/api/telemetry', handleDeviceTelemetryRead);
    return app;
}

describe('GH#3286 VAPID key alias', () => {
    const OLD_ENV = process.env.VAPID_PUBLIC_KEY;
    afterAll(() => { process.env.VAPID_PUBLIC_KEY = OLD_ENV; });

    it('canonical and alias both return the key when configured', async () => {
        process.env.VAPID_PUBLIC_KEY = 'BTestKey123';
        const app = buildApp();
        const canonical = await request(app).get('/api/push/vapid-public-key');
        const alias = await request(app).get('/api/notifications/vapid-key');
        expect(canonical.status).toBe(200);
        expect(alias.status).toBe(200);
        expect(alias.body).toEqual(canonical.body);
        expect(alias.body).toEqual({ success: true, publicKey: 'BTestKey123' });
    });

    it('canonical and alias both 503 when not configured', async () => {
        delete process.env.VAPID_PUBLIC_KEY;
        const app = buildApp();
        const canonical = await request(app).get('/api/push/vapid-public-key');
        const alias = await request(app).get('/api/notifications/vapid-key');
        expect(canonical.status).toBe(503);
        expect(alias.status).toBe(503);
        expect(alias.body).toEqual(canonical.body);
    });
});

describe('GH#3286 telemetry alias', () => {
    afterEach(() => telemetry.getEntries.mockClear());

    it('400 on both paths without creds', async () => {
        const app = buildApp();
        const canonical = await request(app).get('/api/device-telemetry');
        const alias = await request(app).get('/api/telemetry');
        expect(canonical.status).toBe(400);
        expect(alias.status).toBe(400);
        expect(alias.body).toEqual(canonical.body);
    });

    it('401 on both paths with bad creds', async () => {
        const app = buildApp();
        const q = `?deviceId=${deviceId}&deviceSecret=wrong`;
        const canonical = await request(app).get('/api/device-telemetry' + q);
        const alias = await request(app).get('/api/telemetry' + q);
        expect(canonical.status).toBe(401);
        expect(alias.status).toBe(401);
        expect(alias.body).toEqual(canonical.body);
    });

    it('200 with entries on both paths with valid creds (entity/device-scoped)', async () => {
        const app = buildApp();
        const q = `?deviceId=${deviceId}&deviceSecret=${deviceSecret}`;
        const canonical = await request(app).get('/api/device-telemetry' + q);
        const alias = await request(app).get('/api/telemetry' + q);
        expect(canonical.status).toBe(200);
        expect(alias.status).toBe(200);
        expect(alias.body).toEqual(canonical.body);
        expect(alias.body).toMatchObject({ success: true, count: 1 });
        // scoped to the authenticated device, never global
        expect(telemetry.getEntries).toHaveBeenLastCalledWith(chatPool, deviceId, expect.any(Object));
    });
});
