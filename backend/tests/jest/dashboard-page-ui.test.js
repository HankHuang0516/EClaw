const fs = require('fs');
const path = require('path');

describe('dashboard page self-improvement UI', () => {
    const pagePath = path.join(__dirname, '../../public/portal/dashboard.html');
    const html = fs.readFileSync(pagePath, 'utf8');

    test('renders a live entity overview panel with stable actions', () => {
        expect(html).toContain('class="dashboard-entity-summary" id="dashboardEntitySummary" data-state="loading" data-tab-content="entities"');
        expect(html).toContain('id="dashboardEntitySummaryStatus" role="status" aria-live="polite" aria-atomic="true"');
        expect(html).toContain('id="dashboardEntitySummaryTitle"');
        expect(html).toContain('id="dashboardEntitySummaryMeta"');
        expect(html).toContain('id="dashboardMetricBound"');
        expect(html).toContain('id="dashboardMetricActive"');
        expect(html).toContain('id="dashboardMetricChannel"');
        expect(html).toContain('id="dashboardMetricE2ee"');
        expect(html).toContain('id="dashboardSummaryRefresh" type="button" onclick="refreshDashboardEntities()"');
        expect(html).toContain('id="dashboardSummaryAdd" type="button" onclick="focusAddEntity()"');
    });

    test('updates the overview state from existing entity data without HTML injection', () => {
        expect(html).toContain('function renderDashboardEntitySummary(stateOverride)');
        expect(html).toContain("summary.dataset.state = state;");
        expect(html).toContain("entities.filter(isDashboardEntityActive).length");
        expect(html).toContain("entities.filter(e => e.bindingType === 'channel').length");
        expect(html).toContain("entities.filter(e => e.encryptionStatus === 'e2ee').length");
        expect(html).toContain("title.textContent = dashboardText('dashboard_summary_error_title'");
        expect(html).toContain("meta.textContent = dashboardText('dashboard_summary_empty_meta'");
        expect(html).toContain("return value && value !== key ? value : fallback;");
        expect(html).not.toContain('dashboardEntitySummaryTitle.innerHTML');
        expect(html).not.toContain('dashboardEntitySummaryMeta.innerHTML');
    });

    test('keeps loading, empty, error, and tab visibility synchronized', () => {
        expect(html).toContain("renderDashboardEntitySummary('loading');");
        expect(html).toContain("renderDashboardEntitySummary('error');");
        expect(html).toContain("renderDashboardEntitySummary('empty');");
        expect(html).toContain("renderDashboardEntitySummary('ready');");
        expect(html).toContain("if (entitySummary) entitySummary.style.display = '';");
        expect(html).toContain("if (entitySummary) entitySummary.style.display = 'none';");
        expect(html).toContain('async function refreshDashboardEntities()');
        expect(html).toContain('function focusAddEntity()');
    });

    test('adds mobile-safe layout guards for dashboard controls', () => {
        expect(html).toMatch(/\.dashboard-entity-summary\s*\{[\s\S]*justify-content:\s*space-between/);
        expect(html).toMatch(/\.dashboard-entity-metrics\s*\{[\s\S]*grid-template-columns:\s*repeat\(4,\s*minmax\(72px,\s*1fr\)\)/);
        expect(html).toMatch(/@media \(max-width: 640px\)[\s\S]*\.page-header\s*\{[\s\S]*flex-direction:\s*column/);
        expect(html).toMatch(/@media \(max-width: 640px\)[\s\S]*\.dashboard-entity-summary\s*\{[\s\S]*flex-direction:\s*column/);
        expect(html).toMatch(/@media \(max-width: 640px\)[\s\S]*\.dashboard-entity-metrics\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
        expect(html).toMatch(/@media \(max-width: 640px\)[\s\S]*\.dashboard-entity-actions \.btn\s*\{[\s\S]*min-width:\s*0/);
    });
});
