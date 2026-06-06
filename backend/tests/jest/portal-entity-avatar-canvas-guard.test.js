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
