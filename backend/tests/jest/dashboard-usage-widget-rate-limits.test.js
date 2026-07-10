'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DASHBOARD_HTML = path.resolve(__dirname, '../../public/portal/dashboard.html');

function makeLocalStorage() {
    const store = new Map();
    return {
        getItem(key) {
            return store.has(key) ? store.get(key) : null;
        },
        setItem(key, value) {
            store.set(key, String(value));
        }
    };
}

function loadUsageHelpers(localStorage = makeLocalStorage()) {
    const html = fs.readFileSync(DASHBOARD_HTML, 'utf8');
    const match = html.match(/const CODEX_RATE_LIMIT_CACHE_KEY[\s\S]*?\n\s*function renderClaudeBars/);
    expect(match).toBeTruthy();
    const helperCode = match[0].replace(/\n\s*function renderClaudeBars$/, '');
    const context = {
        window: { localStorage }
    };

    return vm.runInNewContext(
        helperCode + '\n({ normalizeCodexRateLimits, isValidCodexRateLimits, isUntrustedZeroCodexRateLimits, resolveCodexRateLimits, withResolvedCodexRateLimits });',
        context
    );
}

describe('Dashboard usage widget Codex rate limits', () => {
    test('rejects the Codex CLI zero-window raw rate-limit block', () => {
        const helpers = loadUsageHelpers();
        expect(helpers.isValidCodexRateLimits({
            primary: { used_percent: 0.0, window_minutes: 0, resets_at: 1780000000 },
            secondary: null,
            plan_type: 'pro'
        })).toBe(false);
    });

    test('falls back to the previous valid flat Codex rate limits', () => {
        const helpers = loadUsageHelpers();
        const valid = {
            five_hour_pct: 42,
            five_hour_resets_at: 1780000000,
            seven_day_pct: 17,
            seven_day_resets_at: 1780500000,
            plan_type: 'pro',
            updated_at: '2026-06-03T10:00:00Z'
        };

        expect(helpers.resolveCodexRateLimits(valid)).toEqual(valid);
        expect(helpers.resolveCodexRateLimits({
            five_hour_pct: 0,
            five_hour_resets_at: 1780000000,
            seven_day_pct: null,
            seven_day_resets_at: null,
            plan_type: 'pro'
        })).toEqual(valid);
    });

    test('falls back to cached valid Codex rate limits after reload', () => {
        const localStorage = makeLocalStorage();
        const firstLoad = loadUsageHelpers(localStorage);
        const valid = {
            five_hour_pct: 34,
            five_hour_resets_at: 1780000100,
            seven_day_pct: 12,
            seven_day_resets_at: 1780500100,
            plan_type: 'pro',
            updated_at: '2026-06-03T10:01:00Z'
        };

        firstLoad.resolveCodexRateLimits(valid);
        const secondLoad = loadUsageHelpers(localStorage);

        expect(secondLoad.resolveCodexRateLimits({
            primary: { used_percent: 0.0, window_minutes: 0, resets_at: 1780000200 },
            secondary: null,
            plan_type: 'pro'
        })).toEqual(valid);
    });

    test('does not treat unattributed zero Codex limits as valid quota truth', () => {
        const helpers = loadUsageHelpers();

        expect(helpers.isUntrustedZeroCodexRateLimits({
            five_hour_pct: 0,
            five_hour_resets_at: 1780000000,
            seven_day_pct: 0,
            seven_day_resets_at: 1780500000,
            plan_type: null,
            updated_at: '2026-07-10T09:47:04.965Z'
        })).toBe(true);
        expect(helpers.isValidCodexRateLimits({
            five_hour_pct: 0,
            five_hour_resets_at: 1780000000,
            seven_day_pct: 0,
            seven_day_resets_at: 1780500000,
            plan_type: null,
            updated_at: '2026-07-10T09:47:04.965Z'
        })).toBe(false);
        expect(helpers.isValidCodexRateLimits({
            five_hour_pct: 0,
            five_hour_resets_at: 1780000000,
            seven_day_pct: 0,
            seven_day_resets_at: 1780500000,
            plan_type: 'prolite',
            updated_at: '2026-07-10T09:47:04.965Z'
        })).toBe(true);
    });

    test('keeps previous nonzero Codex limits when a device-latest row reports unattributed zero', () => {
        const helpers = loadUsageHelpers();
        const valid = {
            five_hour_pct: 94,
            five_hour_resets_at: 1783677455,
            seven_day_pct: 17,
            seven_day_resets_at: 1784244512,
            plan_type: 'prolite',
            updated_at: '2026-07-10T09:48:18.522Z'
        };

        expect(helpers.resolveCodexRateLimits(valid)).toEqual(valid);
        expect(helpers.resolveCodexRateLimits({
            five_hour_pct: 0,
            five_hour_resets_at: 1783694855,
            seven_day_pct: 0,
            seven_day_resets_at: 1784281655,
            plan_type: null,
            updated_at: '2026-07-10T09:48:01.464Z'
        })).toEqual(valid);
    });

    test('loader renders with resolved latest snapshot data', () => {
        const html = fs.readFileSync(DASHBOARD_HTML, 'utf8');
        expect(html).toContain('const latest = withResolvedCodexRateLimits(snap.latest);');
        expect(html).toContain('renderCodexBars(latest);');
        expect(html).not.toContain('renderCodexBars(snap.latest);');
    });
});
