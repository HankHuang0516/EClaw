/**
 * Rental Proxy (Token Metering) Unit Tests
 *
 * Tests the pure billing functions: token estimation, cost computation,
 * fee splitting. The actual chargeRentalUsage flow is tested in
 * rental-contract.test.js once P2-F entity handover is in place.
 *
 * @see docs/plans/2026-04-10-bot-rental-marketplace-design.md §11.3
 * @see /portal/roadmap.html — ⑧ Token Metering System
 */

// No pg mock needed — these are pure functions
jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
        connect: jest.fn().mockResolvedValue({
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        }),
    })),
}));

const proxy = require('../../rental-proxy');

describe('rental-proxy: estimateTokens', () => {
    test('empty or non-string returns 0', () => {
        expect(proxy.estimateTokens('')).toBe(0);
        expect(proxy.estimateTokens(null)).toBe(0);
        expect(proxy.estimateTokens(undefined)).toBe(0);
        expect(proxy.estimateTokens(42)).toBe(0);
    });

    test('short string returns at least 1', () => {
        expect(proxy.estimateTokens('hi')).toBe(1);
        expect(proxy.estimateTokens('a')).toBe(1);
    });

    test('chars ÷ 4 rounded up', () => {
        expect(proxy.estimateTokens('a'.repeat(100))).toBe(25);
        expect(proxy.estimateTokens('a'.repeat(101))).toBe(26);
        expect(proxy.estimateTokens('a'.repeat(4))).toBe(1);
        expect(proxy.estimateTokens('a'.repeat(5))).toBe(2);
    });

    test('CJK text also uses chars÷4', () => {
        // 中文字 is 1 char in JS but typically >1 token in LLMs.
        // We intentionally use chars÷4 for simplicity (design decision #1).
        const cjk = '你好世界'; // 4 chars
        expect(proxy.estimateTokens(cjk)).toBe(1);
    });
});

describe('rental-proxy: computeCostMli', () => {
    test('basic: 1000 tokens at 10 e幣/1K = 10,000 mli', () => {
        // rate = 10 e幣/1K = 10,000 mli/1K
        expect(proxy.computeCostMli(1000, 10_000)).toBe(10_000);
    });

    test('rounds up fractional costs', () => {
        // 1 token at 10,000 mli/1K = 10 mli → ceil = 10
        expect(proxy.computeCostMli(1, 10_000)).toBe(10);
        // 3 tokens at 1000 mli/1K = 3 mli → ceil = 3
        expect(proxy.computeCostMli(3, 1000)).toBe(3);
    });

    test('zero tokens or zero rate = 0', () => {
        expect(proxy.computeCostMli(0, 10_000)).toBe(0);
        expect(proxy.computeCostMli(100, 0)).toBe(0);
        expect(proxy.computeCostMli(-5, 10_000)).toBe(0);
    });

    test('small token counts at low rates', () => {
        // 1 token at 1000 mli/1K = 1 mli → ceil = 1
        expect(proxy.computeCostMli(1, 1000)).toBe(1);
    });

    test('realistic scenario: 3400 tokens at 10 e幣/1K', () => {
        // 3400 × 10,000 / 1000 = 34,000 mli = 34 e幣
        expect(proxy.computeCostMli(3400, 10_000)).toBe(34_000);
    });
});

describe('rental-proxy: splitFees', () => {
    test('15% total fee, 2% insurance', () => {
        const fees = proxy.splitFees(10_000);
        // platform total = 10000 × 1500 / 10000 = 1500
        // insurance      = 10000 × 200 / 10000 = 200
        // platform net   = 1500 - 200 = 1300
        // owner net      = 10000 - 1500 = 8500
        expect(fees.gross).toBe(10_000);
        expect(fees.ownerNet).toBe(8_500);
        expect(fees.platformNet).toBe(1_300);
        expect(fees.insuranceMli).toBe(200);
        expect(fees.ownerNet + fees.platformNet + fees.insuranceMli).toBe(fees.gross);
    });

    test('zero or negative = all zeros', () => {
        const fees = proxy.splitFees(0);
        expect(fees.gross).toBe(0);
        expect(fees.ownerNet).toBe(0);
    });

    test('small amount preserves invariant', () => {
        const fees = proxy.splitFees(100);
        // platform = floor(100 × 0.15) = 15
        // insurance = floor(100 × 0.02) = 2
        // platform net = 15 - 2 = 13
        // owner = 100 - 15 = 85
        expect(fees.ownerNet).toBe(85);
        expect(fees.platformNet).toBe(13);
        expect(fees.insuranceMli).toBe(2);
        expect(fees.ownerNet + fees.platformNet + fees.insuranceMli).toBe(100);
    });

    test('very small amount (1 mli)', () => {
        const fees = proxy.splitFees(1);
        // floor(1 × 0.15) = 0 → owner gets everything
        expect(fees.ownerNet).toBe(1);
        expect(fees.platformNet).toBe(0);
        expect(fees.insuranceMli).toBe(0);
    });

    test('large realistic: 34,000 mli (34 e幣 conversation)', () => {
        const fees = proxy.splitFees(34_000);
        // platform = floor(34000 × 0.15) = 5100
        // insurance = floor(34000 × 0.02) = 680
        // platform net = 5100 - 680 = 4420
        // owner = 34000 - 5100 = 28900
        expect(fees.ownerNet).toBe(28_900);
        expect(fees.platformNet).toBe(4_420);
        expect(fees.insuranceMli).toBe(680);
        expect(fees.ownerNet + fees.platformNet + fees.insuranceMli).toBe(34_000);
    });
});

describe('rental-proxy: constants', () => {
    test('PLATFORM_FEE_BPS = 1500 (15%)', () => {
        expect(proxy.PLATFORM_FEE_BPS).toBe(1500);
    });

    test('INSURANCE_POOL_BPS = 200 (2%)', () => {
        expect(proxy.INSURANCE_POOL_BPS).toBe(200);
    });

    test('virtual wallet UUIDs match wallet.js', () => {
        expect(proxy.PLATFORM_WALLET_USER_ID).toBe('00000000-0000-0000-0000-000000000001');
        expect(proxy.INSURANCE_POOL_USER_ID).toBe('00000000-0000-0000-0000-000000000002');
    });
});

describe('rental-proxy: end-to-end cost calculation', () => {
    test('renter sends 200-char message, bot replies 800-char: cost breakdown', () => {
        const inputText = 'a'.repeat(200);  // 50 tokens
        const outputText = 'b'.repeat(800); // 200 tokens
        const rate = 10_000; // 10 e幣/1K

        const inputTokens = proxy.estimateTokens(inputText);
        const outputTokens = proxy.estimateTokens(outputText);
        expect(inputTokens).toBe(50);
        expect(outputTokens).toBe(200);

        const totalTokens = inputTokens + outputTokens; // 250
        const cost = proxy.computeCostMli(totalTokens, rate);
        // 250 × 10,000 / 1000 = 2,500 mli = 2.5 e幣
        expect(cost).toBe(2_500);

        const fees = proxy.splitFees(cost);
        // owner: 2500 × 85% = 2125
        expect(fees.ownerNet).toBe(2_125);
        // platform net: floor(2500×0.15) - floor(2500×0.02) = 375 - 50 = 325
        expect(fees.platformNet).toBe(325);
        // insurance: 50
        expect(fees.insuranceMli).toBe(50);
        // Conservation: 2125 + 325 + 50 = 2500
        expect(fees.ownerNet + fees.platformNet + fees.insuranceMli).toBe(cost);
    });
});
