const fs = require('fs');
const path = require('path');

describe('publisher setup page self-improvement UI', () => {
    const pagePath = path.join(__dirname, '../../public/portal/publisher-setup.html');
    const html = fs.readFileSync(pagePath, 'utf8');

    test('renders a secret-safe setup status panel and publisher return path', () => {
        expect(html).toContain('class="setup-summary" id="setupSummary" role="status" aria-live="polite" aria-atomic="true" data-state="empty"');
        expect(html).toContain('id="setupProgressText"');
        expect(html).toContain('id="setupProgressHint"');
        expect(html).toContain('0 of 4 keys entered / 已填 0/4 組金鑰');
        expect(html).toContain('href="publisher.html">Back to Publisher / 返回發布器</a>');
        expect(html).toContain('Ready to save. Secret values stay hidden in this checklist.');
    });

    test('tracks all four credential fields without exposing secret values', () => {
        [
            ['xConsumerKey', 'Consumer Key / 消費者金鑰'],
            ['xConsumerSecret', 'Consumer Secret / 消費者密鑰'],
            ['xAccessToken', 'Access Token / 存取權杖'],
            ['xAccessTokenSecret', 'Access Token Secret / 存取權杖密鑰'],
        ].forEach(([id, label]) => {
            expect(html).toContain(`data-key-item="${id}" data-state="missing"`);
            expect(html).toContain(`id="state-${id}"`);
            expect(html).toContain(label);
            expect(html).toContain(`aria-describedby="hint-${id} state-${id}" aria-invalid="false"`);
        });
        expect(html).toContain("status.textContent = filled ? 'Ready / 已填' : 'Missing / 未填';");
        expect(html).not.toContain('state.textContent = input.value');
    });

    test('keeps save disabled until all required keys are present and marks missing fields after submit', () => {
        expect(html).toContain('id="saveBtn" onclick="saveToVault()" disabled');
        expect(html).toContain('let hasAttemptedSave = false;');
        expect(html).toContain('function getCompletedKeyCount()');
        expect(html).toContain('function updateSetupState()');
        expect(html).toContain("if (btn && btn.dataset.busy !== 'true') btn.disabled = !complete;");
        expect(html).toContain("input.setAttribute('aria-invalid', hasAttemptedSave && !filled ? 'true' : 'false');");
        expect(html).toContain("field.classList.toggle('field-missing', hasAttemptedSave && !filled);");
        expect(html).toContain('hasAttemptedSave = true;');
        expect(html).toContain('bindSetupStateInputs();');
    });

    test('adds responsive layout rules for narrow portal/webview widths', () => {
        expect(html).toContain('@media (max-width: 520px)');
        expect(html).toMatch(/\.setup-checklist\s*\{[\s\S]*grid-template-columns:\s*1fr/);
        expect(html).toMatch(/\.actions \.btn\s*\{[\s\S]*flex:\s*1 1 100%/);
        expect(html).toMatch(/\.pw-toggle\s*\{[\s\S]*min-width:\s*42px/);
    });
});
