/**
 * Phase H1.5 — /api/health → 503 → Railway auto-restart on severe stuck.
 *
 * railway.json already has healthcheckPath=/api/health + restartPolicyType=ON_FAILURE.
 * H1.5 makes the endpoint return 503 only when (a) at least one entity has been
 * idle past SEVERE_STUCK_MS AND (b) we're past HEALTH_BOOT_GRACE_MS — to avoid
 * a crashloop where DB-loaded stale state trips immediate 503 → kill → repeat.
 */

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

jest.mock('../../db', () => ({
    initDatabase: jest.fn().mockResolvedValue(true),
    saveDeviceData: jest.fn().mockResolvedValue(true),
    saveAllDevices: jest.fn().mockResolvedValue(true),
    loadAllDevices: jest.fn().mockResolvedValue({}),
    deleteDevice: jest.fn().mockResolvedValue(true),
    getStats: jest.fn().mockResolvedValue({}),
    closeDatabase: jest.fn().mockResolvedValue(undefined),
    saveOfficialBot: jest.fn().mockResolvedValue(true),
    loadOfficialBots: jest.fn().mockResolvedValue({}),
    deleteOfficialBot: jest.fn().mockResolvedValue(true),
    loadSubscriptions: jest.fn().mockResolvedValue({}),
    saveSubscription: jest.fn().mockResolvedValue(true),
    pool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
}));

const app = require('../../index');
const evaluate = app._evaluateDeliveryHealth;
const SEVERE_MS = app._SEVERE_STUCK_MS;
const GRACE_MS = app._HEALTH_BOOT_GRACE_MS;
const HEARTBEAT_MS = app._HEARTBEAT_STUCK_MS;

describe('Phase H1.5 — evaluateDeliveryHealth severity gate', () => {
    test('exposes documented thresholds (severe=300s, grace=180s)', () => {
        expect(SEVERE_MS).toBe(300_000);
        expect(GRACE_MS).toBe(180_000);
        // Severe must be strictly greater than the H1.2 alert threshold,
        // otherwise we'd 503 on every alert and thrash.
        expect(SEVERE_MS).toBeGreaterThan(HEARTBEAT_MS);
    });

    test('empty stuck list → not severe regardless of uptime', () => {
        const r = evaluate([], 999_999_999);
        expect(r.severe).toBe(false);
        expect(r.stuckCount).toBe(0);
        expect(r.oldestIdleMs).toBe(0);
    });

    test('single mildly-stuck entity (idle > 90s, ≤ 5min) → NOT severe', () => {
        const r = evaluate(
            [{ entityId: 5, idleMs: 120_000 }],
            10 * 60 * 1000, // 10 min uptime — well past grace
        );
        expect(r.severe).toBe(false);
        expect(r.oldestIdleMs).toBe(120_000);
        expect(r.stuckCount).toBe(1);
    });

    test('severely stuck entity but uptime within grace → NOT severe', () => {
        const r = evaluate(
            [{ entityId: 5, idleMs: 600_000 }], // 10min idle
            60_000, // only 60s uptime — still warming up
        );
        expect(r.severe).toBe(false);
    });

    test('severely stuck entity past grace → severe (triggers 503)', () => {
        const r = evaluate(
            [{ entityId: 5, idleMs: 6 * 60 * 1000 }], // 6 min idle
            10 * 60 * 1000, // 10 min uptime
        );
        expect(r.severe).toBe(true);
        expect(r.oldestIdleMs).toBe(6 * 60 * 1000);
    });

    test('idleMs == SEVERE_STUCK_MS → not severe (strict >)', () => {
        const r = evaluate(
            [{ entityId: 5, idleMs: SEVERE_MS }],
            10 * 60 * 1000,
        );
        expect(r.severe).toBe(false);
    });

    test('idleMs == SEVERE_STUCK_MS + 1 → severe', () => {
        const r = evaluate(
            [{ entityId: 5, idleMs: SEVERE_MS + 1 }],
            10 * 60 * 1000,
        );
        expect(r.severe).toBe(true);
    });

    test('uptimeMs == HEALTH_BOOT_GRACE_MS → not severe yet (strict >)', () => {
        const r = evaluate(
            [{ entityId: 5, idleMs: 6 * 60 * 1000 }],
            GRACE_MS,
        );
        expect(r.severe).toBe(false);
    });

    test('returns oldestIdleMs of the worst stuck entity, not first', () => {
        const r = evaluate(
            [
                { entityId: 5, idleMs: 100_000 },
                { entityId: 6, idleMs: 700_000 }, // worst — should win
                { entityId: 7, idleMs: 200_000 },
            ],
            10 * 60 * 1000,
        );
        expect(r.oldestIdleMs).toBe(700_000);
        expect(r.severe).toBe(true);
        expect(r.stuckCount).toBe(3);
    });

    test('response shape includes all documented threshold fields', () => {
        const r = evaluate([], 0);
        expect(r).toEqual(expect.objectContaining({
            stuckThresholdMs: HEARTBEAT_MS,
            severeThresholdMs: SEVERE_MS,
            bootGraceMs: GRACE_MS,
            stuckCount: 0,
            oldestIdleMs: 0,
            severe: false,
        }));
    });
});

describe('Phase H1.5 — /api/health HTTP integration', () => {
    let request;
    beforeAll(() => {
        request = require('supertest');
    });

    test('healthy state → 200 with delivery.severe === false', async () => {
        const res = await request(app).get('/api/health');
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ok');
        expect(res.body.delivery.severe).toBe(false);
        expect(res.body.delivery.severeThresholdMs).toBe(SEVERE_MS);
        expect(res.body.delivery.bootGraceMs).toBe(GRACE_MS);
    });
});
