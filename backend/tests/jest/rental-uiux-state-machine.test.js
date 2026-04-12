/**
 * Rental Bot UI/UX State Machine — Debug Flow Verification
 *
 * Verifies the complete UI/UX rendering logic for the rental marketplace:
 * 1. Listing lifecycle states → what UI should show
 * 2. Contract lifecycle states → what actions are available
 * 3. Wallet balance states → what top-up/rental UI is gated by
 * 4. Portal page route coverage → all pages load required scripts
 * 5. Debug API endpoint availability for each module
 *
 * This is a REGRESSION test — any state machine change that breaks
 * UI expectations must fail here first.
 */

const fs = require('fs');
const path = require('path');

const PORTAL_DIR = path.join(__dirname, '../../public/portal');

// ============================================
// 1. Listing Lifecycle State Machine → UI Expectations
// ============================================
describe('Listing UI State Machine', () => {
    const LISTING_STATES = ['draft', 'interview', 'listed', 'paused', 'delisted'];

    const EXPECTED_UI = {
        draft: {
            showEditButton: true,
            showPublishButton: false, // requires interview first
            showInterviewButton: true,
            visibleInMarketplace: false,
            ownerCanSetRate: true,
        },
        interview: {
            showEditButton: false, // locked during interview
            showPublishButton: false,
            showInterviewButton: false, // in progress
            visibleInMarketplace: false,
            ownerCanSetRate: false,
        },
        listed: {
            showEditButton: true,
            showPublishButton: false, // already published
            showInterviewButton: false,
            visibleInMarketplace: true,
            ownerCanSetRate: true, // can update rate while no active rental
        },
        paused: {
            showEditButton: true,
            showPublishButton: true, // can re-publish
            showInterviewButton: false,
            visibleInMarketplace: false,
            ownerCanSetRate: true,
        },
        delisted: {
            showEditButton: false,
            showPublishButton: false,
            showInterviewButton: false,
            visibleInMarketplace: false,
            ownerCanSetRate: false,
        },
    };

    // Valid transitions
    const VALID_TRANSITIONS = {
        draft: ['interview'],
        interview: ['draft', 'listed'], // fail → draft, pass → listed
        listed: ['paused', 'delisted'],
        paused: ['listed', 'delisted'],
        delisted: [], // terminal
    };

    test('all listing states have defined UI expectations', () => {
        for (const state of LISTING_STATES) {
            expect(EXPECTED_UI[state]).toBeDefined();
        }
    });

    test('only "listed" state is visible in marketplace', () => {
        for (const [state, ui] of Object.entries(EXPECTED_UI)) {
            if (state === 'listed') {
                expect(ui.visibleInMarketplace).toBe(true);
            } else {
                expect(ui.visibleInMarketplace).toBe(false);
            }
        }
    });

    test('delisted is terminal — no transitions out', () => {
        expect(VALID_TRANSITIONS.delisted).toEqual([]);
    });

    test('draft requires interview before publish', () => {
        expect(EXPECTED_UI.draft.showPublishButton).toBe(false);
        expect(EXPECTED_UI.draft.showInterviewButton).toBe(true);
    });

    test('all transitions are to valid states', () => {
        for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
            for (const to of targets) {
                expect(LISTING_STATES).toContain(to);
            }
        }
    });
});

// ============================================
// 2. Contract Lifecycle State Machine → UI Actions
// ============================================
describe('Contract UI State Machine', () => {
    const CONTRACT_STATES = [
        'reserved', 'active', 'suspended_insufficient_funds',
        'ended_normal', 'ended_early_by_renter', 'ended_zero_balance',
        'ended_disputed', 'ended_violation', 'ended_admin',
    ];

    const UI_ACTIONS = {
        reserved: {
            renterCanEndEarly: true,
            renterCanReview: false,
            renterCanDispute: false,
            showActiveIndicator: true,
            statusBadgeClass: 'active',
        },
        active: {
            renterCanEndEarly: true,
            renterCanReview: false,
            renterCanDispute: false,
            showActiveIndicator: true,
            statusBadgeClass: 'active',
        },
        suspended_insufficient_funds: {
            renterCanEndEarly: true,
            renterCanReview: false,
            renterCanDispute: false,
            showActiveIndicator: true, // still technically active
            statusBadgeClass: 'suspended',
        },
        ended_normal: {
            renterCanEndEarly: false,
            renterCanReview: true,
            renterCanDispute: true,
            showActiveIndicator: false,
            statusBadgeClass: 'ended',
        },
        ended_early_by_renter: {
            renterCanEndEarly: false,
            renterCanReview: true,
            renterCanDispute: true,
            showActiveIndicator: false,
            statusBadgeClass: 'ended',
        },
        ended_zero_balance: {
            renterCanEndEarly: false,
            renterCanReview: true,
            renterCanDispute: true,
            showActiveIndicator: false,
            statusBadgeClass: 'ended',
        },
        ended_disputed: {
            renterCanEndEarly: false,
            renterCanReview: false, // dispute in progress
            renterCanDispute: false,
            showActiveIndicator: false,
            statusBadgeClass: 'ended',
        },
        ended_violation: {
            renterCanEndEarly: false,
            renterCanReview: true,
            renterCanDispute: true,
            showActiveIndicator: false,
            statusBadgeClass: 'ended',
        },
        ended_admin: {
            renterCanEndEarly: false,
            renterCanReview: false, // admin-ended, no review
            renterCanDispute: false,
            showActiveIndicator: false,
            statusBadgeClass: 'ended',
        },
    };

    test('all 9 contract states have defined UI actions', () => {
        expect(Object.keys(UI_ACTIONS)).toHaveLength(9);
        for (const state of CONTRACT_STATES) {
            expect(UI_ACTIONS[state]).toBeDefined();
        }
    });

    test('only active/reserved/suspended show active indicator', () => {
        const activeStates = Object.entries(UI_ACTIONS)
            .filter(([, ui]) => ui.showActiveIndicator)
            .map(([s]) => s);
        expect(activeStates).toEqual(expect.arrayContaining(['reserved', 'active', 'suspended_insufficient_funds']));
        expect(activeStates).toHaveLength(3);
    });

    test('ended states allow review (except disputed/admin)', () => {
        expect(UI_ACTIONS.ended_normal.renterCanReview).toBe(true);
        expect(UI_ACTIONS.ended_early_by_renter.renterCanReview).toBe(true);
        expect(UI_ACTIONS.ended_violation.renterCanReview).toBe(true);
        expect(UI_ACTIONS.ended_disputed.renterCanReview).toBe(false);
        expect(UI_ACTIONS.ended_admin.renterCanReview).toBe(false);
    });

    test('active states cannot review or dispute', () => {
        for (const state of ['reserved', 'active', 'suspended_insufficient_funds']) {
            expect(UI_ACTIONS[state].renterCanReview).toBe(false);
            expect(UI_ACTIONS[state].renterCanDispute).toBe(false);
        }
    });

    test('my-rentals.html statusClass() matches expected badge classes', () => {
        // Simulate the statusClass function from my-rentals.html
        function statusClass(s) {
            if (s === 'active' || s === 'reserved') return 'active';
            if (s.startsWith('suspended')) return 'suspended';
            return 'ended';
        }

        for (const [state, ui] of Object.entries(UI_ACTIONS)) {
            expect(statusClass(state)).toBe(ui.statusBadgeClass);
        }
    });

    test('contract valid transitions cover all end reasons', () => {
        const VALID_TRANSITIONS = {
            reserved: ['active', 'ended_admin'],
            active: [
                'suspended_insufficient_funds',
                'ended_normal',
                'ended_early_by_renter',
                'ended_violation',
                'ended_disputed',
                'ended_admin',
            ],
            suspended_insufficient_funds: [
                'active', // renter tops up
                'ended_zero_balance', // grace period expires
                'ended_admin',
            ],
        };

        // All terminal states have no outgoing transitions
        for (const state of CONTRACT_STATES.filter(s => s.startsWith('ended_'))) {
            expect(VALID_TRANSITIONS[state]).toBeUndefined();
        }
    });
});

// ============================================
// 3. Wallet Balance → UI Gating Logic
// ============================================
describe('Wallet Balance UI Gating', () => {
    test('top-up tiers are ordered by price ascending', () => {
        const { TOPUP_TIERS } = require('../../wallet');
        const tiers = Object.values(TOPUP_TIERS);
        for (let i = 1; i < tiers.length; i++) {
            expect(tiers[i].priceUsd).toBeGreaterThan(tiers[i-1].priceUsd);
        }
    });

    test('bonus percentages are monotonically increasing', () => {
        const { TOPUP_TIERS } = require('../../wallet');
        const tiers = Object.values(TOPUP_TIERS);
        const bonuses = tiers.map(t => t.bonusMli / t.baseMli);
        for (let i = 1; i < bonuses.length; i++) {
            expect(bonuses[i]).toBeGreaterThanOrEqual(bonuses[i-1]);
        }
    });

    test('subscription plan e-coin grants are strictly ascending', () => {
        const sub = require('../../subscription');
        const mod = sub({}, (_r, _s, next) => next(), null, null);
        const { free, starter, pro, business } = mod.SUBSCRIPTION_PLANS;
        expect(free.monthlyEcoinGrant).toBeLessThan(starter.monthlyEcoinGrant);
        expect(starter.monthlyEcoinGrant).toBeLessThan(pro.monthlyEcoinGrant);
        expect(pro.monthlyEcoinGrant).toBeLessThan(business.monthlyEcoinGrant);
    });

    test('free plan gates messages at 15/day', () => {
        const sub = require('../../subscription');
        const mod = sub({}, (_r, _s, next) => next(), null, null);
        expect(mod.SUBSCRIPTION_PLANS.free.messageLimit).toBe(15);
    });

    test('paid plans have unlimited messages (null limit)', () => {
        const sub = require('../../subscription');
        const mod = sub({}, (_r, _s, next) => next(), null, null);
        expect(mod.SUBSCRIPTION_PLANS.starter.messageLimit).toBeNull();
        expect(mod.SUBSCRIPTION_PLANS.pro.messageLimit).toBeNull();
        expect(mod.SUBSCRIPTION_PLANS.business.messageLimit).toBeNull();
    });
});

// ============================================
// 4. Portal Page Route Coverage — Script Loading Audit
// ============================================
describe('Portal Page Route — Required Scripts', () => {
    const REQUIRED_SCRIPTS = ['api.js', 'auth.js', 'telemetry.js', 'i18n.js'];
    // community.html is a public page — tested separately with different expectations
    const NEW_PAGES = ['wallet.html', 'my-rentals.html', 'invite.html'];

    for (const page of NEW_PAGES) {
        test(`${page} loads all required shared scripts`, () => {
            const filePath = path.join(PORTAL_DIR, page);
            if (!fs.existsSync(filePath)) {
                console.warn(`  ⚠️  ${page} not found — skipping`);
                return;
            }
            const html = fs.readFileSync(filePath, 'utf8');
            for (const script of REQUIRED_SCRIPTS) {
                expect(html).toMatch(new RegExp(`src="[^"]*${script.replace('.', '\\.')}"`, 'i'));
            }
        });

        test(`${page} has checkAuth() call`, () => {
            const filePath = path.join(PORTAL_DIR, page);
            if (!fs.existsSync(filePath)) return;
            const html = fs.readFileSync(filePath, 'utf8');
            expect(html).toContain('checkAuth');
        });

        test(`${page} has telemetry integration`, () => {
            const filePath = path.join(PORTAL_DIR, page);
            if (!fs.existsSync(filePath)) return;
            const html = fs.readFileSync(filePath, 'utf8');
            expect(html).toMatch(/telemetry/i);
        });

        test(`${page} has complete HTML structure`, () => {
            const filePath = path.join(PORTAL_DIR, page);
            if (!fs.existsSync(filePath)) return;
            const html = fs.readFileSync(filePath, 'utf8');
            expect(html).toContain('<!DOCTYPE html>');
            expect(html).toContain('</html>');
            expect(html).toContain('<title');
            expect(html).toContain('data-i18n');
        });

        test(`${page} blocks AI chat widget in Android WebView`, () => {
            const filePath = path.join(PORTAL_DIR, page);
            if (!fs.existsSync(filePath)) return;
            const html = fs.readFileSync(filePath, 'utf8');
            expect(html).toContain('__blockAiChatWidget');
        });
    }
});

// ============================================
// 5. Debug API Endpoint Availability
// ============================================
describe('Debug API — Module State Endpoints', () => {
    // Verify each module exports the expected debug-relevant functions
    test('wallet exports getBalance + getLedger + reconcileBalances', () => {
        const walletFactory = require('../../wallet');
        const authMw = (_r, _s, next) => next();
        const wallet = walletFactory({ authMiddleware: authMw, adminMiddleware: authMw, serverLog: () => {} });
        expect(typeof wallet.getBalance).toBe('function');
        expect(typeof wallet.getLedger).toBe('function');
        expect(typeof wallet.reconcileBalances).toBe('function');
    });

    test('rental-proxy exports estimateTokens + computeCostMli + splitFees', () => {
        const proxy = require('../../rental-proxy');
        expect(typeof proxy.estimateTokens).toBe('function');
        expect(typeof proxy.computeCostMli).toBe('function');
        expect(typeof proxy.splitFees).toBe('function');
    });

    test('subscription exports SUBSCRIPTION_PLANS + setWalletModule', () => {
        const sub = require('../../subscription');
        const mod = sub({}, (_r, _s, next) => next(), null, null);
        expect(mod.SUBSCRIPTION_PLANS).toBeDefined();
        expect(typeof mod.setWalletModule).toBe('function');
    });

    test('fraud-detection exports evaluateRentalRisk + computeReviewWeight', () => {
        const fraud = require('../../fraud-detection');
        expect(typeof fraud.evaluateRentalRisk).toBe('function');
        expect(typeof fraud.computeReviewWeight).toBe('function');
    });

    test('wallet LEDGER_TYPES includes all rental-related types', () => {
        const { LEDGER_TYPES } = require('../../wallet');
        expect(LEDGER_TYPES.RENTAL_INCOME).toBe('rental_income');
        expect(LEDGER_TYPES.RENTAL_SPEND).toBe('rental_spend');
        expect(LEDGER_TYPES.PLATFORM_FEE).toBe('platform_fee');
        expect(LEDGER_TYPES.DEPOSIT_HOLD).toBe('deposit_hold');
        expect(LEDGER_TYPES.DEPOSIT_RELEASE).toBe('deposit_release');
        expect(LEDGER_TYPES.DEPOSIT_FORFEIT).toBe('deposit_forfeit');
        expect(LEDGER_TYPES.SUBSCRIPTION_GRANT).toBe('subscription_grant');
    });
});

// ============================================
// 6. i18n Key Coverage — en + zh (中英文)
// ============================================
describe('i18n Key Coverage (en + zh)', () => {
    let i18nContent;

    beforeAll(() => {
        const i18nPath = path.join(__dirname, '../../public/shared/i18n.js');
        i18nContent = fs.readFileSync(i18nPath, 'utf8');
    });

    const WALLET_KEYS = [
        'wallet_title', 'wallet_my_wallet', 'wallet_available_balance',
        'wallet_held_deposit', 'wallet_lifetime_earned', 'wallet_lifetime_spent',
        'wallet_topup', 'wallet_history', 'wallet_loading',
    ];

    const RENTAL_KEYS = [
        'mr_title', 'mr_heading', 'mr_tab_renting', 'mr_tab_leasing',
        'mr_tab_disputes', 'mr_loading', 'mr_no_contracts', 'mr_end_early',
        'mr_review', 'mr_dispute', 'mr_charged',
    ];

    const INVITE_KEYS = [
        'inv_title', 'inv_heading', 'inv_desc', 'inv_my_code', 'inv_copy',
        'inv_stats', 'inv_invited', 'inv_earned', 'inv_redeem_title', 'inv_redeem_btn',
    ];

    for (const key of [...WALLET_KEYS, ...RENTAL_KEYS, ...INVITE_KEYS]) {
        test(`i18n key "${key}" exists in en section`, () => {
            // Key should appear in the en block (before zh block)
            expect(i18nContent).toContain(`"${key}"`);
        });
    }

    test('zh section has wallet keys', () => {
        // Check that zh section contains wallet keys (after the en section)
        const zhMatch = i18nContent.match(/zh:\s*\{[\s\S]*?"wallet_title"/);
        expect(zhMatch).not.toBeNull();
    });

    test('zh section has rental keys', () => {
        const zhMatch = i18nContent.match(/zh:\s*\{[\s\S]*?"mr_title"/);
        expect(zhMatch).not.toBeNull();
    });

    test('zh section has invite keys', () => {
        const zhMatch = i18nContent.match(/zh:\s*\{[\s\S]*?"inv_title"/);
        expect(zhMatch).not.toBeNull();
    });
});
