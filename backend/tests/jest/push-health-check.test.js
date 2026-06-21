'use strict';

// Push round-trip health-check cron — card_0a5d4a97.
//
// These tests cover the cron module (createPushHealthCheckCron) directly
// against a fake in-memory pool. We also extend the existing push-notifications
// supertest to exercise POST /api/push/ack via the real express app to prove
// the route wiring + payload validation.

const {
    DEFAULT_CRON,
    DEFAULT_TIMEZONE,
    DEFAULT_ACK_WINDOW_MS,
    DEFAULT_DEAD_THRESHOLD,
    createPushHealthCheckCron,
    loadConfig,
    describeDeadSubscription,
} = require('../../push-health-check-cron');

// ─── Fake pool ──────────────────────────────────────────────────────────
// Models the small slice of push_subscriptions + push_health_run +
// push_ack_log we actually touch. Anything else falls through to a no-op
// rowCount:0 response so the cron's defensive .catch(() => {}) paths don't
// crash on unexpected SQL.
function makePool({ subscriptions = [] } = {}) {
    const subs = subscriptions.map(s => ({
        consecutive_failures: 0,
        ...s,
    }));
    const runs = [];                  // [{ run_id, ... }]
    const acks = [];                  // [{ nonce, subscription_id, run_id }]
    const calls = [];
    let nextSubId = Math.max(0, ...subs.map(s => s.id || 0)) + 1;

    function query(sql, params = []) {
        const text = String(sql).trim();
        calls.push({ sql: text, params });

        // ── SELECT active subscriptions ─────────────────────────────────
        if (text.startsWith('SELECT id, device_id, endpoint, p256dh, auth, consecutive_failures')) {
            const rows = subs
                .filter(s => s.is_active !== false)
                .map(s => ({
                    id: s.id,
                    device_id: s.device_id,
                    endpoint: s.endpoint,
                    p256dh: s.p256dh,
                    auth: s.auth,
                    consecutive_failures: s.consecutive_failures || 0,
                }));
            return Promise.resolve({ rows, rowCount: rows.length });
        }

        // ── INSERT into push_health_run ─────────────────────────────────
        if (text.startsWith('INSERT INTO push_health_run')) {
            const [run_id, started_at, sent_count, reason] = params;
            runs.push({ run_id, started_at, sent_count, reason, delivered_count: 0, acked_count_60s: 0, dead_count: 0, error_count: 0 });
            return Promise.resolve({ rows: [], rowCount: 1 });
        }

        // ── UPDATE push_health_run (finalize) ───────────────────────────
        if (text.startsWith('UPDATE push_health_run')) {
            const [finished_at, delivered, acked, dead, errors, runId] = params;
            const row = runs.find(r => r.run_id === runId);
            if (row) {
                row.finished_at = finished_at;
                row.delivered_count = delivered;
                row.acked_count_60s = acked;
                row.dead_count = dead;
                row.error_count = errors;
            }
            return Promise.resolve({ rows: [], rowCount: row ? 1 : 0 });
        }

        // ── UPDATE last_health_sent_at ──────────────────────────────────
        if (text.startsWith('UPDATE push_subscriptions') && text.includes('last_health_sent_at = $1')) {
            const [iso, subId] = params;
            const row = subs.find(s => s.id === subId);
            if (row) row.last_health_sent_at = iso;
            return Promise.resolve({ rows: [], rowCount: row ? 1 : 0 });
        }

        // ── UPDATE consecutive_failures = 0 (reset) ─────────────────────
        if (text.startsWith('UPDATE push_subscriptions') && text.includes('consecutive_failures = 0')) {
            const [iso, subId] = params;
            const row = subs.find(s => s.id === subId);
            if (row) {
                row.consecutive_failures = 0;
                row.last_health_acked_at = iso;
            }
            return Promise.resolve({ rows: [], rowCount: row ? 1 : 0 });
        }

        // ── UPDATE consecutive_failures = consecutive_failures + 1 ──────
        if (text.startsWith('UPDATE push_subscriptions') && text.includes('consecutive_failures = consecutive_failures + 1')) {
            const [subId] = params;
            const row = subs.find(s => s.id === subId);
            if (row) {
                row.consecutive_failures = (row.consecutive_failures || 0) + 1;
                return Promise.resolve({ rows: [{ consecutive_failures: row.consecutive_failures }], rowCount: 1 });
            }
            return Promise.resolve({ rows: [], rowCount: 0 });
        }

        // ── UPDATE is_active = FALSE (deactivate) ──────────────────────
        if (text.startsWith('UPDATE push_subscriptions') && text.includes('is_active = FALSE')) {
            const [iso, reason, subId] = params;
            const row = subs.find(s => s.id === subId);
            if (row) {
                row.is_active = false;
                row.deactivated_at = iso;
                row.deactivated_reason = reason;
            }
            return Promise.resolve({ rows: [], rowCount: row ? 1 : 0 });
        }

        // ── DELETE subscription by endpoint (410/404 sweep) ─────────────
        if (text.startsWith('DELETE FROM push_subscriptions')) {
            const [endpoint] = params;
            const i = subs.findIndex(s => s.endpoint === endpoint);
            if (i >= 0) {
                subs.splice(i, 1);
                return Promise.resolve({ rows: [], rowCount: 1 });
            }
            return Promise.resolve({ rows: [], rowCount: 0 });
        }

        // ── SELECT DISTINCT nonce FROM push_ack_log ─────────────────────
        if (text.startsWith('SELECT DISTINCT nonce')) {
            const [runId, nonceList] = params;
            const hits = acks.filter(a => a.run_id === runId && nonceList.includes(a.nonce));
            const unique = [...new Set(hits.map(a => a.nonce))];
            return Promise.resolve({ rows: unique.map(nonce => ({ nonce })), rowCount: unique.length });
        }

        // ── INSERT INTO kanban_cards (follow-up card) ──────────────────
        if (text.startsWith('INSERT INTO kanban_cards')) {
            return Promise.resolve({ rows: [], rowCount: 1 });
        }

        // ── SELECT counts for getDbCounts ──────────────────────────────
        if (text.includes('SUM(CASE WHEN is_active')) {
            const active = subs.filter(s => s.is_active !== false).length;
            const dead = subs.filter(s => s.is_active === false).length;
            return Promise.resolve({ rows: [{ active, dead }], rowCount: 1 });
        }

        return Promise.resolve({ rows: [], rowCount: 0 });
    }

    return {
        query,
        // Inspection helpers for tests.
        _subs: subs,
        _runs: runs,
        _acks: acks,
        _calls: calls,
        _addAck(nonce, runId, subId) {
            acks.push({ nonce, run_id: runId, subscription_id: subId });
        },
        _nextSubId: () => nextSubId++,
    };
}

function makeSubscription(id) {
    return {
        id,
        device_id: `dev-${id}`,
        endpoint: `https://push.example.com/${id}`,
        p256dh: `p256dh-${id}`,
        auth: `auth-${id}`,
        is_active: true,
    };
}

// ─── loadConfig ──────────────────────────────────────────────────────────
describe('loadConfig', () => {
    test('defaults: every-30-minute Asia/Taipei, 60s ack window, 3-fail dead', () => {
        const config = loadConfig({});
        expect(config.cron).toBe(DEFAULT_CRON);
        expect(config.timezone).toBe(DEFAULT_TIMEZONE);
        expect(config.ackWindowMs).toBe(DEFAULT_ACK_WINDOW_MS);
        expect(config.deadThreshold).toBe(DEFAULT_DEAD_THRESHOLD);
        expect(config.assignedBots).toEqual([2]);
        expect(config.priority).toBe('P1');
    });

    test('PUSH_HEALTH_CRON_ENABLED=0 disables', () => {
        const config = loadConfig({ PUSH_HEALTH_CRON_ENABLED: '0' });
        expect(config.configured).toBe(false);
        expect(config.skipReason).toBe('disabled');
    });

    test('reads cardDeviceId from PUSH_HEALTH_DEVICE_ID first, then ADMIN_DEVICE_IDS', () => {
        expect(loadConfig({ PUSH_HEALTH_DEVICE_ID: 'pri-1', ADMIN_DEVICE_IDS: 'admin-a' }).cardDeviceId).toBe('pri-1');
        expect(loadConfig({ ADMIN_DEVICE_IDS: 'admin-a,admin-b' }).cardDeviceId).toBe('admin-a');
        expect(loadConfig({}).cardConfigured).toBe(false);
    });

    test('FOLLOWUP_BOTS env override accepts CSV', () => {
        const config = loadConfig({ ADMIN_DEVICE_IDS: 'd1', PUSH_HEALTH_FOLLOWUP_BOTS: '2,4,7' });
        expect(config.assignedBots).toEqual([2, 4, 7]);
    });
});

// ─── runOnce: happy path ────────────────────────────────────────────────
describe('runOnce — single cron tick', () => {
    test('queries active subscriptions, sends one push per row, logs run row', async () => {
        const pool = makePool({ subscriptions: [makeSubscription(1), makeSubscription(2)] });
        const sent = [];
        const sendNotification = jest.fn(async (sub, payload, opts) => {
            sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), opts });
            // Auto-ack to simulate live SW returning the nonce within the window.
            const parsed = JSON.parse(payload);
            pool._addAck(parsed.nonce, parsed.runId, sub.endpoint.endsWith('/1') ? 1 : 2);
        });
        const wait = jest.fn(async () => {});  // skip the 60s wait

        const monitor = createPushHealthCheckCron({
            env: { ADMIN_DEVICE_IDS: 'dev-admin' },
            pool,
            sendNotification,
            wait,
            audit: jest.fn(),
            now: () => 1_700_000_000_000,
        });

        const result = await monitor.runOnce('test');

        // Per-subscription push fired with health payload + correct TTL/urgency.
        expect(sendNotification).toHaveBeenCalledTimes(2);
        for (const s of sent) {
            expect(s.payload.type).toBe('health');
            expect(typeof s.payload.nonce).toBe('string');
            expect(s.payload.nonce.length).toBeGreaterThan(0);
            expect(s.payload.runId).toBe(result.runId);
            expect(s.opts.TTL).toBe(60);
            expect(s.opts.urgency).toBe('very-low');
        }

        // Run row inserted + finalized.
        expect(pool._runs).toHaveLength(1);
        const run = pool._runs[0];
        expect(run.run_id).toBe(result.runId);
        expect(run.sent_count).toBe(2);
        expect(run.delivered_count).toBe(2);
        expect(run.acked_count_60s).toBe(2);
        expect(run.error_count).toBe(0);
        expect(run.dead_count).toBe(0);

        // Cron return shape matches.
        expect(result.ok).toBe(true);
        expect(result.sentCount).toBe(2);
        expect(result.deliveredCount).toBe(2);
        expect(result.ackedCount).toBe(2);

        // 60s wait was driven by the injected wait fn.
        expect(wait).toHaveBeenCalledWith(DEFAULT_ACK_WINDOW_MS);
    });

    test('subscriptions that never ack accumulate consecutive_failures and stay active until threshold', async () => {
        const pool = makePool({ subscriptions: [makeSubscription(1)] });
        // sendNotification succeeds but NO acks recorded.
        const monitor = createPushHealthCheckCron({
            env: { ADMIN_DEVICE_IDS: 'dev-admin' },
            pool,
            sendNotification: jest.fn().mockResolvedValue(undefined),
            wait: async () => {},
            audit: jest.fn(),
            now: () => Date.parse('2026-06-21T00:00:00Z'),
        });

        const r1 = await monitor.runOnce('test');
        expect(r1.ackedCount).toBe(0);
        expect(pool._subs[0].consecutive_failures).toBe(1);
        expect(pool._subs[0].is_active).not.toBe(false);

        const r2 = await monitor.runOnce('test');
        expect(pool._subs[0].consecutive_failures).toBe(2);
        expect(pool._subs[0].is_active).not.toBe(false);

        // Third failure: dead + follow-up card.
        const r3 = await monitor.runOnce('test');
        expect(pool._subs[0].consecutive_failures).toBe(3);
        expect(pool._subs[0].is_active).toBe(false);
        expect(pool._subs[0].deactivated_reason).toBe('consecutive_health_failures');
        expect(r3.followups).toHaveLength(1);
        expect(r3.followups[0].created).toBe(true);
        expect(r3.deadCount).toBeGreaterThanOrEqual(1);
        // Insert into kanban_cards happened.
        const cardInsert = pool._calls.find(c => c.sql.startsWith('INSERT INTO kanban_cards'));
        expect(cardInsert).toBeTruthy();
        expect(cardInsert.params[3]).toContain('subscription_id: 1');
        expect(cardInsert.params[6]).toBe(JSON.stringify([2]));  // assignedBots:[2] per spec
        expect(cardInsert.params[4]).toBe('P1');                  // priority
        expect(cardInsert.params[5]).toBe('todo');                // status
    });

    test('subscription that acks resets its streak even if it had previous failures', async () => {
        const pool = makePool({ subscriptions: [{ ...makeSubscription(1), consecutive_failures: 2 }] });
        const sendNotification = jest.fn(async (sub, payload) => {
            const parsed = JSON.parse(payload);
            pool._addAck(parsed.nonce, parsed.runId, 1);
        });

        const monitor = createPushHealthCheckCron({
            env: { ADMIN_DEVICE_IDS: 'dev-admin' },
            pool,
            sendNotification,
            wait: async () => {},
            audit: jest.fn(),
            now: () => Date.now(),
        });

        const result = await monitor.runOnce('test');
        expect(result.ackedCount).toBe(1);
        expect(pool._subs[0].consecutive_failures).toBe(0);
        expect(pool._subs[0].is_active).not.toBe(false);
    });

    test('410-Gone subscription is removed immediately, before ack window', async () => {
        const pool = makePool({ subscriptions: [makeSubscription(1), makeSubscription(2)] });
        const sendNotification = jest.fn(async (sub) => {
            if (sub.endpoint.endsWith('/1')) {
                const err = new Error('gone');
                err.statusCode = 410;
                throw err;
            }
            // 2 succeeds but doesn't ack
        });

        const monitor = createPushHealthCheckCron({
            env: { ADMIN_DEVICE_IDS: 'dev-admin' },
            pool,
            sendNotification,
            wait: async () => {},
            audit: jest.fn(),
            now: () => Date.now(),
        });

        const result = await monitor.runOnce('test');
        // sub 1 was removed by 410 sweep
        expect(pool._subs.find(s => s.id === 1)).toBeUndefined();
        expect(result.deadCount).toBeGreaterThanOrEqual(1);
        // sub 2 still around with failure incremented
        expect(pool._subs.find(s => s.id === 2)).toBeTruthy();
    });

    test('non-410 sendNotification error is recorded as errorCount, not a deactivation', async () => {
        const pool = makePool({ subscriptions: [makeSubscription(1)] });
        const sendNotification = jest.fn().mockRejectedValue(Object.assign(new Error('boom'), { statusCode: 500 }));

        const monitor = createPushHealthCheckCron({
            env: { ADMIN_DEVICE_IDS: 'dev-admin' },
            pool,
            sendNotification,
            wait: async () => {},
            audit: jest.fn(),
            now: () => Date.now(),
        });

        const result = await monitor.runOnce('test');
        expect(result.errorCount).toBe(1);
        expect(result.deliveredCount).toBe(0);
        // Still increments consecutive_failures since no ack.
        expect(pool._subs[0].consecutive_failures).toBe(1);
        expect(pool._subs[0].is_active).not.toBe(false);
    });
});

// ─── runOnce: skip paths ─────────────────────────────────────────────────
describe('runOnce — skip paths', () => {
    test('disabled cron returns skipped without DB access', async () => {
        const pool = makePool();
        const sendNotification = jest.fn();

        const monitor = createPushHealthCheckCron({
            env: { PUSH_HEALTH_CRON_ENABLED: '0' },
            pool,
            sendNotification,
            wait: async () => {},
            audit: jest.fn(),
            now: () => Date.now(),
        });

        const result = await monitor.runOnce('test');
        expect(result.skipped).toBe(true);
        expect(result.reason).toBe('disabled');
        expect(sendNotification).not.toHaveBeenCalled();
    });

    test('missing sendNotification skips without trying any pushes', async () => {
        const pool = makePool({ subscriptions: [makeSubscription(1)] });
        const monitor = createPushHealthCheckCron({
            env: { ADMIN_DEVICE_IDS: 'dev-admin' },
            pool,
            sendNotification: null,
            wait: async () => {},
            audit: jest.fn(),
            now: () => Date.now(),
        });

        const result = await monitor.runOnce('test');
        expect(result.skipped).toBe(true);
        expect(result.reason).toBe('sendNotification_missing');
    });

    test('zero active subscriptions: still records a run with sent_count=0', async () => {
        const pool = makePool({ subscriptions: [] });
        const sendNotification = jest.fn();

        const monitor = createPushHealthCheckCron({
            env: { ADMIN_DEVICE_IDS: 'dev-admin' },
            pool,
            sendNotification,
            wait: async () => {},
            audit: jest.fn(),
            now: () => Date.now(),
        });

        const result = await monitor.runOnce('test');
        expect(result.ok).toBe(true);
        expect(result.sentCount).toBe(0);
        expect(sendNotification).not.toHaveBeenCalled();
        expect(pool._runs[0].sent_count).toBe(0);
    });
});

// ─── startCron ──────────────────────────────────────────────────────────
describe('startCron', () => {
    test('schedules with default cron/timezone and audits the wire-up', () => {
        const schedule = jest.fn(() => ({ stop: jest.fn() }));
        const audit = jest.fn();
        const monitor = createPushHealthCheckCron({
            env: { ADMIN_DEVICE_IDS: 'dev-admin' },
            pool: makePool(),
            sendNotification: jest.fn(),
            wait: async () => {},
            audit,
            now: () => Date.now(),
        });

        monitor.startCron({ nodeCron: { schedule } });

        expect(schedule).toHaveBeenCalledWith(
            DEFAULT_CRON,
            expect.any(Function),
            { timezone: DEFAULT_TIMEZONE }
        );
        expect(audit).toHaveBeenCalledWith(
            'info',
            'push_health_check',
            expect.stringContaining('scheduled'),
            expect.objectContaining({ result: 'scheduled' })
        );
    });

    test('throws when nodeCron is missing — caller must wire it', () => {
        const monitor = createPushHealthCheckCron({
            env: { ADMIN_DEVICE_IDS: 'dev-admin' },
            pool: makePool(),
            sendNotification: jest.fn(),
            wait: async () => {},
            audit: jest.fn(),
            now: () => Date.now(),
        });
        expect(() => monitor.startCron({})).toThrow(/nodeCron/);
    });

    test('disabled env is a no-op (does not throw even without nodeCron)', () => {
        const monitor = createPushHealthCheckCron({
            env: { PUSH_HEALTH_CRON_ENABLED: '0' },
            pool: makePool(),
            sendNotification: jest.fn(),
            wait: async () => {},
            audit: jest.fn(),
            now: () => Date.now(),
        });
        expect(() => monitor.startCron({})).not.toThrow();
    });
});

// ─── getDbCounts ────────────────────────────────────────────────────────
describe('getDbCounts', () => {
    test('returns active vs dead counts from push_subscriptions', async () => {
        const pool = makePool({
            subscriptions: [
                makeSubscription(1),
                makeSubscription(2),
                { ...makeSubscription(3), is_active: false },
            ],
        });
        const monitor = createPushHealthCheckCron({
            env: { ADMIN_DEVICE_IDS: 'dev-admin' },
            pool,
            sendNotification: jest.fn(),
            wait: async () => {},
            audit: jest.fn(),
            now: () => Date.now(),
        });
        const counts = await monitor.getDbCounts();
        expect(counts).toEqual({ activeSubscriptions: 2, deadSubscriptions: 1 });
    });
});

// ─── describeDeadSubscription ───────────────────────────────────────────
describe('describeDeadSubscription', () => {
    test('renders endpoint + consecutive failure count + triage steps', () => {
        const desc = describeDeadSubscription({
            id: 42,
            deviceId: 'dev-x',
            endpoint: 'https://push.example.com/very/long/endpoint/abc123',
            consecutiveFailures: 5,
            threshold: 3,
            deactivatedAtIso: '2026-06-21T08:00:00Z',
        });
        expect(desc).toContain('subscription_id: 42');
        expect(desc).toContain('device_id: dev-x');
        expect(desc).toContain('5 consecutive');
        expect(desc).toContain('≥3 required');
        expect(desc).toContain('https://push.example.com/very/long/endpoint/abc123');
        expect(desc).toMatch(/Triage:/);
    });
});

// ─── /api/push/ack route — supertest against the real express app ──────
describe('POST /api/push/ack — route wiring', () => {
    let app;
    let request;
    let chatPoolMock;

    beforeAll(() => {
        require('./helpers/mock-setup');
        request = require('supertest');
        // The route uses chatPool directly; mock-setup stubs the `pg` Pool to
        // return rows:[],rowCount:0 — that's enough for happy-path 200, but
        // we also assert that the route validates inputs (400 paths). For
        // attribution to the most-recent run we'd want a real run row; we
        // don't need it for the supertest layer since the cron logic itself
        // is unit-tested above.
        app = require('../../index');
    });

    afterAll(async () => {
        try {
            const { httpServer } = require('../../index');
            await new Promise(resolve => httpServer.close(resolve));
        } catch (_) { /* server may already be closed */ }
        jest.resetModules();
    });

    function post(path) {
        return request(app).post(path).set('Host', 'localhost');
    }

    test('rejects empty/missing nonce with 400', async () => {
        const res = await post('/api/push/ack').send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/nonce/i);
    });

    test('rejects nonce longer than 64 chars', async () => {
        const longNonce = 'a'.repeat(65);
        const res = await post('/api/push/ack').send({ nonce: longNonce });
        expect(res.status).toBe(400);
    });

    test('accepts a well-formed ack and returns success', async () => {
        const res = await post('/api/push/ack').send({
            nonce: 'abc123nonce',
            runId: 'run_deadbeef00000000',
            subscriptionId: 42,
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    test('ignores non-integer subscriptionId without erroring', async () => {
        const res = await post('/api/push/ack').send({
            nonce: 'another-nonce',
            subscriptionId: 'not-a-number',
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});
