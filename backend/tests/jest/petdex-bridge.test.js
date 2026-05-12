/**
 * Petdex bridge unit tests — descriptor shape + sync (mocked pool/fetch).
 * The renderer-side frame-index math is exercised in petdx-renderer.test.js.
 */

const bridge = require('../../petdex-bridge');

describe('buildDescriptor', () => {
    it('produces a spritesheet descriptor with all 9 animations', () => {
        const d = bridge.buildDescriptor({
            slug: 'boba',
            displayName: 'Boba',
            kind: 'creature',
            spritesheetUrl: 'https://r2/boba.webp',
            petJsonUrl: 'https://r2/boba.json',
            zipUrl: 'https://r2/boba.zip',
            submittedBy: 'railly',
        });
        expect(d.id).toBe('petdex-boba');
        expect(d.assetType).toBe('spritesheet');
        expect(d.asset.url).toBe('https://r2/boba.webp');
        expect(d.asset.cols).toBe(8);
        expect(d.asset.rows).toBe(9);
        expect(d.asset.frameWidth).toBe(192);
        expect(d.asset.frameHeight).toBe(208);
        expect(Object.keys(d.asset.animations).sort()).toEqual([
            'failed', 'idle', 'jumping', 'review',
            'running', 'running-left', 'running-right',
            'waiting', 'waving',
        ]);
        // idle uses variable per-frame durations
        expect(Array.isArray(d.asset.animations.idle.frames)).toBe(true);
        expect(d.asset.animations.idle.frames.length).toBe(6);
        // uniform animations use {count, dur, last?}
        expect(d.asset.animations.running.count).toBe(6);
        expect(d.asset.animations.running.dur).toBe(120);
        expect(d.asset.animations.running.last).toBe(220);
    });

    it('maps every EClaw state to a row via stateAssets', () => {
        const d = bridge.buildDescriptor({
            slug: 'cortana',
            displayName: 'Cortana',
            kind: 'character',
            spritesheetUrl: 'https://r2/cortana.webp',
        });
        expect(d.supportedStates).toEqual(['IDLE', 'BUSY', 'WALKING', 'SLEEPING', 'EXCITED', 'HAPPY']);
        expect(d.stateAssets.IDLE.animation).toBe('idle');
        expect(d.stateAssets.BUSY.animation).toBe('running');
        expect(d.stateAssets.WALKING.animation).toBe('running-right');
        expect(d.stateAssets.SLEEPING.animation).toBe('waiting');
        expect(d.stateAssets.EXCITED.animation).toBe('jumping');
        expect(d.stateAssets.HAPPY.animation).toBe('waving');
    });

    it('attaches Petdex provenance + MIT license', () => {
        const d = bridge.buildDescriptor({
            slug: 'pixel-panda',
            displayName: 'Pixel Panda',
            kind: 'creature',
            spritesheetUrl: 'https://r2/pixel-panda.webp',
            submittedBy: 'user42',
        });
        expect(d.sourceAttribution.project).toBe('crafter-station/petdex');
        expect(d.sourceAttribution.license).toBe('MIT');
        expect(d.sourceAttribution.slug).toBe('pixel-panda');
        expect(d.sourceAttribution.submittedBy).toBe('user42');
    });
});

describe('syncPetdexCatalog', () => {
    const originalFetch = global.fetch;
    afterEach(() => { global.fetch = originalFetch; });

    function mockPool() {
        const calls = [];
        return {
            calls,
            query: jest.fn(async (sql, params) => {
                calls.push({ sql: sql.slice(0, 60), params });
                return { rows: [] };
            }),
        };
    }

    it('upserts every valid pet and skips malformed entries', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                generatedAt: '2026-05-12',
                total: 4,
                pets: [
                    { slug: 'boba', displayName: 'Boba', kind: 'creature', spritesheetUrl: 'https://r2/boba.webp' },
                    { slug: 'cortana', displayName: 'Cortana', kind: 'character', spritesheetUrl: 'https://r2/cortana.webp' },
                    null,                                          // dropped: nullish
                    { slug: 'broken' },                            // dropped: no spritesheetUrl
                ],
            }),
        }));
        const pool = mockPool();
        const log = jest.fn();
        const result = await bridge.syncPetdexCatalog(pool, log);
        expect(result.total).toBe(4);
        expect(result.inserted).toBe(2);
        expect(result.failed).toBe(2);
        expect(pool.calls.length).toBe(2);
        expect(pool.calls[0].params[0]).toBe('petdex-boba');
        expect(pool.calls[1].params[0]).toBe('petdex-cortana');
    });

    it('counts DB failures and surfaces them without throwing', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                pets: [{ slug: 'a', displayName: 'A', kind: 'creature', spritesheetUrl: 'https://r2/a.webp' }],
            }),
        }));
        const pool = { query: jest.fn(async () => { throw new Error('db down'); }) };
        const log = jest.fn();
        const result = await bridge.syncPetdexCatalog(pool, log);
        expect(result.inserted).toBe(0);
        expect(result.failed).toBe(1);
    });

    it('returns zeros when the manifest fetch fails', async () => {
        global.fetch = jest.fn(async () => ({ ok: false, status: 502 }));
        const pool = mockPool();
        const result = await bridge.syncPetdexCatalog(pool, () => {});
        expect(result.inserted).toBe(0);
        expect(result.total).toBe(0);
    });
});
