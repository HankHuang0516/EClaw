/**
 * done-gate: automation / ops cards are exempt from the PR-link sub-requirement,
 * but STILL must cite the 6-item evidence checklist.
 *
 * Ops/cron cards (health checks, audits, scheduled automations) have NO code
 * change → no PR to cite, so the PR-link check blocked every one of them and
 * forced a manual requiresPreflightReview:false. This exemption keys off the
 * isAutomation flag (is_automation母卡 OR is_auto_generated [Auto] child) that
 * kanban.js passes from the card row.
 */
'use strict';

const {
    evaluateDoneGate,
    PREFLIGHT_MARKER,
} = require('../../agent-improvement/done-gate');

const preflightText = `${PREFLIGHT_MARKER} — auto-composed]\n## 本任務如何避免過往同類錯誤\n...`;

// Build a 6-item evidence comment. Toggle the PR link / a single checklist item.
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

// Common: preflight marker + a jest-log artifact so the ONLY variable under
// test is the PR link / checklist completeness, not the artifact requirement.
function baseComments(evidenceOpts) {
    return [
        mkComment(preflightText, { isSystem: true, t: '2026-06-07T01:00:00Z' }),
        mkComment(evidence(evidenceOpts), { isSystem: false, t: '2026-06-07T02:00:00Z' }),
    ];
}
const jestLog = [mkFile('jest_out.txt', 'text/plain')];

describe('done-gate — automation/ops PR-link exemption', () => {
    test('(a) automation card with 6 items but NO PR link → ALLOWED', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2',
            painTags: ['task_context'],
            comments: baseComments({ pr: false }),
            files: jestLog,
            isAutomation: true,
        });
        expect(v.allowed).toBe(true);
    });

    test('(b) NON-automation card with 6 items but no PR link → BLOCKED on PR link', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2',
            painTags: ['task_context'],
            comments: baseComments({ pr: false }),
            files: jestLog,
            isAutomation: false,
        });
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('PREFLIGHT_GATE_FAILED');
        expect(v.missingItems).toEqual(['PR link']);
    });

    test('(b2) omitting isAutomation entirely is treated as non-automation → still needs PR link', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2',
            painTags: ['task_context'],
            comments: baseComments({ pr: false }),
            files: jestLog,
            // isAutomation not passed
        });
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toEqual(['PR link']);
    });

    test('(c) automation card STILL needs all 6 checklist items — missing one → BLOCKED', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2',
            painTags: ['task_context'],
            comments: baseComments({ pr: false, drop: 'Test plan' }),
            files: jestLog,
            isAutomation: true,
        });
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('PREFLIGHT_GATE_FAILED');
        expect(v.missingItems).toContain('Test plan');
    });

    test('automation card WITH a PR link is still fine (exemption only skips the check, never rejects a present link)', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2',
            painTags: ['task_context'],
            comments: baseComments({ pr: true }),
            files: jestLog,
            isAutomation: true,
        });
        expect(v.allowed).toBe(true);
    });
});
