const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ops = require('../../aihankapps-ops');
const source = fs.readFileSync(path.resolve(__dirname, '../../aihankapps-hub/hub-wishlist-ops.js'), 'utf8');
const HOUR = 3600000, NOW = Date.UTC(2026, 10, 14, 4, 15);
function load(lang = 'zh-Hant') {
    const sandbox = { window: {}, document: { documentElement: { lang } }, Date, Intl, Number, String, Object, Array, Map, Set };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../aihankapps-hub/hub-wishlist-i18n.js'), 'utf8'), sandbox);
    vm.runInNewContext(source, sandbox);
    return sandbox.window.HubWishlistOps;
}
const windowOf = extra => ({ from: NOW - HOUR, to: NOW, count: 0, lowerBound: 0, coverage: 'complete', fresh: true, ...extra });
const summary = w => ({ workers: [{ id: 'wishlist-retail', metrics: [{ id: 'retail_lookups_completed', last60Minutes: w }] }] });
const parsed = w => ops.workSummary(summary(w)).totals['work.wishlist-retail.retail_lookups_completed'];

describe('Wishlist rolling-hour workload', () => {
    test('preserves a source-issued exact zero, separately from CP counts', () => {
        const ui = load();
        expect(ui.recentValue(parsed(windowOf()), NOW)).toMatchObject({ value: 0, exact: true });
        const html = ui.recentCells({ ok: true, workTotals: {
            'work.wishlist-retail.retail_lookups_completed': parsed(windowOf({ count: 12 })),
            'work.wishlist-retail.retail_cp_evaluated': parsed(windowOf({ count: 7 }))
        } }, NOW);
        expect(html).toContain('12 件'); expect(html).toContain('7 件'); expect(html).not.toContain('19 件');
    });
    test('partial windows keep a lower bound instead of inventing an exact count', () => {
        const data = parsed(windowOf({ coverage: 'partial', count: 999, lowerBound: 4 }));
        expect(data.last60Minutes.count).toBeNull();
        expect(load().recentValue(data, NOW)).toMatchObject({ value: 4, exact: false });
        const html = load().recentCells({ ok: true, workTotals: { 'work.wishlist-retail.retail_lookups_completed': data } }, NOW);
        expect(html).toContain('至少 4 件'); expect(html).not.toContain('999');
    });
    test.each([null, undefined, '0', false, NaN, -1, 1.5])('invalid count %p remains unknown', count => {
        const data = parsed(windowOf({ count, lowerBound: null }));
        expect(load().recentValue(data, NOW).value).toBeNull();
    });
    test('old or failed live reads do not display stale counts', () => {
        expect(load().recentValue(parsed(windowOf({ fresh: false })), NOW).value).toBeNull();
        expect(load().recentValue(parsed(windowOf()), NOW + 11 * 60000).value).toBeNull();
        expect(load().recentValue(parsed(windowOf({ fresh: undefined })), NOW).value).toBeNull();
        expect(load().recentCells({ ok: false, workTotals: { 'work.wishlist-retail.retail_lookups_completed': parsed(windowOf({ count: 5 })) } }, NOW)).not.toContain('5 件');
    });
    test('zero lower bounds and unobserved windows are not exact zero observations', () => {
        expect(load().recentValue(parsed(windowOf({ coverage: 'partial', count: null, lowerBound: 0 })), NOW).value).toBeNull();
        expect(load().recentValue(parsed(windowOf({ coverage: 'not_observed', count: null, lowerBound: null })), NOW).value).toBeNull();
    });
    test('a closed hourly bucket or cumulative total cannot stand in for a rolling hour', () => {
        expect(load().recentValue({ sinceCollectionStart: 200 }, NOW).value).toBeNull();
        expect(parsed(windowOf({ from: NOW - 2 * HOUR })).last60Minutes).toBeUndefined();
        expect(parsed(windowOf({ coverage: 'invented' })).last60Minutes).toBeUndefined();
    });
    test('public projection never includes source event IDs or arbitrary fields', () => {
        const data = parsed(windowOf({ count: 1, sourcePath: '/private', events: ['private-id'], secret: 'never-public' }));
        expect(JSON.stringify(data)).not.toMatch(/private|never-public|events|secret/);
        expect(Object.keys(data.last60Minutes).sort()).toEqual(['count', 'coverage', 'fresh', 'from', 'lowerBound', 'to']);
    });
});

describe('Wishlist operations copy', () => {
    test.each(['en', 'zh-TW', 'zh-CN', 'ja', 'ko'])('rolling count and chart labels render in %s', lang => {
        const ui = load(lang);
        const html = ui.recentCells({ ok: true, workTotals: { 'work.wishlist-retail.retail_lookups_completed': parsed(windowOf({ count: 12 })) } }, NOW);
        expect(html).not.toMatch(/\{time\}|\{n\}|undefined/);
        expect(html).toContain('12');
    });
    test('all supported dictionaries have the same keys and interpolation variables', () => {
        const sandbox = { window: {}, document: { documentElement: { lang: 'en' } } };
        vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../aihankapps-hub/hub-wishlist-i18n.js'), 'utf8'), sandbox);
        const { messages, locales, t } = sandbox.window.HubWishlistText;
        const variables = text => (text.match(/\{\w+\}/g) || []).sort();
        for (const locale of locales) {
            expect(Object.keys(messages[locale]).sort()).toEqual(Object.keys(messages.en).sort());
            for (const key of Object.keys(messages.en)) {
                expect(messages[locale][key].trim()).not.toBe('');
                expect(variables(messages[locale][key])).toEqual(variables(messages.en[key]));
            }
        }
        expect(t('至少 {n} 件', { n: 4 })).toBe('At least 4');
    });
});

describe('shared operations chart lifecycle', () => {
    test('disposing a lazy chart cancels its pending load and observer', () => {
        jest.useFakeTimers();
        try {
            const sandbox = { window: { document: {} }, document: { body: { hasAttribute: () => false } }, Map, Set, Date, Intl, Number, Math, clearTimeout, setTimeout };
            vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../public/AiHankApps/ops/ops-view.js'), 'utf8'), sandbox);
            const chart = { generation: 0, loadTimer: setTimeout(() => { throw new Error('disposed load ran'); }, 100), observer: { disconnect: jest.fn() }, cache: new Map([['hour', {}]]), cancelGesture: jest.fn() };
            sandbox.window.AiHankOpsCharts.WaveChart.prototype.destroy.call(chart);
            jest.runAllTimers();
            expect(chart.observer.disconnect).toHaveBeenCalledTimes(1);
            expect(chart.cancelGesture).toHaveBeenCalledTimes(1);
            expect(chart.cache.size).toBe(0);
            expect(chart.destroyed).toBe(true);
        } finally { jest.useRealTimers(); }
    });
});
