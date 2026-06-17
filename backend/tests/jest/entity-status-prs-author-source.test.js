'use strict';

/**
 * Tests for the prs_merged author-source (Tier 1 per-entity git author).
 * Spec: docs/specs/per-entity-git-author-spec.md (§6)
 * Card: card_35009109c256040aa91200bd
 *
 * Verifies the new git-author-grounded source UNIONs + dedupes with the existing
 * kanban-evidence-comment path, and that it degrades gracefully (never errors).
 */

const entityStatus = require('../../entity-status');

const DEVICE = 'd1';
const ENTITY = 2;

function makePool(matchers) {
    return {
        async query(sql, params) {
            const s = sql.replace(/\s+/g, ' ').trim();
            for (const m of matchers) {
                if (m.match(s, params)) return { rows: m.rows(params) };
            }
            return { rows: [] };
        },
    };
}

// Evidence-comment rows referencing PR #200 (the existing path).
const evidenceMatcher = {
    match: (s) => s.includes('FROM kanban_comments') && s.includes('github'),
    rows: () => [
        { text: 'merged https://github.com/HankHuang0516/EClaw/pull/200', created_at: new Date('2026-06-05T00:00:00Z') },
    ],
};

afterEach(() => {
    // Always clear the injected source so a leak can't poison other suites.
    entityStatus.setPrAuthorSource(null);
});

describe('prs_merged author-source', () => {
    test('UNIONs author-source PRs with the evidence path', async () => {
        entityStatus.initTable(makePool([evidenceMatcher]));
        // Author-source contributes a DIFFERENT pr (#201).
        entityStatus.setPrAuthorSource(async (email, ctx) => {
            expect(email).toBe('entity-2@bots.eclaw');
            expect(ctx).toEqual({ deviceId: DEVICE, entityId: ENTITY });
            return [
                { owner: 'HankHuang0516', repo: 'EClaw', number: 201, lastEventAt: new Date('2026-06-08T00:00:00Z') },
            ];
        });
        const items = await entityStatus.getAchievements(DEVICE, ENTITY);
        const pr = items.find(x => x.axis === 'prs_merged');
        expect(pr.count).toBe(2); // #200 (evidence) + #201 (author)
        expect(pr.lastEventAt).toBe(new Date('2026-06-08T00:00:00Z').toISOString());
    });

    test('dedupes a PR that appears in BOTH the evidence path and the author-source', async () => {
        entityStatus.initTable(makePool([evidenceMatcher]));
        // Author-source re-reports the SAME pr #200 (via prKey form).
        entityStatus.setPrAuthorSource(async () => [
            { prKey: 'hankhuang0516/eclaw#200', lastEventAt: new Date('2026-06-09T00:00:00Z') },
        ]);
        const items = await entityStatus.getAchievements(DEVICE, ENTITY);
        const pr = items.find(x => x.axis === 'prs_merged');
        expect(pr.count).toBe(1); // collapsed, not double-counted
    });

    test('author-source can be the ONLY source (no evidence comments)', async () => {
        entityStatus.initTable(makePool([])); // empty DB
        entityStatus.setPrAuthorSource(async () => [
            { owner: 'HankHuang0516', repo: 'EClaw', number: 300 },
            { owner: 'HankHuang0516', repo: 'EClaw', number: 301 },
        ]);
        const items = await entityStatus.getAchievements(DEVICE, ENTITY);
        expect(items.find(x => x.axis === 'prs_merged').count).toBe(2);
    });

    test('graceful degrade: no source injected → evidence-path count only', async () => {
        entityStatus.initTable(makePool([evidenceMatcher]));
        entityStatus.setPrAuthorSource(null);
        const items = await entityStatus.getAchievements(DEVICE, ENTITY);
        expect(items.find(x => x.axis === 'prs_merged').count).toBe(1); // just #200
    });

    test('graceful degrade: a THROWING source never errors, falls back to evidence path', async () => {
        entityStatus.initTable(makePool([evidenceMatcher]));
        entityStatus.setPrAuthorSource(async () => { throw new Error('GH 503 unreachable'); });
        const items = await entityStatus.getAchievements(DEVICE, ENTITY);
        const pr = items.find(x => x.axis === 'prs_merged');
        expect(pr.count).toBe(1); // evidence path stands
        // and the other five axes are unaffected
        expect(items).toHaveLength(6);
    });

    test('graceful degrade: malformed (non-array) source contributes nothing', async () => {
        entityStatus.initTable(makePool([evidenceMatcher]));
        entityStatus.setPrAuthorSource(async () => ({ not: 'an array' }));
        const items = await entityStatus.getAchievements(DEVICE, ENTITY);
        expect(items.find(x => x.axis === 'prs_merged').count).toBe(1);
    });

    test('author-source bare number is normalized into the shared #N key space', async () => {
        entityStatus.initTable(makePool([])); // no evidence
        entityStatus.setPrAuthorSource(async () => [{ number: '402' }, { number: 402 }]);
        const items = await entityStatus.getAchievements(DEVICE, ENTITY);
        // both normalize to #402 → 1 distinct
        expect(items.find(x => x.axis === 'prs_merged').count).toBe(1);
    });
});
