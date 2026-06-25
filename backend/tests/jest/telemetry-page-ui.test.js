const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '../../public/portal/telemetry.html');

describe('telemetry page UI context', () => {
    const html = fs.readFileSync(htmlPath, 'utf8');

    test('renders a live telemetry context panel with a clear-type action', () => {
        expect(html).toContain('id="telemetryContext"');
        expect(html).toContain('role="status" aria-live="polite" aria-atomic="true" data-state="loading"');
        expect(html).toContain('id="telemetryContextTitle"');
        expect(html).toContain('id="telemetryContextMeta"');
        expect(html).toContain('id="clearTypeFilter"');
        expect(html).toContain('Clear type filter / 清除類型篩選');
        expect(html).toContain('.tel-clear-filter[hidden] { display: none; }');
    });

    test('updates context state without injecting filter text as HTML', () => {
        expect(html).toContain('function updateTelemetryContext(options = {})');
        expect(html).toContain("context.dataset.state = state;");
        expect(html).toContain("clear.hidden = !filtered;");
        expect(html).toContain("title.textContent = filtered");
        expect(html).toContain("meta.textContent = `${fmtNumber(count)} entries loaded");
        expect(html).not.toContain('telemetryContextTitle.innerHTML');
        expect(html).not.toContain('telemetryContextMeta.innerHTML');
    });

    test('keeps refresh busy state and reset behavior stable', () => {
        expect(html).toContain("content.setAttribute('aria-busy', isBusy ? 'true' : 'false');");
        expect(html).toContain('refreshBtn.disabled = !!isBusy;');
        expect(html).toContain("updateTelemetryContext({ state: 'loading' });");
        expect(html).toContain('let telemetryFetchSeq = 0;');
        expect(html).toContain('const requestSeq = ++telemetryFetchSeq;');
        expect(html).toContain('if (requestSeq !== telemetryFetchSeq) return;');
        expect(html).toContain('function clearTypeFilter()');
        expect(html).toContain("typeSel.value = '';");
        expect(html).toContain("document.getElementById('clearTypeFilter').addEventListener('click', clearTypeFilter);");
    });

    test('uses fallback-aware translation helpers for generated labels', () => {
        expect(html).toContain("const totalLabel = tt('[html]telemetry_total_label', 'Total entries');");
        expect(html).toContain("window.confirm(tt('[html]telemetry_clear_confirm', 'Clear the entire telemetry buffer for this device?'))");
        expect(html).not.toContain("i18n.t('[html]telemetry_total_label', 'Total entries')");
    });

    test('shows filtered empty copy and mobile-safe table controls', () => {
        expect(html).toContain('No ${selectedTypeLabel(type)} telemetry entries in buffer.');
        expect(html).toContain('class="tel-table-wrap"');
        expect(html).toMatch(/\.tel-table-wrap\s*\{[\s\S]*overflow-x:\s*auto/);
        expect(html).toMatch(/@media \(max-width: 720px\)[\s\S]*\.tel-context-panel\s*\{[\s\S]*flex-direction:\s*column/);
        expect(html).toMatch(/@media \(max-width: 720px\)[\s\S]*table\.tel-table\s*\{[\s\S]*min-width:\s*520px/);
    });
});
