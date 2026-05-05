/**
 * Regression coverage for Pricing Advisor info slide claims.
 * The slide must not present unavailable model tiers or demo pricing metrics
 * as real EClaw Pricing Advisor output.
 */

const fs = require('fs');
const path = require('path');

const SLIDE = path.resolve(__dirname, '../../public/portal/assets/slides/info-why-eclaw-b5-pricing-advisor.html');
const INDEX_JS = path.resolve(__dirname, '../../index.js');

describe('Pricing Advisor slide copy', () => {
    const source = fs.readFileSync(SLIDE, 'utf8');

    test('does not claim GPT-5 tier', () => {
        expect(source).not.toMatch(/GPT-5\s*tier/i);
        expect(source).toContain('MiniMax 2.7');
    });

    test('marks fit score and rental range as demo/sample data', () => {
        expect(source).toContain('Sample display');
        expect(source).toContain('DEMO FIT');
        expect(source).toContain('Demo rental range');
        expect(source).toContain('示範 18–24 e-coin / min');
    });

    test('adds a clear disclaimer that actual pricing comes from system computation', () => {
        expect(source).toContain('此頁為 Pricing 顧問功能展示');
        expect(source).toContain('不代表實際 bot 分數、工具數或建議租金');
        expect(source).toContain('以系統運算結果為準');
    });
});

describe('info-pricing-slide debug endpoint registration', () => {
    test('backend exposes an authenticated temporary debug endpoint for slide verification', () => {
        const source = fs.readFileSync(INDEX_JS, 'utf8');
        expect(source).toMatch(/app\.get\(['"]\/api\/debug\/info-pricing-slide['"]/);
        expect(source).toMatch(/claimsGpt5Tier/);
        expect(source).toMatch(/usesCurrentModelLabel/);
        expect(source).toMatch(/hasPricingDisclaimer/);
    });
});
