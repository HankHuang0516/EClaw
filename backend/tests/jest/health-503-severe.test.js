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
const SEVERE_MIN = app._SEVERE_STUCK_MIN_COUNT;

// Helper: synth a stuck entity that USED to drain (lastDrainedAt non-null).
// These count toward severe. Pre-H1.2 ghost entries (lastDrainedAt=null) do NOT.
function alive(entityId, idleMs) {
    return { entityId, idleMs, lastDrainedAt: Date.now() - idleMs };
}
function ghost(entityId, idleMs) {
    return { entityId, idleMs, lastDrainedAt: null };
}

describe('Phase H1.5 — evaluateDeliveryHealth severity gate', () => {
    test('exposes documented thresholds (severe=300s, grace=180s, minCount=5)', () => {
        expect(SEVERE_MS).toBe(300_000);
        expect(GRACE_MS).toBe(180_000);
        expect(SEVERE_MIN).toBe(5);
        // Severe must be strictly greater than the H1.2 alert threshold,
        // otherwise we'd 503 on every alert and thrash.
        expect(SEVERE_MS).toBeGreaterThan(HEARTBEAT_MS);
    });

    test('empty stuck list → not severe regardless of uptime', () => {
        const r = evaluate([], 999_999_999);
        expect(r.severe).toBe(false);
        expect(r.stuckCount).toBe(0);
        expect(r.severeStuckCount).toBe(0);
        expect(r.oldestIdleMs).toBe(0);
    });

    test('5+ alive bots stopped past grace → severe (triggers 503)', () => {
        const list = [1, 2, 3, 4, 5].map(id => alive(id, 6 * 60 * 1000));
        const r = evaluate(list, 10 * 60 * 1000);
        expect(r.severeStuckCount).toBe(5);
        expect(r.severe).toBe(true);
    });

    test('4 alive bots stopped past grace → NOT severe (under min count)', () => {
        const list = [1, 2, 3, 4].map(id => alive(id, 6 * 60 * 1000));
        const r = evaluate(list, 10 * 60 * 1000);
        expect(r.severeStuckCount).toBe(4);
        expect(r.severe).toBe(false);
    });

    test('one alive bot stopped past grace → NOT severe (one orphan ≠ daemon dead)', () => {
        const r = evaluate([alive(5, 6 * 60 * 1000)], 10 * 60 * 1000);
        expect(r.severe).toBe(false);
    });

    test('mildly stuck (idle 90s–5min) → NOT severe even with many entries', () => {
        const list = [1, 2, 3, 4, 5, 6].map(id => alive(id, 120_000));
        const r = evaluate(list, 10 * 60 * 1000);
        expect(r.severeStuckCount).toBe(0);
        expect(r.severe).toBe(false);
        expect(r.stuckCount).toBe(6);
    });

    test('severe-eligible state but uptime within grace → NOT severe', () => {
        const list = [1, 2, 3, 4, 5, 6].map(id => alive(id, 6 * 60 * 1000));
        const r = evaluate(list, 60_000);
        expect(r.severe).toBe(false);
    });

    test('1000 ghost bots (lastDrainedAt=null) past grace → NOT severe', () => {
        // The exact prod scenario that triggered this hotfix: pre-H1.2 historical
        // queues with no drain stamps. Must never auto-restart on these.
        const list = Array.from({ length: 1000 }, (_, i) => ghost(i, 6 * 60 * 1000));
        const r = evaluate(list, 10 * 60 * 1000);
        expect(r.severeStuckCount).toBe(0);
        expect(r.severe).toBe(false);
        expect(r.stuckCount).toBe(1000);
    });

    test('mixed: 4 alive stopped + 100 ghosts → still NOT severe (alive < min)', () => {
        const list = [
            ...[1, 2, 3, 4].map(id => alive(id, 6 * 60 * 1000)),
            ...Array.from({ length: 100 }, (_, i) => ghost(100 + i, 6 * 60 * 1000)),
        ];
        const r = evaluate(list, 10 * 60 * 1000);
        expect(r.severeStuckCount).toBe(4);
        expect(r.severe).toBe(false);
    });

    test('mixed: 5 alive stopped + 100 ghosts → severe (alive crosses min)', () => {
        const list = [
            ...[1, 2, 3, 4, 5].map(id => alive(id, 6 * 60 * 1000)),
            ...Array.from({ length: 100 }, (_, i) => ghost(100 + i, 6 * 60 * 1000)),
        ];
        const r = evaluate(list, 10 * 60 * 1000);
        expect(r.severeStuckCount).toBe(5);
        expect(r.severe).toBe(true);
    });

    test('idleMs == SEVERE_STUCK_MS → not severe (strict >)', () => {
        const list = Array.from({ length: 10 }, (_, i) => alive(i, SEVERE_MS));
        const r = evaluate(list, 10 * 60 * 1000);
        expect(r.severeStuckCount).toBe(0);
        expect(r.severe).toBe(false);
    });

    test('idleMs == SEVERE_STUCK_MS + 1 with 5+ alive → severe', () => {
        const list = Array.from({ length: 5 }, (_, i) => alive(i, SEVERE_MS + 1));
        const r = evaluate(list, 10 * 60 * 1000);
        expect(r.severeStuckCount).toBe(5);
        expect(r.severe).toBe(true);
    });

    test('uptimeMs == HEALTH_BOOT_GRACE_MS → not severe yet (strict >)', () => {
        const list = Array.from({ length: 5 }, (_, i) => alive(i, 6 * 60 * 1000));
        const r = evaluate(list, GRACE_MS);
        expect(r.severe).toBe(false);
    });

    test('returns oldestIdleMs of the worst entity (alive OR ghost)', () => {
        const r = evaluate(
            [
                alive(5, 100_000),
                ghost(6, 700_000), // worst — ghost still counted for oldestIdleMs (observability)
                alive(7, 200_000),
            ],
            10 * 60 * 1000,
        );
        expect(r.oldestIdleMs).toBe(700_000);
        expect(r.stuckCount).toBe(3);
        expect(r.severeStuckCount).toBe(0); // none alive past 5min
        expect(r.severe).toBe(false);
    });

    test('response shape includes all documented threshold fields', () => {
        const r = evaluate([], 0);
        expect(r).toEqual(expect.objectContaining({
            stuckThresholdMs: HEARTBEAT_MS,
            severeThresholdMs: SEVERE_MS,
            severeMinCount: SEVERE_MIN,
            bootGraceMs: GRACE_MS,
            stuckCount: 0,
            severeStuckCount: 0,
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
