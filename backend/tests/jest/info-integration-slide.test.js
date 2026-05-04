/**
 * Regression coverage for the Cross-platform Integration Ecosystem info slide.
 * The marketing slide must only present integrations that are actually
 * supported or wired today, and must not show invented platform counts/SLA.
 */

const fs = require('fs');
const path = require('path');

const SLIDE = path.resolve(__dirname, '../../public/portal/assets/slides/info-integration.html');
const INDEX_JS = path.resolve(__dirname, '../../index.js');

const UNSUPPORTED_VISIBLE_CLAIMS = [
    'Discord',
    'Slack',
    'Teams',
    'LINE',
    'WhatsApp',
    'GitLab',
    'VS Code',
    'JetBrains',
    'Docker',
    'Kubernetes',
    'AWS',
    'Azure',
    'GCP',
    'Vercel',
    'DigitalOcean',
];

describe('Integration ecosystem slide copy', () => {
    const source = fs.readFileSync(SLIDE, 'utf8');

    test('only lists currently supported or wired integrations', () => {
        for (const name of ['Telegram', 'Railway', 'GitHub', 'MiniMax', 'Anthropic', 'OpenAI', 'Voyage']) {
            expect(source).toContain(name);
        }
        for (const name of UNSUPPORTED_VISIBLE_CLAIMS) {
            expect(source).not.toContain(name);
        }
    });

    test('removes invented scale, success-rate, and SLA stats', () => {
        expect(source).not.toContain('50+');
        expect(source).not.toContain('99.9%');
        expect(source).not.toContain('24/7');
        expect(source).toContain('7');
        expect(source).toContain('已上線 / 已接線整合');
        expect(source).toContain('1');
        expect(source).toContain('公開 channel plugin');
        expect(source).toContain('2026-05');
    });

    test('does not keep a dead complete-integration-list CTA', () => {
        expect(source).not.toContain('查看完整整合列表');
        expect(source).not.toMatch(/href=["']#["']/);
    });

    test('clearly states that only available or wired capabilities are shown', () => {
        expect(source).toContain('僅列出已上線或已接線能力');
        expect(source).toContain('未上線/未實作項目不列為正式支援');
    });
});

describe('info-integration-slide debug endpoint registration', () => {
    test('backend exposes an authenticated temporary debug endpoint for slide verification', () => {
        const source = fs.readFileSync(INDEX_JS, 'utf8');
        expect(source).toMatch(/app\.get\(['"]\/api\/debug\/info-integration-slide['"]/);
        expect(source).toMatch(/unsupportedClaimsPresent/);
        expect(source).toMatch(/supportedIntegrationsPresent/);
        expect(source).toMatch(/hasActualStats/);
        expect(source).toMatch(/hasDeadCompleteListCta/);
    });
});
