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
    const route = slice("router.get('/marketplace'", 2200);

    it('enriches each listing with owner_public_code from devices map', () => {
        expect(route).toMatch(/const devicesMap = _interviewDeps\?\.devices;/);
        expect(route).toMatch(/devicesMap\?\.\[l\.owner_device_id\]\?\.entities\?\.\[l\.owner_entity_id\]/);
    });

    it('only attaches owner_public_code when entity has one (no overwrite to null)', () => {
        // Conditional attach — owner_public_code is only set on the output
        // object when the resolved entity actually has a publicCode, so a
        // cross-device / unresolved entity never gets owner_public_code: null.
        expect(route).toMatch(/if \(ent\?\.publicCode\) out\.owner_public_code = ent\.publicCode;/);
    });

    it('surfaces owner_entity_id + petdx_avatar_url for the marketplace avatar render', () => {
        // card_e8d7796a: marketplace frontend needs owner_entity_id to render
        // the canonical petdx 夥伴 chibi via renderAvatarHtml(avatar, 48, eid).
        expect(route).toMatch(/owner_entity_id: l\.owner_entity_id != null \? Number\(l\.owner_entity_id\) : null/);
        expect(route).toMatch(/petdx_avatar_url: l\.petdx_avatar_url \|\| null/);
    });

    it('enrichment runs AFTER drift filter (so dropped listings stay dropped)', () => {
        const filterPos = route.indexOf('filterDriftedListings(');
        const enrichPos = route.indexOf('owner_public_code');
        expect(filterPos).toBeGreaterThan(-1);
        expect(enrichPos).toBeGreaterThan(filterPos);
    });

    it('response body still uses res.json({ success, listings })', () => {
        expect(route).toMatch(/res\.json\(\{ success: true, listings: enriched \}\)/);
    });
});
