const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(
    path.join(__dirname, '../../public/portal/community.html'),
    'utf8',
);
const i18n = fs.readFileSync(
    path.join(__dirname, '../../public/shared/i18n.js'),
    'utf8',
);

const RESULT_I18N_KEYS = [
    'community_result_summary_default',
    'community_result_detail_default',
    'community_result_clear_filters',
    'community_result_filter_search',
    'community_result_filter_category',
    'community_result_filter_capabilities',
    'community_result_filter_rate',
    'community_result_filter_separator',
    'community_result_count_one',
    'community_result_count_many',
    'community_result_count_unknown',
    'community_result_summary_filtered',
    'community_result_summary_default_count',
    'community_result_detail_filtered',
    'community_result_detail_default_sorted',
];

const ERROR_I18N_KEYS = [
    'community_error_title',
    'community_error_desc',
];

function loadTranslations() {
    const noop = () => {};
    const sandbox = {
        _result: null,
        localStorage: { getItem: () => null, setItem: noop },
        navigator: { language: 'en' },
        document: { querySelectorAll: () => [], documentElement: { lang: 'en' }, addEventListener: noop, getElementById: () => null },
        window: { location: { search: '' } },
        setTimeout: noop,
        console: { log: noop, warn: noop, error: noop },
    };
    vm.createContext(sandbox);
    vm.runInContext(i18n + '\n_result = TRANSLATIONS;', sandbox, { timeout: 5000 });
    return sandbox._result;
}

function hasKey(dict, key) {
    return Object.prototype.hasOwnProperty.call(dict, key);
}

describe('community.html result context controls', () => {
    test('renders a live result summary between filters and stats', () => {
        expect(html).toContain('class="plaza-result-panel" id="resultPanel" role="status" aria-live="polite"');
        expect(html).toContain('id="resultSummary" data-i18n="community_result_summary_default"');
        expect(html).toContain('id="resultDetail" data-i18n="community_result_detail_default"');
        expect(html).toContain('id="clearAllFilters" type="button" onclick="clearAllFilters()" data-i18n="community_result_clear_filters" disabled');
    });

    test('result panel describes active search, category, capabilities, and rate filters', () => {
        expect(html).toContain('function updateResultPanel(resultCount, options = {})');
        expect(html).toContain("activeParts.push(tr('community_result_filter_search', { query: searchQuery }))");
        expect(html).toContain("activeParts.push(tr('community_result_filter_category', { category: currentFilterLabel() }))");
        expect(html).toContain("activeParts.push(tr('community_result_filter_capabilities', { capabilities: Array.from(selectedCaps).join(', ') }))");
        expect(html).toContain("activeParts.push(tr('community_result_filter_rate', { min: rateMin, max: rateMax }))");
        expect(html).toContain("tr('community_result_summary_filtered'");
        expect(html).toContain("'community_result_detail_default_sorted'");
        expect(html).toContain('clearBtn.disabled = !hasActive');
    });

    test('initializes the select control to the API sort before first render', () => {
        expect(html).toContain("let currentSort = 'newest'");
        expect(html).toContain("const sortSelect = document.getElementById('sortSelect')");
        expect(html).toContain('if (sortSelect) sortSelect.value = currentSort');
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
        expect(html).toContain('updateResultPanel(0, { error: options.error })');
        expect(html).toContain('updateResultPanel(bots.length)');
        expect(html).toContain('function filterAndSort() { syncFiltersToUrl(); updateResultPanel(); loadBots(); }');
    });

    test('load errors use a distinct localized result and empty state', () => {
        expect(html).toContain('renderGrid([], { error: true })');
        expect(html).toContain("summary.textContent = tr('community_error_title')");
        expect(html).toContain("detail.textContent = tr('community_error_desc')");
        expect(html).toContain("const titleKey = mode === 'error' ? 'community_error_title' : 'community_empty_title'");
        expect(html).toContain("const descKey = mode === 'error' ? 'community_error_desc' : 'community_empty_desc'");
        expect(html).toContain('updateResultPanel(0, { error: options.error })');
    });

    test('defines result panel i18n keys across supported locales', () => {
        const translations = loadTranslations();
        const localeEntries = Object.entries(translations).filter(([, dict]) => dict && typeof dict === 'object');
        const nonZhTwLocales = localeEntries.filter(([locale]) => locale !== 'zh-TW');

        RESULT_I18N_KEYS.forEach(key => {
            expect(hasKey(translations.zh, key)).toBe(true);
            expect(hasKey(translations['zh-TW'], key)).toBe(false);

            const missingLocales = nonZhTwLocales
                .filter(([, dict]) => !hasKey(dict, key))
                .map(([locale]) => locale);
            expect(missingLocales).toEqual([]);
        });

        ERROR_I18N_KEYS.forEach(key => {
            const missingLocales = localeEntries
                .filter(([, dict]) => !hasKey(dict, key))
                .map(([locale]) => locale);
            expect(missingLocales).toEqual([]);
        });
    });
});

describe('community.html filter URL persistence (card_f6b61c8)', () => {
    test('filterAndSort syncs filters to the URL', () => {
        expect(html).toContain('function filterAndSort() { syncFiltersToUrl(); updateResultPanel(); loadBots(); }');
        expect(html).toContain('function syncFiltersToUrl()');
        expect(html).toContain('history.replaceState(null,');
    });

    test('syncFiltersToUrl writes q/sort/rateMin/rateMax and clears defaults', () => {
        const sync = html.slice(html.indexOf('function syncFiltersToUrl()'), html.indexOf('function restoreFiltersFromUrl()'));
        expect(sync).toContain("searchQuery ? p.set('q', searchQuery) : p.delete('q')");
        expect(sync).toContain("p.set('sort', currentSort) : p.delete('sort')");
        expect(sync).toContain("p.set('rateMin', String(rateMin)) : p.delete('rateMin')");
        expect(sync).toContain("p.set('rateMax', String(rateMax)) : p.delete('rateMax')");
        // preserves unrelated params by starting from the current querystring
        expect(sync).toContain('new URLSearchParams(window.location.search)');
    });

    test('restoreFiltersFromUrl runs before the initial render and rehydrates state + inputs', () => {
        expect(html).toContain('function restoreFiltersFromUrl()');
        // called before the first sortSelect.value assignment / bootstrap loadBots
        const restoreIdx = html.indexOf('restoreFiltersFromUrl();\n    const sortSelect = document.getElementById(\'sortSelect\');');
        expect(restoreIdx).toBeGreaterThan(-1);
        const restore = html.slice(html.indexOf('function restoreFiltersFromUrl()'), html.indexOf('/* ══════ Interactions ══════ */'));
        expect(restore).toContain("const q = p.get('q')");
        expect(restore).toContain("if (si) si.value = searchQuery");
        expect(restore).toContain("if (ss) ss.value = sort");
        expect(restore).toContain('Math.min(Math.max(rmin, 1), 50)');
    });
});
