/**
 * Phase 4 #9 — rule promotion engine.
 * Card: card_5ac74610cbf1f89440427809
 *
 * Deterministic input → suggestion shape. No DB / network / GitHub.
 */
'use strict';

const {
    DEFAULT_THRESHOLD,
    SEVERITY_THRESHOLD_OVERRIDE,
    RULE_VEHICLES,
    PAIN_AXIS_TO_VEHICLE,
    sortChronological,
    trailingRunForTag,
    effectiveThreshold,
    highestSeverity,
    evaluatePromotions,
    renderMetaPrBody,
    buildMetaPrDraft,
} = require('../../agent-improvement/rule-promotion');

const { PAIN_TAXONOMY } = require('../../agent-improvement/episode-schema');

// Minimal episode factory — only the fields the engine reads.
function ep(cardId, tag, occurredAt, severity = 'P2', extra = {}) {
    return {
        cardId,
        painTags: Array.isArray(tag) ? tag : [tag],
        occurredAt,
        severity,
        ...extra,
    };
}

const T = (n) => `2026-06-1${n}T00:00:00+08:00`; // T(0)..T(9) ascending

describe('constants', () => {
    test('DEFAULT_THRESHOLD is 3', () => {
        expect(DEFAULT_THRESHOLD).toBe(3);
    });
    test('P0 promotes faster than P2/P3', () => {
        expect(SEVERITY_THRESHOLD_OVERRIDE.P0).toBeLessThan(SEVERITY_THRESHOLD_OVERRIDE.P2);
        expect(SEVERITY_THRESHOLD_OVERRIDE.P0).toBe(2);
    });
    test('every pain axis maps to a known vehicle', () => {
        for (const tag of PAIN_TAXONOMY) {
            const m = PAIN_AXIS_TO_VEHICLE[tag];
            expect(m).toBeDefined();
            expect(RULE_VEHICLES).toContain(m.vehicle);
            expect(typeof m.target).toBe('string');
            expect(m.target.length).toBeGreaterThan(0);
        }
    });
});

describe('sortChronological()', () => {
    test('sorts ASC by occurredAt, stable by cardId on ties', () => {
        const a = ep('b', 'auth_session', T(2));
        const b = ep('a', 'auth_session', T(2)); // same time, earlier cardId
        const c = ep('c', 'auth_session', T(1));
        const out = sortChronological([a, b, c]).map(e => e.cardId);
        expect(out).toEqual(['c', 'a', 'b']);
    });
    test('does not mutate input', () => {
        const arr = [ep('b', 'auth_session', T(2)), ep('a', 'auth_session', T(1))];
        const snapshot = arr.map(e => e.cardId);
        sortChronological(arr);
        expect(arr.map(e => e.cardId)).toEqual(snapshot);
    });
});

describe('trailingRunForTag()', () => {
    test('returns the unbroken streak ending at the latest tagged episode', () => {
        const sorted = sortChronological([
            ep('c1', 'auth_session', T(0)),
            ep('c2', 'auth_session', T(1)),
            ep('c3', 'auth_session', T(2)),
        ]);
        expect(trailingRunForTag('auth_session', sorted).map(e => e.cardId))
            .toEqual(['c1', 'c2', 'c3']);
    });
    test('an interrupting episode without the tag resets the run', () => {
        const sorted = sortChronological([
            ep('c1', 'auth_session', T(0)),
            ep('c2', 'test_coverage', T(1)), // breaks the auth streak
            ep('c3', 'auth_session', T(2)),
            ep('c4', 'auth_session', T(3)),
        ]);
        // trailing run is only c3,c4 (c1 is before the break)
        expect(trailingRunForTag('auth_session', sorted).map(e => e.cardId))
            .toEqual(['c3', 'c4']);
    });
    test('empty when tag never present', () => {
        const sorted = sortChronological([ep('c1', 'auth_session', T(0))]);
        expect(trailingRunForTag('ux_feedback', sorted)).toEqual([]);
    });
});

describe('effectiveThreshold() / highestSeverity()', () => {
    test('a single P0 in the run pulls the bar to 2', () => {
        const run = [ep('c1', 'auth_session', T(0), 'P2'), ep('c2', 'auth_session', T(1), 'P0')];
        expect(effectiveThreshold(run)).toBe(2);
    });
    test('all-P2 run keeps the default bar of 3', () => {
        const run = [ep('c1', 'auth_session', T(0), 'P2'), ep('c2', 'auth_session', T(1), 'P2')];
        expect(effectiveThreshold(run)).toBe(3);
    });
    test('highestSeverity returns the most severe', () => {
        expect(highestSeverity([
            ep('c1', 'auth_session', T(0), 'P3'),
            ep('c2', 'auth_session', T(1), 'P1'),
        ])).toBe('P1');
    });
});

describe('evaluatePromotions()', () => {
    test('no suggestion below threshold (2 consecutive P2 < bar 3)', () => {
        const out = evaluatePromotions([
            ep('c1', 'task_context', T(0), 'P2'),
            ep('c2', 'task_context', T(1), 'P2'),
        ]);
        expect(out).toEqual([]);
    });

    test('3 consecutive same-axis P2 warnings → one suggestion', () => {
        const out = evaluatePromotions([
            ep('c1', 'task_context', T(0), 'P2'),
            ep('c2', 'task_context', T(1), 'P2'),
            ep('c3', 'task_context', T(2), 'P2'),
        ]);
        expect(out).toHaveLength(1);
        const s = out[0];
        expect(s.painTag).toBe('task_context');
        expect(s.consecutiveCount).toBe(3);
        expect(s.threshold).toBe(3);
        expect(s.vehicle).toBe(PAIN_AXIS_TO_VEHICLE.task_context.vehicle);
        expect(s.supportingCardIds).toEqual(['c1', 'c2', 'c3']);
        expect(s.suggestionId).toBe('promote:task_context:c3');
    });

    test('2 consecutive warnings with a P0 promote early (bar drops to 2)', () => {
        const out = evaluatePromotions([
            ep('c1', 'auth_session', T(0), 'P0'),
            ep('c2', 'auth_session', T(1), 'P2'),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].consecutiveCount).toBe(2);
        expect(out[0].threshold).toBe(2);
        expect(out[0].highestSeverity).toBe('P0');
    });

    test('an interrupting different-axis episode breaks the streak (no promotion)', () => {
        const out = evaluatePromotions([
            ep('c1', 'task_context', T(0), 'P2'),
            ep('c2', 'task_context', T(1), 'P2'),
            ep('c3', 'ux_feedback', T(2), 'P2'), // breaks task_context streak
            ep('c4', 'task_context', T(3), 'P2'),
        ]);
        // task_context trailing run is only c4 → below bar
        const tc = out.find(s => s.painTag === 'task_context');
        expect(tc).toBeUndefined();
    });

    test('deterministic ordering: equal severity → alphabetical painTag', () => {
        // Both axes co-tagged on every episode (neither streak interrupted) and
        // share the same episode-level severities, so highestSeverity ties at P0;
        // tiebreak is alphabetical painTag → task_context before test_coverage.
        const out = evaluatePromotions([
            ep('a1', ['task_context', 'test_coverage'], T(0), 'P2'),
            ep('a2', ['task_context', 'test_coverage'], T(1), 'P0'),
            ep('a3', ['task_context', 'test_coverage'], T(2), 'P2'),
        ]);
        expect(out.map(s => s.painTag)).toEqual(['task_context', 'test_coverage']);
        expect(out.every(s => s.highestSeverity === 'P0')).toBe(true);
    });

    test('a later different-axis episode resets the prior axis trailing run', () => {
        // task_context streak of 3, then 2 unrelated test_coverage episodes —
        // task_context no longer has a TRAILING run (it was interrupted), so it
        // does not promote; test_coverage (only 2, P0) does via the P0 bar drop.
        const out = evaluatePromotions([
            ep('a1', 'task_context', T(0), 'P2'),
            ep('a2', 'task_context', T(1), 'P2'),
            ep('a3', 'task_context', T(2), 'P2'),
            ep('b1', 'test_coverage', T(3), 'P0'),
            ep('b2', 'test_coverage', T(4), 'P0'),
        ]);
        expect(out.map(s => s.painTag)).toEqual(['test_coverage']);
    });

    test('caller can override the global threshold', () => {
        const out = evaluatePromotions([
            ep('c1', 'task_context', T(0), 'P2'),
            ep('c2', 'task_context', T(1), 'P2'),
        ], { threshold: 2 });
        expect(out).toHaveLength(1);
        expect(out[0].threshold).toBe(2);
    });

    test('empty / non-array input → empty', () => {
        expect(evaluatePromotions([])).toEqual([]);
        expect(evaluatePromotions(null)).toEqual([]);
        expect(evaluatePromotions(undefined)).toEqual([]);
    });

    test('ignores tags outside the closed taxonomy', () => {
        const out = evaluatePromotions([
            ep('c1', 'not_a_real_tag', T(0), 'P0'),
            ep('c2', 'not_a_real_tag', T(1), 'P0'),
        ]);
        expect(out).toEqual([]);
    });
});

describe('renderMetaPrBody()', () => {
    const suggestion = evaluatePromotions([
        ep('c1', 'task_context', T(0), 'P2', { missedChecks: ['no Task Contract published'] }),
        ep('c2', 'task_context', T(1), 'P2', { missedChecks: ['scope drifted mid-card'] }),
        ep('c3', 'task_context', T(2), 'P2', { userFeedback: '不知道自己該做甚麼' }),
    ])[0];

    test('includes axis, count, vehicle, and every supporting episode lesson', () => {
        const md = renderMetaPrBody(suggestion);
        expect(md).toContain('task_context');
        expect(md).toContain('3 consecutive');
        expect(md).toContain(suggestion.vehicle);
        expect(md).toContain('no Task Contract published');
        expect(md).toContain('scope drifted mid-card');
        expect(md).toContain('不知道自己該做甚麼');
        expect(md).toContain('[c1 · P2]');
        expect(md).toContain(`suggestionId: ${suggestion.suggestionId}`);
    });

    test('is deterministic — same suggestion renders identical body', () => {
        expect(renderMetaPrBody(suggestion)).toBe(renderMetaPrBody(suggestion));
    });

    test('falls back to deliverable when no lesson fields present', () => {
        const s = evaluatePromotions([
            ep('d1', 'task_context', T(0), 'P2', { deliverable: 'thing A' }),
            ep('d2', 'task_context', T(1), 'P2', { deliverable: 'thing B' }),
            ep('d3', 'task_context', T(2), 'P2', { deliverable: 'thing C' }),
        ])[0];
        const md = renderMetaPrBody(s);
        expect(md).toContain('thing A');
    });

    test('empty input → empty string', () => {
        expect(renderMetaPrBody(null)).toBe('');
    });
});

describe('buildMetaPrDraft()', () => {
    const s = evaluatePromotions([
        ep('c1', 'test_coverage', T(0), 'P1'),
        ep('c2', 'test_coverage', T(1), 'P1'),
        ep('c3', 'test_coverage', T(2), 'P1'),
    ])[0];

    test('produces title/body/branch/suggestionId', () => {
        const draft = buildMetaPrDraft(s);
        expect(draft.title).toContain('test_coverage');
        expect(draft.title).toContain(s.vehicle);
        expect(draft.branch).toBe('oodar/promote-test-coverage');
        expect(draft.body).toBe(renderMetaPrBody(s));
        expect(draft.suggestionId).toBe(s.suggestionId);
    });
});

describe('integration with real fixtures', () => {
    const FIXTURES = require('../../agent-improvement/__tests__/fixtures/episodes');

    test('runs against the canonical fixture set without throwing', () => {
        const out = evaluatePromotions(FIXTURES);
        expect(Array.isArray(out)).toBe(true);
        // Each fixture has a distinct painTag → no axis reaches a run of 2,
        // so nothing should promote. Guards against false positives.
        expect(out).toEqual([]);
    });
});
