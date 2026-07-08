const fs = require('fs');
const path = require('path');

const COMMUNITY_HTML = fs.readFileSync(
    path.join(__dirname, '../../public/portal/community.html'),
    'utf8',
);
const DB_JS = fs.readFileSync(
    path.join(__dirname, '../../db.js'),
    'utf8',
);
const RENTAL_JS = fs.readFileSync(
    path.join(__dirname, '../../rental.js'),
    'utf8',
);
const ENTITY_UTILS_JS = fs.readFileSync(
    path.join(__dirname, '../../public/portal/shared/entity-utils.js'),
    'utf8',
);
const PETDEX_BRIDGE_JS = fs.readFileSync(
    path.join(__dirname, '../../petdex-bridge.js'),
    'utf8',
);
const COMPANION_API_JS = fs.readFileSync(
    path.join(__dirname, '../../companion-api.js'),
    'utf8',
);
const BACKFILL_AVATAR_JS = fs.readFileSync(
    path.join(__dirname, '../../scripts/backfill-companion-avatar-url.js'),
    'utf8',
);

describe('community.html — bot plaza must surface PETDX companion avatar', () => {
    test('loads entity-utils.js + avatar-petdx.js shared modules', () => {
        expect(COMMUNITY_HTML).toMatch(/<script[^>]*src=["']shared\/entity-utils\.js["']/);
        expect(COMMUNITY_HTML).toMatch(/<script[^>]*src=["']\.\.\/shared\/avatar-petdx\.js["']/);
    });

    test('defines resolveBotAvatar() preferring petdxAvatarUrl over avatar', () => {
        expect(COMMUNITY_HTML).toMatch(/function\s+resolveBotAvatar\s*\(/);
        expect(COMMUNITY_HTML).toMatch(/row\.petdxAvatarUrl/);
    });

    test('routes plaza listings through resolveBotAvatar + botAvatarHtml — no raw inline (avatar||).startsWith branch left', () => {
        // The old inline emoji/URL ternary used (bot.avatar||'').startsWith('http').
        // Catch any regression where the same antipattern reappears against a bot
        // record, since that path silently skips the petdxAvatarUrl enrichment.
        const inlineMatches = COMMUNITY_HTML.match(/\(bot\.avatar\|\|['"][^'"]*['"]\)\.startsWith/g);
        expect(inlineMatches).toBeNull();
        const inlineRentalMatches = COMMUNITY_HTML.match(/l\.avatar_url\s*&&\s*l\.avatar_url\.startsWith\(/g);
        expect(inlineRentalMatches).toBeNull();
    });

    test('community + rental listing rows flow through resolveBotAvatar', () => {
        // Community search row mapping uses resolveBotAvatar(r)
        expect(COMMUNITY_HTML).toMatch(/avatar:\s*resolveBotAvatar\(r\)/);
        // Rental marketplace row mapping forwards petdx_avatar_url alongside avatar_url
        expect(COMMUNITY_HTML).toMatch(/resolveBotAvatar\(\s*\{\s*petdxAvatarUrl:\s*l\.petdx_avatar_url/);
    });
});

describe('searchPublicCards — surfaces petdx_avatar_url for plaza enrichment', () => {
    test('SQL joins companion_select_log + companions and selects avatar_url', () => {
        // Search query must LEFT JOIN LATERAL the companion select log →
        // companions to surface each owner's current companion avatar.
        const fn = DB_JS.split('async function searchPublicCards')[1] || '';
        const body = fn.split(/\nasync function /)[0];
        expect(body).toMatch(/companion_select_log/);
        expect(body).toMatch(/LEFT JOIN companions/);
        expect(body).toMatch(/petdx\.avatar_url\s+AS\s+petdx_avatar_url/i);
        expect(body).toMatch(/petdxAvatarUrl:\s*r\.petdx_avatar_url/);
    });

    test('getPublicCardDetail also surfaces petdxAvatarUrl', () => {
        const fn = DB_JS.split('async function getPublicCardDetail')[1] || '';
        const body = fn.split(/\nasync function /)[0];
        expect(body).toMatch(/companion_select_log/);
        expect(body).toMatch(/petdxAvatarUrl:\s*r\.petdx_avatar_url/);
    });
});

describe('rental.js — marketplace + listing detail expose petdx_avatar_url', () => {
    test('searchMarketplace SQL joins companion_select_log', () => {
        // Find the marketplace listing query — identified by DISTINCT ON
        // (bl.owner_device_id, bl.owner_entity_id), the dedup key.
        const block = RENTAL_JS.match(/DISTINCT ON \(bl\.owner_device_id[\s\S]+?ORDER BY \$\{orderBy\}/);
        expect(block).not.toBeNull();
        expect(block[0]).toMatch(/companion_select_log/);
        expect(block[0]).toMatch(/petdx\.avatar_url\s+AS\s+petdx_avatar_url/i);
    });

    test('getListing SQL joins companion_select_log + selects avatar_url', () => {
        const fn = RENTAL_JS.split('async function getListing')[1] || '';
        const body = fn.split(/\nasync function /)[0];
        // The single-listing detail query previously didn't even select
        // avatar_url — locking in the fix here.
        expect(body).toMatch(/bl\.avatar_url/);
        expect(body).toMatch(/companion_select_log/);
        expect(body).toMatch(/petdx_avatar_url/);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// avatar.webp 404 invariant — card_8aabe54193a4eefa21dced81 (P3)
//
// GET /api/petdx/<slug>/avatar.webp 404s on prod for bridge-synced companions
// (e.g. zoro) because the avatar.webp R2 key is never populated by the catalog
// bridge. That is NON-BLOCKING and BY DESIGN: the canonical avatar source is the
// shared renderAvatarHtml() CSS sprite-crop path (PR #3539), and every emitted
// petdx_avatar_url points at sprite.webp — which the crop path renders correctly.
//
// The avatar.webp single-frame URL is a Phase 4/5 optimization that is ONLY ever
// emitted AFTER its bytes are written to R2 (deriveSpriteAvatarUrl on submit, and
// the backfill cron, both PUT before repointing avatar_url). These tests lock in
// that invariant so no future change can emit an avatar.webp URL that 404s.
// ─────────────────────────────────────────────────────────────────────────
describe('avatar.webp 404 invariant — sprite-crop is the canonical avatar source', () => {
    test('shared renderAvatarHtml crops petdx sprite.webp (background-size 800% 900%)', () => {
        // The crop branch is the canonical avatar render for petdx sprite URLs.
        expect(ENTITY_UTILS_JS).toMatch(/function\s+isPetdxSprite\s*\(/);
        // isPetdxSprite matches sprite.webp / sprite.png — NOT avatar.webp.
        expect(ENTITY_UTILS_JS).toMatch(/sprite\\\.\(webp\|png\)/);
        expect(ENTITY_UTILS_JS).not.toMatch(/isPetdxSprite[\s\S]{0,200}avatar\\\.webp/);
        // The crop branch frame-0 CSS — the source of correct rendering.
        expect(ENTITY_UTILS_JS).toMatch(/background-size:\s*800%\s*900%/);
    });

    test('catalog bridge stores sprite.webp as avatar_url (never avatar.webp)', () => {
        // spriteProxyUrl — the value the bridge writes to companions.avatar_url —
        // must end in sprite.webp so bridge-synced companions render via the crop
        // path and never reference an unpopulated avatar.webp key.
        const fn = PETDEX_BRIDGE_JS.split('function spriteProxyUrl')[1] || '';
        const body = fn.split(/\nfunction /)[0];
        expect(body).toMatch(/sprite\.webp/);
        expect(body).not.toMatch(/avatar\.webp/);
    });

    test('deriveSpriteAvatarUrl PUTs avatar.webp to R2 BEFORE returning the avatar.webp URL', () => {
        // The submit-path derive must upload the cropped frame to R2 and only then
        // return the /api/petdx/<slug>/avatar.webp proxy URL — so a returned
        // avatar.webp URL always has bytes behind it (no 404 emitted).
        const fn = COMPANION_API_JS.split('async function deriveSpriteAvatarUrl')[1] || '';
        const body = fn.split(/\n(?:async )?function /)[0];
        const putIdx = body.indexOf('PutObjectCommand');
        const urlIdx = body.search(/return\s+`[^`]*avatar\.webp/);
        expect(putIdx).toBeGreaterThan(-1);
        expect(urlIdx).toBeGreaterThan(-1);
        // The PUT must precede the avatar.webp return.
        expect(putIdx).toBeLessThan(urlIdx);
    });

    test('backfill cron PUTs avatar.webp to R2 BEFORE repointing avatar_url', () => {
        // The Phase-5 backfill must upload the avatar.webp object and only then
        // UPDATE companions.avatar_url to the avatar.webp URL — same no-404
        // invariant for the batch path.
        const fn = BACKFILL_AVATAR_JS.split('async function runBackfill')[1] || '';
        const body = fn.split(/\n(?:async )?function /)[0];
        const putIdx = body.indexOf('PutObjectCommand');
        const updateIdx = body.search(/UPDATE companions SET avatar_url/);
        expect(putIdx).toBeGreaterThan(-1);
        expect(updateIdx).toBeGreaterThan(-1);
        expect(putIdx).toBeLessThan(updateIdx);
    });

    test('petdx_avatar_url consumers route through the crop-aware renderAvatarHtml', () => {
        // marketplace.html + community.html feed petdx_avatar_url into
        // renderAvatarHtml / resolveBotAvatar — the crop path — never a raw <img>
        // that would 404 on a missing avatar.webp.
        const MARKETPLACE_HTML = fs.readFileSync(
            path.join(__dirname, '../../public/portal/marketplace.html'),
            'utf8',
        );
        expect(MARKETPLACE_HTML).toMatch(/petdx_avatar_url/);
        expect(MARKETPLACE_HTML).toMatch(/renderAvatarHtml\(/);
        expect(COMMUNITY_HTML).toMatch(/resolveBotAvatar\(\s*\{\s*petdxAvatarUrl:\s*l\.petdx_avatar_url/);
    });
});
