'use strict';

/**
 * reference-resolver unit tests — verifies resolveReferences() does the
 * correct DB queries per ref type and formats the return shape.
 *
 * DB is mocked so this test does not require Postgres.
 */

const { resolveReferences, resolveCardRef } = require('../../reference-resolver');

function mockPool(responses) {
    const queries = [];
    const pool = {
        query: jest.fn(async (sql, args) => {
            queries.push({ sql, args });
            const handler = responses.shift();
            if (typeof handler === 'function') return handler(sql, args);
            if (handler instanceof Error) throw handler;
            return handler;
        }),
        _queries: queries,
    };
    return pool;
}

describe('resolveCardRef', () => {
    test('short prefix resolves to full id via LIKE lookup', async () => {
        const pool = mockPool([
            { rows: [{ id: 'card_f6321df2aaaa1111bbbb2222' }] }, // short-prefix SELECT
            { rows: [{ id: 'card_f6321df2aaaa1111bbbb2222', title: 'Fix UI', status: 'in_progress', priority: 'P1' }] }, // main SELECT
            { rows: [{ text: 'latest update' }] }, // last comment
        ]);
        const r = await resolveCardRef(pool, 'dev1', 'card_f6321df2');
        expect(r.resolved).toBe(true);
        expect(r.title).toBe('Fix UI');
        expect(r.status).toBe('in_progress');
        expect(r.priority).toBe('P1');
        expect(r.lastComment).toBe('latest update');
        expect(r.canonicalId).toBe('card_f6321df2aaaa1111bbbb2222');
    });

    test('exact 24-hex id skips the LIKE resolve step', async () => {
        const pool = mockPool([
            { rows: [{ id: 'card_d3cdda1455152e3caee8d4ac', title: 'Long', status: 'done', priority: 'P2' }] },
            { rows: [] }, // no comments
        ]);
        const r = await resolveCardRef(pool, 'dev1', 'card_d3cdda1455152e3caee8d4ac');
        expect(r.resolved).toBe(true);
        expect(r.title).toBe('Long');
        expect(r.lastComment).toBeNull();
        // Only 2 queries (main + comment), no short-prefix query
        expect(pool._queries).toHaveLength(2);
    });

    test('ambiguous short prefix (2 matches) returns not_found', async () => {
        const pool = mockPool([
            { rows: [{ id: 'card_f6321df2aaaa' }, { id: 'card_f6321df2bbbb' }] }, // 2 matches
            { rows: [] }, // exact-match on the raw short id returns nothing
        ]);
        const r = await resolveCardRef(pool, 'dev1', 'card_f6321df2');
        expect(r.resolved).toBe(false);
        expect(r.error).toBe('not_found');
    });

    test('card not in device returns not_found', async () => {
        const pool = mockPool([
            { rows: [] }, // short-prefix: no hits
            { rows: [] }, // main: no hits
        ]);
        const r = await resolveCardRef(pool, 'dev1', 'card_deadbeef');
        expect(r.resolved).toBe(false);
        expect(r.error).toBe('not_found');
    });
});

describe('resolveReferences', () => {
    test('mixed refs route to correct resolvers', async () => {
        // Route by SQL pattern + arg so the mock is order-independent (resolveReferences
        // uses Promise.all, so card lookups run concurrently and interleave).
        const pool = {
            query: jest.fn(async (sql, args) => {
                // short-prefix resolver
                if (/LIKE \$3/.test(sql) && /LIKE \$4/.test(sql)) {
                    if (args[2] === 'f6321df2%') return { rows: [{ id: 'card_f6321df2aaaa' }] };
                    if (args[2] === 'abcdef12%') return { rows: [{ id: 'card_abcdef12aaaa' }] };
                    return { rows: [] };
                }
                // main SELECT title/status/priority
                if (/SELECT id, title, status, priority/.test(sql)) {
                    if (args[0] === 'card_f6321df2aaaa') {
                        return { rows: [{ id: 'card_f6321df2aaaa', title: 'Card A', status: 'todo', priority: 'P1' }] };
                    }
                    if (args[0] === 'card_abcdef12aaaa') {
                        return { rows: [{ id: 'card_abcdef12aaaa', title: 'Card B', status: 'done', priority: 'P2' }] };
                    }
                    return { rows: [] };
                }
                // last-comment query
                if (/kanban_comments/.test(sql)) {
                    if (args[0] === 'card_f6321df2aaaa') return { rows: [{ text: 'hi' }] };
                    return { rows: [] };
                }
                return { rows: [] };
            }),
        };

        const refs = [
            { refType: 'card', refId: 'card_f6321df2' },
            { refType: 'review', refId: 'review_xyz123456' }, // unsupported
            { refType: 'src', refId: 'src://kanban/card/abcdef12', kind: 'kanban', innerType: 'card', innerId: 'abcdef12', anchor: null },
            { refType: 'src', refId: 'src://wiki/page/abcdef12', kind: 'wiki', innerType: 'page', innerId: 'abcdef12', anchor: null },
        ];
        const out = await resolveReferences(pool, 'dev1', refs);

        expect(out).toHaveLength(4);
        expect(out[0]).toMatchObject({ refType: 'card', resolved: true, title: 'Card A' });
        expect(out[1]).toMatchObject({ refType: 'review', resolved: false, error: 'unsupported' });
        expect(out[2]).toMatchObject({ refType: 'src', resolved: true, title: 'Card B' });
        expect(out[3]).toMatchObject({ refType: 'src', resolved: false, error: 'unsupported' });
    });

    test('DB error on one ref does not break others', async () => {
        const pool = {
            query: jest.fn()
                // first card: throws on the short-prefix query
                .mockRejectedValueOnce(new Error('conn dropped'))
                // second card: normal resolve (exact 24-hex skips short-prefix, so 2 queries)
                .mockResolvedValueOnce({ rows: [{ id: 'card_111111111111111111111111', title: 'OK', status: 'todo', priority: 'P2' }] })
                .mockResolvedValueOnce({ rows: [] }),
        };
        const refs = [
            { refType: 'card', refId: 'card_f6321df2' },
            { refType: 'card', refId: 'card_111111111111111111111111' },
        ];
        const out = await resolveReferences(pool, 'dev1', refs);
        expect(out[0]).toMatchObject({ resolved: false, error: 'lookup_failed' });
        expect(out[1]).toMatchObject({ resolved: true, title: 'OK' });
    });

    test('empty / missing args return empty array', async () => {
        expect(await resolveReferences(null, 'dev', [])).toEqual([]);
        expect(await resolveReferences({ query: jest.fn() }, null, [{ refType: 'card', refId: 'card_x' }])).toEqual([]);
        expect(await resolveReferences({ query: jest.fn() }, 'dev', [])).toEqual([]);
    });

    test('anchor is preserved on resolved src ref', async () => {
        const pool = mockPool([
            { rows: [{ id: 'card_abcdef12aaaa' }] },
            { rows: [{ id: 'card_abcdef12aaaa', title: 'Parent', status: 'review', priority: 'P0' }] },
            { rows: [] },
        ]);
        const refs = [{
            refType: 'src',
            refId: 'src://kanban/card/abcdef12#comment-xyz',
            kind: 'kanban',
            innerType: 'card',
            innerId: 'abcdef12',
            anchor: '#comment-xyz',
        }];
        const out = await resolveReferences(pool, 'dev1', refs);
        expect(out[0].anchor).toBe('#comment-xyz');
        expect(out[0].resolved).toBe(true);
    });
});
