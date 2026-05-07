/**
 * Invite click-tracking tests.
 *
 * Covers db.logInviteClick + db.getInviteClickStats contract. These back
 * the /invite/:code share-link route which (a) fixes the prior 404 and
 * (b) logs step-1 funnel telemetry for the invite conversion metric.
 *
 * pg Pool is mocked because db.js's module-scoped pool is null until
 * initDatabase() runs (requires DATABASE_URL — not in unit-test env).
 * Helpers accept a poolArg override for exactly this reason.
 */

let mockQuery;

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: jest.fn(),
        connect: jest.fn(),
        end: jest.fn(),
    })),
}));

let db;

beforeEach(() => {
    jest.resetModules();
    mockQuery = jest.fn();
    db = require('../../db');
});

const fakePool = () => ({ query: (...a) => mockQuery(...a) });

describe('db.logInviteClick', () => {
    it('inserts a row with all fields when pg is available', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        const ok = await db.logInviteClick(
            { code: 'ABC123', ipHash: 'deadbeef12345678', userAgent: 'UA/1.0', referer: 'https://x.example/p' },
            fakePool()
        );
        expect(ok).toBe(true);
        expect(mockQuery).toHaveBeenCalledTimes(1);
        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/INSERT INTO invite_clicks/);
        expect(params).toEqual(['ABC123', 'deadbeef12345678', 'UA/1.0', 'https://x.example/p', 'direct']);
    });

    it('coerces missing metadata to NULL instead of undefined', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
        const ok = await db.logInviteClick({ code: 'XY99' }, fakePool());
        expect(ok).toBe(true);
        const [, params] = mockQuery.mock.calls[0];
        expect(params).toEqual(['XY99', null, null, null, 'direct']);
    });

    it('returns false (no throw) on DB error — redirect path must not break', async () => {
        mockQuery.mockRejectedValueOnce(new Error('connection refused'));
        const ok = await db.logInviteClick({ code: 'FAIL' }, fakePool());
        expect(ok).toBe(false);
    });

    it('returns false when pool is unavailable (no module pool, no override)', async () => {
        // Call with no poolArg and the module-scoped pool is null in unit env.
        const ok = await db.logInviteClick({ code: 'NOPG' });
        expect(ok).toBe(false);
    });
});

describe('db.getInviteClickStats', () => {
    it('returns per-code aggregate with clicks + unique_clicks + redeemed flag', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [
            { code: 'AAA1', clicks: 5, unique_clicks: 3, last_clicked_at: new Date('2026-04-24T01:00:00Z'), redeemed: true },
            { code: 'BBB2', clicks: 2, unique_clicks: 2, last_clicked_at: new Date('2026-04-23T18:00:00Z'), redeemed: false },
        ]});
        const stats = await db.getInviteClickStats(fakePool());
        expect(stats).toHaveLength(2);
        expect(stats[0].code).toBe('AAA1');
        expect(stats[0].clicks).toBe(5);
        expect(stats[0].unique_clicks).toBe(3);
        expect(stats[0].redeemed).toBe(true);
        expect(stats[1].redeemed).toBe(false);
    });

    it('groups by code and joins to invite_codes for redeemed flag', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        await db.getInviteClickStats(fakePool());
        const sql = mockQuery.mock.calls[0][0];
        expect(sql).toMatch(/GROUP BY c\.code/);
        expect(sql).toMatch(/FROM invite_codes WHERE code = c\.code/);
        expect(sql).toMatch(/COUNT\(DISTINCT c\.ip_hash\)/);
        expect(sql).toMatch(/LIMIT 100/);
    });

    it('returns [] (not throws) on DB error', async () => {
        mockQuery.mockRejectedValueOnce(new Error('bad sql'));
        const stats = await db.getInviteClickStats(fakePool());
        expect(stats).toEqual([]);
    });

    it('coerces redeemed to strict boolean (not nullable)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [
            { code: 'CCC3', clicks: 1, unique_clicks: 1, last_clicked_at: new Date(), redeemed: null },
        ]});
        const stats = await db.getInviteClickStats(fakePool());
        expect(stats[0].redeemed).toBe(false);
    });
});

describe('db.getInviteClickStatsForOwner', () => {
    it('filters by owner_device_id via JOIN on invite_codes', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [] });
        await db.getInviteClickStatsForOwner('owner-1', fakePool());
        const [sql, params] = mockQuery.mock.calls[0];
        expect(sql).toMatch(/WHERE ic\.owner_device_id = \$1/);
        expect(sql).toMatch(/LEFT JOIN/);
        expect(params).toEqual(['owner-1']);
    });

    it('includes codes with zero clicks (LEFT JOIN keeps never-shared codes)', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [
            { code: 'UNUSED', created_at: new Date(), used_by_device_id: null, used_at: null, clicks: 0, unique_clicks: 0, last_clicked_at: null },
        ]});
        const rows = await db.getInviteClickStatsForOwner('owner-2', fakePool());
        expect(rows).toHaveLength(1);
        expect(rows[0].code).toBe('UNUSED');
        expect(rows[0].clicks).toBe(0);
        expect(rows[0].redeemed).toBe(false);
    });

    it('marks redeemed=true when used_by_device_id is not null', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [
            { code: 'USED1', created_at: new Date(), used_by_device_id: 'friend-1', used_at: new Date(), clicks: 3, unique_clicks: 2, last_clicked_at: new Date() },
        ]});
        const rows = await db.getInviteClickStatsForOwner('owner-3', fakePool());
        expect(rows[0].redeemed).toBe(true);
        expect(rows[0].redeemed_at).toBeTruthy();
    });

    it('returns [] on DB error', async () => {
        mockQuery.mockRejectedValueOnce(new Error('boom'));
        const rows = await db.getInviteClickStatsForOwner('owner-4', fakePool());
        expect(rows).toEqual([]);
    });
});
