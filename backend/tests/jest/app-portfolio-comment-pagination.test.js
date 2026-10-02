const express = require('express');
const request = require('supertest');
const community = require('../../app-portfolio-community');

function fixtureRows(count, highestId = BigInt(count)) {
    return Array.from({ length: count }, (_, index) => ({
        id: String(highestId - BigInt(index)),
        nickname: `reader-${index}`,
        content: `Local pagination fixture ${index}`,
        createdAt: '2026-10-01T00:00:00.000Z',
    }));
}

function fixturePool(rows) {
    return {
        query: jest.fn(async (sql, params = []) => {
            if (/CREATE (?:TABLE|INDEX)/.test(sql)) return { rows: [], rowCount: 0 };
            if (/COUNT\(\*\).*FROM app_portfolio_likes/.test(sql)) {
                return { rows: [{ count: 7 }] };
            }
            if (/SELECT EXISTS.*FROM app_portfolio_likes/.test(sql)) {
                return { rows: [{ liked: true }] };
            }
            if (/COUNT\(\*\).*FROM app_portfolio_comments/.test(sql)) {
                expect(params).toEqual(['stray-map']);
                return { rows: [{ count: rows.length }] };
            }
            if (/FROM app_portfolio_comments/.test(sql)) {
                expect(sql).toMatch(/SELECT id::text, nickname, content, created_at AS "createdAt"/);
                expect(sql).toMatch(/WHERE app_id = \$1 AND \(\$2::bigint IS NULL OR id < \$2::bigint\)/);
                expect(sql).toMatch(/ORDER BY id DESC\s+LIMIT 51/);
                expect(params[0]).toBe('stray-map');
                const before = params[1];
                return { rows: rows.filter(row => before === null || BigInt(row.id) < BigInt(before)).slice(0, 51) };
            }
            throw new Error(`Unexpected SQL in isolated pagination test: ${sql}`);
        }),
    };
}

function testApp(pool) {
    const app = express();
    app.use('/api/app-portfolio', community.createRouter(() => pool));
    return app;
}

describe('portfolio comment pagination', () => {
    test.each([undefined, '1', '9007199254740993', '9223372036854775807'])('accepts a bounded string cursor: %s', value => {
        expect(community.validCommentCursor(value)).toBe(true);
    });

    test.each([null, '', '0', '-1', '01', '1.5', '1e3', ' 1', '1 ', '9223372036854775808', '999999999999999999999', 1, ['1'], {}])('rejects an invalid cursor: %s', value => {
        expect(community.validCommentCursor(value)).toBe(false);
    });

    test('reads all three pages without loss, duplication or a truncated total', async () => {
        const rows = fixtureRows(120);
        const pool = fixturePool(rows);
        const app = testApp(pool);
        const seen = [];
        let cursor;
        const pageLengths = [];
        for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
            let call = request(app).get('/api/app-portfolio/apps/stray-map/community');
            if (cursor) call = call.query({ before: cursor });
            const response = await call;
            expect(response.status).toBe(200);
            expect(response.body.success).toBe(true);
            expect(response.body.commentCount).toBe(120);
            expect(response.body.likeCount).toBe(7);
            expect(response.body.liked).toBe(false);
            pageLengths.push(response.body.comments.length);
            seen.push(...response.body.comments.map(row => row.id));
            cursor = response.body.nextCursor;
            expect(cursor).toBe(pageIndex === 0 ? '71' : pageIndex === 1 ? '21' : null);
        }
        expect(pageLengths).toEqual([50, 50, 20]);
        expect(seen).toEqual(rows.map(row => row.id));
        expect(new Set(seen).size).toBe(120);
    });

    test.each([0, 1, 50])('does not advertise a next page when %i comments remain', async count => {
        const result = await community.getCommunity(fixturePool(fixtureRows(count)), 'stray-map', null);
        expect(result.comments).toHaveLength(count);
        expect(result.commentCount).toBe(count);
        expect(result.nextCursor).toBeNull();
    });

    test('keeps bigint IDs as strings and uses the 50th rather than the lookahead row', async () => {
        const rows = fixtureRows(52, 9007199254741100n);
        const pool = fixturePool(rows);
        const first = await community.getCommunity(pool, 'stray-map', 'isolated-hash');
        expect(first.liked).toBe(true);
        expect(first.nextCursor).toBe(rows[49].id);
        expect(first.comments[0].id).toBe('9007199254741100');
        const last = await community.getCommunity(pool, 'stray-map', null, first.nextCursor);
        expect(last.comments.map(row => row.id)).toEqual(rows.slice(50).map(row => row.id));
        expect(last.nextCursor).toBeNull();
        expect(last.commentCount).toBe(52);
    });

    test.each(['before=0', 'before=-1', 'before=9223372036854775808', 'before=1&before=2'])('rejects malformed HTTP pagination before touching a database: %s', async query => {
        const pool = { query: jest.fn() };
        const response = await request(testApp(pool)).get(`/api/app-portfolio/apps/stray-map/community?${query}`);
        expect(response.status).toBe(400);
        expect(response.body.error).toBe('invalid-comment-cursor');
        expect(pool.query).not.toHaveBeenCalled();
    });

    test('returns an unavailable response, not an empty successful page, on a database error', async () => {
        const pool = { query: jest.fn().mockRejectedValue(new Error('isolated unavailable fixture')) };
        const logger = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const response = await request(testApp(pool)).get('/api/app-portfolio/apps/stray-map/community');
            expect(response.status).toBe(503);
            expect(response.body.success).toBe(false);
            expect(response.body).not.toHaveProperty('commentCount');
            expect(response.body).not.toHaveProperty('comments');
        } finally {
            logger.mockRestore();
        }
    });
});
