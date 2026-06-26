/**
 * Owner-decision classifier — unit tests.
 *
 * Card: server-side owner-decision inbox classifier (子2).
 *
 * jest.config.js uses testEnvironment: 'node'. The classifier is a pure,
 * dependency-free module, so this lives in tests/jest (the testMatch dir) and
 * imports it by relative path, mirroring agent-improvement-episode-schema.test.js.
 */
'use strict';

const {
    classifyOwnerDecision,
    classifyCardOwnerDecision,
    OWNER_ONLY_CATEGORIES,
} = require('../../agent-improvement/owner-decision-classifier');

describe('classifyOwnerDecision — owner-only positives (1 per category)', () => {
    const POSITIVES = [
        ['irreversible_data', 'We need to DROP TABLE chat_orders to reclaim space'],
        ['spend_cost', 'Upgrade to the paid plan, this will cost $200/month'],
        ['product_direction', 'Should we prioritize the roadmap item for avatars?'],
        ['legal_pii', 'This touches PII retention policy and GDPR compliance'],
        ['security_policy', 'This changes the auth policy and requires secret rotation'],
        ['strategic_tradeoff', 'This is a strategic tradeoff between speed and quality'],
    ];

    test.each(POSITIVES)('category %s → ownerOnly=true and category present', (category, text) => {
        const r = classifyOwnerDecision(text);
        expect(r.ownerOnly).toBe(true);
        expect(r.categories).toContain(category);
        expect(Array.isArray(r.reasons)).toBe(true);
        expect(r.reasons.length).toBeGreaterThan(0);
    });

    test('explicit flag → ownerOnly=true, category explicit_flag', () => {
        const r = classifyOwnerDecision('owner-only decision required before we proceed');
        expect(r.ownerOnly).toBe(true);
        expect(r.categories).toContain('explicit_flag');
    });

    test('每個分類都覆蓋繁中關鍵字', () => {
        expect(classifyOwnerDecision('這個操作不可逆，會抹除資料').categories).toContain('irreversible_data');
        expect(classifyOwnerDecision('要加預算改用付費方案').categories).toContain('spend_cost');
        expect(classifyOwnerDecision('這關係到產品方向要不要做').categories).toContain('product_direction');
        expect(classifyOwnerDecision('涉及個資與保留期合規').categories).toContain('legal_pii');
        expect(classifyOwnerDecision('需要調整權限政策與金鑰輪換').categories).toContain('security_policy');
        expect(classifyOwnerDecision('這是速度與品質的取捨權衡').categories).toContain('strategic_tradeoff');
        expect(classifyOwnerDecision('這是不可授權的決定').categories).toContain('explicit_flag');
    });
});

describe('classifyOwnerDecision — bot-resolvable negatives (ownerOnly=false)', () => {
    const NEGATIVES = [
        ['CI-green reversible PR', 'fix typo, tests green, merge'],
        ['UX vision-check', 'Please vision-check the new settings card layout on mobile and desktop, screenshot attached'],
        ['bugfix', 'Fix null pointer in renderer, add a guard, tests pass'],
        ['dep bump', 'Bump lodash from 4.17.20 to 4.17.21 via dependabot'],
        ['doc update', 'Update the README with local setup steps'],
        ['staleness auto-block', '⏰ 此卡片閒置超過 12 小時，自動移至 blocked 欄，等待認領'],
    ];

    test.each(NEGATIVES)('%s → ownerOnly=false', (_label, text) => {
        const r = classifyOwnerDecision(text);
        expect(r.ownerOnly).toBe(false);
        expect(r.categories).toEqual([]);
    });

    test('empty / non-string is safe and not owner-only', () => {
        expect(classifyOwnerDecision('').ownerOnly).toBe(false);
        expect(classifyOwnerDecision(undefined).ownerOnly).toBe(false);
        expect(classifyOwnerDecision(null).ownerOnly).toBe(false);
    });
});

describe('classifyCardOwnerDecision — card-level helper', () => {
    test('UI vision-check card short-circuits to ownerOnly=false', () => {
        const r = classifyCardOwnerDecision({
            title: 'Polish the settings card spacing',
            description: 'Tighten the avatar layout on mobile',
            requiresScreenshotReview: true,
            painTags: ['ux_feedback'],
        });
        expect(r.ownerOnly).toBe(false);
    });

    test('owner-only work is NOT short-circuited even with screenshot review off', () => {
        const r = classifyCardOwnerDecision({
            title: 'Purge deleted-account PII tables',
            description: 'DROP TABLE on the residual device-scoped tables',
            requiresScreenshotReview: false,
            painTags: ['scope_completeness'],
        });
        expect(r.ownerOnly).toBe(true);
        expect(r.categories).toContain('irreversible_data');
    });

    test('gateReason explicit flag forces ownerOnly even if title/body are benign', () => {
        const r = classifyCardOwnerDecision({
            title: 'Routine cleanup',
            description: 'small refactor',
            gateReason: 'legal-hold: do not auto-resolve',
        });
        expect(r.ownerOnly).toBe(true);
        expect(r.categories).toContain('explicit_flag');
    });

    test('concatenates fields — a keyword only in latestComment still fires', () => {
        const r = classifyCardOwnerDecision({
            title: 'Investigate option',
            description: 'see comment',
            latestComment: 'Recommend we move to the paid plan, budget impact noted',
        });
        expect(r.ownerOnly).toBe(true);
        expect(r.categories).toContain('spend_cost');
    });

    test('a UI card that ALSO requires screenshot but has non-UI painTags is NOT short-circuited', () => {
        const r = classifyCardOwnerDecision({
            title: 'Delete account flow',
            description: 'wipe user data irreversibly',
            requiresScreenshotReview: true,
            painTags: ['scope_completeness'],
        });
        expect(r.ownerOnly).toBe(true);
    });
});

describe('classifier shape invariants', () => {
    test('exposes the enumerated owner-only categories', () => {
        const names = OWNER_ONLY_CATEGORIES.map(c => c.category);
        expect(names).toEqual([
            'irreversible_data',
            'spend_cost',
            'product_direction',
            'legal_pii',
            'security_policy',
            'strategic_tradeoff',
        ]);
    });
});

describe('audit card_c6731c2f — false-positive hardening', () => {
    const fp = (s) => expect(classifyOwnerDecision(s).ownerOnly).toBe(false);
    const tp = (s, cat) => {
        const r = classifyOwnerDecision(s);
        expect(r.ownerOnly).toBe(true);
        if (cat) expect(r.categories).toContain(cat);
    };

    test('F1 — a bare $ no longer trips spend_cost (shell / template / jQuery)', () => {
        fp('fix shell script using $1 and $PATH');
        fp('template literal uses ${foo}');
        fp('refactor the jQuery $ selector');
    });
    test('F1 — a real price shape still fires spend_cost', () => {
        tp('bump the plan, it is $200 per month', 'spend_cost');
        tp('花錢 $1,000 budget', 'spend_cost');
    });
    test('F2 — substring over-matches are gone (suspend / swipe / auto-purge / truncated)', () => {
        fp('account suspended after 3 failed logins');
        fp('fix swipe up gesture');
        fp('auto-purge done cards via doneRetention');
        fp('the log output was truncated');
    });
    test('F2 — the real words still fire', () => {
        tp('we should spend more on infra', 'spend_cost');
        tp('truncate the orders table', 'irreversible_data');
        tp('purge the production database', 'irreversible_data');
    });
    test('F3 — casual 需要你 is not an explicit owner flag', () => {
        fp('這個需要你確認一下');
        fp('需要你幫忙看一下 log');
    });
    test('F3 — a deliberate 需要你<decision-verb> marker still forces ownerOnly', () => {
        tp('需要你決策要不要 rollback', 'explicit_flag');
        tp('這題需要你核可', 'explicit_flag');
    });
});
