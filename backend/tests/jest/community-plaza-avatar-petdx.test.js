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
