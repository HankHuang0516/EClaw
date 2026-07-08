/**
 * done-gate: PR-link enforcement is a PER-CARD OPT-IN option (requirePrLink),
 * DEFAULT OFF (not blocking).
 *
 * Owner directive 2026-07-03 (Hank):
 *   「PR link 是 option 且默認不阻擋。應該是創卡的時候就要設定 PR link option
 *     啟動阻擋 或關閉阻擋。自動化任務母卡也應該要能設定這個部分。」
 *
 * Behavior under test (the load-bearing rule):
 *   - requirePrLink absent / false  → PR link is NOT required at done (default no block).
 *   - requirePrLink === true         → the evidence comment MUST cite a github PR link.
 *   - The 6-item evidence checklist is ALWAYS enforced regardless of requirePrLink.
 *   - Automation/ops cards stay exempt from the PR-link sub-check even when opted in
 *     (redundant safety on top of the default-off behavior — see
 *     donegate-ops-prlink-exempt.test.js).
 *
 * This supersedes / generalises PR #3870's automation-only PR-link exemption:
 * everything is exempt by default; opting in (requirePrLink:true) turns it on.
 */
'use strict';

const {
    evaluateDoneGate,
    PREFLIGHT_MARKER,
} = require('../../agent-improvement/done-gate');

const preflightText = `${PREFLIGHT_MARKER} — auto-composed]\n## 本任務如何避免過往同類錯誤\n...`;

// Build a 6-item evidence comment. Toggle the PR link / drop one checklist item.
function evidence(opts = {}) {
    const includePR = opts.pr !== false;
    const dropItem = opts.drop || null; // e.g. 'Test plan' to omit that heading
    const items = [
        'Scope', 'Acceptance', 'Test plan',
        'Evidence plan', 'Out-of-scope', 'User POV',
    ].filter(h => h !== dropItem);
    const lines = items.map(h => `## ${h} — written content here`);
    if (includePR) {
        lines.push('see https://github.com/HankHuang0516/EClaw/pull/9999 for the change');
    }
    return lines.join('\n');
}

function mkComment(text, opts = {}) {
    return {
        text,
        isSystem: opts.isSystem ?? false,
        createdAt: opts.t ?? '2026-06-07T02:00:00Z',
    };
}

function mkFile(filename, mimeType, t = '2026-06-07T03:00:00Z') {
    return { filename, mime_type: mimeType, created_at: t };
}

// preflight marker (system) + one evidence comment. jest-log artifact so the ONLY
// variable under test is the PR link / checklist completeness.
function baseComments(evidenceOpts) {
    return [
        mkComment(preflightText, { isSystem: true, t: '2026-06-07T01:00:00Z' }),
        mkComment(evidence(evidenceOpts), { isSystem: false, t: '2026-06-07T02:00:00Z' }),
    ];
}
const jestLog = [mkFile('jest_out.txt', 'text/plain')];

function baseInput(extra = {}) {
    return {
        oldStatus: 'in_progress', newStatus: 'done',
        requiresPreflightReview: true,
        severity: 'P2',
        painTags: ['task_context'],
        files: jestLog,
        ...extra,
    };
}

describe('done-gate — per-card requirePrLink option (default off)', () => {
    // (a) opted IN + 6 items + NO PR link → BLOCKED on PR link
    test('(a) requirePrLink:true + 6 items + NO PR link → BLOCKED with "PR link"', () => {
        const v = evaluateDoneGate(baseInput({
            comments: baseComments({ pr: false }),
            requirePrLink: true,
        }));
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('PREFLIGHT_GATE_FAILED');
        expect(v.missingItems).toEqual(['PR link']);
        expect(v.error).toMatch(/PR link/i);
    });

    // (b) default off — requirePrLink:false + 6 items + no PR link → ALLOWED
    test('(b) requirePrLink:false + 6 items + no PR link → ALLOWED (default no longer blocks)', () => {
        const v = evaluateDoneGate(baseInput({
            comments: baseComments({ pr: false }),
            requirePrLink: false,
        }));
        expect(v.allowed).toBe(true);
    });

    // (b2) default off — requirePrLink absent entirely + no PR link → ALLOWED
    test('(b2) requirePrLink ABSENT + 6 items + no PR link → ALLOWED (default off)', () => {
        const v = evaluateDoneGate(baseInput({
            comments: baseComments({ pr: false }),
            // requirePrLink not passed
        }));
        expect(v.allowed).toBe(true);
    });

    // (b3) explicit non-true truthy-ish values do NOT enable enforcement — only === true does
    test('(b3) requirePrLink truthy-but-not-true (e.g. "true" string / 1) does NOT enforce', () => {
        for (const val of ['true', 1, {}, 'yes']) {
            const v = evaluateDoneGate(baseInput({
                comments: baseComments({ pr: false }),
                requirePrLink: val,
            }));
            expect(v.allowed).toBe(true);
        }
    });

    // (c) opted IN + PR link present → ALLOWED
    test('(c) requirePrLink:true + PR link present → ALLOWED', () => {
        const v = evaluateDoneGate(baseInput({
            comments: baseComments({ pr: true }),
            requirePrLink: true,
        }));
        expect(v.allowed).toBe(true);
    });

    // (d) 6-item checklist still enforced regardless of requirePrLink
    describe('(d) 6-item checklist ALWAYS enforced regardless of requirePrLink', () => {
        test('requirePrLink:false, missing a checklist item → BLOCKED on that item', () => {
            const v = evaluateDoneGate(baseInput({
                comments: baseComments({ pr: false, drop: 'Test plan' }),
                requirePrLink: false,
            }));
            expect(v.allowed).toBe(false);
            expect(v.code).toBe('PREFLIGHT_GATE_FAILED');
            expect(v.missingItems).toContain('Test plan');
        });

        test('requirePrLink absent, missing a checklist item → BLOCKED on that item', () => {
            const v = evaluateDoneGate(baseInput({
                comments: baseComments({ pr: false, drop: 'Acceptance' }),
            }));
            expect(v.allowed).toBe(false);
            expect(v.missingItems).toContain('Acceptance');
        });

        test('requirePrLink:true, missing a checklist item → BLOCKED on the item (not PR link first)', () => {
            const v = evaluateDoneGate(baseInput({
                comments: baseComments({ pr: false, drop: 'Out-of-scope' }),
                requirePrLink: true,
            }));
            expect(v.allowed).toBe(false);
            expect(v.missingItems).toContain('Out-of-scope');
        });
    });

    // Automation exemption is a redundant safety on top of default-off: even when
    // a card opts in, automation/ops cards skip the PR-link sub-check.
    test('(e) requirePrLink:true + isAutomation:true + no PR link → ALLOWED (automation exempt even opted-in)', () => {
        const v = evaluateDoneGate(baseInput({
            comments: baseComments({ pr: false }),
            requirePrLink: true,
            isAutomation: true,
        }));
        expect(v.allowed).toBe(true);
    });

    // Artifact (jest log) requirement is orthogonal — still enforced when opted in.
    test('(f) requirePrLink:true + 6 items + PR link but NO jest artifact → BLOCKED on jest artifact', () => {
        const v = evaluateDoneGate(baseInput({
            comments: baseComments({ pr: true }),
            requirePrLink: true,
            files: [], // no artifact after preflight
        }));
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toEqual(['jest_output_artifact']);
    });
});
