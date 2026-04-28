/**
 * Phase H1.1 — messageQueue cap + dead-letter buffer.
 *
 * Hermes [回應超時] recurred 2026-04-28 (mqLen=1349 observed earlier) because
 * per-entity messageQueue grew unbounded. This locks in the cap so the next
 * fan-out can't silently stall the bridge.
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
const enqueue = app._enqueueMessage;
const QUEUE_CAP = app._MESSAGE_QUEUE_CAP;
const DLQ_CAP = app._DEAD_LETTER_CAP;
const createDefaultEntity = app._createDefaultEntity;
const clampQueuesOnLoad = app._clampQueuesOnLoad;
const devices = app.devices;

describe('Phase H1.1 — enqueueMessage cap + DLQ', () => {
    test('exposes the documented caps (200 / 50)', () => {
        expect(QUEUE_CAP).toBe(200);
        expect(DLQ_CAP).toBe(50);
    });

    test('default entity factory initialises both queues empty', () => {
        const ent = createDefaultEntity(7);
        expect(ent.messageQueue).toEqual([]);
        expect(ent.deadLetterQueue).toEqual([]);
    });

    test('queue stays clamped at cap; oldest spills to DLQ', () => {
        const ent = createDefaultEntity(5);
        for (let i = 0; i < QUEUE_CAP + 10; i++) {
            enqueue(ent, { text: `msg-${i}`, timestamp: i }, 'unit_test');
        }
        expect(ent.messageQueue.length).toBe(QUEUE_CAP);
        // Oldest 10 spilled into DLQ
        expect(ent.deadLetterQueue.length).toBe(10);
        // First DLQ entry is the very first message pushed
        expect(ent.deadLetterQueue[0].text).toBe('msg-0');
        expect(ent.deadLetterQueue[0].droppedReason).toBe('queue_overflow');
        expect(ent.deadLetterQueue[0].droppedCtx).toBe('unit_test');
        // mq head is the (QUEUE_CAP+1)th item we sent: msg-10
        expect(ent.messageQueue[0].text).toBe('msg-10');
    });

    test('DLQ itself is bounded — only the most recent DEAD_LETTER_CAP overflows survive', () => {
        const ent = createDefaultEntity(9);
        const total = QUEUE_CAP + DLQ_CAP + 25;
        for (let i = 0; i < total; i++) {
            enqueue(ent, { text: `msg-${i}` }, 'flood');
        }
        expect(ent.messageQueue.length).toBe(QUEUE_CAP);
        expect(ent.deadLetterQueue.length).toBe(DLQ_CAP);
        // DLQ keeps the LATEST drops, not the earliest — earliest are dropped wholesale.
        const firstDlq = ent.deadLetterQueue[0].text;
        const lastDlq = ent.deadLetterQueue[DLQ_CAP - 1].text;
        // First surviving DLQ entry index = total - QUEUE_CAP - DLQ_CAP
        expect(firstDlq).toBe(`msg-${total - QUEUE_CAP - DLQ_CAP}`);
        // Last DLQ entry index = total - QUEUE_CAP - 1
        expect(lastDlq).toBe(`msg-${total - QUEUE_CAP - 1}`);
    });

    test('skips work safely if entity is missing', () => {
        expect(() => enqueue(null, { text: 'x' }, 'noop')).not.toThrow();
        expect(() => enqueue(undefined, { text: 'x' }, 'noop')).not.toThrow();
    });

    test('lazy-initialises queues if entity arrived without them (legacy data)', () => {
        const ent = { entityId: 1 };
        enqueue(ent, { text: 'first' }, 'legacy');
        expect(ent.messageQueue).toEqual([{ text: 'first' }]);
        expect(ent.deadLetterQueue).toEqual([]);
    });

    test('clampQueuesOnLoad trims pre-cap legacy state from devices map', () => {
        // Stash + clear so we don't pollute prod-shape singleton between asserts.
        const snapshot = { ...devices };
        for (const k of Object.keys(devices)) delete devices[k];

        const overflowEntity = { entityId: 42, messageQueue: [], deadLetterQueue: [] };
        for (let i = 0; i < QUEUE_CAP + 500; i++) {
            overflowEntity.messageQueue.push({ text: `legacy-${i}` });
        }
        const dlqOverflow = { entityId: 43, messageQueue: [], deadLetterQueue: [] };
        for (let i = 0; i < DLQ_CAP + 20; i++) {
            dlqOverflow.deadLetterQueue.push({ text: `dlq-${i}` });
        }
        devices['fake-device'] = { entities: { 42: overflowEntity, 43: dlqOverflow } };

        clampQueuesOnLoad();

        expect(overflowEntity.messageQueue.length).toBe(QUEUE_CAP);
        // Oldest 500 are dropped wholesale (no DLQ promotion — they're pre-fix legacy)
        expect(overflowEntity.messageQueue[0].text).toBe('legacy-500');
        expect(overflowEntity.deadLetterQueue.length).toBe(0);

        expect(dlqOverflow.deadLetterQueue.length).toBe(DLQ_CAP);
        expect(dlqOverflow.deadLetterQueue[0].text).toBe('dlq-20');

        // Restore
        for (const k of Object.keys(devices)) delete devices[k];
        Object.assign(devices, snapshot);
    });
});
