'use strict';

/**
 * card_ed04f8aa — device-vars merge must not drop owner (null-source) keys.
 *
 * Regression for the 2026-07-02 vault wipe: a single
 * `{source:'web', vars:{ONE_KEY}}` write (exactly the shape the /api/help
 * example showed) silently dropped 29 owner/deviceSecret-set (null-source)
 * keys because merge step-1 only preserved keys with a truthy source that
 * differed from `src`. Unit-tests the pure merge (no pg pool needed).
 */

const { mergeDeviceVars } = require('../../lib/device-vars-merge');

describe('mergeDeviceVars — owner (null-source) key preservation', () => {
    it('a single source:web write does NOT drop pre-existing owner keys (THE 2026-07-02 wipe)', () => {
        const { merged } = mergeDeviceVars({
            existingVars:    { OWNER_A: 'a', OWNER_B: 'b', OWNER_C: 'c' },
            existingSources: {}, // owner keys carry no source (null)
            incoming: { NEW_KEY: 'n' },
            src: 'web',
        });
        expect(merged).toEqual({ OWNER_A: 'a', OWNER_B: 'b', OWNER_C: 'c', NEW_KEY: 'n' });
    });

    it('pre-fix behavior would have wiped them — assert the fix keeps all four', () => {
        const { merged } = mergeDeviceVars({
            existingVars:    { K1: '1', K2: '2' },
            existingSources: { K1: null, K2: null },
            incoming: { K3: '3' },
            src: 'app',
        });
        expect(Object.keys(merged).sort()).toEqual(['K1', 'K2', 'K3']);
    });

    it('patch:true is purely additive — keeps even same-source keys omitted from the payload', () => {
        const { merged } = mergeDeviceVars({
            existingVars:    { W1: '1', W2: '2' },
            existingSources: { W1: 'web', W2: 'web' },
            incoming: { W3: '3' },
            src: 'web',
            patchMode: true,
        });
        expect(merged).toEqual({ W1: '1', W2: '2', W3: '3' });
    });

    it('non-patch same-source sync STILL deletes an omitted same-source key (editor semantic), but keeps owner keys', () => {
        const { merged } = mergeDeviceVars({
            existingVars:    { OWNER_X: 'x', WEB_A: 'a', WEB_B: 'b' },
            existingSources: { WEB_A: 'web', WEB_B: 'web' }, // OWNER_X null
            incoming: { WEB_A: 'a2' },
            src: 'web',
        });
        expect(merged.OWNER_X).toBe('x');   // owner key preserved
        expect(merged.WEB_A).toBe('a2');    // updated
        expect(merged.WEB_B).toBeUndefined(); // same-source, omitted → deleted
    });

    it('keeps keys from the OTHER source untouched', () => {
        const { merged, mergedSources } = mergeDeviceVars({
            existingVars:    { APP_ONLY: 'x' },
            existingSources: { APP_ONLY: 'app' },
            incoming: { WEB_NEW: 'y' },
            src: 'web',
        });
        expect(merged).toEqual({ APP_ONLY: 'x', WEB_NEW: 'y' });
        expect(mergedSources.APP_ONLY).toBe('app');
        expect(mergedSources.WEB_NEW).toBe('web');
    });

    it('cross-source value conflict splits into _Web/_APP', () => {
        const { merged, conflicts } = mergeDeviceVars({
            existingVars:    { TOKEN: 'app-val' },
            existingSources: { TOKEN: 'app' },
            incoming: { TOKEN: 'web-val' },
            src: 'web',
        });
        expect(merged.TOKEN_Web).toBe('web-val');
        expect(merged.TOKEN_APP).toBe('app-val');
        expect(merged.TOKEN).toBeUndefined();
        expect(conflicts).toEqual([{ key: 'TOKEN', webKey: 'TOKEN_Web', appKey: 'TOKEN_APP' }]);
    });

    it('empty incoming in patch mode preserves everything (no-op write)', () => {
        const { merged } = mergeDeviceVars({
            existingVars: { A: '1', B: '2' }, existingSources: { A: 'web', B: null },
            incoming: {}, src: 'web', patchMode: true,
        });
        expect(merged).toEqual({ A: '1', B: '2' });
    });
});

describe('index.js wiring', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');

    it('POST handler destructures patch and calls mergeDeviceVars', () => {
        expect(src).toMatch(/const patchMode = req\.body\.patch === true/);
        expect(src).toMatch(/mergeDeviceVars\(\{/);
        expect(src).toMatch(/require\('\.\/lib\/device-vars-merge'\)/);
    });

    it('help example advertises the SAFE additive patch path', () => {
        expect(src).toMatch(/SAFE additive patch/);
        expect(src).toMatch(/"patch":true/);
    });
});
