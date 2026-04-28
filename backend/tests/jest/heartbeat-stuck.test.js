/**
 * Phase H1.2 — heartbeat / delivery-stuck detection.
 *
 * Hermes [回應超時] recurred 2026-04-28 because there was no server-side signal
 * for "queue has items but daemon hasn't drained recently" — the only alert was
 * a sibling bot complaining downstream. This locks in the threshold and the
 * findStuckEntities() shape so /api/health can't quietly drift.
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
const findStuck = app._findStuckEntities;
const STUCK_MS = app._HEARTBEAT_STUCK_MS;
const enqueue = app._enqueueMessage;
const devices = app.devices;

function clearDevices() {
    for (const k of Object.keys(devices)) delete devices[k];
}

describe('Phase H1.2 — findStuckEntities', () => {
    afterEach(clearDevices);

    test('exposes the documented threshold (90s)', () => {
        expect(STUCK_MS).toBe(90_000);
    });

    test('empty devices map → no stuck entities', () => {
        clearDevices();
        expect(findStuck()).toEqual([]);
    });

    test('bound bot with mq>0 + recent drain → NOT stuck', () => {
        clearDevices();
        const now = Date.now();
        const bot = {
            entityId: 5, isBound: true, character: 'HERMES',
            messageQueue: [{ text: 'pending' }],
            lastDrainedAt: now - 10_000, // drained 10s ago — alive
        };
        devices['dev-1'] = { entities: { 5: bot } };
        expect(findStuck(now)).toEqual([]);
    });

    test('bound bot with mq>0 + stale drain → STUCK', () => {
        clearDevices();
        const now = Date.now();
        const bot = {
            entityId: 5, isBound: true, character: 'HERMES',
            messageQueue: [{ text: 'queued-1' }, { text: 'queued-2' }],
            lastEnqueuedAt: now - 120_000,
            lastDrainedAt: now - 120_000, // 120s > 90s threshold
        };
        devices['dev-2'] = { entities: { 5: bot } };
        const stuck = findStuck(now);
        expect(stuck).toHaveLength(1);
        expect(stuck[0]).toMatchObject({
            deviceId: 'dev-2',
            entityId: 5,
            character: 'HERMES',
            mqLen: 2,
        });
        expect(stuck[0].idleMs).toBeGreaterThanOrEqual(STUCK_MS);
    });

    test('unbound entity is ignored even if mq stale', () => {
        clearDevices();
        const now = Date.now();
        const ghost = {
            entityId: 9, isBound: false,
            messageQueue: [{ text: 'orphan' }],
            lastDrainedAt: now - 600_000,
        };
        devices['dev-3'] = { entities: { 9: ghost } };
        expect(findStuck(now)).toEqual([]);
    });

    test('bot that has never drained falls back to lastEnqueuedAt for staleness', () => {
        clearDevices();
        const now = Date.now();
        const newbie = {
            entityId: 7, isBound: true, character: 'NEWBOT',
            messageQueue: [{ text: 'first' }],
            lastDrainedAt: null,
            lastEnqueuedAt: now - 200_000,
        };
        devices['dev-4'] = { entities: { 7: newbie } };
        const stuck = findStuck(now);
        expect(stuck).toHaveLength(1);
        expect(stuck[0].lastDrainedAt).toBeNull();
        expect(stuck[0].idleMs).toBeGreaterThanOrEqual(STUCK_MS);
    });

    test('enqueueMessage stamps lastEnqueuedAt', () => {
        const ent = { entityId: 5, isBound: true, messageQueue: [], deadLetterQueue: [] };
        const before = Date.now();
        enqueue(ent, { text: 'hello' }, 'unit_test');
        expect(ent.lastEnqueuedAt).toBeGreaterThanOrEqual(before);
    });

    test('multiple stuck bots all surface', () => {
        clearDevices();
        const now = Date.now();
        devices['dev-5'] = {
            entities: {
                5: {
                    entityId: 5, isBound: true, character: 'HERMES',
                    messageQueue: [{}, {}, {}],
                    lastDrainedAt: now - 95_000,
                },
                6: {
                    entityId: 6, isBound: true, character: 'OPENBOT',
                    messageQueue: [{}],
                    lastDrainedAt: now - 91_000,
                },
                7: {
                    entityId: 7, isBound: true, character: 'ALIVE',
                    messageQueue: [{}],
                    lastDrainedAt: now - 5_000, // healthy
                },
            },
        };
        const stuck = findStuck(now);
        const ids = stuck.map(s => s.entityId).sort();
        expect(ids).toEqual([5, 6]);
    });
});
