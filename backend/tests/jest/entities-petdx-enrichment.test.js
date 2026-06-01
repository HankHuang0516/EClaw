/**
 * Phase 0 regression: /api/entities is the canonical transport for
 * PETDX_CURRENT_<entityId> and PETDX_AVATAR_<entityId>. The portal resolver
 * must not read broad device-vars directly just to render kanban avatars.
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

    it('decrypts device_vars once server-side and projects only PETDX_CURRENT/PETDX_AVATAR keys', () => {
        expect(helper).toMatch(/db\.getDeviceVars\(deviceId\)/);
        expect(helper).toMatch(/decryptVars\(row\.encrypted_vars,\s*row\.iv,\s*row\.auth_tag\)/);
        expect(helper).toMatch(/PETDX_\(CURRENT\|AVATAR\)_/);
        expect(helper).toMatch(/item\.petdxCompanionId\s*=\s*value/);
        expect(helper).toMatch(/item\.petdxAvatarUrl\s*=\s*value/);
    });

    it('does not break /api/entities when vault enrichment is unavailable', () => {
        expect(helper).toMatch(/if \(!deviceId \|\| !SEAL_KEY_HEX\) return out/);
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
