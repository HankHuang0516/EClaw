'use strict';

/**
 * Backend slice tests for the Achievements panel.
 * Card: card_8ca0b6acb1fb3d7a0b650dfd (Hank 2026-06-10 09:04 TW).
 *
 * Pool-mocked tests asserting the per-axis query shape and aggregation
 * behavior. Verifies the 6-axis CANONICAL_ACHIEVEMENTS surface, isolation
 * by (deviceId, entityId), and event drill-down chip shapes.
 */

const entityStatus = require('../../entity-status');

function makePool(rowsByQuery) {
    return {
        async query(sql, params) {
            const s = sql.replace(/\s+/g, ' ').trim();
            for (const matcher of rowsByQuery) {
                if (matcher.match(s, params)) return { rows: matcher.rows(params) };
            }
            return { rows: [] };
        },
    };
}

describe('Achievements backend slice', () => {
    const DEVICE = 'd1';
    const ENTITY = 2;

    test('CANONICAL_ACHIEVEMENTS has the 6 expected axes in order', () => {
        expect(entityStatus.CANONICAL_ACHIEVEMENTS).toEqual([
            'tasks_done',
            'chat_upvotes',
            'chat_downvotes',
            'prs_merged',
            'cards_reviewed',
            'notes_authored',
        ]);
    });

    test('getAchievements returns 6 rows in canonical order with count 0 when pool is empty', async () => {
        entityStatus.initTable(makePool([]));
        const items = await entityStatus.getAchievements(DEVICE, ENTITY);
        expect(items).toHaveLength(6);
        expect(items.map(x => x.axis)).toEqual(entityStatus.CANONICAL_ACHIEVEMENTS);
        items.forEach(item => {
            expect(item.count).toBe(0);
            expect(item.lastEventAt).toBeNull();
        });
    });

    test('getAchievements aggregates tasks_done by status=done AND jsonb containment on assigned_bots', async () => {
        const lastTs = new Date('2026-06-10T12:00:00Z');
        const pool = makePool([
            {
                match: (s) => s.includes('FROM kanban_cards') && s.includes('status = \'done\'') && s.includes('assigned_bots @> to_jsonb($2::int)'),
                rows: (p) => {
                    expect(p[0]).toBe(DEVICE);
                    expect(p[1]).toBe(ENTITY);
                    return [{ c: 17, ts: lastTs }];
                },
            },
        ]);
        entityStatus.initTable(pool);
        const items = await entityStatus.getAchievements(DEVICE, ENTITY);
        const done = items.find(x => x.axis === 'tasks_done');
        expect(done.count).toBe(17);
        expect(done.lastEventAt).toBe(lastTs.toISOString());
    });

    test('getAchievements chat_upvotes uses like_count column', async () => {
        const pool = makePool([
            {
                match: (s) => s.includes('FROM chat_messages') && s.includes('like_count') && s.includes('is_from_bot = true'),
                rows: () => [{ c: 42, ts: new Date('2026-06-10T10:00:00Z') }],
            },
        ]);
        entityStatus.initTable(pool);
        const items = await entityStatus.getAchievements(DEVICE, ENTITY);
        expect(items.find(x => x.axis === 'chat_upvotes').count).toBe(42);
    });

    test('getAchievements chat_downvotes uses dislike_count column', async () => {
        const pool = makePool([
            {
                match: (s) => s.includes('FROM chat_messages') && s.includes('dislike_count') && s.includes('is_from_bot = true'),
                rows: () => [{ c: 3, ts: null }],
            },
        ]);
        entityStatus.initTable(pool);
        const items = await entityStatus.getAchievements(DEVICE, ENTITY);
        expect(items.find(x => x.axis === 'chat_downvotes').count).toBe(3);
    });

    test('getAchievements cards_reviewed counts ALL reviewer participation (Q1 default)', async () => {
        const pool = makePool([
            {
                match: (s) => s.includes('FROM kanban_cards') && s.includes('reviewer_entity_id') && s.includes("status IN ('in_progress','done')"),
                rows: () => [{ c: 11, ts: null }],
            },
        ]);
        entityStatus.initTable(pool);
        const items = await entityStatus.getAchievements(DEVICE, ENTITY);
        expect(items.find(x => x.axis === 'cards_reviewed').count).toBe(11);
    });

    // card_13405b3448d89931665c1670 — prs_merged is now derived from on-device
    // GitHub PR URLs in kanban evidence comments (+ rework_pr_number union),
    // replacing the hardcoded-0 stub.
    test('getAchievements prs_merged is 0 when no PR URLs and no rework PRs', async () => {
        entityStatus.initTable(makePool([]));
        const items = await entityStatus.getAchievements(DEVICE, ENTITY);
        expect(items.find(x => x.axis === 'prs_merged').count).toBe(0);
        expect(items.find(x => x.axis === 'prs_merged').lastEventAt).toBeNull();
    });

    test('getAchievements prs_merged counts DISTINCT PR URLs from this entity\'s comments', async () => {
        const t1 = new Date('2026-06-10T08:00:00Z');
        const t2 = new Date('2026-06-11T09:00:00Z');
        const pool = makePool([
            {
                match: (s, p) => s.includes('FROM kanban_comments') && s.includes('from_entity_id = $2')
                    && s.includes('github') && (expect(p[0]).toBe(DEVICE), expect(p[1]).toBe(ENTITY), true),
                rows: () => [
                    { text: 'merged https://github.com/HankHuang0516/EClaw/pull/3461 ✅', created_at: t2 },
                    { text: 'PR https://github.com/HankHuang0516/EClaw/pull/3460 squash-merged', created_at: t1 },
                    // duplicate of #3461 — must NOT double-count
                    { text: 'follow-up on github.com/HankHuang0516/EClaw/pull/3461 merged', created_at: t1 },
                ],
            },
        ]);
        entityStatus.initTable(pool);
        const items = await entityStatus.getAchievements(DEVICE, ENTITY);
        const pr = items.find(x => x.axis === 'prs_merged');
        expect(pr.count).toBe(2);
        expect(pr.lastEventAt).toBe(t2.toISOString());
    });

    test('getAchievements prs_merged falls back to ALL referenced PRs when none signal merge (never 0 if PRs exist)', async () => {
        const pool = makePool([
            {
                match: (s) => s.includes('FROM kanban_comments') && s.includes('github'),
                rows: () => [
                    { text: 'opened https://github.com/HankHuang0516/EClaw/pull/100', created_at: new Date('2026-06-01T00:00:00Z') },
                    { text: 'see https://github.com/HankHuang0516/EClaw/pull/101 for the diff', created_at: new Date('2026-06-02T00:00:00Z') },
                ],
            },
        ]);
        entityStatus.initTable(pool);
        const items = await entityStatus.getAchievements(DEVICE, ENTITY);
        expect(items.find(x => x.axis === 'prs_merged').count).toBe(2);
    });

    test('getAchievements prs_merged UNIONs rework_pr_number on owned/reviewed cards (deduped across sources)', async () => {
        const pool = makePool([
            {
                match: (s) => s.includes('FROM kanban_comments') && s.includes('github'),
                rows: () => [
                    { text: 'merged https://github.com/HankHuang0516/EClaw/pull/200', created_at: new Date('2026-06-05T00:00:00Z') },
                ],
            },
            {
                match: (s) => s.includes('FROM kanban_cards') && s.includes('rework_pr_number'),
                rows: () => [
                    { pr: 'https://github.com/HankHuang0516/EClaw/pull/200', updated_at: new Date('2026-06-06T00:00:00Z') }, // dup of comment PR
                    { pr: '201', updated_at: new Date('2026-06-07T00:00:00Z') }, // bare number → new
                ],
            },
        ]);
        entityStatus.initTable(pool);
        const items = await entityStatus.getAchievements(DEVICE, ENTITY);
        expect(items.find(x => x.axis === 'prs_merged').count).toBe(2);
    });

    test('getAchievementEvents for prs_merged returns distinct PR chips newest-first', async () => {
        const t1 = new Date('2026-06-10T08:00:00Z');
        const t2 = new Date('2026-06-11T09:00:00Z');
        const pool = makePool([
            {
                match: (s) => s.includes('FROM kanban_comments') && s.includes('github') && s.includes('ORDER BY created_at DESC'),
                rows: () => [
                    { text: 'merged https://github.com/HankHuang0516/EClaw/pull/3461', created_at: t2 },
                    { text: 'merged https://github.com/HankHuang0516/EClaw/pull/3460 and dup of github.com/HankHuang0516/EClaw/pull/3461', created_at: t1 },
                ],
            },
        ]);
        entityStatus.initTable(pool);
        const items = await entityStatus.getAchievementEvents(DEVICE, ENTITY, 'prs_merged', 10);
        expect(items.length).toBe(2);
        expect(items[0].chip).toEqual({
            kind: 'pr',
            prNumber: 3461,
            url: 'https://github.com/HankHuang0516/EClaw/pull/3461',
            excerpt: expect.any(String),
        });
        expect(items[1].chip.prNumber).toBe(3460);
        // no duplicate 3461 chip from the second row
        expect(items.filter(i => i.chip.prNumber === 3461)).toHaveLength(1);
    });

    test('getAchievementEvents for tasks_done returns card chips', async () => {
        const pool = makePool([
            {
                match: (s) => s.includes('FROM kanban_cards') && s.includes('assigned_bots @> to_jsonb($2::int)') && s.includes('ORDER BY updated_at DESC'),
                rows: () => [
                    { id: 'card_a', title: 'Ship X', updated_at: new Date('2026-06-10T08:00:00Z') },
                    { id: 'card_b', title: 'Ship Y', updated_at: new Date('2026-06-09T08:00:00Z') },
                ],
            },
        ]);
        entityStatus.initTable(pool);
        const items = await entityStatus.getAchievementEvents(DEVICE, ENTITY, 'tasks_done', 10);
        expect(items).toHaveLength(2);
        expect(items[0].chip).toEqual({ kind: 'card', cardId: 'card_a', label: 'Ship X' });
    });

    test('getAchievementEvents for chat_upvotes returns chat chips with truncated excerpt', async () => {
        const longText = 'x'.repeat(120);
        const pool = makePool([
            {
                match: (s) => s.includes('FROM chat_messages') && s.includes('like_count') && s.includes('ORDER BY created_at DESC'),
                rows: () => [{ id: 'msg_1', text: longText, created_at: new Date('2026-06-10T08:00:00Z') }],
            },
        ]);
        entityStatus.initTable(pool);
        const items = await entityStatus.getAchievementEvents(DEVICE, ENTITY, 'chat_upvotes', 10);
        expect(items[0].chip.kind).toBe('chat');
        expect(items[0].chip.excerpt).toHaveLength(60);
    });

    test('getAchievementEvents rejects non-canonical axis (whitelist)', async () => {
        entityStatus.initTable(makePool([]));
        const items = await entityStatus.getAchievementEvents(DEVICE, ENTITY, 'not_canonical', 10);
        expect(items).toEqual([]);
    });

    test('getAchievementEvents limit cap = 100', async () => {
        let capturedLimit = null;
        const pool = makePool([
            {
                match: (s) => s.includes('FROM kanban_cards') && s.includes('assigned_bots @> to_jsonb($2::int)'),
                rows: (p) => { capturedLimit = p[2]; return []; },
            },
        ]);
        entityStatus.initTable(pool);
        await entityStatus.getAchievementEvents(DEVICE, ENTITY, 'tasks_done', 99999);
        expect(capturedLimit).toBe(100);
    });
});
