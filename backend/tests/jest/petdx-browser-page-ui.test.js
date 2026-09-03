const fs = require('fs');
const path = require('path');

describe('petdx browser page self-improvement UI', () => {
    const pagePath = path.join(__dirname, '../../public/portal/petdx-browser.html');
    const html = fs.readFileSync(pagePath, 'utf8');

    test('renders a live browse context panel with clear and refresh actions', () => {
        expect(html).toContain('class="browse-context" id="browseContext" role="status" aria-live="polite" aria-atomic="true"');
        expect(html).toContain('id="browseContextTitle"');
        expect(html).toContain('id="browseContextMeta"');
        expect(html).toContain('id="browseContextFilters" aria-label="Active filters"');
        expect(html).toContain('id="clear-active-filters" onclick="resetFilters()" hidden');
        expect(html).toContain('id="refresh-list" onclick="refreshCompanionList()"');
        expect(html).toContain('function renderBrowseContext(state)');
    });

    test('filter chips expose pressed state and active filter labels', () => {
        expect(html).toContain("c.type = 'button';");
        expect(html).toContain("c.setAttribute('aria-pressed', filterState[group.key] === opt.v ? 'true' : 'false');");
        expect(html).toContain('c.dataset.filterKey = group.key;');
        expect(html).toContain('c.dataset.filterValue = opt.v;');
        expect(html).toContain('function currentFilterLabels()');
        expect(html).toContain("if (group.key === 'sort' && filterState.sort === 'popular') return;");
        expect(html).toContain('active-filter-chip');
        expect(html).toContain('clearBtn.hidden = activeLabels.length === 0;');
    });

    test('list loading state is observable and guarded against stale responses', () => {
        expect(html).toContain('let listRequestSeq = 0;');
        expect(html).toContain('const requestId = ++listRequestSeq;');
        expect(html).toContain("grid.setAttribute('aria-busy', 'true');");
        expect(html).toContain("grid.setAttribute('aria-busy', 'false');");
        expect(html).toContain('if (requestId !== listRequestSeq) return;');
        expect(html).not.toContain('if (isLoading) return;');
    });

    test('mobile context and status controls stack without clipped buttons', () => {
        expect(html).toMatch(/@media \(max-width: 600px\)[\s\S]*\.browse-context\s*\{[\s\S]*flex-direction:\s*column/);
        expect(html).toMatch(/@media \(max-width: 600px\)[\s\S]*\.browse-context-actions \.context-btn\s*\{[\s\S]*flex:\s*1 1 0/);
        expect(html).toMatch(/@media \(max-width: 600px\)[\s\S]*\.status-bar\s*\{[\s\S]*flex-direction:\s*column/);
    });
});
