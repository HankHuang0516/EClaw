/**
 * PR-B regression: /api/entities enrichment reads companion selections from
 * the companion_select_log source of truth (joined to companions for the live
 * avatar_url), NOT the retired PETDX_CURRENT_/PETDX_AVATAR_<id> device-vars
 * vault mirror. The portal resolver still receives petdxCompanionId +
 * petdxAvatarUrl on each entity payload.
 */

const fs = require('fs');

const src = fs.readFileSync(require.resolve('../../index'), 'utf8');

function slice(anchor, span = 4500) {
    const i = src.indexOf(anchor);
    expect(i).toBeGreaterThan(-1);
    return src.slice(i, i + span);
}

describe('/api/entities petdx enrichment', () => {
    const helper = slice('async function getPetdxEntityEnrichmentMap', 2500);
    const handler = slice("app.get('/api/entities',", 8000);

    it('reads the latest selection per entity from companion_select_log joined to companions', () => {
        expect(helper).toMatch(/chatPool\.query/);
        expect(helper).toMatch(/DISTINCT ON \(l\.entity_id\)/);
        expect(helper).toMatch(/FROM companion_select_log l/);
        expect(helper).toMatch(/LEFT JOIN companions c ON c\.id = l\.companion_id/);
        // No vault decrypt path remains.
        expect(helper).not.toMatch(/decryptVars/);
        expect(helper).not.toMatch(/db\.getDeviceVars/);
    });

    it('skips tombstoned selections and falls back to the static avatar path', () => {
        expect(helper).toMatch(/if \(r\.origin === PETDX_TOMBSTONE_ORIGIN\) continue/);
        expect(helper).toMatch(/\/static\/companions\/\$\{companionId\}\/avatar\.png/);
        expect(helper).toMatch(/petdxCompanionId: companionId, petdxAvatarUrl: avatarUrl/);
    });

    it('does not break /api/entities when enrichment query fails', () => {
        expect(helper).toMatch(/if \(!deviceId\) return out/);
        expect(helper).toMatch(/catch \(err\)/);
        expect(helper).toMatch(/return out/);
    });

    it('adds petdxCompanionId and petdxAvatarUrl to each entity payload', () => {
        expect(handler).toMatch(/const petdxByEntityId\s*=\s*await getPetdxEntityEnrichmentMap\(authedDeviceId\)/);
        expect(handler).toMatch(/const petdx\s*=\s*petdxByEntityId\.get\(entity\.entityId\) \|\| \{\}/);
        expect(handler).toMatch(/petdxCompanionId:\s*petdx\.petdxCompanionId \|\| null/);
        expect(handler).toMatch(/petdxAvatarUrl:\s*petdx\.petdxAvatarUrl \|\| null/);
    });
});
