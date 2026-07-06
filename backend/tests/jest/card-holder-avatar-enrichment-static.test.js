/**
 * Regression guard for the recurring (5+ times) card-holder avatar bug
 * (card_55e811b8) + the exam wrong-entity avatar (card_cea91e58).
 *
 * STRUCTURAL cause: /api/contacts/my-cards was the ONLY card-holder read path that
 * never enriched rows with petdxAvatarUrl (recent/search/cross-device all do), so
 * when the canvas sprite descriptor failed the front-end had no URL fallback and
 * dropped straight to the emoji. Prior fixes patched other rows and left my-cards
 * fragile — hence the recurrence. These are SOURCE assertions (like
 * mention-ux-static.test.js) that fail if the enrichment / URL-precedence / active-
 * entity binding is ever removed again.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

describe('card-holder my-cards must enrich rows with petdxAvatarUrl (index.js)', () => {
    const idx = read('index.js');

    it('the /api/contacts/my-cards handler calls enrichCardHolderEntriesWithPetdx before responding', () => {
        const start = idx.indexOf("'/api/contacts/my-cards'");
        expect(start).toBeGreaterThan(-1);
        // scan the handler body up to the next route registration
        const nextRoute = idx.indexOf("app.get('/api/contacts/recent'", start);
        const body = idx.slice(start, nextRoute > 0 ? nextRoute : start + 4000);
        // FAIL-ON-OLD: old my-cards did `res.json({ success: true, cards })` with no enrich.
        expect(body).toMatch(/enrichCardHolderEntriesWithPetdx\(\s*cards\s*\)/);
        // and the response must send the enriched list, not the raw one
        expect(body).toMatch(/cards:\s*enrichedCards/);
    });

    it('the POST /api/contacts handler enriches the new contact with petdxAvatarUrl (card_7ced13ac)', () => {
        const start = idx.indexOf("app.post('/api/contacts'");
        expect(start).toBeGreaterThan(-1);
        // scan the handler body up to the next route registration
        const nextRoute = idx.indexOf("app.delete('/api/contacts'", start);
        const body = idx.slice(start, nextRoute > 0 ? nextRoute : start + 4000);
        // FAIL-ON-OLD: old POST did `contact: enrichCardHolderEntry(card)` — the
        // sync variant omits petdxAvatarUrl, so the freshly-added row flashed
        // from the partner avatar to the emoji fallback until reload.
        expect(body).not.toMatch(/contact:\s*enrichCardHolderEntry\(/);
        expect(body).toMatch(/contact:\s*\(await enrichCardHolderEntriesWithPetdx\(\[card\]\)\)\[0\]/);
    });

    it('petdx enrichment uses same-origin sprite assets when avatar_url is missing', () => {
        expect(idx).toMatch(/function resolvePetdxSelectionAvatarUrl/);
        expect(idx).toMatch(/row\.asset_type === 'spritesheet'/);
        expect(idx).toMatch(/isPetdxSpriteProxyUrl\(row\.asset_url\)/);
        expect(idx).toMatch(/return row\.asset_url\.trim\(\)/);
    });
});

describe('card-holder.html prefers the enriched proxy URL before the emoji fallback', () => {
    const html = read('public/portal/card-holder.html');

    it('the my-cards LIST view uses petdxAvatarUrl precedence', () => {
        expect(html).toMatch(/const avatar = c\.petdxAvatarUrl \|\| c\.avatar \|\|/);
    });

    it('the my-cards DETAIL view uses petdxAvatarUrl precedence', () => {
        expect(html).toMatch(/const avatar = card\.petdxAvatarUrl \|\| card\.avatar \|\|/);
    });
});

describe('exam.html binds the top-right avatar to the ACTIVE entity, not bound[0]', () => {
    const html = read('public/arena/exam.html');

    it('uses the shared active-entity localStorage key and only falls back to bound[0]', () => {
        expect(html).toContain('eclaw_petdex_active_entity_id');
        // the active-entity find must be present (fallback to bound[0] is fine)
        expect(html).toMatch(/bound\.find\(e => Number\(e\.entityId \|\| e\.id\) === activeId\)/);
        // FAIL-ON-OLD: old code did `entityId = Number(bound[0].entityId || bound[0].id)`
        // as the ONLY selection — assert it's no longer the sole binding.
        expect(html).not.toMatch(/if \(!bound\.length\) return;\s*\n\s*entityId = Number\(bound\[0\]/);
    });
});
