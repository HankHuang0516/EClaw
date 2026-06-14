/**
 * Regression for GH#3045 / card_9b40b69a326df292d23122bf.
 *
 * AvatarPetdx.mount() used to forward the entire companion card returned by
 * /api/companion/current straight to PetdxRenderer.createRenderer. The card
 * passes validateDescriptor (id/assetType/supportedStates are hoisted by
 * rowToCompanionCard) so no exception is thrown — but for *procedural*
 * companions the renderer key lives at `companion.descriptor.asset.renderer`
 * (rowToCompanionCard only hoists `asset`/`stateAssets` for spritesheets),
 * so PetdxRenderer can't find the registered drawer and silently falls back
 * to `fallback-blob`. The user-visible symptom is an avatar slot rendering
 * the wrong creature shape on cold load.
 *
 * Fix: mount() unwraps `descriptor.descriptor` before handing it off, mirroring
 * the unwrap pattern already used by the modal detail dialog in
 * backend/public/portal/petdx-browser.html (L609).
 */

const path = require('path');

describe('AvatarPetdx.mount → PetdxRenderer.createRenderer arg shape (GH#3045)', () => {
    let AvatarPetdx;
    let createRendererSpy;
    let originalWindow;
    let originalDocument;
    let registeredCanvas;

    const ENTITY_ID = 9040;

    // What /api/companion/current returns for a *procedural* companion:
    // top-level id/assetType/supportedStates (rowToCompanionCard hoist),
    // and the renderer payload nested under .descriptor (the raw JSONB).
    const PROCEDURAL_COMPANION = {
        id: 'lobster-classic',
        name: 'Lobster Classic',
        assetType: 'procedural',
        supportedStates: ['IDLE', 'BUSY'],
        descriptor: {
            id: 'lobster-classic',
            assetType: 'procedural',
            supportedStates: ['IDLE', 'BUSY'],
            asset: {
                renderer: 'lobster-procedural',
                params: { bodyColor: '#c0392b' },
            },
            stateAssets: { IDLE: { fps: 4, loop: true } },
        },
    };

    beforeEach(() => {
        jest.resetModules();
        originalWindow = global.window;
        originalDocument = global.document;

        createRendererSpy = jest.fn(() => ({
            start: jest.fn(),
            stop: jest.fn(),
        }));

        // Minimal canvas stub — only needs the attrs mount() reads.
        registeredCanvas = {
            getAttribute(name) {
                if (name === 'data-petdx-entity-id') return String(ENTITY_ID);
                if (name === 'data-petdx-state') return null;
                return null;
            },
        };

        global.window = {
            PetdxRenderer: {
                createRenderer: createRendererSpy,
                // prefetchSpritesheet intentionally omitted — warmSpritesheet
                // should bail for procedural without touching it.
            },
            console: { warn: jest.fn() },
        };
        global.document = {
            querySelectorAll: jest.fn(() => [registeredCanvas]),
        };

        AvatarPetdx = require('../../public/shared/avatar-petdx.js');
        AvatarPetdx._setDescriptor(ENTITY_ID, PROCEDURAL_COMPANION);
    });

    afterEach(() => {
        global.window = originalWindow;
        global.document = originalDocument;
    });

    test('mount unwraps the nested procedural descriptor so asset.renderer survives', () => {
        AvatarPetdx.mount();

        expect(createRendererSpy).toHaveBeenCalledTimes(1);
        const arg = createRendererSpy.mock.calls[0][0];

        expect(arg.canvas).toBe(registeredCanvas);
        expect(arg.state).toBe('IDLE');

        // The bug: if mount forwards the wrapper, arg.descriptor.asset is
        // undefined (only spritesheet wrappers hoist `asset`). After the
        // fix it must surface the inner renderer descriptor so the
        // 'lobster-procedural' drawer key is reachable.
        expect(arg.descriptor).toBeDefined();
        expect(arg.descriptor.assetType).toBe('procedural');
        expect(arg.descriptor.asset).toBeDefined();
        expect(arg.descriptor.asset.renderer).toBe('lobster-procedural');
    });

    test('mount still forwards a plain descriptor (already-unwrapped) unchanged', () => {
        // Some callers (and the test seam) feed in a bare renderer descriptor
        // — no `.descriptor` wrapper. Unwrap must be a no-op in that case.
        const BARE = {
            id: 'lobster-classic',
            assetType: 'procedural',
            supportedStates: ['IDLE'],
            asset: { renderer: 'lobster-procedural', params: {} },
            stateAssets: { IDLE: { fps: 4, loop: true } },
        };
        AvatarPetdx._setDescriptor(ENTITY_ID, BARE);

        AvatarPetdx.mount();

        expect(createRendererSpy).toHaveBeenCalledTimes(1);
        const arg = createRendererSpy.mock.calls[0][0];
        expect(arg.descriptor.asset.renderer).toBe('lobster-procedural');
    });
});
