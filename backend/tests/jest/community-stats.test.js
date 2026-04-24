/**
 * Community plaza stats endpoint contract test.
 *
 * Tests db.getCommunityStats shape + SQL param handling. Injects a fake
 * pool because the module-scoped pool is created lazily via initDatabase()
 * which requires DATABASE_URL — not available in unit-test env.
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

describe('db.getCommunityStats', () => {
    it('returns the full shape with totals + top_categories', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ total_bots: 42, new_today: 3, active_7d: 11 }] })
            .mockResolvedValueOnce({ rows: [
                { tag: 'customer-service', count: 18 },
                { tag: 'translator', count: 12 },
                { tag: 'coding', count: 7 },
            ]});
        const stats = await db.getCommunityStats(fakePool());
        expect(stats).toEqual({
            total_bots: 42,
            new_today: 3,
            active_7d: 11,
            top_categories: [
                { tag: 'customer-service', count: 18 },
                { tag: 'translator', count: 12 },
                { tag: 'coding', count: 7 },
            ],
        });
    });

    it('returns zeros + empty categories when no public bots exist', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ total_bots: 0, new_today: 0, active_7d: 0 }] })
            .mockResolvedValueOnce({ rows: [] });
        const stats = await db.getCommunityStats(fakePool());
        expect(stats).toEqual({
            total_bots: 0,
            new_today: 0,
            active_7d: 0,
            top_categories: [],
        });
    });

    it('never throws — degrades to zeros + error flag on db failure', async () => {
        mockQuery.mockRejectedValueOnce(new Error('connection refused'));
        const stats = await db.getCommunityStats(fakePool());
        expect(stats.total_bots).toBe(0);
        expect(stats.new_today).toBe(0);
        expect(stats.active_7d).toBe(0);
        expect(stats.top_categories).toEqual([]);
        expect(stats.error).toBe('query_failed');
    });

    it('fires exactly two queries in parallel — totals + categories', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [{ total_bots: 1, new_today: 0, active_7d: 1 }] })
            .mockResolvedValueOnce({ rows: [{ tag: 'test', count: 1 }] });
        await db.getCommunityStats(fakePool());
        expect(mockQuery).toHaveBeenCalledTimes(2);
        const totalsSql = mockQuery.mock.calls[0][0];
        expect(totalsSql).toMatch(/public_set/);
        expect(totalsSql).toMatch(/INTERVAL '7 days'/);
        expect(totalsSql).toMatch(/Asia\/Taipei/);
        const catSql = mockQuery.mock.calls[1][0];
        expect(catSql).toMatch(/jsonb_array_elements_text/);
        expect(catSql).toMatch(/LIMIT 5/);
    });

    it('coerces missing totals row to zeros without crashing', async () => {
        mockQuery
            .mockResolvedValueOnce({ rows: [] })
            .mockResolvedValueOnce({ rows: [] });
        const stats = await db.getCommunityStats(fakePool());
        expect(stats).toEqual({
            total_bots: 0,
            new_today: 0,
            active_7d: 0,
            top_categories: [],
        });
    });
});
