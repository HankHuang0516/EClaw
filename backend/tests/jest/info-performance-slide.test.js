/**
 * Regression coverage for the Performance Tracking info slide.
 * The marketing slide must not present static mock metrics as live production
 * telemetry or use an unrelated Korean Won currency symbol.
 */

const fs = require('fs');
const path = require('path');

const SLIDE = path.resolve(__dirname, '../../public/portal/assets/slides/info-performance.html');
const INDEX_JS = path.resolve(__dirname, '../../index.js');

describe('Performance Tracking slide copy', () => {
    const source = fs.readFileSync(SLIDE, 'utf8');

    test('does not show static mock metrics as LIVE production telemetry', () => {
        expect(source).not.toMatch(/>LIVE</);
        expect(source).not.toMatch(/class=["']live-indicator["']/);
        expect(source).toContain('DEMO');
        expect(source).toContain('示意資料');
    });

    test('uses a Taiwan-friendly sample currency instead of Korean Won', () => {
        expect(source).not.toContain('₩');
        expect(source).not.toContain('₩847K');
        expect(source).toContain('NT$76K');
    });

    test('avoids precise absolute production claims for mock metrics', () => {
        expect(source).not.toContain('98.7%');
        expect(source).not.toContain('156ms');
        expect(source).toContain('最高 1.2K');
        expect(source).toContain('約 98%');
        expect(source).toContain('&lt; 200ms');
    });

    test('adds a clear disclaimer that values are demo data, not production results', () => {
        expect(source).toContain('本頁為即時效能追蹤功能展示');
        expect(source).toContain('不代表目前 EClawbot 生產營收、SLO 或即時監控結果');
        expect(source).toContain('實際數值以產品後台與系統紀錄為準');
    });

    test('uses a mobile-responsive viewport and media queries', () => {
        expect(source).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1\.0">/);
        expect(source).toMatch(/@media \(max-width: 768px\)/);
        expect(source).toMatch(/@media \(max-width: 600px\)/);
    });
});

describe('info-performance-slide debug endpoint registration', () => {
    test('backend exposes an authenticated temporary debug endpoint for slide verification', () => {
        const source = fs.readFileSync(INDEX_JS, 'utf8');
        expect(source).toMatch(/app\.get\(['"]\/api\/debug\/info-performance-slide['"]/);
        expect(source).toMatch(/claimsLiveTelemetry/);
        expect(source).toMatch(/usesKoreanWonSymbol/);
        expect(source).toMatch(/hasDemoDisclaimer/);
        expect(source).toMatch(/hasResponsiveViewport/);
    });
});
