/**
 * SOFT done-gate mode (owner decision card_f52ef42e).
 *
 * Hank's choice: "軟 gate：無交付物只掛 ⚠️ chip + 擋自動升級，不硬擋移動，零誤擋風險".
 * These tests pin the pure evaluateDoneGate contract + the device-preferences
 * done_gate_mode coercion. They FAIL on the pre-soft code (which had no softMode
 * arg → always hard-blocked) and PASS after.
 *
 * The kanban.js move-hook wiring (⚠️ comment + done_gate_soft_flagged + escalation
 * suppression) is DB/router-bound; it is exercised end-to-end by the existing
 * kanban integration tests. Here we prove the gate CONTRACT the hook relies on.
 */
'use strict';

const {
    evaluateDoneGate,
    buildSoftWarning,
    PREFLIGHT_MARKER,
} = require('../../agent-improvement/done-gate');
const devicePrefs = require('../../device-preferences');

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
    return { text, isSystem: opts.isSystem ?? false, createdAt: opts.t ?? '2026-06-07T00:00:00Z' };
}
function mkFile(filename, mimeType, t = '2026-06-07T03:00:00Z') {
    return { filename, mime_type: mimeType, created_at: t };
}

const preflight = mkComment(preflightText, { isSystem: true, t: '2026-06-07T01:00:00Z' });
const fullEvidence = mkComment(evidence(), { isSystem: false, t: '2026-06-07T02:00:00Z' });
const jestFile = mkFile('jest_out.txt', 'text/plain');

describe('SOFT done-gate — (a) incomplete card moves to done, NOT blocked, ⚠️ recorded', () => {
    test('no preflight + no evidence + no file → allowed with a softWarning', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2', painTags: ['task_context'],
            comments: [], files: [],
            softMode: true,
        });
        expect(v.allowed).toBe(true);
        expect(v.softWarning).toBeTruthy();
        expect(v.softWarning.missing).toContain('preflight_comment');
        expect(typeof v.softWarning.summary).toBe('string');
        expect(v.softWarning.summary).toContain('軟 gate');
    });

    test('preflight present but missing jest artifact → allowed with jest_output_artifact warning', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2', painTags: ['task_context'],
            comments: [preflight, fullEvidence], files: [],
            softMode: true,
        });
        expect(v.allowed).toBe(true);
        expect(v.softWarning.missing).toContain('jest_output_artifact');
    });

    test('missing evidence checklist → allowed and the checklist gap is surfaced', () => {
        const noEvidence = mkComment('just a note, no checklist', { t: '2026-06-07T02:00:00Z' });
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2', painTags: ['task_context'],
            comments: [preflight, noEvidence], files: [jestFile],
            softMode: true,
        });
        expect(v.allowed).toBe(true);
        expect(v.softWarning).toBeTruthy();
        expect(v.softWarning.missing.length).toBeGreaterThan(0);
    });
});

describe('SOFT done-gate — (b) pure-backend card gets NO screenshot demand/block', () => {
    // The painTag delivery_reliability WOULD infer isUiCard=true (bug the callsite
    // fixes by passing isUiCard=requires_screenshot_review). Prove that an explicit
    // isUiCard:false overrides the painTag inference and never demands a screenshot,
    // in BOTH modes, for a P0 card (the tier that would otherwise require a shot).
    test('soft: P0 backend card (isUiCard:false, delivery_reliability) → clean pass, no screenshot warning', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P0',
            isUiCard: false,
            painTags: ['delivery_reliability'],
            comments: [preflight, fullEvidence],
            files: [jestFile],
            softMode: true,
        });
        expect(v.allowed).toBe(true);
        expect(v.softWarning).toBeUndefined();
    });

    test('hard: same P0 backend card also passes (isUiCard:false overrides painTag)', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P0',
            isUiCard: false,
            painTags: ['delivery_reliability'],
            comments: [preflight, fullEvidence],
            files: [jestFile],
            softMode: false,
        });
        expect(v.allowed).toBe(true);
    });

    test('regression guard: WITHOUT the explicit isUiCard, the painTag alone infers UI → hard-blocked', () => {
        // card_5d50ee10 tightened this: delivery_reliability is a UI_CARD_PAIN_TAG,
        // so the HARD vision check now fires FIRST (even before the old severity-tier
        // screenshot check), demanding both an image and a [VISION] attestation. The
        // card is still blocked — now on the stronger vision sentinels. The callsite
        // avoids this false-positive by passing an explicit isUiCard=false for
        // backend cards (see the two tests above).
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P0',
            painTags: ['delivery_reliability'],
            comments: [preflight, fullEvidence],
            files: [jestFile],
            softMode: false,
        });
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toEqual(['vision_screenshot_artifact', 'vision_attestation']);
    });
});

describe('SOFT done-gate — (c) HARD mode preserves the legacy hard-block byte-for-byte', () => {
    test('missing jest artifact → rejected (no softMode)', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2', painTags: ['task_context'],
            comments: [preflight, fullEvidence], files: [],
            softMode: false,
        });
        expect(v.allowed).toBe(false);
        expect(v.code).toBe('PREFLIGHT_GATE_FAILED');
        expect(v.missingItems).toEqual(['jest_output_artifact']);
        expect(v.softWarning).toBeUndefined();
    });

    test('missing preflight → rejected (no softMode, default behaviour)', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P2', painTags: ['task_context'],
            comments: [], files: [],
        });
        expect(v.allowed).toBe(false);
        expect(v.error).toBe('Preflight comment missing');
    });

    test('P0 UI card missing screenshot → rejected (no softMode)', () => {
        const v = evaluateDoneGate({
            oldStatus: 'in_progress', newStatus: 'done',
            requiresPreflightReview: true,
            severity: 'P0', painTags: ['ux_feedback'],
            comments: [preflight, fullEvidence], files: [jestFile],
            softMode: false,
        });
        expect(v.allowed).toBe(false);
        expect(v.missingItems).toEqual(['screenshot_artifact']);
    });
});

describe('SOFT done-gate — (d) fully-evidenced card moves cleanly with NO warning in either mode', () => {
    const full = {
        oldStatus: 'in_progress', newStatus: 'done',
        requiresPreflightReview: true,
        severity: 'P2', painTags: ['task_context'],
        comments: [preflight, fullEvidence], files: [jestFile],
    };
    test('soft: allowed, no softWarning', () => {
        const v = evaluateDoneGate({ ...full, softMode: true });
        expect(v.allowed).toBe(true);
        expect(v.softWarning).toBeUndefined();
    });
    test('hard: allowed', () => {
        const v = evaluateDoneGate({ ...full, softMode: false });
        expect(v.allowed).toBe(true);
    });
});

describe('SOFT done-gate — buildSoftWarning maps sentinels to human labels', () => {
    test('maps known sentinels', () => {
        const w = buildSoftWarning(['preflight_comment', 'jest_output_artifact', 'screenshot_artifact', 'PR link']);
        expect(w.missing).toEqual(['preflight_comment', 'jest_output_artifact', 'screenshot_artifact', 'PR link']);
        expect(w.summary).toContain('OODA-R preflight 留言');
        expect(w.summary).toContain('jest/測試 log 附件');
        expect(w.summary).toContain('截圖附件');
        expect(w.summary).toContain('PR 連結');
        expect(w.summary).toContain('zero false-block');
    });
    test('unknown sentinel passes through', () => {
        const w = buildSoftWarning(['something_new']);
        expect(w.summary).toContain('something_new');
    });
});

describe('SOFT done-gate — device pref done_gate_mode coercion', () => {
    test('DEFAULTS.done_gate_mode is "soft" (Hank\'s choice)', () => {
        expect(devicePrefs.DEFAULTS.done_gate_mode).toBe('soft');
    });

    test('coerce via updatePrefs: only exact "hard" → hard; everything else → soft', async () => {
        const calls = [];
        const stubPool = {
            query: jest.fn().mockImplementation((sql, params) => {
                calls.push({ sql, params });
                return Promise.resolve({ rows: [], rowCount: 0 });
            }),
        };
        await devicePrefs.initTable(stubPool);

        const cases = [
            { in: 'hard', out: 'hard' },
            { in: 'soft', out: 'soft' },
            { in: 'HARD', out: 'soft' },   // case-sensitive: only exact 'hard'
            { in: 'garbage', out: 'soft' },
            { in: true, out: 'soft' },     // non-string junk fails SAFE to soft
            { in: '', out: 'soft' },
        ];
        for (const c of cases) {
            calls.length = 0;
            await devicePrefs.updatePrefs('dev-soft-test', { done_gate_mode: c.in });
            const insert = calls.find(x => /INSERT INTO device_preferences/i.test(x.sql));
            expect(insert).toBeTruthy();
            const stored = JSON.parse(insert.params[1]);
            expect(stored.done_gate_mode).toBe(c.out);
        }
    });
});
