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
            // usage warning source self-repair: INSERT ... usage_warning_config
            // params: [deviceId, mergedJson, ts]
            if (/INSERT INTO device_preferences/i.test(sql) && /usage_warning_config/i.test(sql)) {
                const deviceId = params[0];
                const merged = JSON.parse(params[1]);
                prefsStore[deviceId] = { ...(prefsStore[deviceId] || {}), usage_warning_config: merged };
                return Promise.resolve({ rows: [] });
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

describe('usage display source self-repair', () => {
    function buildAppWithProvider(provider) {
        mockPool = makeMockPool();
        logCalls = [];
        passiveHealth.init({
            pool: mockPool,
            devices: freshDevices(),
            entityStatus: {
                logOperation: (...args) => { logCalls.push(args); return Promise.resolve(); },
            },
            feedbackModule: { saveFeedback: jest.fn().mockResolvedValue(null) },
            deriveChannelProvider: () => provider,
            getChannelAccountById: jest.fn().mockResolvedValue({ id: 10, callback_url: 'https://codex.eclawbot.com/eclaw-webhook' }),
            isReady: () => true,
            selfBaseUrl: 'http://localhost:3999',
        });
    }

    it('runEntity repairs Codex channel usage_warning_config.entity_engines', async () => {
        const origFetch = global.fetch;
        global.fetch = jest.fn().mockResolvedValue({ ok: true });
        try {
            buildAppWithProvider('codex');
            const result = await passiveHealth.runEntity(DEVICE_ID, DEVICE_SECRET, 2, { autoRepair: true });
            expect(result.usageDisplayRepair).toMatchObject({ changed: true, engine: 'codex', entityId: 2 });
            expect(prefsStore[DEVICE_ID].usage_warning_config.entity_engines).toEqual({ '2': 'codex' });
            expect(logCalls.some(call => call[2] === 'usage_warning_self_repair')).toBe(true);
        } finally {
            global.fetch = origFetch;
        }
    });

    it('does not rewrite usage source for unmanaged providers', async () => {
        const origFetch = global.fetch;
        global.fetch = jest.fn().mockResolvedValue({ ok: true });
        try {
            buildAppWithProvider('openclaw');
            const result = await passiveHealth.runEntity(DEVICE_ID, DEVICE_SECRET, 2, { autoRepair: true });
            expect(result.usageDisplayRepair).toMatchObject({ changed: false, reason: 'provider_not_managed', provider: 'openclaw' });
            expect(prefsStore[DEVICE_ID]).toBeUndefined();
        } finally {
            global.fetch = origFetch;
        }
    });
});

describe('partial settings PUT preserves omitted fields', () => {
    it('PUT {autoRepair:false} alone does NOT disable enabled', async () => {
        await request(app).put('/api/passive-health/settings')
            .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, enabled: true, autoRepair: true, intervalHours: 6 });
        const res = await request(app).put('/api/passive-health/settings')
            .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, autoRepair: false });
        expect(res.statusCode).toBe(200);
        expect(res.body.settings.enabled).toBe(true);      // preserved
        expect(res.body.settings.intervalHours).toBe(6);   // preserved
        expect(res.body.settings.autoRepair).toBe(false);  // changed
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

describe('callback-active gate (no callback registered → cannot reply)', () => {
    // Build an app where getChannelAccountById returns a controllable account so we
    // can simulate (a) callback registered and (b) callback NULL for the same entity.
    function buildAppWithAccount(account) {
        mockPool = makeMockPool();
        logCalls = [];
        passiveHealth.init({
            pool: mockPool,
            devices: freshDevices(),
            entityStatus: {
                logOperation: (...args) => { logCalls.push(args); return Promise.resolve(); },
            },
            feedbackModule: {
                saveFeedback: jest.fn().mockResolvedValue({ id: 'fb-1' }),
                getFeedbackById: jest.fn().mockResolvedValue(null),
                createGithubIssue: jest.fn().mockResolvedValue(null),
            },
            deriveChannelProvider: () => 'openclaw',
            getChannelAccountById: jest.fn().mockResolvedValue(account),
            isReady: () => true,
            selfBaseUrl: 'http://localhost:3999',
        });
        const a = express();
        a.use('/api/channel/passive-health', passiveHealth.channelRouter);
        return a;
    }

    it('entity with callback_url=null → readiness:no_callback, canReply:false, callbackActive:false, NOT healthy', async () => {
        const a = buildAppWithAccount({ id: 10, callback_url: null });
        const res = await request(a)
            .get('/api/channel/passive-health/2')
            .query({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(200);
        expect(res.body.eligible).toBe(true);
        expect(res.body.healthy).toBe(false);          // no longer a misleading green
        expect(res.body.canReply).toBe(false);
        expect(res.body.callbackActive).toBe(false);
        expect(res.body.readiness).toBe('no_callback');
        expect(res.body.failingSignals).toContain('no_callback');
        expect(res.body.signals.callbackActive).toBe(false);
    });

    it('entity with callback_url set → unaffected (healthy, canReply:true, readiness:healthy)', async () => {
        // No /health probe fetch in this path would resolve to callbackHealthy:false;
        // stub global fetch to a 200 so the callback probe does not flip the verdict.
        const origFetch = global.fetch;
        global.fetch = jest.fn().mockResolvedValue({ ok: true });
        try {
            const a = buildAppWithAccount({ id: 10, callback_url: 'https://cb.example.com/hook' });
            const res = await request(a)
                .get('/api/channel/passive-health/2')
                .query({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
            expect(res.status).toBe(200);
            expect(res.body.eligible).toBe(true);
            expect(res.body.healthy).toBe(true);
            expect(res.body.canReply).toBe(true);
            expect(res.body.callbackActive).toBe(true);
            expect(res.body.readiness).toBe('healthy');
            expect(res.body.failingSignals).not.toContain('no_callback');
        } finally {
            global.fetch = origFetch;
        }
    });

    it('no account record → callbackActive stays null (unknown), does not falsely fail', async () => {
        const a = buildAppWithAccount(null);
        const res = await request(a)
            .get('/api/channel/passive-health/2')
            .query({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(res.status).toBe(200);
        expect(res.body.callbackActive).toBeNull();
        expect(res.body.canReply).toBe(true);           // unknown ≠ cannot-reply
        expect(res.body.readiness).toBe('healthy');     // no failing signals
        expect(res.body.failingSignals).not.toContain('no_callback');
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

// ── 2026-11-13: one outage is one incident ───────────────────────────────────
// An entity that stayed "unhealthy" got 3 repair attempts, a feedback row and a
// GitHub issue on every sweep, without end. Some of those entities were delivering
// messages normally (their bridges just had no /health at the host root); the
// others were really down and stayed down.
describe('callback probe: a host without a /health route is not a dead host', () => {
    const { probeCallback } = passiveHealth._internal;
    let origFetch, asked;
    // answers: { '<url>': status | 'ERR' }
    function answer(map) {
        asked = [];
        global.fetch = jest.fn(async (url) => {
            asked.push(String(url));
            const status = map[String(url)];
            if (status === undefined || status === 'ERR') throw new Error('connect ECONNREFUSED');
            return { ok: status >= 200 && status < 300, status };
        });
    }
    beforeEach(() => { origFetch = global.fetch; });
    afterEach(() => { global.fetch = origFetch; });

    it('webhook at the host root: 2xx is healthy, a gateway error or no answer is down, anything else is no opinion', async () => {
        const root = 'https://bot.example.com/health';
        const verdict = async status => { answer({ [root]: status }); return (await probeCallback('https://bot.example.com/eclaw-webhook')).healthy; };
        expect(await verdict(200)).toBe(true);
        expect(await verdict(502)).toBe(false);
        expect(await verdict(530)).toBe(false);
        expect(await verdict('ERR')).toBe(false);
        expect(await verdict(501)).toBeNull();   // a Python bridge with only do_POST answers 501 to GET
        expect(await verdict(404)).toBeNull();
        expect(await verdict(401)).toBeNull();
        expect(asked).toEqual([root]);
    });

    it('webhook under a path prefix: asks beside the webhook first, and the root only speaks when that has no route', async () => {
        const cb = 'https://tunnel.example.com/codex12/eclaw-webhook';
        const beside = 'https://tunnel.example.com/codex12/health', root = 'https://tunnel.example.com/health';

        answer({ [beside]: 200, [root]: 502 });
        expect((await probeCallback(cb)).healthy).toBe(true);
        expect(asked).toEqual([beside]);

        // the bridge answers under its prefix (no health route); the tunnel's root goes nowhere — the old false alarm
        answer({ [beside]: 404, [root]: 502 });
        expect(await probeCallback(cb)).toEqual({ healthy: null, beside: 'answered', root: 'down' });

        answer({ [beside]: 404, [root]: 200 });
        expect((await probeCallback(cb)).healthy).toBe(true);

        // nothing behind the prefix: down, whatever the root says
        answer({ [beside]: 502, [root]: 200 });
        expect((await probeCallback(cb)).healthy).toBe(false);
        answer({});
        expect((await probeCallback(cb)).healthy).toBe(false);
    });
});

describe('repairs back off and the same failure is reported once', () => {
    const HOUR = 3600e3, DAY = 24 * HOUR;
    const T0 = Date.UTC(2026, 10, 13, 5, 0, 0);
    let clock, opLog, feedbackRows, saveFeedback, repairCalls, healthStatus, pushSnapshot, origFetch, nowSpy;

    function build(account) {
        const pool = {
            query: jest.fn(async (sql, params) => {
                if (/FROM entity_operation_log/.test(sql) && /event_type = 'passive_health'/.test(sql)) {
                    const rows = opLog.filter(e => e.type === 'passive_health' && e.payload.healthy === true).sort((a, b) => b.at - a.at);
                    return { rows: rows.slice(0, 1).map(e => ({ occurred_at: new Date(e.at) })) };
                }
                if (/FROM entity_operation_log/.test(sql) && /event_type = 'self_repair'/.test(sql)) {
                    expect(sql).toMatch(/event_payload \? 'filed'/);
                    const since = params[2].getTime();
                    const rows = opLog.filter(e => e.type === 'self_repair' && 'filed' in e.payload && e.payload.reason !== 'no_callback' && e.at > since);
                    return { rows: [{ failed_cycles: rows.length, last_cycle_at: rows.length ? new Date(Math.max(...rows.map(e => e.at))) : null }] };
                }
                if (/FROM feedback/.test(sql)) {
                    expect(sql).toMatch(/app_version = 'passive-health'/);
                    const rows = feedbackRows.filter(f => f.entityId === params[1] && f.created_at > params[2]).sort((a, b) => b.created_at - a.created_at);
                    return { rows: rows.slice(0, 1).map(f => ({ id: f.id, created_at: String(f.created_at), github_issue_url: null, signals: f.signals })) };
                }
                return { rows: [] };
            }),
        };
        saveFeedback = jest.fn(async (_pool, fb) => {
            const id = 100 + feedbackRows.length;
            feedbackRows.push({ id, entityId: String(fb.logSnapshot.entityId), created_at: clock, signals: fb.logSnapshot.failingSignals });
            return { id };
        });
        passiveHealth.init({
            pool,
            devices: { [DEVICE_ID]: { deviceSecret: DEVICE_SECRET, entities: { 2: { isBound: true, bindingType: 'channel', channelAccountId: 10 } } } },
            entityStatus: { logOperation: async (_d, _e, type, summary, payload) => { opLog.push({ at: clock, type, summary, payload }); } },
            feedbackModule: { saveFeedback },
            deriveChannelProvider: () => 'custom',
            getChannelAccountById: jest.fn().mockResolvedValue(account === undefined ? { id: 10, callback_url: 'https://bot.example.com/eclaw-webhook' } : account),
            isReady: () => true,
            selfBaseUrl: 'http://localhost:3999',
            repairSpacingMs: 0,
            getPushSnapshot: () => pushSnapshot,
        });
    }
    const sweep = () => passiveHealth.runEntity(DEVICE_ID, DEVICE_SECRET, 2, { autoRepair: true });

    beforeEach(() => {
        clock = T0; opLog = []; feedbackRows = []; repairCalls = 0; healthStatus = 502; pushSnapshot = null;
        nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
        origFetch = global.fetch;
        global.fetch = jest.fn(async (url) => {
            if (String(url).includes('/api/channel/self-repair')) { repairCalls += 1; return { ok: true, status: 200, json: async () => ({ success: false }) }; }
            return { ok: healthStatus === 200, status: healthStatus };
        });
        build();
    });
    afterEach(() => { global.fetch = origFetch; nowSpy.mockRestore(); });

    it('a lasting outage: 3 attempts now, again after a day (twice), then weekly — and one report a week, not one a sweep', async () => {
        let r = await sweep();                                   // first failure of the incident
        expect(repairCalls).toBe(3);
        expect(saveFeedback).toHaveBeenCalledTimes(1);
        expect(r).toMatchObject({ healthy: false, repaired: false, bugFiled: true });

        clock = T0 + 6 * HOUR; r = await sweep();                // next sweep: left alone
        expect(repairCalls).toBe(3);
        expect(saveFeedback).toHaveBeenCalledTimes(1);
        expect(r).toMatchObject({ repairHeld: true, failedCycles: 1, nextRepairAt: new Date(T0 + DAY).toISOString() });
        expect(opLog[opLog.length - 1].summary).toMatch(/unhealthy \(callback_unhealthy\) — repair on hold until .* after 1 failed repair cycle/);
        expect(opLog.filter(e => e.type === 'self_repair').length).toBe(4); // 3 attempts + the cycle's end, nothing new

        clock = T0 + DAY; r = await sweep();                     // a day later: one more cycle, no second report
        expect(repairCalls).toBe(6);
        expect(saveFeedback).toHaveBeenCalledTimes(1);
        expect(r).toMatchObject({ bugFiled: false, alreadyReported: true, feedbackId: 100 });
        expect(opLog[opLog.length - 1]).toMatchObject({ type: 'self_repair', payload: { filed: false, report: 'already_reported' } });

        clock = T0 + 2 * DAY; await sweep();                     // third failed cycle
        expect(repairCalls).toBe(9);
        clock = T0 + 3 * DAY; r = await sweep();                 // from here on: weekly
        expect(repairCalls).toBe(9);
        expect(r).toMatchObject({ repairHeld: true, failedCycles: 3, nextRepairAt: new Date(T0 + 9 * DAY).toISOString() });
        clock = T0 + 8 * DAY; await sweep();
        expect(repairCalls).toBe(9);

        clock = T0 + 9 * DAY; r = await sweep();                 // the weekly cycle; the report is a week old, so it is repeated once
        expect(repairCalls).toBe(12);
        expect(saveFeedback).toHaveBeenCalledTimes(2);
        expect(r).toMatchObject({ bugFiled: true });
    });

    it('a recovery ends the incident: the next failure is repaired and reported at once', async () => {
        await sweep();
        expect([repairCalls, saveFeedback.mock.calls.length]).toEqual([3, 1]);

        clock = T0 + 6 * HOUR; healthStatus = 200;
        expect(await sweep()).toMatchObject({ healthy: true, repaired: false });

        clock = T0 + 12 * HOUR; healthStatus = 502;
        const r = await sweep();
        expect(repairCalls).toBe(6);
        expect(saveFeedback).toHaveBeenCalledTimes(2);            // the first report belongs to the incident that ended
        expect(r).toMatchObject({ bugFiled: true });
    });

    it('a different failure in the same incident is a new report; a different count of the same one is not', async () => {
        const { reportOnce } = passiveHealth._internal;
        feedbackRows.push({ id: 7, entityId: '2', created_at: T0 - HOUR, signals: ['callback_unhealthy', 'open_errors:5'] });
        const incident = { healthyAt: T0 - DAY };
        expect(await reportOnce(DEVICE_ID, DEVICE_SECRET, 2, 'custom', ['open_errors:9', 'callback_unhealthy'], incident, T0))
            .toMatchObject({ filed: false, reason: 'already_reported', feedbackId: 7, nextReportAt: T0 - HOUR + 7 * DAY });
        expect(saveFeedback).not.toHaveBeenCalled();
        expect(await reportOnce(DEVICE_ID, DEVICE_SECRET, 2, 'custom', ['callback_unhealthy', 'heartbeat_stale'], incident, T0)).toMatchObject({ filed: true });
        expect(await reportOnce(DEVICE_ID, DEVICE_SECRET, 3, 'custom', ['callback_unhealthy', 'open_errors:5'], incident, T0)).toMatchObject({ filed: true }); // another entity
    });

    it('no callback registered: reported once, never "repaired"', async () => {
        build({ id: 10, callback_url: null });
        expect(await sweep()).toMatchObject({ readiness: 'no_callback', bugFiled: true });
        clock = T0 + 6 * HOUR;
        expect(await sweep()).toMatchObject({ readiness: 'no_callback', bugFiled: false, alreadyReported: true });
        expect(saveFeedback).toHaveBeenCalledTimes(1);
        expect(repairCalls).toBe(0);
        // and it does not count as a failed repair cycle if a callback is registered later
        build();
        clock = T0 + 7 * HOUR;
        await sweep();
        expect(repairCalls).toBe(3);
    });

    it('a push the callback accepted in the last 6 hours outweighs a failed probe', async () => {
        const verdict = async () => passiveHealth.computePassiveHealth(DEVICE_ID, 2);
        expect((await verdict()).failingSignals).toEqual(['callback_unhealthy']);

        pushSnapshot = { consecutiveFailures: 0, lastSuccessAt: T0 - HOUR };
        const ok = await verdict();
        expect(ok.healthy).toBe(true);
        expect(ok.signals.callbackProbe).toEqual({ beside: null, root: 'down', overruledByPush: true });

        pushSnapshot = { consecutiveFailures: 0, lastSuccessAt: T0 - 7 * HOUR };   // too long ago
        expect((await verdict()).healthy).toBe(false);
        pushSnapshot = { consecutiveFailures: 2, lastSuccessAt: T0 - HOUR };       // pushes have failed since
        expect((await verdict()).healthy).toBe(false);
    });

    it('channel-backpressure remembers when a push last succeeded', () => {
        const bp = require('../../channel-backpressure');
        const target = { deviceId: 'dev-bp', entityId: 9, channelAccountId: 1 };
        bp.recordChannelPushResult(target, { success: true }, { now: 5000 });
        expect(bp.getChannelBackpressureSnapshot(target)).toMatchObject({ consecutiveFailures: 0, lastSuccessAt: 5000 });
        bp.recordChannelPushResult(target, { success: false, status: 502 }, { now: 6000 });
        expect(bp.getChannelBackpressureSnapshot(target)).toMatchObject({ consecutiveFailures: 1, lastSuccessAt: 5000 });
    });
});
