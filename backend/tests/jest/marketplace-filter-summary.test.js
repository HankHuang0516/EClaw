const fs = require('fs');
const path = require('path');

const MARKETPLACE_HTML = path.join(__dirname, '../../public/portal/marketplace.html');

describe('marketplace filter result summary', () => {
    const html = fs.readFileSync(MARKETPLACE_HTML, 'utf8');

    test('renders a live result summary and clear filters control', () => {
        expect(html).toContain('class="mp-results-bar"');
        expect(html).toContain('aria-live="polite"');
        expect(html).toContain('id="resultSummary"');
        expect(html).toContain('id="filterSummary"');
        expect(html).toContain('id="clearFiltersButton"');
    });

    test('tracks active search, capability, and rate filters', () => {
        expect(html).toContain('function hasActiveMarketplaceFilters()');
        expect(html).toMatch(/document\.getElementById\('searchInput'\)\?\.value\.trim\(\)/);
        expect(html).toMatch(/document\.getElementById\('capabilitySelect'\)\?\.value/);
        expect(html).toMatch(/min > RATE_MIN \|\| max < RATE_MAX/);
    });

    test('clear filters resets only filter controls and reloads marketplace data', () => {
        expect(html).toContain('function resetMarketplaceFilters()');
        expect(html).toContain("document.getElementById('searchInput').value = ''");
        expect(html).toContain("document.getElementById('capabilitySelect').value = ''");
        expect(html).toContain("document.getElementById('minRateInput').value = String(RATE_MIN)");
        expect(html).toContain("document.getElementById('maxRateInput').value = String(RATE_MAX)");
        expect(html).toMatch(/clearFiltersButton'\)\.addEventListener\('click', resetMarketplaceFilters\)/);
    });

    test('refreshes the result summary after async loading completes', () => {
        expect(html).toMatch(/finally\s*{\s*state\.loading = false;\s*updateFilterSummary\(\);/);
    });

    test('empty state distinguishes no marketplace data from no matching filters', () => {
        expect(html).toContain('No matching bots for current filters.');
        expect(html).toContain("tt('community_empty_desc', 'Try different keywords or filters')");
        expect(html).toContain("tt('mp_no_results', 'No bots available yet. Check back later!')");
    });
});
