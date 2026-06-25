const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '../../public/portal/card-holder.html');
const i18nPath = path.join(__dirname, '../../public/shared/i18n.js');

describe('card-holder page UI summary', () => {
    let html;
    let i18n;

    beforeAll(() => {
        html = fs.readFileSync(htmlPath, 'utf8');
        i18n = fs.readFileSync(i18nPath, 'utf8');
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
        expect(html).toContain('cardholder_search_result_one');
        expect(html).toContain('cardholder_search_result_many');
        expect(html).toContain('cardholder_search_meta');
        expect(html).toContain('cardholder_cards_shown_one');
        expect(html).toContain('cardholder_cards_shown_many');
        expect(html).toContain('cardholder_summary_meta');
        expect(html).toContain('cardholder_pending_request_one');
        expect(html).toContain('cardholder_pending_request_many');
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

    test('in-flight searches cannot restore stale result panes', () => {
        expect(html).toContain('let searchRequestSeq = 0;');
        expect(html).toContain('const requestSeq = ++searchRequestSeq;');
        expect(html).toContain('function isLatestSearchQuery(query, requestSeq)');
        expect(html).toContain('if (!isLatestSearchQuery(query, requestSeq)) return;');
        expect(html).toContain('searchDebounce = setTimeout(() => performSearch(query, requestSeq), 300);');
    });

    test('local translation helper uses fallback text for missing keys', () => {
        expect(html).toContain('const value = i18n.t(key);');
        expect(html).toContain('return value && value !== key ? value : fallback;');
    });

    test('summary and clear states ship EN and ZH translations', () => {
        [
            'common_clear',
            'cardholder_clear_search',
            'cardholder_clear_filter',
            'cardholder_requests_hint',
            'cardholder_active_filter',
            'cardholder_cards_shown_one',
            'cardholder_cards_shown_many',
            'cardholder_summary_meta',
            'cardholder_search_result_one',
            'cardholder_search_result_many',
            'cardholder_search_meta',
            'cardholder_pending_request_one',
            'cardholder_pending_request_many',
        ].forEach((key) => {
            const occurrences = i18n.match(new RegExp(`"${key}"`, 'g')) || [];
            expect(occurrences.length).toBeGreaterThanOrEqual(2);
        });
    });
});
