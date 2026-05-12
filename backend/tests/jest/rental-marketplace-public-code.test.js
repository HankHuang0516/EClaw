/**
 * Regression: GET /api/rental/marketplace must include each listing's
 * owner_public_code so the community.html grid can build a /c/:publicCode
 * URL for the "開始對話" CTA. Pre-fix the response only had owner_device_id
 * + owner_entity_id, and the UI fell through to listing.id (a UUID) which
 * /c/:publicCode rejects.
 */

const fs = require('fs');

const src = fs.readFileSync(require.resolve('../../rental.js'), 'utf8');

function slice(anchor, span = 1500) {
    const i = src.indexOf(anchor);
    expect(i).toBeGreaterThan(-1);
    return src.slice(i, i + span);
}

describe('rental marketplace owner_public_code enrichment', () => {
    const route = slice("router.get('/marketplace'", 1500);

    it('enriches each listing with owner_public_code from devices map', () => {
        expect(route).toMatch(/const devicesMap = _interviewDeps\?\.devices;/);
        expect(route).toMatch(/devicesMap\?\.\[l\.owner_device_id\]\?\.entities\?\.\[l\.owner_entity_id\]/);
    });

    it('only attaches owner_public_code when entity has one (no overwrite to null)', () => {
        expect(route).toMatch(/ent\?\.publicCode \? \{ \.\.\.l, owner_public_code: ent\.publicCode \} : l/);
    });

    it('enrichment runs AFTER drift filter (so dropped listings stay dropped)', () => {
        const filterPos = route.indexOf('filterDriftedListings(');
        const enrichPos = route.indexOf('owner_public_code:');
        expect(filterPos).toBeGreaterThan(-1);
        expect(enrichPos).toBeGreaterThan(filterPos);
    });

    it('response body still uses res.json({ success, listings })', () => {
        expect(route).toMatch(/res\.json\(\{ success: true, listings: enriched \}\)/);
    });
});
