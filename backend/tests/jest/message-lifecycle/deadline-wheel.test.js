/**
 * Tests for the MessageLifecycle Phase 2 Step 2 deliverables:
 *   - backend/lib/message-lifecycle/deadline-wheel.js
 *   - backend/lib/message-lifecycle/sweeper.js
 *   - backend/lib/message-lifecycle/cold-start.js
 *
 * Card: card_545ce5986b9c1332315ba303.
 * Spec: docs/specs/message-lifecycle-spec.md §4 + §9.9.
 *
 * The wheel runs against an in-memory ZSET stub (see createInMemoryClient in
 * deadline-wheel.js). The stub is the same shape ioredis exposes, so the
 * suite locks the contract that production Redis must honor.
 */

const {
    createWheel,
    createInMemoryClient,
    createSweeper,
    runColdStart,
    deadlinesKey,
    DEFAULT_KEY_PREFIX,
} = require('../../../lib/message-lifecycle');

describe('deadline-wheel.createWheel', () => {
    let client;
    let wheel;

    beforeEach(() => {
        client = createInMemoryClient();
        wheel = createWheel({ redisClient: client });
    });

    test('schedule + popDue returns due ids in FIFO-by-deadline order', async () => {
        // Three deadlines, intentionally scheduled out of chronological order.
        await wheel.schedule('m_third', 3000);
        await wheel.schedule('m_first', 1000);
        await wheel.schedule('m_second', 2000);

        // now=2500ms should pop the two earliest, leaving m_third.
        const due = await wheel.popDue(2500);
        expect(due).toEqual(['m_first', 'm_second']);

        // Subsequent popDue at the same cutoff returns empty — the same id
        // is never popped twice (at-least-once contract; the spec §4.3
        // dedup is upstream of the wheel).
        const again = await wheel.popDue(2500);
        expect(again).toEqual([]);

        // m_third still in the wheel until its score is in range.
        expect(await wheel.size()).toBe(1);
        const final = await wheel.popDue(5000);
        expect(final).toEqual(['m_third']);
        expect(await wheel.size()).toBe(0);
    });

    test('cancel removes a message from the wheel', async () => {
        await wheel.schedule('m_a', 1000);
        await wheel.schedule('m_b', 2000);
        expect(await wheel.size()).toBe(2);

        const removed = await wheel.cancel('m_a');
        expect(removed).toBe(1);
        expect(await wheel.size()).toBe(1);

        // popDue past both original deadlines should only return m_b.
        const due = await wheel.popDue(5000);
        expect(due).toEqual(['m_b']);
    });

    test('cancel of unknown id is a no-op (returns 0)', async () => {
        const removed = await wheel.cancel('never_scheduled');
        expect(removed).toBe(0);
    });

    test('requeue updates an existing deadline to a later score', async () => {
        await wheel.schedule('m_x', 1000);
        // popDue at 1500 would normally pop m_x; requeue first to 5000.
        await wheel.requeue('m_x', 5000);

        const tooEarly = await wheel.popDue(1500);
        expect(tooEarly).toEqual([]);

        const later = await wheel.popDue(5500);
        expect(later).toEqual(['m_x']);
    });

    test('requeue updates an existing deadline to an earlier score', async () => {
        await wheel.schedule('m_y', 9999);
        await wheel.requeue('m_y', 100);
        const due = await wheel.popDue(200);
        expect(due).toEqual(['m_y']);
    });

    test('popDue honors maxBatch cap', async () => {
        for (let i = 0; i < 10; i++) {
            await wheel.schedule(`m_${i}`, i + 1);
        }
        const first = await wheel.popDue(100, 3);
        expect(first).toHaveLength(3);
        expect(first).toEqual(['m_0', 'm_1', 'm_2']);
        const rest = await wheel.popDue(100, 100);
        expect(rest).toHaveLength(7);
    });

    test('schedule rejects null / undefined / empty message ids', async () => {
        await expect(wheel.schedule(null, 1)).rejects.toThrow(/messageId/);
        await expect(wheel.schedule(undefined, 1)).rejects.toThrow(/messageId/);
        await expect(wheel.schedule('', 1)).rejects.toThrow(/messageId/);
    });

    test('schedule rejects non-finite deadlines', async () => {
        await expect(wheel.schedule('m', NaN)).rejects.toThrow(/deadline/);
        await expect(wheel.schedule('m', Infinity)).rejects.toThrow(/deadline/);
        await expect(wheel.schedule('m', 'soon')).rejects.toThrow(/deadline/);
    });

    test('disabled wheel (no Redis) logs once + becomes no-op', async () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const off = createWheel({});
        expect(off.enabled).toBe(false);
        await off.schedule('m', 1);
        await off.requeue('m', 2);
        expect(await off.popDue(99)).toEqual([]);
        expect(await off.cancel('m')).toBe(0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/REDIS_URL not set/);
        warn.mockRestore();
    });

    test('integration smoke: 3 deadlines, time advances, popDue returns in order', async () => {
        // Spec acceptance per dispatch — verifies the wheel's promise that
        // it pops earliest-first as wall time moves forward.
        const ids = ['alpha', 'beta', 'gamma'];
        const deadlines = [1000, 2000, 3000];
        await Promise.all(ids.map((id, i) => wheel.schedule(id, deadlines[i])));

        expect(await wheel.popDue(500)).toEqual([]);
        expect(await wheel.popDue(1500)).toEqual(['alpha']);
        expect(await wheel.popDue(2500)).toEqual(['beta']);
        expect(await wheel.popDue(3500)).toEqual(['gamma']);
        expect(await wheel.size()).toBe(0);
    });

    test('deadlinesKey + DEFAULT_KEY_PREFIX are exported for downstream wiring', () => {
        // Step 3 dual-write needs the same key prefix to reach the same ZSET.
        expect(DEFAULT_KEY_PREFIX).toBe('ml');
        expect(deadlinesKey('ml')).toBe('ml:deadlines');
        expect(deadlinesKey('custom')).toBe('custom:deadlines');
    });
});

describe('sweeper.createSweeper', () => {
    let client;
    let wheel;

    beforeEach(() => {
        client = createInMemoryClient();
        wheel = createWheel({ redisClient: client });
    });

    test('_tickOnce hands each due id to the onDue handler', async () => {
        await wheel.schedule('m_a', 100);
        await wheel.schedule('m_b', 200);
        await wheel.schedule('m_z', 9999);

        const seen = [];
        const sweeper = createSweeper({
            wheel,
            onDue: async (id) => { seen.push(id); },
            now: () => 500,
        });
        await sweeper._tickOnce();
        expect(seen).toEqual(['m_a', 'm_b']);

        // m_z still in the wheel.
        expect(await wheel.size()).toBe(1);
    });

    test('onDue handler error does not wedge the loop', async () => {
        await wheel.schedule('m_bad', 100);
        await wheel.schedule('m_good', 200);

        const seen = [];
        const errors = [];
        const sweeper = createSweeper({
            wheel,
            now: () => 1000,
            onDue: async (id) => {
                seen.push(id);
                if (id === 'm_bad') throw new Error('boom');
            },
            logError: (msg, err) => errors.push({ msg, err: err && err.message }),
        });
        await sweeper._tickOnce();
        expect(seen).toEqual(['m_bad', 'm_good']);
        expect(errors).toHaveLength(1);
        expect(errors[0].err).toBe('boom');
    });

    test('LIFECYCLE_SWEEP_INTERVAL_MS env override', () => {
        const prev = process.env.LIFECYCLE_SWEEP_INTERVAL_MS;
        try {
            process.env.LIFECYCLE_SWEEP_INTERVAL_MS = '2500';
            const s = createSweeper({ wheel, onDue: async () => {} });
            expect(s.intervalMs).toBe(2500);
        } finally {
            if (prev === undefined) delete process.env.LIFECYCLE_SWEEP_INTERVAL_MS;
            else process.env.LIFECYCLE_SWEEP_INTERVAL_MS = prev;
        }
    });

    test('invalid env falls back to default 5000', () => {
        const prev = process.env.LIFECYCLE_SWEEP_INTERVAL_MS;
        try {
            process.env.LIFECYCLE_SWEEP_INTERVAL_MS = 'banana';
            const s = createSweeper({ wheel, onDue: async () => {} });
            expect(s.intervalMs).toBe(5000);
        } finally {
            if (prev === undefined) delete process.env.LIFECYCLE_SWEEP_INTERVAL_MS;
            else process.env.LIFECYCLE_SWEEP_INTERVAL_MS = prev;
        }
    });

    test('createSweeper validates required options', () => {
        expect(() => createSweeper(null)).toThrow();
        expect(() => createSweeper({ wheel })).toThrow(/onDue/);
        expect(() => createSweeper({ onDue: () => {} })).toThrow(/wheel/);
    });

    test('start / stop lifecycle', async () => {
        const sweeper = createSweeper({ wheel, onDue: async () => {}, intervalMs: 60_000 });
        sweeper.start();
        expect(sweeper.isRunning).toBe(true);
        await sweeper.stop();
        expect(sweeper.isRunning).toBe(false);
    });
});

describe('cold-start.runColdStart (spec §9.9 — Redis lost → restart)', () => {
    function makeFakePool(rowsByCursor) {
        return {
            calls: [],
            async query(sql, params) {
                this.calls.push({ sql, params: [...params] });
                const cursor = params[1] !== undefined
                    ? `${params[1].toISOString()}|${params[2]}`
                    : '__head__';
                const rows = rowsByCursor[cursor] || [];
                // Honor LIMIT (params[0]).
                return { rows: rows.slice(0, params[0]) };
            },
        };
    }

    test('§9.9: simulate Redis lost → restart → wheel restored from DB', async () => {
        // Two rows would have been in the wheel before Redis was flushed.
        const rows = [
            {
                message_id: 'msg_inbound_old',
                state: 'inbound_seen',
                inbound_seen_at: new Date('2026-01-01T00:00:00Z'),
                bot_acked_at: null,
                push_delivered_at: null,
            },
            {
                message_id: 'msg_bot_acked_old',
                state: 'bot_acked',
                inbound_seen_at: new Date('2026-01-01T00:00:30Z'),
                bot_acked_at: new Date('2026-01-01T00:00:45Z'),
                push_delivered_at: null,
            },
        ];
        const pool = makeFakePool({ __head__: rows });

        const client = createInMemoryClient();
        const wheel = createWheel({ redisClient: client });
        expect(await wheel.size()).toBe(0); // Redis was flushed

        const result = await runColdStart({
            wheel,
            pool,
            now: () => new Date('2026-01-01T00:30:00Z').getTime(),
            log: () => {},
        });

        expect(result.scanned).toBe(2);
        expect(result.scheduled).toBe(2);
        // Wheel now has both stale rows re-armed.
        expect(await wheel.size()).toBe(2);

        // popDue at "now" pops every re-armed row whose deadline is in the
        // past — verifying the §9.9 contract that alerts which would have
        // fired during the outage emit on the first post-restart sweep.
        const due = await wheel.popDue(new Date('2026-01-01T00:30:00Z').getTime());
        expect(due.sort()).toEqual(['msg_bot_acked_old', 'msg_inbound_old']);
    });

    test('paginates beyond a single page (globe-user generalization)', async () => {
        // Three pages: 2 + 2 + 1 rows. Page size = 2 forces real keyset
        // pagination via the cursor params.
        const page1 = [
            mkRow('m1', 'inbound_seen', '2026-01-01T00:00:00Z'),
            mkRow('m2', 'inbound_seen', '2026-01-01T00:00:01Z'),
        ];
        const page2 = [
            mkRow('m3', 'bot_acked', '2026-01-01T00:00:02Z'),
            mkRow('m4', 'push_delivered', '2026-01-01T00:00:03Z'),
        ];
        const page3 = [
            mkRow('m5', 'inbound_seen', '2026-01-01T00:00:04Z'),
        ];

        const rowsByCursor = {
            __head__: page1,
            [`${page1[1].inbound_seen_at.toISOString()}|m2`]: page2,
            [`${page2[1].inbound_seen_at.toISOString()}|m4`]: page3,
        };
        const pool = makeFakePool(rowsByCursor);

        const wheel = createWheel({ redisClient: createInMemoryClient() });
        const result = await runColdStart({
            wheel,
            pool,
            pageSize: 2,
            now: () => Date.parse('2026-01-01T01:00:00Z'),
            log: () => {},
        });

        expect(result.pages).toBe(3);
        expect(result.scanned).toBe(5);
        expect(result.scheduled).toBe(5);
        expect(await wheel.size()).toBe(5);
        // First page query has no cursor params (pageSize only).
        expect(pool.calls[0].params).toHaveLength(1);
        // Subsequent pages have keyset (pageSize, cursorTs, cursorId).
        expect(pool.calls[1].params).toHaveLength(3);
        expect(pool.calls[1].params[2]).toBe('m2');
        expect(pool.calls[2].params[2]).toBe('m4');
    });

    test('skips user_seen rows via the SQL WHERE clause', async () => {
        const pool = makeFakePool({ __head__: [] });
        const wheel = createWheel({ redisClient: createInMemoryClient() });
        const result = await runColdStart({ wheel, pool, log: () => {} });
        // Verify the WHERE excludes user_seen + lists the three live states.
        expect(pool.calls[0].sql).toMatch(/state IN \('inbound_seen', 'bot_acked', 'push_delivered'\)/);
        expect(pool.calls[0].sql).not.toMatch(/user_seen/);
        expect(result.scanned).toBe(0);
    });

    test('returns early when wheel is disabled (no Redis)', async () => {
        const pool = {
            calls: [],
            async query(sql, params) {
                this.calls.push({ sql, params });
                return { rows: [] };
            },
        };
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const wheel = createWheel({});
        const result = await runColdStart({ wheel, pool, log: () => {} });
        expect(result).toEqual({ scanned: 0, scheduled: 0, pages: 0 });
        expect(pool.calls).toHaveLength(0); // never hit PG
        warn.mockRestore();
    });

    test('runColdStart validates required args', async () => {
        await expect(runColdStart()).rejects.toThrow(/wheel.*pool|pool.*wheel/);
        await expect(runColdStart({ wheel: {} })).rejects.toThrow();
        await expect(runColdStart({ pool: {} })).rejects.toThrow();
    });
});

function mkRow(id, state, isoTs) {
    return {
        message_id: id,
        state,
        inbound_seen_at: new Date(isoTs),
        bot_acked_at: state === 'bot_acked' || state === 'push_delivered' ? new Date(isoTs) : null,
        push_delivered_at: state === 'push_delivered' ? new Date(isoTs) : null,
    };
}
