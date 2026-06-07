/**
 * Phase 0 #2a — feedback ingestion bridge (classifier + ingestEpisode).
 * Card: card_2024e5eebe1411b9a798fc28
 *
 * Pool-mocked unit tests: classifier mapping (forward + fallback), ingest
 * rejection on bad shape, ingest rejection on secret-shaped substrings.
 */
'use strict';

const {
    classifyPainTags,
    ingestEpisode,
    KEYWORD_TO_TAG,
} = require('../../agent-improvement');

const { PAIN_TAXONOMY } = require('../../agent-improvement/episode-schema');

function fakePool(captured = []) {
    return {
        query: jest.fn(async (sql, params) => {
            captured.push({ sql, params });
            return { rows: [{ id: captured.length }] };
        }),
        captured,
    };
}

describe('classifyPainTags()', () => {
    test('matches single delivery_reliability keyword in Chinese', () => {
        expect(classifyPainTags('一旦斷線訊息就被阻擋')).toContain('delivery_reliability');
    });

    test('matches auth_session via English keyword', () => {
        expect(classifyPainTags('login session keeps expiring')).toContain('auth_session');
    });

    test('matches redirect_deeplink in Chinese', () => {
        expect(classifyPainTags('App 轉導不穩定')).toContain('redirect_deeplink');
    });

    test('accumulates multiple tags from one feedback line', () => {
        const tags = classifyPainTags('帳號莫名要重新登入而且 App 轉導不穩定 測試也沒完整');
        expect(tags).toEqual(expect.arrayContaining(['auth_session', 'redirect_deeplink', 'test_coverage']));
    });

    test('taskType adds tag when keyword scan misses', () => {
        const tags = classifyPainTags('unrelated text', 'pr_review');
        expect(tags).toContain('scope_completeness');
    });

    test('falls back to scope_completeness when nothing matches', () => {
        expect(classifyPainTags('hello world')).toEqual(['scope_completeness']);
    });

    test('every returned tag is in PAIN_TAXONOMY', () => {
        const samples = [
            ['一旦斷線訊息就被阻擋', undefined],
            ['silent kick session', undefined],
            ['random unrelated', 'bugfix'],
            ['', undefined],
        ];
        for (const [text, taskType] of samples) {
            for (const t of classifyPainTags(text, taskType)) {
                expect(PAIN_TAXONOMY).toContain(t);
            }
        }
    });

    test('KEYWORD_TO_TAG covers every taxonomy tag', () => {
        const tags = new Set(KEYWORD_TO_TAG.map(e => e.tag));
        for (const t of PAIN_TAXONOMY) {
            expect(tags.has(t)).toBe(true);
        }
    });
});

describe('ingestEpisode()', () => {
    const baseEpisode = () => ({
        _deviceId: 'dev-test-1',
        cardId: 'card_test_ok',
        entityId: 2,
        taskType: 'bugfix',
        painTags: ['ux_feedback'],
        deliverable: 'fix the thing',
        userVisibleResult: 'fixed for users',
        evidence: [{ kind: 'pr', ref: 'PR#999' }],
        missedChecks: [],
        severity: 'P2',
        occurredAt: '2026-06-07T09:00:00+08:00',
    });

    test('inserts a valid episode and returns id', async () => {
        const pool = fakePool();
        const r = await ingestEpisode(baseEpisode(), pool);
        expect(r.id).toBe(1);
        expect(pool.query).toHaveBeenCalledTimes(1);
        const call = pool.captured[0];
        expect(call.sql).toMatch(/INSERT INTO agent_improvement_episodes/);
        expect(call.params[0]).toBe('dev-test-1');
        expect(call.params[2]).toBe(2);
    });

    test('rejects unknown painTag with EP_INVALID', async () => {
        const ep = { ...baseEpisode(), painTags: ['something_made_up'] };
        const pool = fakePool();
        await expect(ingestEpisode(ep, pool)).rejects.toMatchObject({ code: 'EP_INVALID' });
        expect(pool.query).not.toHaveBeenCalled();
    });

    test('rejects missing required field with EP_INVALID', async () => {
        const ep = baseEpisode();
        delete ep.severity;
        const pool = fakePool();
        await expect(ingestEpisode(ep, pool)).rejects.toMatchObject({ code: 'EP_INVALID' });
    });

    test('rejects secret-shaped substring (no insert)', async () => {
        const ep = baseEpisode();
        ep.userFeedback = 'oops bot_secret=abcdef in the log';
        const pool = fakePool();
        await expect(ingestEpisode(ep, pool)).rejects.toThrow(/secret-shaped/);
        expect(pool.query).not.toHaveBeenCalled();
    });

    test('rejects nested secret in evidence note', async () => {
        const ep = baseEpisode();
        ep.evidence = [{ kind: 'log', ref: 'x', note: 'Bearer abc.def.ghi.token' }];
        const pool = fakePool();
        await expect(ingestEpisode(ep, pool)).rejects.toThrow(/secret-shaped/);
    });

    test('serializes painTags / evidence / missedChecks as JSON params', async () => {
        const pool = fakePool();
        await ingestEpisode(baseEpisode(), pool);
        const p = pool.captured[0].params;
        expect(JSON.parse(p[4])).toEqual(['ux_feedback']);
        expect(JSON.parse(p[7])).toEqual([{ kind: 'pr', ref: 'PR#999' }]);
        expect(JSON.parse(p[8])).toEqual([]);
    });
});
