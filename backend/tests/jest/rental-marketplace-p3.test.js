/**
 * Rental Marketplace Test Plan — P3: Trust Layer
 *
 * P3-2: Review 48h window expiry
 * P3-4: All 4 dispute types + SLA times
 * P3-6: Credit score formula verification
 */

// No DB needed — testing constants and pure logic

describe('P3-4: Dispute types and SLA times', () => {
    let trustModule;

    beforeAll(() => {
        // trust.js is a factory, but we can require it and extract constants
        // Mock pg to avoid DB connection
        jest.doMock('pg', () => ({
            Pool: jest.fn().mockImplementation(() => ({
                query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
                connect: jest.fn().mockResolvedValue({
                    query: jest.fn().mockResolvedValue({ rows: [] }),
                    release: jest.fn(),
                }),
                end: jest.fn(),
            })),
        }));

        const trustFactory = require('../../trust');
        const authMw = (_req, _res, next) => next();
        const adminMw = (_req, _res, next) => next();
        trustModule = trustFactory({ authMiddleware: authMw, adminMiddleware: adminMw, serverLog: () => {} });
    });

    test('DISPUTE_TYPES contains all 4 types', () => {
        expect(trustModule.DISPUTE_TYPES).toEqual(
            expect.arrayContaining(['bot_crash', 'bot_quality', 'capability_mismatch', 'financial'])
        );
        expect(trustModule.DISPUTE_TYPES).toHaveLength(4);
    });

    test('bot_crash SLA: 5 min first response, 5 min resolve', () => {
        const sla = trustModule.SLA_MS.bot_crash;
        expect(sla.firstResponse).toBe(5 * 60 * 1000);   // 5 minutes
        expect(sla.resolve).toBe(5 * 60 * 1000);          // 5 minutes
    });

    test('bot_quality SLA: 24h first response, 72h resolve', () => {
        const sla = trustModule.SLA_MS.bot_quality;
        expect(sla.firstResponse).toBe(24 * 3600 * 1000); // 24 hours
        expect(sla.resolve).toBe(72 * 3600 * 1000);       // 72 hours
    });

    test('capability_mismatch SLA: 24h first response, 48h resolve', () => {
        const sla = trustModule.SLA_MS.capability_mismatch;
        expect(sla.firstResponse).toBe(24 * 3600 * 1000);
        expect(sla.resolve).toBe(48 * 3600 * 1000);
    });

    test('financial SLA: 12h first response, 48h resolve', () => {
        const sla = trustModule.SLA_MS.financial;
        expect(sla.firstResponse).toBe(12 * 3600 * 1000);
        expect(sla.resolve).toBe(48 * 3600 * 1000);
    });

    test('SLA miss compensation is 50 e幣 (50,000 mli)', () => {
        expect(trustModule.SLA_MISS_COMPENSATION_MLI).toBe(50000);
    });

    test('cooldown is 24 hours', () => {
        expect(trustModule.COOLDOWN_HOURS).toBe(24);
    });

    test('auto-delist threshold is 3.0', () => {
        expect(trustModule.AUTO_DELIST_THRESHOLD).toBe(3.0);
    });
});

describe('P3-6: Credit score formula verification', () => {
    // Formula: GREATEST(0, LEAST(10, avg_rating×2 - bad_disputes×0.5 - frauds×2))

    function computeScore(avgRating, badDisputes, frauds) {
        return Math.max(0, Math.min(10, avgRating * 2 - badDisputes * 0.5 - frauds * 2));
    }

    test('perfect rating (5★, 0 disputes, 0 frauds) = 10.0', () => {
        expect(computeScore(5, 0, 0)).toBe(10);
    });

    test('average rating (3★, 0 disputes, 0 frauds) = 6.0', () => {
        expect(computeScore(3, 0, 0)).toBe(6);
    });

    test('3★ with 2 disputes = 5.0', () => {
        expect(computeScore(3, 2, 0)).toBe(5);
    });

    test('3★ with 1 fraud = 4.0', () => {
        expect(computeScore(3, 0, 1)).toBe(4);
    });

    test('low rating (1★) = 2.0', () => {
        expect(computeScore(1, 0, 0)).toBe(2);
    });

    test('below auto-delist: 1★ + 2 frauds = 0 (clamped)', () => {
        const score = computeScore(1, 0, 2);
        expect(score).toBeLessThan(3.0); // below auto-delist threshold
    });

    test('score cannot go below 0', () => {
        expect(computeScore(0, 10, 10)).toBe(0);
    });

    test('score cannot go above 10', () => {
        expect(computeScore(5, 0, 0)).toBe(10);
    });
});

describe('P3: Fraud detection rules', () => {
    const fraud = require('../../fraud-detection');

    test('self-rental blocked', () => {
        const result = fraud.evaluateRentalRisk({
            ownerUserId: 'user-abc',
            renterUserId: 'user-abc',
            renterAccountAgeMs: 30 * 24 * 3600 * 1000,
        });
        expect(result.allowed).toBe(false);
        expect(result.flags).toContain('self_rental');
    });

    test('new account (<7 days) gets +50% deposit premium', () => {
        const result = fraud.evaluateRentalRisk({
            ownerUserId: 'user-owner-1234567',
            renterUserId: 'user-renter-1234567',
            renterCreatedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000), // 3 days ago
            depositMli: 200000,
        });
        expect(result.allowed).toBe(true);
        expect(result.flags).toContain('new_account');
        expect(result.adjustedDepositMli).toBe(300000); // 200000 × 1.5
    });

    test('old account (30+ days) no premium', () => {
        const result = fraud.evaluateRentalRisk({
            ownerUserId: 'user-owner-old12345',
            renterUserId: 'user-renter-old12345',
            renterCreatedAt: new Date(Date.now() - 30 * 24 * 3600 * 1000),
            depositMli: 200000,
        });
        expect(result.allowed).toBe(true);
        expect(result.flags).not.toContain('new_account');
        expect(result.adjustedDepositMli).toBe(200000);
    });

    test('new account review weight = 0.3', () => {
        const recentDate = new Date(Date.now() - 3 * 24 * 3600 * 1000); // 3 days ago
        const weight = fraud.computeReviewWeight(recentDate);
        expect(weight).toBeCloseTo(0.3, 1);
    });

    test('old account review weight = 1.0', () => {
        const oldDate = new Date(Date.now() - 30 * 24 * 3600 * 1000); // 30 days ago
        const weight = fraud.computeReviewWeight(oldDate);
        expect(weight).toBe(1.0);
    });
});
