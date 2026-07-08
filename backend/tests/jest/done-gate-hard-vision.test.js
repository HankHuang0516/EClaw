/**
 * HARD vision / interaction evidence done-gate (card_5d50ee10, P0).
 *
 * Fixes the class of "card marked done but has a visible bug the owner had to
 * find" failures: a UI card cannot close without proof the reviewer LOOKED
 * (an image attachment + a [VISION] attestation of what was seen), and a UX card
 * cannot close without proof the reviewer OPERATED (a [UX-OPERATED] attestation +
 * an interaction artifact).
 *
 * These two checks are the whole point of the gate — they HARD-BLOCK a →done move
 * EVEN IN SOFT MODE (soft mode must NOT suppress them). A pure backend card that
 * is neither UI nor UX is completely unaffected (still soft).
 *
 * Every test here FAILS on the pre-card_5d50ee10 code (which had no [VISION] /
 * [UX-OPERATED] concept and let soft mode allow everything) and PASSES after.
 */
'use strict';

const {
    evaluateDoneGate,
    PREFLIGHT_MARKER,
    VISION_TOKEN,
    UX_OPERATED_TOKEN,
} = require('../../agent-improvement/done-gate');

const preflightText = `${PREFLIGHT_MARKER} — auto-composed]\n## 本任務如何避免過往同類錯誤\n...`;

function evidence() {
    return [
        '## Scope — done', '## Acceptance — done', '## Test plan — done',
        '## Evidence plan — done', '## Out-of-scope — none', '## User POV — verified',
    ].join('\n');
}
function mkComment(text, opts = {}) {
    return { text, isSystem: opts.isSystem ?? false, createdAt: opts.t ?? '2026-07-04T02:00:00Z' };
}
function mkFile(filename, mimeType, t = '2026-07-04T03:00:00Z') {
    return { filename, mime_type: mimeType, created_at: t };
}

const preflight = mkComment(preflightText, { isSystem: true, t: '2026-07-04T01:00:00Z' });
const fullEvidence = mkComment(evidence(), { isSystem: false, t: '2026-07-04T02:00:00Z' });
const jestFile = mkFile('jest_out.txt', 'text/plain');
const imageFile = mkFile('after.png', 'image/png');
const visionComment = mkComment(`${VISION_TOKEN} the reply box grew from 26px to 146px and the grip renders 280x12`, { t: '2026-07-04T02:30:00Z' });
const uxOperatedComment = mkComment(`${UX_OPERATED_TOKEN} drove a real touch swipe on the inbox; scrollTop moved 0→320 and window.scrollY stayed 0`, { t: '2026-07-04T02:30:00Z' });

// Base for a UI card, explicit signal via requiresScreenshotReview.
function uiBase(extra = {}) {
    return {
        oldStatus: 'in_progress', newStatus: 'done',
        requiresPreflightReview: true,
        severity: 'P1',
        requiresScreenshotReview: true,   // explicit UI signal (automatic detection)
        comments: [preflight, fullEvidence],
        files: [jestFile],
        ...extra,
    };
}
// Base for a UX card, explicit signal via requiresInteractionReview.
function uxBase(extra = {}) {
    return {
        oldStatus: 'in_progress', newStatus: 'done',
        requiresPreflightReview: true,
        severity: 'P1',
        requiresInteractionReview: true,   // explicit UX signal
        comments: [preflight, fullEvidence],
        files: [jestFile],
        ...extra,
    };
}

describe('HARD vision evidence — UI cards blocked EVEN IN SOFT MODE without image + [VISION]', () => {
    test('UI card missing image → blocked (soft mode)', () => {
        const v = evaluateDoneGate(uiBase({
            // has [VISION] comment but NO image attachment after preflight
            comments: [preflight, fullEvidence, visionComment],
            files: [jestFile],   // jest log only, no image
            softMode: true,
        }));
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toContain('vision_screenshot_artifact');
    });

    test('UI card missing image → blocked (hard mode too)', () => {
        const v = evaluateDoneGate(uiBase({
            comments: [preflight, fullEvidence, visionComment],
            files: [jestFile],
            softMode: false,
        }));
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toContain('vision_screenshot_artifact');
    });

    test('UI card with image but NO [VISION] comment → blocked (even soft)', () => {
        const v = evaluateDoneGate(uiBase({
            comments: [preflight, fullEvidence],   // no [VISION] attestation
            files: [jestFile, imageFile],
            softMode: true,
        }));
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toContain('vision_attestation');
    });

    test('UI card with image + [VISION] present but description too short → blocked', () => {
        const shortVision = mkComment(`${VISION_TOKEN} ok`, { t: '2026-07-04T02:30:00Z' }); // <15 chars after token
        const v = evaluateDoneGate(uiBase({
            comments: [preflight, fullEvidence, shortVision],
            files: [jestFile, imageFile],
            softMode: true,
        }));
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toContain('vision_attestation');
    });

    test('UI card with image + [VISION] + real description → allowed', () => {
        const v = evaluateDoneGate(uiBase({
            comments: [preflight, fullEvidence, visionComment],
            files: [jestFile, imageFile],
            softMode: true,
        }));
        expect(v.allowed).toBe(true);
        expect(v.missingItems).toBeUndefined();
    });

    test('automatic UI detection: painTag "frontend" alone triggers the vision check', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true, severity: 'P2',
            painTags: ['frontend'],
            comments: [preflight, fullEvidence],   // no image, no [VISION]
            files: [jestFile],
            softMode: true,
        });
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toContain('vision_screenshot_artifact');
    });

    test('automatic UI detection: an attached image makes it a UI card (needs [VISION])', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true, severity: 'P2',
            // no explicit flag, no UI painTag — but an image is attached
            comments: [preflight, fullEvidence],
            files: [jestFile, imageFile],
            softMode: true,
        });
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toContain('vision_attestation');
    });
});

describe('HARD interaction evidence — UX cards blocked EVEN IN SOFT MODE without [UX-OPERATED] + artifact', () => {
    test('UX card missing [UX-OPERATED] → blocked (soft mode)', () => {
        const v = evaluateDoneGate(uxBase({
            comments: [preflight, fullEvidence],   // no [UX-OPERATED]
            files: [jestFile],                     // has an artifact
            softMode: true,
        }));
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toContain('ux_operated_attestation');
    });

    test('UX card with [UX-OPERATED] but short description → blocked', () => {
        const shortOp = mkComment(`${UX_OPERATED_TOKEN} tapped`, { t: '2026-07-04T02:30:00Z' }); // <15 chars
        const v = evaluateDoneGate(uxBase({
            comments: [preflight, fullEvidence, shortOp],
            files: [jestFile],
            softMode: true,
        }));
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toContain('ux_operated_attestation');
    });

    test('UX card with [UX-OPERATED] but NO artifact → blocked', () => {
        const v = evaluateDoneGate(uxBase({
            comments: [preflight, fullEvidence, uxOperatedComment],
            files: [],   // no artifact at all
            softMode: true,
        }));
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toContain('ux_interaction_artifact');
    });

    test('UX card with [UX-OPERATED] + artifact → allowed', () => {
        const v = evaluateDoneGate(uxBase({
            comments: [preflight, fullEvidence, uxOperatedComment],
            files: [jestFile],
            softMode: true,
        }));
        expect(v.allowed).toBe(true);
        expect(v.missingItems).toBeUndefined();
    });

    test('UX card whose ONLY artifact is an image is ALSO auto-classified UI → needs [VISION] too', () => {
        // Automatic detection: an attached image makes any card a UI card. So a UX
        // card whose interaction artifact is a screenshot must additionally carry a
        // [VISION] attestation. Without it, the vision check blocks first.
        const v = evaluateDoneGate(uxBase({
            comments: [preflight, fullEvidence, uxOperatedComment],
            files: [imageFile],
            softMode: true,
        }));
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toContain('vision_attestation');
    });

    test('UX card operated with an image artifact + a [VISION] attestation → allowed (dual-classified)', () => {
        const v = evaluateDoneGate(uxBase({
            comments: [preflight, fullEvidence, uxOperatedComment, visionComment],
            files: [imageFile],
            softMode: true,
        }));
        expect(v.allowed).toBe(true);
    });

    test('automatic UX detection: painTag "scroll" alone triggers the interaction check', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true, severity: 'P2',
            painTags: ['scroll'],
            comments: [preflight, fullEvidence],   // no [UX-OPERATED]
            files: [jestFile],
            softMode: true,
        });
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toContain('ux_operated_attestation');
    });
});

describe('HARD checks do NOT touch pure backend cards (still soft)', () => {
    test('pure non-UI/non-UX backend card is unaffected — soft allows with warning, no hard block', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2',
            isUiCard: false,                 // explicit: not a UI card
            painTags: ['task_context'],      // no UI/UX painTag
            comments: [preflight, fullEvidence],
            files: [],                       // missing jest → soft warning, NOT a hard block
            softMode: true,
        });
        expect(v.allowed).toBe(true);        // soft mode lets it through
        expect(v.softWarning).toBeTruthy();
        expect(v.softWarning.missing).toContain('jest_output_artifact');
        // and crucially NONE of the hard vision/UX sentinels appear
        expect(v.softWarning.missing).not.toContain('vision_attestation');
        expect(v.softWarning.missing).not.toContain('ux_operated_attestation');
    });

    test('fully-evidenced backend card → clean pass, no warning', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2',
            isUiCard: false,
            painTags: ['task_context'],
            comments: [preflight, fullEvidence],
            files: [jestFile],
            softMode: true,
        });
        expect(v.allowed).toBe(true);
        expect(v.softWarning).toBeUndefined();
    });

    test('explicit isUiCard:false overrides an attached image (no vision demand)', () => {
        // A backend card that happens to attach a diagram image must NOT be forced
        // into the UI-vision branch when the reviewer explicitly said isUiCard:false.
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2',
            isUiCard: false,
            painTags: ['task_context'],
            comments: [preflight, fullEvidence],
            files: [jestFile, imageFile],
            softMode: true,
        });
        expect(v.allowed).toBe(true);
        expect(v.softWarning).toBeUndefined();
    });
});

describe('HARD checks are inert for non-done / opted-out moves', () => {
    test('move to review (not done) is never gated by the vision check', () => {
        const v = evaluateDoneGate(uiBase({ newStatus: 'review', softMode: true, files: [jestFile] }));
        expect(v.allowed).toBe(true);
    });
    test('requiresPreflightReview:false opts the whole card out', () => {
        const v = evaluateDoneGate(uiBase({ requiresPreflightReview: false, softMode: true, files: [jestFile] }));
        expect(v.allowed).toBe(true);
    });
});
