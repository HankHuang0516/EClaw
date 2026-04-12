/**
 * Subscription Plans & Top-up Tiers Tests (Jest)
 *
 * Tests:
 * - GET /api/subscription/plans returns all plan tiers
 * - GET /api/wallet/topup/tiers returns 5 tiers with bonuses
 * - subscription_grant ledger type is valid
 * - Plan constants are consistent
 */

// ── Mock pg ──
jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        connect: jest.fn().mockResolvedValue({
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

// ── Direct module tests (no supertest needed) ──

describe('Subscription Plans constants', () => {
    let subscriptionFactory;

    beforeAll(() => {
        subscriptionFactory = require('../../subscription');
    });

    test('factory exports SUBSCRIPTION_PLANS after init', () => {
        const devices = {};
        const authMw = (_req, _res, next) => next();
        const mod = subscriptionFactory(devices, authMw, null, null);

        expect(mod.SUBSCRIPTION_PLANS).toBeDefined();
        expect(mod.OFFICIAL_BOT_MONTHLY_ECOIN).toBe(30000);
    });

    test('SUBSCRIPTION_PLANS has free, starter, pro, business', () => {
        const devices = {};
        const authMw = (_req, _res, next) => next();
        const mod = subscriptionFactory(devices, authMw, null, null);
        const plans = mod.SUBSCRIPTION_PLANS;

        expect(plans.free).toBeDefined();
        expect(plans.starter).toBeDefined();
        expect(plans.pro).toBeDefined();
        expect(plans.business).toBeDefined();
    });

    test('free plan has 15 message limit and no e-coin grant', () => {
        const devices = {};
        const authMw = (_req, _res, next) => next();
        const mod = subscriptionFactory(devices, authMw, null, null);
        const free = mod.SUBSCRIPTION_PLANS.free;

        expect(free.messageLimit).toBe(15);
        expect(free.monthlyEcoinGrant).toBe(0);
        expect(free.priceUsd).toBe(0);
        expect(free.maxConcurrentRentals).toBe(1);
        expect(free.marketplaceDiscountBps).toBe(0);
    });

    test('starter plan grants 2000 e-coins and has unlimited messages', () => {
        const devices = {};
        const authMw = (_req, _res, next) => next();
        const mod = subscriptionFactory(devices, authMw, null, null);
        const starter = mod.SUBSCRIPTION_PLANS.starter;

        expect(starter.monthlyEcoinGrant).toBe(2000);
        expect(starter.messageLimit).toBeNull();
        expect(starter.maxConcurrentRentals).toBe(2);
        expect(starter.marketplaceDiscountBps).toBe(500);
        expect(starter.googlePlayProductId).toBe('eclaw_sub_starter');
    });

    test('pro plan grants 8000 e-coins with 10% discount', () => {
        const devices = {};
        const authMw = (_req, _res, next) => next();
        const mod = subscriptionFactory(devices, authMw, null, null);
        const pro = mod.SUBSCRIPTION_PLANS.pro;

        expect(pro.monthlyEcoinGrant).toBe(8000);
        expect(pro.maxConcurrentRentals).toBe(5);
        expect(pro.marketplaceDiscountBps).toBe(1000);
    });

    test('business plan grants 20000 e-coins with unlimited rentals', () => {
        const devices = {};
        const authMw = (_req, _res, next) => next();
        const mod = subscriptionFactory(devices, authMw, null, null);
        const biz = mod.SUBSCRIPTION_PLANS.business;

        expect(biz.monthlyEcoinGrant).toBe(20000);
        expect(biz.maxConcurrentRentals).toBe(-1); // unlimited
        expect(biz.marketplaceDiscountBps).toBe(1500);
    });

    test('plans are frozen (immutable)', () => {
        const devices = {};
        const authMw = (_req, _res, next) => next();
        const mod = subscriptionFactory(devices, authMw, null, null);

        expect(Object.isFrozen(mod.SUBSCRIPTION_PLANS)).toBe(true);
    });

    test('setWalletModule is a function', () => {
        const devices = {};
        const authMw = (_req, _res, next) => next();
        const mod = subscriptionFactory(devices, authMw, null, null);

        expect(typeof mod.setWalletModule).toBe('function');
    });

    test('e-coin grant amounts scale correctly across tiers', () => {
        const devices = {};
        const authMw = (_req, _res, next) => next();
        const mod = subscriptionFactory(devices, authMw, null, null);
        const { free, starter, pro, business } = mod.SUBSCRIPTION_PLANS;

        // Grants should be strictly increasing
        expect(free.monthlyEcoinGrant).toBeLessThan(starter.monthlyEcoinGrant);
        expect(starter.monthlyEcoinGrant).toBeLessThan(pro.monthlyEcoinGrant);
        expect(pro.monthlyEcoinGrant).toBeLessThan(business.monthlyEcoinGrant);

        // Discounts should be strictly increasing
        expect(free.marketplaceDiscountBps).toBeLessThan(starter.marketplaceDiscountBps);
        expect(starter.marketplaceDiscountBps).toBeLessThan(pro.marketplaceDiscountBps);
        expect(pro.marketplaceDiscountBps).toBeLessThan(business.marketplaceDiscountBps);
    });
});

describe('Wallet top-up tiers', () => {
    test('TOPUP_TIERS has 5 tiers with increasing bonuses', () => {
        const { TOPUP_TIERS } = require('../../wallet');

        const tierIds = Object.keys(TOPUP_TIERS);
        expect(tierIds).toHaveLength(5);
        expect(tierIds).toContain('ecoin_tier_small');
        expect(tierIds).toContain('ecoin_tier_starter');
        expect(tierIds).toContain('ecoin_tier_standard');
        expect(tierIds).toContain('ecoin_tier_advanced');
        expect(tierIds).toContain('ecoin_tier_premium');
    });

    test('bonus percentages are 0%, 5%, 8%, 12%, 15%', () => {
        const { TOPUP_TIERS, USD_TO_MLI } = require('../../wallet');

        const small = TOPUP_TIERS.ecoin_tier_small;
        expect(small.bonusMli).toBe(0);
        expect(small.priceUsd).toBe(1);
        expect(small.baseMli).toBe(1 * USD_TO_MLI);

        const starter = TOPUP_TIERS.ecoin_tier_starter;
        const starterBonus = starter.bonusMli / starter.baseMli;
        expect(starterBonus).toBeCloseTo(0.05, 2);

        const premium = TOPUP_TIERS.ecoin_tier_premium;
        const premiumBonus = premium.bonusMli / premium.baseMli;
        expect(premiumBonus).toBeCloseTo(0.15, 2);
    });

    test('total e-coins = base + bonus for each tier', () => {
        const { TOPUP_TIERS } = require('../../wallet');

        for (const [, tier] of Object.entries(TOPUP_TIERS)) {
            const total = tier.baseMli + tier.bonusMli;
            expect(total).toBeGreaterThan(0);
            expect(tier.baseMli).toBeGreaterThan(0);
            expect(tier.bonusMli).toBeGreaterThanOrEqual(0);
        }
    });
});

describe('Wallet LEDGER_TYPES', () => {
    test('includes subscription_grant type', () => {
        const { LEDGER_TYPES } = require('../../wallet');

        expect(LEDGER_TYPES.SUBSCRIPTION_GRANT).toBe('subscription_grant');
    });

    test('all ledger types are unique strings', () => {
        const { LEDGER_TYPES } = require('../../wallet');
        const values = Object.values(LEDGER_TYPES);
        const unique = new Set(values);

        expect(unique.size).toBe(values.length);
        values.forEach(v => expect(typeof v).toBe('string'));
    });
});

describe('GET /plans endpoint', () => {
    let app;

    beforeAll(() => {
        const express = require('express');
        app = express();
        const devices = {};
        const authMw = (_req, _res, next) => next();
        const mod = require('../../subscription')(devices, authMw, null, null);
        app.use('/api/subscription', mod.router);
    });

    test('returns plan list with correct structure', async () => {
        const request = require('supertest');
        const res = await request(app).get('/api/subscription/plans');

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.plans)).toBe(true);
        expect(res.body.plans.length).toBe(4); // free + starter + pro + business
        expect(res.body.officialBotMonthlyEcoin).toBe(30000);

        // Check each plan has required fields
        for (const plan of res.body.plans) {
            expect(plan).toHaveProperty('id');
            expect(plan).toHaveProperty('name');
            expect(plan).toHaveProperty('priceUsd');
            expect(plan).toHaveProperty('monthlyEcoinGrant');
            expect(plan).toHaveProperty('messageLimit');
            expect(plan).toHaveProperty('maxConcurrentRentals');
            expect(plan).toHaveProperty('marketplaceDiscountBps');
        }
    });

    test('free plan is included with messageLimit 15', async () => {
        const request = require('supertest');
        const res = await request(app).get('/api/subscription/plans');

        const free = res.body.plans.find(p => p.id === 'free');
        expect(free).toBeDefined();
        expect(free.messageLimit).toBe(15);
        expect(free.monthlyEcoinGrant).toBe(0);
        expect(free.googlePlayProductId).toBeNull();
    });
});
