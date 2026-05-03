'use strict';

const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '../../public');
const enterpriseHtml = fs.readFileSync(path.join(publicDir, 'enterprise.html'), 'utf8');

function getProductCatalogUrls() {
    const sectionMatch = enterpriseHtml.match(/data-i18n="ent_ec_product_title"[\s\S]*?<iframe\s+src="([^"]+)"[\s\S]*?<p[^>]*id="ecProductNote"[\s\S]*?<a\s+href="([^"]+)"/);
    if (!sectionMatch) return null;
    return { iframeSrc: sectionMatch[1], openHref: sectionMatch[2] };
}

describe('enterprise product catalog demo links', () => {
    test('uses a repo-owned mock page instead of a stale public note URL', () => {
        const urls = getProductCatalogUrls();
        expect(urls).toEqual({
            iframeSrc: '/assets/mockup-notepages.html',
            openHref: '/assets/mockup-notepages.html',
        });
        expect(urls.iframeSrc).not.toMatch(/^\/p\//);
        expect(fs.existsSync(path.join(publicDir, urls.iframeSrc))).toBe(true);
    });
});
