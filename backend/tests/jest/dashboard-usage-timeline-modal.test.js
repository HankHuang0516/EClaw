/**
 * Usage timeline modal — card_fb8a5a39ebe67581a66c6061.
 * Backend GET /timeline shipped in PR #3291 (5h/7d pct fields); this slice is
 * the dashboard modal. Contract tests over dashboard.html source + the chart
 * geometry helper executed in a VM; interaction covered by prod Playwright E2E.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(
    path.resolve(__dirname, '../../public/portal/dashboard.html'),
    'utf8'
);
const i18nSrc = fs.readFileSync(
    path.resolve(__dirname, '../../public/shared/i18n.js'),
    'utf8'
);

describe('usage timeline modal — wiring contract', () => {
    test('whole-widget click opens the modal, buttons excluded', () => {
        expect(src).toMatch(/w\.addEventListener\('click', \(e\) => \{\s*if \(e\.target\.closest\('button, a'\)\) return;\s*openUsageTimelineModal\(\);/);
    });
    test('modal fetches both windows: 24h and 720h (30d)', () => {
        expect(src).toMatch(/Promise\.all\(\[fetchPts\(24\), fetchPts\(720\)\]\)/);
        expect(src).toMatch(/\/api\/usage\/timeline\?hours=/);
    });
    test('reads the #3291 pct fields', () => {
        for (const f of ['claude_5h_pct', 'codex_5h_pct', 'claude_7d_pct', 'codex_7d_pct']) {
            expect(src).toContain(f);
        }
    });
    test('uses the existing uw color tokens (no palette drift)', () => {
        for (const c of ['#ff8a5c', '#ffc857', '#5cdfff', '#3aa6ff']) {
            expect(src).toContain(c);
        }
    });
    test('empty data falls back to the no-data i18n string', () => {
        expect(src).toMatch(/dashboard_usage_chart_no_data/);
    });
    test('usage widget gets pointer cursor, refresh button keeps refreshUsageWidget', () => {
        expect(src).toMatch(/\.usage-widget \{ cursor: pointer; \}/);
        expect(src).toMatch(/onclick="refreshUsageWidget\(\)"/);
    });
});

describe('usage timeline modal — chart geometry (_utlChartSvg in VM)', () => {
    const match = src.match(/function _utlChartSvg[\s\S]*?\n        \}/);
    expect(match).toBeTruthy();
    const ctx = {};
    vm.createContext(ctx);
    vm.runInContext(match[0] + '; this._fn = _utlChartSvg;', ctx);
    const fn = ctx._fn;

    const mk = (n, base) => Array.from({ length: n }, (_, i) => ({
        t: new Date(Date.UTC(2026, 5, 11, 0, i * 10)),
        a: base + i, b: null,
    }));

    test('returns null for <2 usable points (graceful empty state)', () => {
        expect(fn([], ['a', 'b'], ['#fff', '#000'])).toBeNull();
        expect(fn(mk(1, 10), ['a', 'b'], ['#fff', '#000'])).toBeNull();
    });

    test('renders a polyline for a populated series and skips the all-null one', () => {
        const svg = fn(mk(5, 10), ['a', 'b'], ['#abc111', '#def222']);
        expect(svg).toContain('<polyline');
        expect(svg).toContain('#abc111');
        expect(svg).not.toContain('#def222'); // series b is all null → no line
    });

    test('clamps out-of-range percentages into the 0-100 band', () => {
        const pts = [
            { t: new Date(Date.UTC(2026, 5, 11, 0, 0)), a: -20, b: null },
            { t: new Date(Date.UTC(2026, 5, 11, 1, 0)), a: 250, b: null },
        ];
        const svg = fn(pts, ['a', 'b'], ['#aaa', '#bbb']);
        // y for 0% is H-PY=148, y for 100% is PY=12 — both endpoints clamp there
        expect(svg).toContain('148.0');
        expect(svg).toContain('12.0');
    });

    test('draws the 0/25/50/75/100 gridline labels', () => {
        const svg = fn(mk(3, 50), ['a', 'b'], ['#aaa', '#bbb']);
        for (const v of ['>0<', '>25<', '>50<', '>75<', '>100<']) expect(svg).toContain(v);
    });
});

describe('usage timeline modal — i18n keys', () => {
    const NEEDED = [
        'dashboard_usage_chart_modal_title',
        'dashboard_usage_chart_5h_label',
        'dashboard_usage_chart_weekly_label',
        'dashboard_usage_chart_loading',
        'dashboard_usage_chart_no_data',
    ];
    test.each(NEEDED)('%s is declared in i18n.js', (key) => {
        expect(i18nSrc).toMatch(new RegExp('"' + key + '":'));
    });
});
