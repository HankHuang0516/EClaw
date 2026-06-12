/**
 * Static invariant test for petdx-browser pagination (load-more).
 * Card: card_6e21220bbf406675e7992790 (Hank 2026-06-12 — browser showed only the
 * first 60 companions with no paging).
 *
 * jest.config.js uses testEnvironment: 'node' (matching the portal static tests),
 * so we lock the SOURCE surface. Runtime behaviour (append + reset) is covered by
 * the prod E2E. /api/companion/list already supports page/limit/total — this is a
 * pure front-end consumer fix.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'petdx-browser.html'),
    'utf8'
);

describe('petdx-browser pagination (load-more)', () => {
    test('sends the page param to /api/companion/list', () => {
        expect(html).toMatch(/q\.set\(\s*['"]page['"]\s*,\s*String\(currentPage\)\s*\)/);
    });

    test('loadList supports an append mode (page 1 reset vs next-page append)', () => {
        expect(html).toMatch(/async function loadList\(\s*append\s*=\s*false\s*\)/);
        // append path advances the page; reset path returns to 1
        expect(html).toMatch(/currentPage\s*\+=\s*1/);
        expect(html).toMatch(/currentPage\s*=\s*1/);
    });

    test('tracks loaded vs total and stops appending when exhausted', () => {
        expect(html).toMatch(/loadedCount\s*\+=\s*items\.length/);
        expect(html).toMatch(/totalCount\s*=\s*data\.total/);
        expect(html).toMatch(/loadedCount\s*>=\s*totalCount/);
    });

    test('renders a load-more button wired to append, hidden when all shown', () => {
        expect(html).toMatch(/className\s*=\s*['"]load-more-btn['"]/);
        expect(html).toMatch(/\.load-more-btn\s*\{/); // CSS rule present
        expect(html).toMatch(/addEventListener\(\s*['"]click['"]\s*,\s*\(\)\s*=>\s*loadList\(true\)\s*\)/);
        expect(html).toMatch(/已顯示全部/);
    });

    test('guards against double-trigger while a load-more is in flight', () => {
        expect(html).toMatch(/if\s*\(\s*loadingMore\s*\|\|\s*loadedCount\s*>=\s*totalCount\s*\)\s*return/);
    });
});
