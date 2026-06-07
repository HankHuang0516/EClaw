/**
 * Phase 1 #3a — preflight composer + selector + lesson-extractor.
 * Card: card_50dccd356888b22d6654e85a
 */
'use strict';

const {
    composePreflightComment,
    selectSimilarEpisodes,
    extractLessons,
} = require('../../agent-improvement/preflight');

const FIXTURE_EPISODES = require('../../agent-improvement/__tests__/fixtures/episodes');

describe('extractLessons()', () => {
    test('prefers first missedCheck', () => {
        const ep = { missedChecks: ['no E2E hit prod URL', 'no screenshot'], userFeedback: 'X' };
        expect(extractLessons(ep)).toBe('no E2E hit prod URL');
    });

    test('falls back to userFeedback when no missedChecks', () => {
        expect(extractLessons({ missedChecks: [], userFeedback: 'felt slow' })).toBe('felt slow');
    });

    test('falls back to userVisibleResult when no userFeedback', () => {
        expect(extractLessons({ missedChecks: [], userVisibleResult: 'avatar broke' })).toBe('avatar broke');
    });

    test('returns empty when nothing mineable', () => {
        expect(extractLessons({})).toBe('');
        expect(extractLessons(null)).toBe('');
    });
});

describe('selectSimilarEpisodes()', () => {
    test('returns [] when card taxonomy empty', () => {
        expect(selectSimilarEpisodes([], FIXTURE_EPISODES)).toEqual([]);
    });

    test('matches by taxonomy overlap', () => {
        const r = selectSimilarEpisodes(['ux_feedback'], FIXTURE_EPISODES, 3);
        expect(r.length).toBeGreaterThan(0);
        for (const ep of r) {
            expect(ep.painTags).toContain('ux_feedback');
        }
    });

    test('skips episodes with zero overlap', () => {
        const onlyAuth = FIXTURE_EPISODES.filter(e => e.painTags.includes('auth_session'));
        const fake = [...onlyAuth, { painTags: ['delivery_reliability'], occurredAt: '2026-06-07T00:00:00Z' }];
        const r = selectSimilarEpisodes(['auth_session'], fake);
        for (const ep of r) {
            expect(ep.painTags).toContain('auth_session');
        }
    });

    test('ranks higher-overlap above lower-overlap', () => {
        const candidates = [
            { painTags: ['ux_feedback'], occurredAt: '2026-06-01T00:00:00Z', deliverable: 'one-tag' },
            { painTags: ['ux_feedback', 'test_coverage'], occurredAt: '2026-06-01T00:00:00Z', deliverable: 'two-tag' },
        ];
        const r = selectSimilarEpisodes(['ux_feedback', 'test_coverage'], candidates, 2);
        expect(r[0].deliverable).toBe('two-tag');
        expect(r[1].deliverable).toBe('one-tag');
    });

    test('tie-breaks by occurredAt DESC', () => {
        const candidates = [
            { painTags: ['auth_session'], occurredAt: '2026-06-01T00:00:00Z', deliverable: 'older' },
            { painTags: ['auth_session'], occurredAt: '2026-06-07T00:00:00Z', deliverable: 'newer' },
        ];
        const r = selectSimilarEpisodes(['auth_session'], candidates);
        expect(r[0].deliverable).toBe('newer');
    });

    test('respects limit', () => {
        const r = selectSimilarEpisodes(['delivery_reliability', 'ux_feedback'], FIXTURE_EPISODES, 1);
        expect(r.length).toBe(1);
    });
});

describe('composePreflightComment()', () => {
    test('contains required headings even with no similar episodes', () => {
        const text = composePreflightComment({
            cardTitle: 'random one-off task with nothing to compare against',
        });
        expect(text).toMatch(/本任務如何避免過往同類錯誤/);
        expect(text).toMatch(/Required checklist/);
        expect(text).toMatch(/Scope/);
        expect(text).toMatch(/Acceptance/);
        expect(text).toMatch(/Test plan/);
        expect(text).toMatch(/Evidence plan/);
        expect(text).toMatch(/Out-of-scope/);
    });

    test('emits explicit "no prior episodes" line when similarEpisodes is empty', () => {
        const text = composePreflightComment({ cardTitle: 'whatever' });
        expect(text).toMatch(/No prior episodes match/);
    });

    test('emits lesson bullets for each similar episode', () => {
        const ep = {
            cardId: 'card_xyz', severity: 'P0',
            painTags: ['ux_feedback'],
            missedChecks: ['counter hook only covered push-failure not brain-silence'],
            occurredAt: '2026-06-07T00:00:00Z',
            deliverable: 'd', userVisibleResult: 'u', entityId: 2, taskType: 'bugfix', evidence: [],
        };
        const text = composePreflightComment({
            cardTitle: 'avatar drawer feedback bug',
            cardDescription: 'fixing user feedback path',
            similarEpisodes: [ep],
        });
        expect(text).toMatch(/card_xyz · P0/);
        expect(text).toMatch(/counter hook only covered push-failure/);
    });

    test('classifies the card taxonomy and prints it', () => {
        const text = composePreflightComment({
            cardTitle: '帳號莫名要重新登入 bug',
            cardDescription: '',
        });
        expect(text).toMatch(/auth_session/);
    });

    test('recentRisks section is omitted when empty', () => {
        const text = composePreflightComment({ cardTitle: 'x' });
        expect(text).not.toMatch(/Recent same-area PR risks/);
    });

    test('recentRisks section renders when populated', () => {
        const text = composePreflightComment({
            cardTitle: 'x',
            recentRisks: [
                { ref: 'PR#3221', summary: 'counter hook missed same-device path' },
            ],
        });
        expect(text).toMatch(/Recent same-area PR risks/);
        expect(text).toMatch(/PR#3221: counter hook missed/);
    });
});
