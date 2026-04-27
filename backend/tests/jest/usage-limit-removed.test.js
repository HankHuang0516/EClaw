/**
 * Regression: daily message limit removed.
 *
 * Asserts:
 *   1. enforceUsageLimit() always returns { allowed: true, limit: null, ... }
 *      regardless of premium status, current usage_tracking count, or invite
 *      bonus_messages.
 *   2. The function does NOT increment usage_tracking (no INSERT/UPDATE).
 *
 * Previously: 15-message/day cap (+ invite_rewards.bonus_messages) for free
 * users on /api/client/speak. Cancelled — see backend/subscription.js.
 */

const factoryMock = {};

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: factoryMock.query || jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        connect: jest.fn().mockResolvedValue({
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

describe('enforceUsageLimit (limit removed)', () => {
    let subscriptionFactory;
    let module;
    let queryMock;

    beforeEach(() => {
        jest.resetModules();
        queryMock = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
        factoryMock.query = queryMock;
        subscriptionFactory = require('../../subscription');
        // Minimal harness — devices map + serverLog stub
        module = subscriptionFactory({}, jest.fn());
    });

    test('returns allowed:true with limit:null for unknown deviceId', async () => {
        const result = await module.enforceUsageLimit('any-device');
        expect(result).toEqual({ allowed: true, remaining: null, limit: null });
    });

    test('does not query usage_tracking or invite_rewards', async () => {
        await module.enforceUsageLimit('any-device');
        const sqlCalls = queryMock.mock.calls.map(c => c[0]);
        expect(sqlCalls.some(sql => /usage_tracking/i.test(sql))).toBe(false);
        expect(sqlCalls.some(sql => /invite_rewards/i.test(sql))).toBe(false);
    });

    test('returns allowed:true even when called many times', async () => {
        for (let i = 0; i < 50; i++) {
            const result = await module.enforceUsageLimit('any-device');
            expect(result.allowed).toBe(true);
        }
    });
});
