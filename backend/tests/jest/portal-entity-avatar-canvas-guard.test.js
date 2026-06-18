const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_PATH = path.join(__dirname, '../../public/portal/shared/entity-utils.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

function loadResolver() {
    const ctx = {
        window: {},
        localStorage: { _data: {}, getItem(k) { return this._data[k] || null; }, setItem(k, v) { this._data[k] = v; } },
        console,
    };
    vm.createContext(ctx);
    vm.runInContext(SRC, ctx);
    return ctx;
}

const PETDX_LOBSTER_URL = '/static/companions/petdx-lobster-default/avatar.png';

describe('renderAvatarHtml — canvas-vs-URL guard (Phase 0 dashboard bug fix)', () => {
    test('procedural descriptor falls through to <img> tag — does not emit blank canvas', () => {
        const ctx = loadResolver();
        // Simulate the petdx-lobster-default descriptor that PR #3032 backfilled —
        // procedural asset, no spritesheet, descriptor.avatar.url is null.
        ctx.window.AvatarPetdx = {
            hasDescriptor: (id) => id === 1,
            getDescriptor: (id) => id === 1 ? {
                assetType: 'procedural',
                descriptor: { assetType: 'procedural', asset: { renderer: 'lobster-procedural' } },
            } : null,
            descriptorAvatarUrl: () => null,
        };
        ctx.updateEntityMaps([{ entityId: 1, character: 'LOBSTER', avatar: null, petdxAvatarUrl: PETDX_LOBSTER_URL }]);
        const html = ctx.renderAvatarHtml(ctx.getAvatarForEntity(1), 48, 1);
        expect(html).toContain('<img');
        expect(html).toContain('src="' + PETDX_LOBSTER_URL + '"');
        expect(html).not.toContain('data-petdx-entity-id');
        expect(html).not.toContain('<canvas');
    });

    test('spritesheet descriptor still emits canvas placeholder (Phase 0.1 + custom companions)', () => {
        const ctx = loadResolver();
        ctx.window.AvatarPetdx = {
            hasDescriptor: (id) => id === 2,
            getDescriptor: (id) => id === 2 ? {
                assetType: 'spritesheet',
                descriptor: { assetType: 'spritesheet', asset: { url: 'https://r2/sprite.webp' } },
            } : null,
            descriptorAvatarUrl: () => 'https://r2/sprite.webp',
        };
        ctx.updateEntityMaps([{ entityId: 2, character: 'LOBSTER', avatar: '🐱' }]);
        const html = ctx.renderAvatarHtml(ctx.getAvatarForEntity(2), 48, 2);
        expect(html).toContain('<canvas');
        expect(html).toContain('data-petdx-entity-id="2"');
    });

    test('no AvatarPetdx loaded — emits img for URL avatars (baseline)', () => {
        const ctx = loadResolver();
        ctx.updateEntityMaps([{ entityId: 1, character: 'LOBSTER', avatar: null, petdxAvatarUrl: PETDX_LOBSTER_URL }]);
        const html = ctx.renderAvatarHtml(ctx.getAvatarForEntity(1), 48, 1);
        expect(html).toContain('<img src="' + PETDX_LOBSTER_URL + '"');
        expect(html).not.toContain('<canvas');
    });

    test('emoji avatar still renders as clickable span when no descriptor', () => {
        const ctx = loadResolver();
        ctx.window.AvatarPetdx = {
            hasDescriptor: () => false,
            getDescriptor: () => null,
            descriptorAvatarUrl: () => null,
        };
        ctx.updateEntityMaps([{ entityId: 1, character: 'LOBSTER', avatar: '🐱' }]);
        const html = ctx.renderAvatarHtml('🐱', 48, 1);
        expect(html).toContain('<span');
        expect(html).toContain('class="entity-avatar-emoji"');
        expect(html).toContain('data-entity-id="1"');
        expect(html).toContain('🐱');
        expect(html).not.toContain('<canvas');
        expect(html).not.toContain('<img');
    });

    test('_petdxCanRenderCanvas handles missing getDescriptor (older avatar-petdx)', () => {
        const ctx = loadResolver();
        ctx.window.AvatarPetdx = {
            hasDescriptor: () => true,
            // getDescriptor missing — older builds
        };
        ctx.updateEntityMaps([{ entityId: 1, character: 'LOBSTER', avatar: null, petdxAvatarUrl: PETDX_LOBSTER_URL }]);
        const html = ctx.renderAvatarHtml(ctx.getAvatarForEntity(1), 48, 1);
        // Without getDescriptor, the guard refuses canvas → falls back to img
        expect(html).toContain('<img');
        expect(html).not.toContain('<canvas');
    });

    test('spritesheet descriptor with no sheet URL is treated as un-renderable (per #6 review)', () => {
        const ctx = loadResolver();
        ctx.window.AvatarPetdx = {
            hasDescriptor: () => true,
            // descriptor is tagged spritesheet but the API failed to return a sheet URL.
            // Emitting a canvas would reproduce the same blank-canvas ❓ that motivated this fix.
            getDescriptor: () => ({
                assetType: 'spritesheet',
                descriptor: { assetType: 'spritesheet', asset: {} },
            }),
        };
        ctx.updateEntityMaps([{ entityId: 1, character: 'LOBSTER', avatar: null, petdxAvatarUrl: PETDX_LOBSTER_URL }]);
        const html = ctx.renderAvatarHtml(ctx.getAvatarForEntity(1), 48, 1);
        expect(html).toContain('<img src="' + PETDX_LOBSTER_URL + '"');
        expect(html).not.toContain('<canvas');
    });

    test('spritesheet descriptor with assetUrl (alt shape) also flows through', () => {
        const ctx = loadResolver();
        ctx.window.AvatarPetdx = {
            hasDescriptor: () => true,
            getDescriptor: () => ({
                assetType: 'spritesheet',
                assetUrl: 'https://r2/sheet.webp',
            }),
        };
        ctx.updateEntityMaps([{ entityId: 1, character: 'LOBSTER', avatar: '🐱' }]);
        const html = ctx.renderAvatarHtml('🐱', 48, 1);
        expect(html).toContain('<canvas');
        expect(html).toContain('data-petdx-entity-id="1"');
    });
});

// Regression: cross-device petdx bots (marketplace / arena / share-chat) arrive
// with avatar_url = /api/petdx/<slug>/sprite.webp and NO cached descriptor, so the
// canvas path is skipped. Before this fix renderAvatarHtml emitted a raw <img src=
// sprite.webp> → the whole 8×9 sheet shrank into the box (the "大頭貼 mismatched" P0,
// previously only fixed in community.html). Now it crops frame 0 at the shared layer.
describe('renderAvatarHtml — petdx sprite frame-0 crop (cross-device, no descriptor)', () => {
    const SPRITE = '/api/petdx/zoro/sprite.webp';

    test('isPetdxSprite matches sprite proxy URLs only', () => {
        const ctx = loadResolver();
        expect(ctx.isPetdxSprite('/api/petdx/zoro/sprite.webp')).toBe(true);
        expect(ctx.isPetdxSprite('https://eclawbot.com/api/petdx/a-b/sprite.png')).toBe(true);
        expect(ctx.isPetdxSprite('/api/petdx/zoro/avatar.webp')).toBe(false); // derived single frame
        expect(ctx.isPetdxSprite('/static/x.png')).toBe(false);
        expect(ctx.isPetdxSprite(null)).toBeFalsy();
    });

    test('sprite URL with no AvatarPetdx → frame-0 crop div, NOT raw sheet img', () => {
        const ctx = loadResolver();
        const html = ctx.renderAvatarHtml(SPRITE, 48, 7);
        expect(html).toContain('background-size:800% 900%');
        expect(html).toContain('background-position:0 0');
        expect(html).toContain('url(' + SPRITE + ')');
        expect(html).toContain('data-entity-id="7"');
        expect(html).not.toContain('<img'); // never the raw shrunk sheet
        expect(html).not.toContain('<canvas');
    });

    test('sprite URL when descriptor cache lacks this entity → still cropped', () => {
        const ctx = loadResolver();
        ctx.window.AvatarPetdx = { hasDescriptor: () => false, getDescriptor: () => null };
        const html = ctx.renderAvatarHtml(SPRITE, 56);
        expect(html).toContain('background-size:800% 900%');
        expect(html).not.toContain('<img');
    });

    test('derived avatar.webp (post-backfill) renders as plain img, NOT cropped', () => {
        const ctx = loadResolver();
        const html = ctx.renderAvatarHtml('/api/petdx/zoro/avatar.webp', 48, 7);
        expect(html).toContain('<img src="/api/petdx/zoro/avatar.webp"');
        expect(html).not.toContain('background-size:800% 900%');
    });

    test('own-device animated canvas still wins over crop when descriptor present', () => {
        const ctx = loadResolver();
        ctx.window.AvatarPetdx = {
            hasDescriptor: (id) => id === 3,
            getDescriptor: () => ({ assetType: 'spritesheet', descriptor: { assetType: 'spritesheet', asset: { url: SPRITE } } }),
            descriptorAvatarUrl: () => SPRITE,
        };
        const html = ctx.renderAvatarHtml(SPRITE, 48, 3);
        expect(html).toContain('<canvas');
        expect(html).not.toContain('background-size:800% 900%');
    });
});
