/**
 * done-gate isUiCard classifier — sourced from requires_screenshot_review, NOT
 * painTag (card_b76e6590, Hank 2026-07-09).
 *
 * DEFECT (fixed here): the done-gate inferred "this is a UI card, hard-require a
 * [VISION] image attestation" from the card's painTag (e.g. `delivery_reliability`,
 * assigned by the keyword classifier to any card mentioning delivery/retry/回饋),
 * NOT from the explicit requires_screenshot_review field. Result: pure-backend
 * cron cards and semantic-a11y cards — which carry requires_screenshot_review=false
 * — were mis-classified as UI cards and HARD-BLOCKED demanding an impossible /
 * low-value screenshot (mis-fired 3× in one session).
 *
 * These tests FAIL on the pre-fix code (painTag drives the UI branch → the backend
 * card is demanded vision) and PASS after the fix (only the explicit
 * requires_screenshot_review / isUiCard override drives it).
 *
 * They also cover Fix (2): for a NON-UI card, a `[TEST]` red→green attestation
 * comment substitutes for the jest-log FILE artifact ("語意卡可用測試證據替代截圖").
 */
'use strict';

const {
    evaluateDoneGate,
    detectUiCard,
    detectUxCard,
    inferIsUiCard,
    PREFLIGHT_MARKER,
    TEST_ATTESTATION_TOKEN,
    VISION_TOKEN,
} = require('../../agent-improvement/done-gate');

const preflightText = `${PREFLIGHT_MARKER} — auto-composed]\n## 本任務如何避免過往同類錯誤\n...`;

function evidence() {
    return [
        '## Scope — done', '## Acceptance — done', '## Test plan — done',
        '## Evidence plan — done', '## Out-of-scope — none', '## User POV — verified',
    ].join('\n');
}
function mkComment(text, opts = {}) {
    return { text, isSystem: opts.isSystem ?? false, createdAt: opts.t ?? '2026-07-09T02:00:00Z' };
}
function mkFile(filename, mimeType, t = '2026-07-09T03:00:00Z') {
    return { filename, mime_type: mimeType, created_at: t };
}

const preflight = mkComment(preflightText, { isSystem: true, t: '2026-07-09T01:00:00Z' });
const fullEvidence = mkComment(evidence(), { isSystem: false, t: '2026-07-09T02:00:00Z' });
const jestFile = mkFile('jest_out.txt', 'text/plain');

// ── (1) classifier predicate — unit level ────────────────────────────────────
describe('detectUiCard / detectUxCard key off explicit flags, NOT painTag', () => {
    // The exact defect scenario: a UI-looking painTag on a card with the explicit
    // screenshot-review flag OFF must NOT be classified as a UI card.
    test('painTag delivery_reliability + requiresScreenshotReview:false → NOT a UI card', () => {
        expect(detectUiCard({ painTags: ['delivery_reliability'], requiresScreenshotReview: false })).toBe(false);
    });
    test('painTag ux_feedback (no explicit flag) → NOT a UI card', () => {
        expect(detectUiCard({ painTags: ['ux_feedback'] })).toBe(false);
    });
    test('painTag frontend/visual (no explicit flag) → NOT a UI card', () => {
        expect(detectUiCard({ painTags: ['frontend', 'visual'] })).toBe(false);
    });
    test('requiresScreenshotReview:true → IS a UI card (the real signal)', () => {
        expect(detectUiCard({ requiresScreenshotReview: true })).toBe(true);
    });
    test('explicit isUiCard override still wins either way', () => {
        expect(detectUiCard({ isUiCard: true, requiresScreenshotReview: false })).toBe(true);
        expect(detectUiCard({ isUiCard: false, requiresScreenshotReview: true })).toBe(false);
    });
    test('an attached image does NOT auto-promote to UI (payload has no files arg either)', () => {
        expect(detectUiCard({ painTags: ['task_context'] })).toBe(false);
    });

    test('painTag scroll/drag/navigation (no explicit flag) → NOT a UX card', () => {
        expect(detectUxCard({ painTags: ['scroll', 'drag', 'navigation'] })).toBe(false);
    });
    test('requiresInteractionReview:true → IS a UX card (the real signal)', () => {
        expect(detectUxCard({ requiresInteractionReview: true })).toBe(true);
    });

    test('inferIsUiCard (severity-tier) also keys off the explicit flag, not painTag', () => {
        expect(inferIsUiCard({ painTags: ['delivery_reliability'] })).toBe(false);
        expect(inferIsUiCard({ requiresScreenshotReview: true })).toBe(true);
        expect(inferIsUiCard({ isUiCard: true })).toBe(true);
    });
});

// ── (1) end-to-end through evaluateDoneGate — the gate the move-hook calls ────
describe('evaluateDoneGate: backend card with a UI-looking painTag is NOT demanded vision', () => {
    // RED on old code (painTag delivery_reliability ∈ UI_CARD_PAIN_TAGS → the HARD
    // vision block fires → allowed:false, missing vision_screenshot_artifact).
    // GREEN after fix: a backend card (requires_screenshot_review=false) with a
    // jest log closes cleanly, no vision demand.
    test('cron/backend card (painTag delivery_reliability, no screenshot flag) → allowed, no vision demand', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P1',
            requiresScreenshotReview: false,
            painTags: ['delivery_reliability'],
            comments: [preflight, fullEvidence],
            files: [jestFile],
            softMode: true,
        });
        expect(v.allowed).toBe(true);
        expect(v.softWarning).toBeUndefined();
    });

    test('same backend card in HARD mode also closes cleanly (no false vision block)', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P1',
            requiresScreenshotReview: false,
            painTags: ['ux_feedback'],
            comments: [preflight, fullEvidence],
            files: [jestFile],
            softMode: false,
        });
        expect(v.allowed).toBe(true);
    });

    test('a GENUINE UI card (requires_screenshot_review=true) STILL demands vision (unchanged)', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P1',
            requiresScreenshotReview: true,
            painTags: [],
            comments: [preflight, fullEvidence],   // no image, no [VISION]
            files: [jestFile],
            softMode: true,
        });
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toContain('vision_screenshot_artifact');
    });
});

// ── (2) semantic-evidence path — [TEST] attestation replaces the log file ─────
describe('non-UI card may use a [TEST] red→green attestation in lieu of a jest-log FILE', () => {
    const testAttestation = mkComment(
        `${TEST_ATTESTATION_TOKEN} added done-gate-isuicard-from-screenshot-review.test.js; it fails on old painTag-keyed code (backend card demanded vision) and passes after — red→green verified`,
        { t: '2026-07-09T02:30:00Z' }
    );

    test('backend card with NO file but a [TEST] attestation → closes cleanly (soft)', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2',
            requiresScreenshotReview: false,
            comments: [preflight, fullEvidence, testAttestation],
            files: [],   // no jest-log file at all
            softMode: true,
        });
        expect(v.allowed).toBe(true);
        expect(v.softWarning).toBeUndefined();
    });

    test('backend card with NO file + [TEST] attestation → passes even in HARD mode', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2',
            requiresScreenshotReview: false,
            comments: [preflight, fullEvidence, testAttestation],
            files: [],
            softMode: false,
        });
        expect(v.allowed).toBe(true);
    });

    test('a bare [TEST] token (too short) does NOT satisfy the artifact bar', () => {
        const bare = mkComment(`${TEST_ATTESTATION_TOKEN} ok`, { t: '2026-07-09T02:30:00Z' }); // <15 chars
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2',
            requiresScreenshotReview: false,
            comments: [preflight, fullEvidence, bare],
            files: [],
            softMode: true,
        });
        expect(v.allowed).toBe(true);   // soft mode allows
        expect(v.softWarning.missing).toContain('jest_output_artifact');
    });

    test('the [TEST] escape hatch does NOT weaken a genuine UI card', () => {
        // A UI card cannot swap its screenshot for a [TEST] comment — the HARD
        // vision block is independent and still fires.
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P1',
            requiresScreenshotReview: true,   // UI card
            comments: [preflight, fullEvidence, testAttestation, mkComment(`${VISION_TOKEN} looked at it`, { t: '2026-07-09T02:35:00Z' })],
            files: [],   // no image
            softMode: true,
        });
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toContain('vision_screenshot_artifact');
    });
});
