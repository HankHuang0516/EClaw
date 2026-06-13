/**
 * Passive Health subsystem tests
 *
 * Covers the settings GET/PUT (incl. intervalHours validation), the
 * channel-bound-only eligibility gate, auth rejection on all endpoints, and
 * that the scheduler/compute functions behave as a no-op on a disabled device.
 *
 * The pg pool is a SQL-aware mock (no live DB). The module is init'd directly
 * with mock devices + a mock entity-status so logOperation is a stub.
 */

const express = require('express');
const request = require('supertest');

const passiveHealth = require('../../passive-health');

// In-memory prefs store keyed by deviceId, mutated by the mock pool so PUT then
// GET round-trips like the real device_preferences JSONB merge.
let prefsStore;

function makeMockPool() {
    return {
        query: jest.fn((sql, params) => {
            // getSettings: SELECT prefs FROM device_preferences WHERE device_id = $1
            if (/SELECT prefs FROM device_preferences/i.test(sql)) {
                const deviceId = params[0];
                const prefs = prefsStore[deviceId] || null;
                return Promise.resolve({ rows: prefs ? [{ prefs }] : [] });
            }
            // updateSettings: INSERT ... ON CONFLICT — params: [deviceId, mergedJson, ts]
            if (/INSERT INTO device_preferences/i.test(sql)) {
                const deviceId = params[0];
                const merged = JSON.parse(params[1]);
                prefsStore[deviceId] = { ...(prefsStore[deviceId] || {}), passiveHealth: merged };
                return Promise.resolve({ rows: [] });
            }
            // signal queries — empty (healthy) by default
            if (/FROM entity_error_counters/i.test(sql)) return Promise.resolve({ rows: [] });
            if (/FROM outbound_msg_pending/i.test(sql)) return Promise.resolve({ rows: [] });
            return Promise.resolve({ rows: [] });
        }),
    };
}

let mockPool;
let logCalls;

function buildApp(devices) {
    mockPool = makeMockPool();
    logCalls = [];
    passiveHealth.init({
        pool: mockPool,
        devices,
        entityStatus: {
            logOperation: (...args) => { logCalls.push(args); return Promise.resolve(); },
        },
        feedbackModule: { saveFeedback: jest.fn().mockResolvedValue(null) },
        deriveChannelProvider: () => 'openclaw',
        getChannelAccountById: jest.fn().mockResolvedValue(null),
        isReady: () => true,
        selfBaseUrl: 'http://localhost:3999',
    });

    const app = express();
    app.use('/api/passive-health', passiveHealth.router);
    app.use('/api/channel/passive-health', passiveHealth.channelRouter);
    return app;
}

const DEVICE_ID = 'dev-ph';
const DEVICE_SECRET = 'secret-ph';

function freshDevices() {
    return {
        [DEVICE_ID]: {
            deviceSecret: DEVICE_SECRET,
            entities: {
                // entity 2 = channel-bound (eligible)
                2: { isBound: true, bindingType: 'channel', channelAccountId: 10, lastSeen: new Date().toISOString() },
                // entity 3 = bound but NOT a channel binding (ineligible)
                3: { isBound: true, bindingType: 'webhook' },
                // entity 4 = unbound (ineligible)
                4: { isBound: false, bindingType: null },
            },
        },
    };
}

let app;
beforeEach(() => {
    prefsStore = {};
    app = buildApp(freshDevices());
});

afterAll(() => {
    passiveHealth.stopScheduler();
});

describe('settings GET/PUT', () => {
    it('GET returns defaults (enabled:false) for a fresh device', async () => {
        const res = await request(app)
            .get('/api/passive-health/settings')
            .query({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.settings.enabled).toBe(false);
        expect(res.body.settings.intervalHours).toBe(6);
        expect(res.body.settings.autoRepair).toBe(true);
    });

    it('PUT updates enabled + intervalHours and round-trips via GET', async () => {
        const put = await request(app)
            .put('/api/passive-health/settings')
            .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, enabled: true, intervalHours: 12, autoRepair: false });
        expect(put.status).toBe(200);
        expect(put.body.settings.enabled).toBe(true);
        expect(put.body.settings.intervalHours).toBe(12);
        expect(put.body.settings.autoRepair).toBe(false);

        const get = await request(app)
            .get('/api/passive-health/settings')
            .query({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(get.body.settings.enabled).toBe(true);
        expect(get.body.settings.intervalHours).toBe(12);
    });

    it('PUT rejects out-of-range intervalHours with 400', async () => {
        const tooHigh = await request(app)
            .put('/api/passive-health/settings')
            .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, intervalHours: 9999 });
        expect(tooHigh.status).toBe(400);
        expect(tooHigh.body.error).toMatch(/intervalHours/i);

        const tooLow = await request(app)
            .put('/api/passive-health/settings')
            .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, intervalHours: 0 });
        expect(tooLow.status).toBe(400);
    });
});

describe('auth rejection', () => {
    it('GET settings 400 without creds', async () => {
        const res = await request(app).get('/api/passive-health/settings');
        expect(res.status).toBe(400);
    });
    it('GET settings 401 on wrong secret', async () => {
        const res = await request(app)
            .get('/api/passive-health/settings')
            .query({ deviceId: DEVICE_ID, deviceSecret: 'WRONG' });
        expect(res.status).toBe(401);
    });
    it('POST run 401 on wrong secret', async () => {
        const res = await request(app)
            .post('/api/passive-health/run')
            .send({ deviceId: DEVICE_ID, deviceSecret: 'WRONG' });
        expect(res.status).toBe(401);
    });
    it('GET channel passive-health 401 on wrong secret', async () => {
        const res = await request(app)
            .get('/api/channel/passive-health/2')
            .query({ deviceId: DEVICE_ID, deviceSecret: 'WRONG' });
        expect(res.status).toBe(401);
    });
});

describe('eligibility gate (channel-bound only)', () => {
    it('ineligible: webhook-bound entity returns eligible:false', async () => {
        const res = await request(app)
            .get('/api/channel/passive-health/3')
            .query({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(200);
        expect(res.body.eligible).toBe(false);
        expect(res.body.reason).toBe('not channel-bound');
    });

    it('ineligible: unbound entity returns eligible:false', async () => {
        const res = await request(app)
            .get('/api/channel/passive-health/4')
            .query({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(200);
        expect(res.body.eligible).toBe(false);
        expect(res.body.reason).toBe('not channel-bound');
    });

    it('eligible: channel-bound entity computes a verdict (no signals = healthy)', async () => {
        const res = await request(app)
            .get('/api/channel/passive-health/2')
            .query({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(200);
        expect(res.body.eligible).toBe(true);
        expect(res.body.healthy).toBe(true);
        expect(Array.isArray(res.body.failingSignals)).toBe(true);
        expect(res.body.failingSignals.length).toBe(0);
    });

    it('checkEligible unit helper', () => {
        expect(passiveHealth.checkEligible({ isBound: true, bindingType: 'channel' }).eligible).toBe(true);
        expect(passiveHealth.checkEligible({ isBound: true, bindingType: 'webhook' }).eligible).toBe(false);
        expect(passiveHealth.checkEligible({ isBound: false }).eligible).toBe(false);
        expect(passiveHealth.checkEligible(null).eligible).toBe(false);
    });
});

describe('disabled-device no-op', () => {
    it('schedulerTick does not sweep a device that has not opted in', async () => {
        // enabled defaults to false → tick should write nothing (no INSERT).
        await passiveHealth.schedulerTick();
        const insertCalls = mockPool.query.mock.calls.filter(c => /INSERT INTO device_preferences/i.test(c[0]));
        expect(insertCalls.length).toBe(0);
        expect(logCalls.length).toBe(0);
    });

    it('runDeviceSweep skips ineligible entities and only checks channel-bound ones', async () => {
        const summary = await passiveHealth.runDeviceSweep(DEVICE_ID, DEVICE_SECRET);
        expect(summary.ran).toBe(true);
        // Only entity 2 (channel-bound) is checked; 3 and 4 are skipped.
        expect(summary.checked).toBe(1);
        expect(summary.results[0].entityId).toBe(2);
        expect(summary.results[0].eligible).toBe(true);
    });

    it('manual POST /run is gated by enabled? — run always works (manual), sweep records lastRunAt', async () => {
        const res = await request(app)
            .post('/api/passive-health/run')
            .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.checked).toBe(1);
        // lastRunAt persisted
        const get = await request(app)
            .get('/api/passive-health/settings')
            .query({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(typeof get.body.settings.lastRunAt).toBe('number');
    });
});

describe('heartbeat signal (channel-push entities have no daemon lastSeen)', () => {
    const { collectHeartbeatSignal } = passiveHealth._internal;
    const now = Date.now();

    it('does NOT flag stale when no heartbeat is known (channel-push entity)', () => {
        const sig = collectHeartbeatSignal({ isBound: true, bindingType: 'channel' }, now);
        expect(sig.heartbeatKnown).toBe(false);
        expect(sig.heartbeatStale).toBe(false);
        expect(sig.lastSeen).toBeNull();
    });

    it('flags stale only when a known heartbeat is old', () => {
        const old = collectHeartbeatSignal({ lastSeen: now - 10 * 60 * 1000 }, now);
        expect(old.heartbeatKnown).toBe(true);
        expect(old.heartbeatStale).toBe(true);
    });

    it('does not flag a fresh known heartbeat', () => {
        const fresh = collectHeartbeatSignal({ lastSeen: now - 1000 }, now);
        expect(fresh.heartbeatKnown).toBe(true);
        expect(fresh.heartbeatStale).toBe(false);
    });
});

describe('exports surface', () => {
    it('exposes scheduler + compute functions', () => {
        expect(typeof passiveHealth.startScheduler).toBe('function');
        expect(typeof passiveHealth.stopScheduler).toBe('function');
        expect(typeof passiveHealth.schedulerTick).toBe('function');
        expect(typeof passiveHealth.computePassiveHealth).toBe('function');
        expect(typeof passiveHealth.runDeviceSweep).toBe('function');
        expect(passiveHealth.SETTINGS_DEFAULTS.enabled).toBe(false);
    });
});
