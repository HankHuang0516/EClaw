/**
 * Static invariant test for petdx-browser pagination.
 *
 * Originally written for the load-more flavour (card_6e21220bbf406675e7992790,
 * Hank 2026-06-12). Rewritten for the prev/next 60-per-page redesign
 * (card_ddb8ebfd2112b8cfc89ebc9f, Hank 2026-06-14) — switched away from
 * load-more so DOM nodes from the previous page get GC'd between flips and
 * the heap stays flat on long sessions.
 *
 * jest.config.js uses testEnvironment: 'node' (matching the portal static
 * tests), so we lock the SOURCE surface here. Runtime behaviour is covered by
 * the prod E2E and companion-api.test.js (server response shape).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'petdx-browser.html'),
    'utf8'
);

describe('petdx-browser pagination (prev/next, 60 per page)', () => {
    test('sends page + 60-card limit to /api/companion/list', () => {
        expect(html).toMatch(/q\.set\(\s*['"]page['"]\s*,\s*String\(currentPage\)\s*\)/);
        expect(html).toMatch(/const\s+PAGE_SIZE\s*=\s*60/);
        expect(html).toMatch(/q\.set\(\s*['"]limit['"]\s*,\s*String\(PAGE_SIZE\)\s*\)/);
    });

    test('loadList replaces grid each call (no append mode)', () => {
        // No `append` param on loadList — every call is a fresh page.
        expect(html).toMatch(/async function loadList\(\s*\)/);
        // Append-mode primitives from the old design must be gone.
        expect(html).not.toMatch(/loadedCount/);
        expect(html).not.toMatch(/loadingMore/);
        expect(html).not.toMatch(/load-more-btn/);
    });

    test('tears down per-card renderers + clears grid before the next fetch', () => {
        // tearDownRenderers + grid.innerHTML = '' must happen BEFORE the await
        // — without this, the old 60 canvases linger through the fetch and
        // heap usage doubles between page-flips.
        const loadList = html.match(/async function loadList\(\)\s*\{[\s\S]*?const q = authQuery\(\);/);
        expect(loadList).not.toBeNull();
        expect(loadList[0]).toMatch(/tearDownRenderers\(\)/);
        expect(loadList[0]).toMatch(/grid\.innerHTML\s*=\s*['"]['"]/);
    });

    test('derives totalPages from total + clamps current page when filter shrinks result set', () => {
        expect(html).toMatch(/totalPages\s*=\s*Math\.max\(\s*1\s*,\s*Math\.ceil\(\s*totalCount\s*\/\s*PAGE_SIZE\s*\)\s*\)/);
        // After the count comes back, if currentPage > totalPages we re-fetch
        // the clamped page rather than showing a confusing empty grid.
        expect(html).toMatch(/currentPage\s*>\s*totalPages/);
    });

    test('renders prev + next buttons disabled at the ends', () => {
        expect(html).toMatch(/className\s*=\s*['"]pager-btn['"]/);
        expect(html).toMatch(/prev\.disabled\s*=\s*currentPage\s*<=\s*1/);
        expect(html).toMatch(/next\.disabled\s*=\s*currentPage\s*>=\s*totalPages/);
        // A "Page X of Y" indicator must surface somewhere; bilingual string is fine.
        expect(html).toMatch(/Page \$\{currentPage\} of \$\{totalPages\}/);
    });

    test('filter / search / entity-selector changes reset to page 1', () => {
        // resetFilters() + filter chip click + search debounce + selector change
        // all set currentPage = 1 before re-querying.
        const resetCount = (html.match(/currentPage\s*=\s*1/g) || []).length;
        // 5 expected sites: filter chip handler, resetFilters, search debounce,
        // entity-selector change, and URL-restore guard. Lock the floor.
        expect(resetCount).toBeGreaterThanOrEqual(4);
    });

    test('keeps the URL ?page= param in sync via history.replaceState', () => {
        expect(html).toMatch(/history\.replaceState\(/);
        expect(html).toMatch(/params\.set\(\s*['"]page['"]\s*,\s*String\(currentPage\)\s*\)/);
        // Init reads ?page= back so deep links and refresh survive.
        expect(html).toMatch(/URLSearchParams\(location\.search\)\.get\(\s*['"]page['"]\s*\)/);
    });

    test('shows a distinct "no partners yet" message when totalCount is 0 with no filter active', () => {
        expect(html).toMatch(/No partners yet/);
    });
});
