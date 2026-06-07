/**
 * Phase 1 #3c — done-evidence gate predicate.
 * Card: card_040f1edeaec149afdbb73a29
 *
 * Pure-data unit tests for evaluateDoneGate. The kanban.js callsite is a
 * thin wrapper (fetches comments → forwards to predicate → returns 400 on
 * verdict.allowed=false); the predicate itself owns all the gating logic
 * and is fully covered here without spinning up the router.
 */
'use strict';

const {
    evaluateDoneGate,
    PREFLIGHT_MARKER,
    REQUIRED_EVIDENCE_ITEMS,
} = require('../../agent-improvement/done-gate');

const preflightText = `${PREFLIGHT_MARKER} — auto-composed]\n## 本任務如何避免過往同類錯誤\n...`;
const fullEvidenceText = [
    '[19:50 done evidence]',
    '## Scope — file paths touched',
    '## Acceptance — jest passes',
    '## Test plan — npx jest …',
    '## Evidence plan — output uploaded',
    '## Out-of-scope — deferred items',
].join('\n');

function mkComment(text, { isSystem = false, t = '2026-06-07T00:00:00Z' } = {}) {
    return { text, isSystem, createdAt: t };
}

describe('evaluateDoneGate() — transition shapes', () => {
    test('allows non-done transitions unconditionally', () => {
        const v = evaluateDoneGate({ oldStatus: 'todo', newStatus: 'in_progress', comments: [] });
        expect(v.allowed).toBe(true);
    });

    test('allows in_progress→review unconditionally (only done is gated)', () => {
        const v = evaluateDoneGate({ oldStatus: 'in_progress', newStatus: 'review', comments: [] });
        expect(v.allowed).toBe(true);
    });

    test('allows done→done no-op', () => {
        const v = evaluateDoneGate({ oldStatus: 'done', newStatus: 'done', comments: [] });
        expect(v.allowed).toBe(true);
    });
});

describe('evaluateDoneGate() — bypass', () => {
    test('allows when requiresPreflightReview === false', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: false,
            comments: [],
        });
        expect(v.allowed).toBe(true);
    });

    test('gates when requiresPreflightReview === true', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            comments: [],
        });
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('PREFLIGHT_GATE_FAILED');
    });

    test('gates by default when requiresPreflightReview omitted', () => {
        const v = evaluateDoneGate({ oldStatus: 'in_progress', newStatus: 'done', comments: [] });
        expect(v.allowed).toBe(false);
    });
});

describe('evaluateDoneGate() — preflight presence', () => {
    test('rejects when no preflight marker comment exists', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            comments: [mkComment('random chatter'), mkComment(fullEvidenceText)],
        });
        expect(v.allowed).toBe(false);
        expect(v.error).toMatch(/Preflight comment missing/);
    });

    test('finds preflight in a system comment too (auto-fire path)', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            comments: [
                mkComment(preflightText, { isSystem: true, t: '2026-06-07T01:00:00Z' }),
                mkComment(fullEvidenceText, { isSystem: false, t: '2026-06-07T02:00:00Z' }),
            ],
        });
        expect(v.allowed).toBe(true);
    });
});

describe('evaluateDoneGate() — evidence checklist', () => {
    test('rejects when no evidence comment follows preflight', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            comments: [mkComment(preflightText, { isSystem: true })],
        });
        expect(v.allowed).toBe(false);
        expect(v.error).toMatch(/Evidence comment/);
        expect(v.missingItems).toEqual(REQUIRED_EVIDENCE_ITEMS.slice());
    });

    test('rejects when evidence is missing one item, reports which', () => {
        const partial = fullEvidenceText.replace('## Acceptance — jest passes', '## TODO');
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            comments: [
                mkComment(preflightText, { isSystem: true, t: '2026-06-07T01:00:00Z' }),
                mkComment(partial, { isSystem: false, t: '2026-06-07T02:00:00Z' }),
            ],
        });
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toEqual(['Acceptance']);
    });

    test('rejects when evidence is missing multiple items, reports best-effort smallest gap', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            comments: [
                mkComment(preflightText, { isSystem: true, t: '2026-06-07T01:00:00Z' }),
                mkComment('just Scope', { isSystem: false, t: '2026-06-07T02:00:00Z' }),
                mkComment('Scope and Acceptance and Test plan', { isSystem: false, t: '2026-06-07T03:00:00Z' }),
            ],
        });
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toEqual(['Evidence plan', 'Out-of-scope']);
    });

    test('ignores system comments when looking for evidence', () => {
        // a system comment with all 5 items doesn't count — must be a human-authored evidence comment
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            comments: [
                mkComment(preflightText, { isSystem: true, t: '2026-06-07T01:00:00Z' }),
                mkComment(fullEvidenceText, { isSystem: true, t: '2026-06-07T02:00:00Z' }),
            ],
        });
        expect(v.allowed).toBe(false);
    });

    test('ignores evidence comments POSTED BEFORE the preflight (chronology matters)', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            comments: [
                mkComment(fullEvidenceText, { isSystem: false, t: '2026-06-07T00:00:00Z' }),
                mkComment(preflightText, { isSystem: true, t: '2026-06-07T01:00:00Z' }),
            ],
        });
        expect(v.allowed).toBe(false);
    });

    test('accepts when preflight is followed by a complete evidence comment', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            comments: [
                mkComment(preflightText, { isSystem: true, t: '2026-06-07T01:00:00Z' }),
                mkComment(fullEvidenceText, { isSystem: false, t: '2026-06-07T02:00:00Z' }),
            ],
        });
        expect(v.allowed).toBe(true);
    });
});

describe('evaluateDoneGate() — defensive shape', () => {
    test('handles missing/non-array comments', () => {
        const v = evaluateDoneGate({ oldStatus: 'in_progress', newStatus: 'done' });
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('PREFLIGHT_GATE_FAILED');
    });

    test('ignores comments with non-string text', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            comments: [
                { text: null, isSystem: false },
                { text: 42, isSystem: false },
            ],
        });
        expect(v.allowed).toBe(false);
        expect(v.error).toMatch(/Preflight comment missing/);
    });
});

describe('PREFLIGHT_MARKER / REQUIRED_EVIDENCE_ITEMS contract', () => {
    test('marker matches composer output literal', () => {
        expect(PREFLIGHT_MARKER).toBe('[OODA-R preflight');
    });

    test('5 evidence items in canonical order', () => {
        expect(REQUIRED_EVIDENCE_ITEMS).toEqual([
            'Scope',
            'Acceptance',
            'Test plan',
            'Evidence plan',
            'Out-of-scope',
        ]);
    });
});
