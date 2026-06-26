const fs = require('fs');
const path = require('path');

describe('dashboard page self-improvement UI', () => {
    const pagePath = path.join(__dirname, '../../public/portal/dashboard.html');
    const i18nPath = path.join(__dirname, '../../public/shared/i18n.js');
    const html = fs.readFileSync(pagePath, 'utf8');
    const i18n = fs.readFileSync(i18nPath, 'utf8');

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
        expect(html).toContain("function formatDashboardText(template, values = {})");
        expect(html).toContain("i18n.t(key, params)");
        expect(html).toContain("return value && value !== key ? value : formatDashboardText(fallback, params);");
        expect(html).toContain("dashboardText('dashboard_summary_ready_many', '{count} entities ready', { count: bound })");
        expect(html).toContain("dashboardText('dashboard_summary_ready_meta', '{active} active, {channel} channel-bound, {e2ee} E2EE', { active, channel, e2ee })");
        expect(html).not.toContain('dashboard_summary_ready_many_suffix');
        expect(html).not.toContain('1 entity ready / 1 個實體可用');
        expect(html).not.toContain('entities ready /');
        expect(html).not.toContain("+ e2ee + ' E2EE / '");
        expect(html).not.toContain('dashboardEntitySummaryTitle.innerHTML');
        expect(html).not.toContain('dashboardEntitySummaryMeta.innerHTML');
    });

    test('defines localized entity summary keys without bilingual fallbacks', () => {
        [
            'dashboard_summary_loading_title',
            'dashboard_summary_loading_meta',
            'dashboard_summary_error_title',
            'dashboard_summary_error_meta',
            'dashboard_summary_empty_title',
            'dashboard_summary_empty_meta',
            'dashboard_summary_ready_one',
            'dashboard_summary_ready_many',
            'dashboard_summary_ready_meta',
        ].forEach((key) => {
            const occurrences = i18n.match(new RegExp(`"${key}"`, 'g')) || [];
            expect(occurrences.length).toBeGreaterThanOrEqual(4);
        });
        expect(i18n).toContain('"dashboard_summary_ready_many": "{count} entities ready"');
        expect(i18n).toContain('"dashboard_summary_ready_many": "{count} 個實體可用"');
        expect(i18n).toContain('"dashboard_summary_ready_many": "{count} 个实体可用"');
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

    test('card_cb00b807: mobile summary collapses the empty gap (justify-content:flex-start)', () => {
        // The base rule is space-between (horizontal row); the mobile column MUST
        // override it to flex-start or the title/metrics get pushed apart vertically.
        expect(html).toMatch(/@media \(max-width: 640px\)[\s\S]*\.dashboard-entity-summary\s*\{[\s\S]*flex-direction:\s*column[\s\S]*justify-content:\s*flex-start/);
    });

    test('card_cb00b807: the 4 overview tiles are actionable buttons with drill-in + labels', () => {
        // each metric is a <button> wired to drillDashboardMetric + a descriptive title
        ['bound', 'active', 'channel', 'e2ee'].forEach((m) => {
            expect(html).toMatch(new RegExp(`<button[^>]*class="dashboard-entity-metric"[^>]*data-metric="${m}"[^>]*onclick="drillDashboardMetric\\('${m}'\\)"[^>]*title=`));
        });
        expect(html).toMatch(/function drillDashboardMetric\(/);
        // interactivity affordance + a11y focus ring on the tiles
        expect(html).toMatch(/\.dashboard-entity-metric\s*\{[\s\S]*cursor:\s*pointer/);
        expect(html).toMatch(/\.dashboard-entity-metric:focus-visible\s*\{[\s\S]*outline:/);
    });
});
