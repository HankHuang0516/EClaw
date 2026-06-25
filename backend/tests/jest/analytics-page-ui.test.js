const fs = require('fs');
const path = require('path');

describe('analytics page self-improvement UI', () => {
    const pagePath = path.join(__dirname, '../../public/portal/analytics.html');
    const html = fs.readFileSync(pagePath, 'utf8');

    test('renders an active analytics context panel with a clear-filter action', () => {
        expect(html).toContain('id="filterContext" class="ana-filter-context" role="status" aria-live="polite" aria-atomic="true" data-state="all"');
        expect(html).toContain('id="contextRange"');
        expect(html).toContain('id="contextPath"');
        expect(html).toContain('id="contextHint"');
        expect(html).toContain('id="clearPathBtn" class="ana-clear-btn" type="button" hidden');
        expect(html).toContain('.ana-clear-btn[hidden] { display: none; }');
        expect(html).toContain('All paths / 全部路徑');
    });

    test('updates filter context without exposing HTML from the path filter', () => {
        expect(html).toContain('function renderAnalyticsContext()');
        expect(html).toContain("context.dataset.state = filtered ? 'filtered' : 'all';");
        expect(html).toContain("pathEl.textContent = filtered ? pathGlob : 'All paths / 全部路徑';");
        expect(html).toContain("hintEl.textContent = filtered");
        expect(html).toContain('if (clearBtn) clearBtn.hidden = !filtered;');
        expect(html).not.toContain('pathEl.innerHTML');
    });

    test('keeps fetch state and clear-filter behavior stable', () => {
        expect(html).toContain("content.setAttribute('aria-busy', 'true');");
        expect(html).toContain("content.setAttribute('aria-busy', 'false');");
        expect(html).toContain('refreshBtn.disabled = true;');
        expect(html).toContain('refreshBtn.disabled = false;');
        expect(html).toContain("document.getElementById('clearPathBtn').addEventListener('click'");
        expect(html).toContain("input.value = '';");
        expect(html).toContain('clearTimeout(pathDebounce);');
    });

    test('uses filtered empty copy and mobile-safe table wrappers', () => {
        expect(html).toContain('No paths match "${pathGlob}" in this range');
        expect(html).toContain('No tagged campaigns match "${pathGlob}"');
        expect(html).toMatch(/\.ana-table-wrap\s*\{[\s\S]*overflow-x:\s*auto/);
        expect(html).toMatch(/table\.ana-table\s*\{[\s\S]*min-width:\s*360px/);
        expect(html).toMatch(/@media \(max-width: 720px\)[\s\S]*\.ana-controls label\s*\{[\s\S]*flex:\s*1 1 100%/);
        expect(html).toMatch(/@media \(max-width: 720px\)[\s\S]*\.ana-filter-context\s*\{[\s\S]*flex-direction:\s*column/);
    });
});
