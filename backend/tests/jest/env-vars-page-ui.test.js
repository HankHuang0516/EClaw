const fs = require('fs');
const path = require('path');

describe('env vars page self-improvement UI', () => {
    const pagePath = path.join(__dirname, '../../public/portal/env-vars.html');
    const html = fs.readFileSync(pagePath, 'utf8');

    test('renders a secret-safe vault status panel', () => {
        expect(html).toContain('class="env-state-panel" id="envSummary" role="status" aria-live="polite" aria-atomic="true" data-state="loading"');
        expect(html).toContain('id="envSummaryCount"');
        expect(html).toContain('id="envSummaryMode"');
        expect(html).toContain('id="envSummaryHint"');
        expect(html).toContain('Secret values stay hidden in this summary. / 密鑰值不會顯示在摘要中。');
        expect(html).toContain('Secret values stay hidden in this list. / 清單只顯示 key 名稱，不顯示密鑰值。');
        expect(html).toContain('Values stay encrypted; bot reads are blocked. / 值仍加密保存，Bot 讀取已阻擋。');
    });

    test('updates the status panel from key count and lock state without exposing values', () => {
        expect(html).toContain('function renderEnvSummary(keys, locked)');
        expect(html).toContain("summary.dataset.state = locked ? 'locked' : (count > 0 ? 'ready' : 'empty');");
        expect(html).toContain("? '1 key saved / 已儲存 1 組 key'");
        expect(html).toContain(": `${count} keys saved / 已儲存 ${count} 組 key`;");
        expect(html).toContain("modeEl.textContent = locked ? 'Locked / bots blocked / 已鎖定' : 'Readable / bots allowed / 可讀取';");
        expect(html).toContain('renderEnvSummary(keys, isLocked());');
        expect(html).not.toContain('hintEl.textContent = vars[');
    });

    test('keeps lock and variable actions accessible by name', () => {
        expect(html).toContain("btn.setAttribute('aria-pressed', 'true');");
        expect(html).toContain("btn.setAttribute('aria-label', 'Vault locked; bots cannot read variables');");
        expect(html).toContain("btn.setAttribute('aria-label', 'Vault readable; bots can read variables');");
        expect(html).toContain("addBtn.setAttribute('aria-disabled', 'true');");
        expect(html).toContain('aria-label="Copy reference for ${esc(k)}"');
        expect(html).toContain('aria-label="${esc(i18n.t(\'common_toggle_visibility\'))} ${esc(k)}"');
        expect(html).toContain('aria-label="${esc(i18n.t(\'common_edit\'))} ${esc(k)}"');
        expect(html).toContain('id="botCurlHint" style="margin-top:8px;padding:10px 44px 10px 12px;');
    });

    test('adds narrow-width layout guards for the header, summary, and variable rows', () => {
        expect(html).toContain('@media (max-width: 640px)');
        expect(html).toMatch(/\.page-header\s*\{[\s\S]*flex-direction:\s*column/);
        expect(html).toMatch(/\.env-state-panel\s*\{[\s\S]*grid-template-columns:\s*1fr/);
        expect(html).toMatch(/\.var-row\s*\{[\s\S]*flex-wrap:\s*wrap/);
        expect(html).toMatch(/\.var-row-key\s*\{[\s\S]*max-width:\s*none/);
    });
});
