const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '../../public/portal/card-holder.html');

describe('card-holder page UI summary', () => {
    let html;

    beforeAll(() => {
        html = fs.readFileSync(htmlPath, 'utf8');
    });

    test('renders a live result panel with a clear action', () => {
        expect(html).toContain('id="cardholderResultPanel"');
        expect(html).toContain('aria-live="polite"');
        expect(html).toContain('id="cardholderResultTitle"');
        expect(html).toContain('id="cardholderResultMeta"');
        expect(html).toContain('id="cardholderClearBtn"');
        expect(html).toContain('onclick="clearCardholderView()"');
    });

    test('keeps filter and search totals in a shared summary function', () => {
        expect(html).toContain('function updateCardholderSummary()');
        expect(html).toContain('formatCount(total');
        expect(html).toContain('searchSaved.length + searchExternal.length');
        expect(html).toContain('myCards.length + filteredRecent.length + filteredCollected.length');
        expect(html).toContain('if (currentFilter === \'requests\')');
    });

    test('clear action resets search state and the active filter', () => {
        expect(html).toContain('function clearCardholderView()');
        expect(html).toContain('searchInput.value = \'\'');
        expect(html).toContain('activeSearchQuery = \'\'');
        expect(html).toContain('searchSaved = []');
        expect(html).toContain('searchExternal = []');
        expect(html).toContain('setFilter(\'all\')');
    });

    test('short search queries no longer leave stale result panes visible', () => {
        expect(html).toContain('if (query.length < 2)');
        expect(html).toContain('isSearching = false;');
        expect(html).toContain('rebuildContent();');
    });

    test('local translation helper uses fallback text for missing keys', () => {
        expect(html).toContain('const value = i18n.t(key);');
        expect(html).toContain('return value && value !== key ? value : fallback;');
    });
});
