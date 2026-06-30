'use strict';

/**
 * Petdex community sprite same-origin proxy — ORB (Opaque Response Blocking) fix.
 *
 * Root cause: community/partner pets whose sprite bytes failed to self-host in
 * R2 keep the EXTERNAL CDN URL `https://assets.petdex.dev/pets/<slug>/sprite.webp`.
 * Chrome ORB-blocks that cross-origin webp in the browser (curl 200, browser
 * net::ERR_BLOCKED_BY_ORB), so the companion browser renders the 🦞 fallback for
 * every partner. Approach ②: proxy the sprite same-origin so ORB no longer applies.
 *
 * This suite proves:
 *   (a) the proxy route accepts the valid assets.petdex.dev/pets/<slug>/sprite.webp
 *       shape and REJECTS other hosts/paths/slug charsets (SSRF guard);
 *   (b) the serializer rewrites the external URL to the same-origin proxy path
 *       (asset_url, avatar_url, AND descriptor.asset.url) — and is a no-op for
 *       already-proxied / R2 / null URLs;
 *   (c) the per-kind emoji fallback returns a non-lobster emoji for
 *       character/object/creature (and infers kind from category).
 */

// companion-api pulls in `pg` at require time — mock it so no real connection.
jest.mock('pg', () => {
    const mockQuery = jest.fn();
    const Pool = jest.fn().mockImplementation(() => ({
        query: mockQuery,
        connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
        end: jest.fn(),
    }));
    return { Pool, __mockQuery: mockQuery };
});

const express = require('express');
const request = require('supertest');

const bridge = require('../../petdex-bridge');
const { createRouter } = require('../../petdex-route');
const companionFactory = require('../../companion-api');
const renderer = require('../../public/shared/petdx-renderer');

const EXT = (slug) => `https://assets.petdex.dev/pets/${slug}/sprite.webp`;
const PROXY = (slug) => `/api/petdx/community/${slug}/sprite.webp`;

// ── (b-helpers) bridge rewrite primitives ───────────────────────────
describe('petdex-bridge: community sprite URL rewrite (SSRF-safe)', () => {
    const { rewriteCommunitySpriteUrl, communitySpriteSlugFromUrl, rewriteDescriptorSpriteUrl } = bridge;

    test('rewrites the exact external sprite URL to the same-origin proxy path', () => {
        expect(rewriteCommunitySpriteUrl(EXT('zoro-9889c11ded54')))
            .toBe(PROXY('zoro-9889c11ded54'));
        expect(communitySpriteSlugFromUrl(EXT('boba'))).toBe('boba');
    });

    test('http:// variant also rewrites', () => {
        expect(rewriteCommunitySpriteUrl('http://assets.petdex.dev/pets/boba/sprite.webp'))
            .toBe(PROXY('boba'));
    });

    test('passes through (no-op) for non-matching hosts/paths/files (SSRF guard)', () => {
        const untouched = [
            'https://evil.com/pets/boba/sprite.webp',                  // wrong host
            'https://assets.petdex.dev.evil.com/pets/boba/sprite.webp', // host suffix attack
            'https://assets.petdex.dev/secret/boba/sprite.webp',       // wrong path root
            'https://assets.petdex.dev/pets/boba/avatar.webp',         // wrong file
            'https://assets.petdex.dev/pets/../../etc/sprite.webp',    // traversal in slug
            '/api/petdx/community/boba/sprite.webp',                   // already proxied
            'https://pub-abc.r2.dev/pets/boba/sprite.webp',            // already R2-hosted
            null, undefined, 42, {},
        ];
        for (const u of untouched) {
            expect(rewriteCommunitySpriteUrl(u)).toBe(u);
            expect(communitySpriteSlugFromUrl(u)).toBeNull();
        }
    });

    test('rewriteDescriptorSpriteUrl clones (never mutates the row descriptor)', () => {
        const row = { kind: 'character', asset: { url: EXT('zoro'), cols: 8 } };
        const out = rewriteDescriptorSpriteUrl(row);
        expect(out).not.toBe(row);
        expect(out.asset).not.toBe(row.asset);
        expect(out.asset.url).toBe(PROXY('zoro'));
        expect(out.asset.cols).toBe(8);
        expect(row.asset.url).toBe(EXT('zoro')); // original untouched
    });

    test('rewriteDescriptorSpriteUrl is a no-op for non-community asset urls', () => {
        const row = { asset: { url: '/api/petdx/boba/sprite.webp' } };
        expect(rewriteDescriptorSpriteUrl(row)).toBe(row);
        expect(rewriteDescriptorSpriteUrl(null)).toBeNull();
        expect(rewriteDescriptorSpriteUrl({ name: 'x' })).toEqual({ name: 'x' });
    });
});

// ── (a) proxy route — SSRF guard + streaming ────────────────────────
describe('GET /api/petdx/community/:slug/sprite.webp', () => {
    function appWith(fetchImpl) {
        const app = express();
        app.use('/api/petdx', createRouter({
            r2: { send: () => Promise.reject(new Error('r2 unused')) },
            bucket: 'test-bucket',
            fetch: fetchImpl,
        }));
        return app;
    }

    function okFetch(bytes = Buffer.from('RIFF....WEBPfake')) {
        return jest.fn().mockResolvedValue({
            ok: true, status: 200, arrayBuffer: async () => bytes,
        });
    }

    test('200 + image/webp for a valid slug, fetching the locked-down upstream URL', async () => {
        const fetchImpl = okFetch();
        const app = appWith(fetchImpl);
        const res = await request(app).get(PROXY('zoro-9889c11ded54'));
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('image/webp');
        expect(res.headers['cache-control']).toBe('public, max-age=86400');
        expect(res.body.length).toBeGreaterThan(0);
        // SSRF proof: host + path are hard literals; only the slug varies.
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const calledUrl = fetchImpl.mock.calls[0][0];
        expect(calledUrl).toBe('https://assets.petdex.dev/pets/zoro-9889c11ded54/sprite.webp');
        expect(new URL(calledUrl).host).toBe('assets.petdex.dev');
    });

    test('rejects bad slug charsets BEFORE any fetch (no SSRF, no open proxy)', async () => {
        const fetchImpl = okFetch();
        const app = appWith(fetchImpl);
        // dot, encoded slash/traversal, and a smuggled host all 404 (or never match
        // the route) and must never reach the upstream fetch.
        for (const bad of ['a.b', '..%2F..%2Fetc', 'zoro%2Fevil', 'zoro.evil']) {
            const res = await request(app).get(`/api/petdx/community/${bad}/sprite.webp`);
            expect(res.status).toBe(404);
        }
        // a different filename does not match the route at all
        expect((await request(app).get('/api/petdx/community/zoro/avatar.webp')).status).toBe(404);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('404 when upstream is 404, 502 when upstream errors', async () => {
        const notFound = jest.fn().mockResolvedValue({ ok: false, status: 404 });
        expect((await request(appWith(notFound)).get(PROXY('ghost'))).status).toBe(404);

        const fiveHundred = jest.fn().mockResolvedValue({ ok: false, status: 500 });
        expect((await request(appWith(fiveHundred)).get(PROXY('ghost'))).status).toBe(502);

        const threw = jest.fn().mockRejectedValue(new Error('ECONNRESET'));
        expect((await request(appWith(threw)).get(PROXY('ghost'))).status).toBe(502);
    });
});

// ── (b) serializer rewrite + kind passthrough ───────────────────────
describe('companion-api serializer: rewrites external sprite URLs to the proxy', () => {
    const { rowToCompanionCard, rowToCompanionDetail } = companionFactory._test;

    function spriteRow(over = {}) {
        return {
            id: 'petdex-zoro', name: 'Zoro', version: '1.0.0', author_entity_id: null,
            asset_url: EXT('zoro'), avatar_url: EXT('zoro'), thumbnail_url: null, tags: ['petdex'],
            mood: null, color: null, category: 'human', asset_type: 'spritesheet',
            supported_states: ['IDLE'], download_count: 0, favorite_count: 0,
            rating_avg: null, rating_count: 0, comment_count: 0, scope: 'community',
            descriptor: { kind: 'character', asset: { url: EXT('zoro'), cols: 8, rows: 9 } },
            ...over,
        };
    }

    test('rowToCompanionCard rewrites asset_url, avatar_url and descriptor.asset.url', () => {
        const card = rowToCompanionCard(spriteRow());
        expect(card.assetUrl).toBe(PROXY('zoro'));
        expect(card.avatarUrl).toBe(PROXY('zoro'));
        expect(card.asset.url).toBe(PROXY('zoro'));
        expect(card.asset.cols).toBe(8); // other asset fields preserved
        expect(card.kind).toBe('character'); // kind surfaced for the emoji fallback
    });

    test('rowToCompanionCard does not mutate the source descriptor', () => {
        const row = spriteRow();
        rowToCompanionCard(row);
        expect(row.descriptor.asset.url).toBe(EXT('zoro'));
    });

    test('rowToCompanionCard is a no-op for already-proxied / R2 URLs', () => {
        const card = rowToCompanionCard(spriteRow({
            avatar_url: '/api/petdx/zoro/avatar.webp',
            descriptor: { kind: 'creature', asset: { url: '/api/petdx/boba/sprite.webp' } },
        }));
        expect(card.avatarUrl).toBe('/api/petdx/zoro/avatar.webp');
        expect(card.asset.url).toBe('/api/petdx/boba/sprite.webp');
    });

    test('rowToCompanionDetail rewrites descriptor.asset.url + assetUrl (modal path)', () => {
        const det = rowToCompanionDetail(spriteRow());
        expect(det.assetUrl).toBe(PROXY('zoro'));
        expect(det.descriptor.asset.url).toBe(PROXY('zoro'));
    });
});

// ── (c) per-kind emoji fallback (non-lobster) ───────────────────────
describe('petdx-renderer: fallbackEmojiForKind', () => {
    const { fallbackEmojiForKind, resolveCompanionKind } = renderer;

    test('returns the matching non-lobster emoji per kind', () => {
        expect(fallbackEmojiForKind({ kind: 'character' })).toBe('🧑');
        expect(fallbackEmojiForKind({ kind: 'object' })).toBe('🎯');
        expect(fallbackEmojiForKind({ kind: 'creature' })).toBe('🐾');
    });

    test('infers kind from category when kind is absent', () => {
        expect(fallbackEmojiForKind({ category: 'human' })).toBe('🧑');
        expect(fallbackEmojiForKind({ category: 'animal' })).toBe('🐾');
        expect(fallbackEmojiForKind({ category: 'mascot' })).toBe('🎯');
        expect(resolveCompanionKind({ category: 'human' })).toBe('character');
    });

    test('reads kind off sourceAttribution as a last resort', () => {
        expect(fallbackEmojiForKind({ sourceAttribution: { kind: 'object' } })).toBe('🎯');
    });

    test('only falls back to 🦞 when kind is genuinely unknown', () => {
        expect(fallbackEmojiForKind({})).toBe('🦞');
        expect(fallbackEmojiForKind(null)).toBe('🦞');
        expect(fallbackEmojiForKind({ kind: 'martian' })).toBe('🦞');
    });
});
