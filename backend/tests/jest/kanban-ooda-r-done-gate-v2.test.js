/**
 * Phase 1 #4 — hardened done-gate (v2: artifact + DoD/AC + severity tier)
 *                + heartbeat sweeper selectors.
 * Card: card_337040389de34bcb65cf0cb0
 */
'use strict';

const {
    evaluateDoneGate,
    PREFLIGHT_MARKER,
    USER_POV_ALIASES,
    PR_LINK_PATTERN,
} = require('../../agent-improvement/done-gate');

const {
    classifyCard,
    classifyBatch,
    PROMPT_AFTER_MS,
    ESCALATE_AFTER_MS,
} = require('../../agent-improvement/heartbeat');

const preflightText = `${PREFLIGHT_MARKER} — auto-composed]\n## 本任務如何避免過往同類錯誤\n...`;

function evidence(opts = {}) {
    const includePR = opts.pr !== false;
    const includeUserPOV = opts.userPOV !== false;
    const items = [
        '## Scope', '## Acceptance', '## Test plan',
        '## Evidence plan', '## Out-of-scope',
    ];
    if (includeUserPOV) items.push('## User POV');
    const lines = items.map(h => `${h} — written content here`);
    if (includePR) lines.push('see https://github.com/HankHuang0516/EClaw/pull/9999 for the merged change');
    return lines.join('\n');
}

function mkComment(text, opts = {}) {
    return {
        text,
        isSystem: opts.isSystem ?? false,
        createdAt: opts.t ?? '2026-06-07T00:00:00Z',
    };
}

function mkFile(filename, mimeType, t = '2026-06-07T03:00:00Z') {
    return { filename, mime_type: mimeType, created_at: t };
}

describe('evaluateDoneGate v2 — artifact requirements', () => {
    const baseComments = [
        mkComment(preflightText, { isSystem: true, t: '2026-06-07T01:00:00Z' }),
        mkComment(evidence(), { isSystem: false, t: '2026-06-07T02:00:00Z' }),
    ];

    test('P2 non-UI: jest log alone passes', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2',
            painTags: ['task_context'],
            comments: baseComments,
            files: [mkFile('jest_out.txt', 'text/plain')],
        });
        expect(v.allowed).toBe(true);
    });

    test('P2 non-UI: NO file at all → rejected with jest_output_artifact', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2',
            painTags: ['task_context'],
            comments: baseComments,
            files: [],
        });
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toEqual(['jest_output_artifact']);
    });

    test('P0 UI card: jest log only is NOT enough, requires screenshot too', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P0',
            painTags: ['ux_feedback'],
            comments: baseComments,
            files: [mkFile('jest_out.txt', 'text/plain')],
        });
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toEqual(['screenshot_artifact']);
    });

    test('P0 UI card: jest log + screenshot both → pass', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P0',
            painTags: ['ux_feedback'],
            comments: baseComments,
            files: [
                mkFile('jest_out.txt', 'text/plain'),
                mkFile('proof.png', 'image/png'),
            ],
        });
        expect(v.allowed).toBe(true);
    });

    test('P3 UI card: screenshot is OPTIONAL (severity tier)', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P3',
            painTags: ['ux_feedback'],
            comments: baseComments,
            files: [mkFile('jest_out.txt', 'text/plain')],
        });
        expect(v.allowed).toBe(true);
    });

    test('files uploaded BEFORE the preflight don\'t count', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2',
            painTags: ['task_context'],
            comments: baseComments,
            files: [mkFile('older_jest.txt', 'text/plain', '2026-06-06T23:00:00Z')],
        });
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toEqual(['jest_output_artifact']);
    });

    test('image-only file does NOT satisfy jest_output requirement', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2',
            painTags: ['task_context'],
            comments: baseComments,
            files: [mkFile('screen.png', 'image/png')],
        });
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toEqual(['jest_output_artifact']);
    });

    test('filename-pattern fallback when mime is generic (jest in name)', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2',
            painTags: ['task_context'],
            comments: baseComments,
            files: [mkFile('p1_4_jest_output.txt', 'application/octet-stream')],
        });
        expect(v.allowed).toBe(true);
    });
});

describe('evaluateDoneGate v2 — PR link requirement', () => {
    const baseFiles = [{ filename: 'jest.txt', mime_type: 'text/plain', created_at: '2026-06-07T03:00:00Z' }];

    test('rejected when no github.com pull/N link in evidence', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2',
            painTags: ['task_context'],
            comments: [
                mkComment(preflightText, { isSystem: true, t: '2026-06-07T01:00:00Z' }),
                mkComment(evidence({ pr: false }), { isSystem: false, t: '2026-06-07T02:00:00Z' }),
            ],
            files: baseFiles,
        });
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toEqual(['PR link']);
    });

    test('PR_LINK_PATTERN matches real github URLs', () => {
        expect(PR_LINK_PATTERN.test('https://github.com/HankHuang0516/EClaw/pull/3230')).toBe(true);
        expect(PR_LINK_PATTERN.test('http://github.com/foo/bar/pull/1')).toBe(true);
        expect(PR_LINK_PATTERN.test('gitlab.com/foo/bar/pull/1')).toBe(false);
        expect(PR_LINK_PATTERN.test('https://github.com/foo/bar/issues/1')).toBe(false);
    });
});

describe('evaluateDoneGate v2 — User POV 6th item', () => {
    test('English "User POV" alias accepted', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2',
            painTags: ['task_context'],
            comments: [
                mkComment(preflightText, { isSystem: true, t: '2026-06-07T01:00:00Z' }),
                mkComment(evidence(), { isSystem: false, t: '2026-06-07T02:00:00Z' }),
            ],
            files: [mkFile('jest.txt', 'text/plain')],
        });
        expect(v.allowed).toBe(true);
    });

    test('Chinese "用戶角度" alias accepted', () => {
        const text = [
            '## Scope', '## Acceptance', '## Test plan',
            '## Evidence plan', '## Out-of-scope', '## 用戶角度',
            'https://github.com/foo/bar/pull/1',
        ].join('\n');
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2',
            painTags: ['task_context'],
            comments: [
                mkComment(preflightText, { isSystem: true, t: '2026-06-07T01:00:00Z' }),
                mkComment(text, { isSystem: false, t: '2026-06-07T02:00:00Z' }),
            ],
            files: [mkFile('jest.txt', 'text/plain')],
        });
        expect(v.allowed).toBe(true);
    });

    test('missing User POV → rejected with User POV in missingItems', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2',
            painTags: ['task_context'],
            comments: [
                mkComment(preflightText, { isSystem: true, t: '2026-06-07T01:00:00Z' }),
                mkComment(evidence({ userPOV: false }), { isSystem: false, t: '2026-06-07T02:00:00Z' }),
            ],
            files: [mkFile('jest.txt', 'text/plain')],
        });
        expect(v.allowed).toBe(false);
        expect(v.missingItems.some(s => s.includes('User POV') || s.includes('用戶角度'))).toBe(true);
    });

    test('USER_POV_ALIASES contains both EN and ZH labels', () => {
        expect(USER_POV_ALIASES).toContain('User POV');
        expect(USER_POV_ALIASES).toContain('用戶角度');
    });
});

describe('evaluateDoneGate v1 backward compat — no files/severity passed', () => {
    test('v1 caller (no files, no severity) — 5 items still pass, no PR/User POV needed', () => {
        const evidenceV1 = [
            '## Scope', '## Acceptance', '## Test plan',
            '## Evidence plan', '## Out-of-scope',
        ].join('\n');
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            comments: [
                mkComment(preflightText, { isSystem: true, t: '2026-06-07T01:00:00Z' }),
                mkComment(evidenceV1, { isSystem: false, t: '2026-06-07T02:00:00Z' }),
            ],
            // no files, no severity → v1 path
        });
        expect(v.allowed).toBe(true);
    });
});

describe('heartbeat — classifyCard', () => {
    const now = Date.parse('2026-06-07T20:00:00Z'); // 04:00 TW the next day

    test('idle when not in_progress', () => {
        expect(classifyCard({ status: 'todo', statusChangedAt: 0 }, now)).toBe('idle');
    });

    test('idle when last activity within 2h', () => {
        const lastSec = new Date(now - 1 * 60 * 60 * 1000).toISOString();
        const v = classifyCard({
            status: 'in_progress',
            statusChangedAt: '2026-06-07T05:00:00Z',
            lastNonSystemCommentAt: lastSec,
        }, now);
        expect(v).toBe('idle');
    });

    test('prompt_due at >2h', () => {
        const v = classifyCard({
            status: 'in_progress',
            statusChangedAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
            lastNonSystemCommentAt: null,
            lastHeartbeatPromptAt: null,
        }, now);
        expect(v).toBe('prompt_due');
    });

    test('prompt suppressed if already prompted within 2h', () => {
        const v = classifyCard({
            status: 'in_progress',
            statusChangedAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
            lastNonSystemCommentAt: null,
            lastHeartbeatPromptAt: new Date(now - 30 * 60 * 1000).toISOString(),
        }, now);
        expect(v).toBe('idle');
    });

    test('escalate_due at >24h', () => {
        const v = classifyCard({
            status: 'in_progress',
            statusChangedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
            lastNonSystemCommentAt: null,
            lastEscalateAt: null,
        }, now);
        expect(v).toBe('escalate_due');
    });

    test('escalate suppressed if already escalated within 12h', () => {
        const v = classifyCard({
            status: 'in_progress',
            statusChangedAt: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
            lastNonSystemCommentAt: null,
            lastEscalateAt: new Date(now - 6 * 60 * 60 * 1000).toISOString(),
        }, now);
        expect(v).toBe('idle');
    });

    test('lastNonSystemCommentAt resets the clock', () => {
        // status changed 5h ago, but a comment was posted 30min ago → idle
        const v = classifyCard({
            status: 'in_progress',
            statusChangedAt: new Date(now - 5 * 60 * 60 * 1000).toISOString(),
            lastNonSystemCommentAt: new Date(now - 30 * 60 * 1000).toISOString(),
        }, now);
        expect(v).toBe('idle');
    });

    test('PROMPT_AFTER_MS < ESCALATE_AFTER_MS sanity', () => {
        expect(PROMPT_AFTER_MS).toBeLessThan(ESCALATE_AFTER_MS);
    });
});

describe('heartbeat — classifyBatch', () => {
    const now = Date.parse('2026-06-07T20:00:00Z');

    test('partitions a mixed list', () => {
        const cards = [
            { status: 'todo' },
            { status: 'in_progress', statusChangedAt: new Date(now - 30 * 60 * 1000).toISOString() }, // fresh
            { status: 'in_progress', statusChangedAt: new Date(now - 3 * 60 * 60 * 1000).toISOString() }, // prompt
            { status: 'in_progress', statusChangedAt: new Date(now - 26 * 60 * 60 * 1000).toISOString() }, // escalate
        ];
        const { prompt, escalate } = classifyBatch(cards, now);
        expect(prompt.length).toBe(1);
        expect(escalate.length).toBe(1);
    });

    test('handles non-array input', () => {
        const { prompt, escalate } = classifyBatch(null, now);
        expect(prompt).toEqual([]);
        expect(escalate).toEqual([]);
    });
});

describe('evaluateDoneGate v2 — evidence comment selection (card_4c3a75bc)', () => {
    // Regression: the gate used to lock onto the FIRST comment with all 6 items.
    // If that comment lacked the PR link, a LATER comment that added the link was
    // never read ("先到先贏 — 後補 PR link 永遠讀不到").
    const preflight = mkComment(preflightText, { isSystem: true, t: '2026-06-07T01:00:00Z' });
    const completeNoPr = mkComment(evidence({ pr: false }), { t: '2026-06-07T02:00:00Z' });
    const completeWithPr = mkComment(evidence({ pr: true }), { t: '2026-06-07T03:00:00Z' });
    const jest = mkFile('jest_out.txt', 'text/plain', '2026-06-07T04:00:00Z');

    test('earlier complete-but-no-PR comment + later complete-with-PR comment → PASS', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2', painTags: ['task_context'],
            comments: [preflight, completeNoPr, completeWithPr],
            files: [jest],
        });
        expect(v.allowed).toBe(true);
    });

    test('order-independent: PR-link comment BEFORE a later no-PR comment still PASS', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2', painTags: ['task_context'],
            comments: [preflight, completeWithPr, completeNoPr],
            files: [jest],
        });
        expect(v.allowed).toBe(true);
    });

    test('still fails when NO complete comment carries a PR link', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2', painTags: ['task_context'],
            comments: [preflight, completeNoPr],
            files: [jest],
        });
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toEqual(['PR link']);
    });
});
