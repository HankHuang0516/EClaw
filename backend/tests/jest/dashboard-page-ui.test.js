const fs = require('fs');
const path = require('path');

/**
 * Dashboard "實體總覽" entity-overview summary panel REMOVAL guard.
 *
 * 2026-06-27 (Hank, web_chat): the codex #3740 "entity overview" panel — a big
 * Loading/Bound/Active/Channel/E2EE summary block above the entity grid — was a
 * useless DUPLICATE of the entity grid/list it sat on top of (it just restated
 * counts while filling the whole first screen). Hank asked to remove it and told
 * the designing entity to assess existing UI before enhancing, not duplicate
 * functionality. PR removes the panel (HTML + CSS + JS cluster + the loadEntities
 * side-effect calls + the tab-visibility refs).
 *
 * These tests are the regression guard (per Hank「漏掉的缺口都要有testcase」): they
 * fail if the duplicate panel — or any of its symbols — is reintroduced, and
 * confirm the real content (entity grid, tabs, add-entity, loader) is intact.
 */
describe('dashboard entity-overview panel is removed (no duplicate of the entity grid)', () => {
    const pagePath = path.join(__dirname, '../../public/portal/dashboard.html');
    const html = fs.readFileSync(pagePath, 'utf8');

    test('the summary panel markup is gone', () => {
        expect(html).not.toContain('dashboardEntitySummary');
        expect(html).not.toContain('class="dashboard-entity-summary"');
        expect(html).not.toContain('dashboard-entity-metrics');
        expect(html).not.toContain('dashboard-entity-metric');
        expect(html).not.toContain('dashboard-entity-actions');
        expect(html).not.toContain('id="dashboardMetricBound"');
        expect(html).not.toContain('id="dashboardMetricActive"');
        expect(html).not.toContain('id="dashboardMetricChannel"');
        expect(html).not.toContain('id="dashboardMetricE2ee"');
        expect(html).not.toContain('id="dashboardSummaryRefresh"');
        expect(html).not.toContain('id="dashboardSummaryAdd"');
    });

    test('the panel JS cluster is gone (no dead code / dangling refs)', () => {
        expect(html).not.toContain('renderDashboardEntitySummary');
        expect(html).not.toContain('drillDashboardMetric');
        expect(html).not.toContain('refreshDashboardEntities');
        expect(html).not.toContain('function focusAddEntity');
        expect(html).not.toContain('function setDashboardMetric');
        expect(html).not.toContain('function dashboardText');
        expect(html).not.toContain('function formatDashboardText');
        expect(html).not.toContain('function isDashboardEntityActive');
    });

    test('the panel CSS is gone', () => {
        expect(html).not.toMatch(/\.dashboard-entity-summary\s*\{/);
        expect(html).not.toMatch(/\.dashboard-entity-metric\s*\{/);
    });

    test('the REAL entity content the panel duplicated is preserved', () => {
        // entity grid + its loader (the canonical source of the counts the panel echoed)
        expect(html).toContain("id=\"entityGrid\"");
        expect(html).toMatch(/async function loadEntities\(\)/);
        // the Entities / Org Chart tabs + add-entity flow still present
        expect(html).toContain('data-tab-content="entities"') ; // grid section keeps the tab hook
        expect(html).toMatch(/id=["']addEntityCard["']/);
        expect(html).toMatch(/function toggleAddEntity\(/);
        // tab-visibility no longer references the removed summary element
        expect(html).not.toContain("getElementById('dashboardEntitySummary')");
    });
});
