/**
 * 計畫E ratify-reversibility — unit tests (card_e9d01b6e).
 *
 * The green-light predicate is fail-CLOSED: default_agree ONLY when a reversible
 * class + a real PR + a clean diff/path scan + no owner-decision veto all hold.
 * These tests pin every HOLD path so a regression can't silently widen
 * auto-merge eligibility.
 */
'use strict';

const { classifyRatifyMode, ALLOWED_CLASSES } = require('../../agent-improvement/ratify-reversibility');

const base = (over = {}) => ({
    proposalText: 'Tweak the empty-state copy on the dashboard',
    decidedOptionLabel: 'use the friendlier wording',
    reversibilityClass: 'copy_text',
    changedFiles: ['backend/public/portal/chat.html'],
    diffSummary: '- old copy\n+ new friendlier copy',
    prUrl: 'https://github.com/HankHuang0516/EClaw/pull/9999',
    ...over,
});

const mode = (over) => classifyRatifyMode(base(over)).mode;

describe('classifyRatifyMode — the happy (default_agree) path', () => {
    test('reversible copy change with PR + clean diff + no veto ⇒ default_agree', () => {
        const v = classifyRatifyMode(base());
        expect(v.mode).toBe('default_agree');
        expect(v.holdReasons).toEqual([]);
    });
    test('each allowed class can pass when everything else is clean', () => {
        for (const cls of ALLOWED_CLASSES) {
            expect(mode({ reversibilityClass: cls,
                proposalText: 'minor reversible change', decidedOptionLabel: 'do the small thing',
                diffSummary: '+ a harmless line' })).toBe('default_agree');
        }
    });
});

describe('classifyRatifyMode — fail-closed HOLD paths', () => {
    test('unknown / missing reversibility class ⇒ hold', () => {
        expect(mode({ reversibilityClass: 'something_new' })).toBe('hold');
        expect(mode({ reversibilityClass: undefined })).toBe('hold');
    });
    test('missing or non-http PR url ⇒ hold (branch-first prove)', () => {
        expect(mode({ prUrl: undefined })).toBe('hold');
        expect(mode({ prUrl: 'not-a-url' })).toBe('hold');
        expect(mode({ prUrl: 'javascript:alert(1)' })).toBe('hold');
    });
    test('no changed files AND no diff ⇒ hold (un-auditable)', () => {
        expect(mode({ changedFiles: [], diffSummary: '' })).toBe('hold');
    });
    test('oversized diff ⇒ hold', () => {
        expect(mode({ diffSummary: 'x'.repeat(200001) })).toBe('hold');
    });

    describe('path scanner — irreversible-once-merged / high-blast paths', () => {
        const cases = [
            'backend/migrations/0007_drop_legacy.sql',
            'backend/agent_action_requests_schema.sql',
            'backend/billing/charge.js',
            'backend/auth.js',
            'backend/routes/oauth-callback.js',
            'backend/.env.production',
            'Dockerfile',
            'railway.json',
            '.github/workflows/ci.yml',
        ];
        test.each(cases)('danger path %s ⇒ hold', (f) => {
            expect(mode({ reversibilityClass: 'reversible_code_branch', changedFiles: [f] })).toBe('hold');
        });
        test('an ordinary source path does NOT trip the scanner', () => {
            expect(mode({ reversibilityClass: 'reversible_code_branch',
                changedFiles: ['backend/utils/format.js'] })).toBe('default_agree');
        });
    });

    describe('diff-content scanner — destructive ops regardless of path', () => {
        const danger = [
            'ALTER TABLE users DROP COLUMN email;',
            'DROP TABLE sessions;',
            'TRUNCATE chat_history;',
            'DELETE FROM devices;',          // no WHERE
            'await fs.unlink(path);',
            'rm -rf /var/data',
        ];
        test.each(danger)('destructive diff %s ⇒ hold', (d) => {
            expect(mode({ reversibilityClass: 'reversible_code_branch', diffSummary: d })).toBe('hold');
        });
        test('a scoped DELETE ... WHERE is not flagged by the no-WHERE rule', () => {
            expect(mode({ reversibilityClass: 'reversible_code_branch',
                diffSummary: 'DELETE FROM devices WHERE id = $1;' })).toBe('default_agree');
        });
    });

    describe('owner-decision classifier is a VETO (necessary, never the green light)', () => {
        test('an owner-only proposal ⇒ hold even with a clean diff + PR + allowed class', () => {
            expect(mode({ proposalText: '加預算改用付費方案 升級訂閱', decidedOptionLabel: '核准付費' })).toBe('hold');
            expect(mode({ proposalText: 'this is owner-only / 不可授權', decidedOptionLabel: 'go' })).toBe('hold');
        });
        test('relatedCardText also feeds the veto', () => {
            expect(mode({ relatedCardText: '這操作不可逆，會抹除資料' })).toBe('hold');
        });
    });

    test('fail-closed on a non-object input', () => {
        expect(classifyRatifyMode(undefined).mode).toBe('hold');
        expect(classifyRatifyMode(null).mode).toBe('hold');
        expect(classifyRatifyMode('nope').mode).toBe('hold');
    });
});
