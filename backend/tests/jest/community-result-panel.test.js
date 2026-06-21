const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
    path.join(__dirname, '../../public/portal/community.html'),
    'utf8',
);

describe('community.html result context controls', () => {
    test('renders a live result summary between filters and stats', () => {
        expect(html).toContain('class="plaza-result-panel" id="resultPanel" role="status" aria-live="polite"');
        expect(html).toContain('id="resultSummary"');
        expect(html).toContain('id="resultDetail"');
        expect(html).toContain('id="clearAllFilters" type="button" onclick="clearAllFilters()" disabled');
    });

    test('result panel describes active search, category, capabilities, and rate filters', () => {
        expect(html).toContain('function updateResultPanel(resultCount)');
        expect(html).toContain('activeParts.push(\'search "\' + searchQuery + \'"\')');
        expect(html).toContain("activeParts.push('category ' + currentFilterLabel())");
        expect(html).toContain("activeParts.push('capabilities ' + Array.from(selectedCaps).join(', '))");
        expect(html).toContain("activeParts.push('rate ' + rateMin + '-' + rateMax + ' ecoin/1K')");
        expect(html).toContain('clearBtn.disabled = !hasActive');
    });

    test('clear-all resets every narrowing control without changing sort', () => {
        expect(html).toContain('function clearAllFilters()');
        expect(html).toContain("if (searchInput) searchInput.value = ''");
        expect(html).toContain("if (rateMinEl) rateMinEl.value = '1'");
        expect(html).toContain("if (rateMaxEl) rateMaxEl.value = '50'");
        expect(html).toContain("currentFilter = 'all'");
        expect(html).toContain('selectedCaps.clear()');
        expect(html).toContain('rateMin = 1;');
        expect(html).toContain('rateMax = 50;');
    });

    test('grid rendering keeps the result summary in sync with loaded and empty states', () => {
        expect(html).toContain('updateResultPanel(0)');
        expect(html).toContain('updateResultPanel(bots.length)');
        expect(html).toContain('function filterAndSort() { updateResultPanel(); loadBots(); }');
    });
});
