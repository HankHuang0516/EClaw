'use strict';

/**
 * Pure device-vars merge (card_ed04f8aa).
 *
 * Extracted from the /api/device-vars POST handler so the merge semantics are
 * unit-testable without a live pg pool. Given the existing vault (values +
 * per-key source) and an incoming source-tagged write, compute the new vault.
 *
 * Safety contract (the 2026-07-02 vault-wipe fix):
 *  - A key NOT present in `incoming` is preserved when it belongs to a DIFFERENT
 *    source OR has NO source (null = owner/deviceSecret-set). Owner secrets must
 *    never be collateral of a web/app editor sync. The old handler dropped
 *    null-source keys because its guard was `keySrc && keySrc !== src`
 *    (`null && …` is falsy), so a single `{source:'web', vars:{ONE_KEY}}` write
 *    silently wiped every owner key.
 *  - patchMode = purely additive: preserve EVERY existing key not in `incoming`
 *    (drops nothing). The safe path for programmatic single-key updates.
 *  - Non-patch: the same-source "replace my keys" editor semantic is retained —
 *    a key whose source === src and is omitted from `incoming` is deleted (so a
 *    web editor can delete a web key by leaving it out).
 *  - Cross-source value conflicts on the same key are split into `_Web`/`_APP`.
 *
 * @param {object} p
 * @param {Object<string,string>} [p.existingVars]     current decrypted vars
 * @param {Object<string,string>} [p.existingSources]  current per-key source map
 * @param {Object<string,string>} [p.incoming]         sanitized incoming vars
 * @param {'web'|'app'} p.src                           the write's source
 * @param {boolean} [p.patchMode]                       additive mode
 * @returns {{merged:Object, mergedSources:Object, conflicts:Array}}
 */
function mergeDeviceVars({ existingVars = {}, existingSources = {}, incoming = {}, src, patchMode = false } = {}) {
    const merged = {};
    const mergedSources = {};
    const conflicts = [];

    // 1. Preserve existing keys NOT present in incoming.
    for (const [k, v] of Object.entries(existingVars)) {
        const keySrc = existingSources[k] || null;
        if (!(k in incoming) && (patchMode || keySrc !== src)) {
            merged[k] = v;
            mergedSources[k] = keySrc;
        }
    }

    // 2. Apply incoming keys — detect cross-source conflicts.
    for (const [k, v] of Object.entries(incoming)) {
        const existingVal = existingVars[k];
        const existingSrc = existingSources[k] || null;

        if (existingVal === undefined || existingVal === v || existingSrc === src || !existingSrc) {
            merged[k] = v;
            mergedSources[k] = src;
        } else {
            const webKey = k + '_Web';
            const appKey = k + '_APP';
            delete merged[k];
            delete mergedSources[k];
            if (src === 'web') {
                merged[webKey] = v;            mergedSources[webKey] = 'web';
                merged[appKey] = existingVal;  mergedSources[appKey] = 'app';
            } else {
                merged[webKey] = existingVal;  mergedSources[webKey] = 'web';
                merged[appKey] = v;            mergedSources[appKey] = 'app';
            }
            conflicts.push({ key: k, webKey, appKey });
        }
    }

    // 3. Carry over suffixed keys from the OTHER source still not represented.
    for (const [k, v] of Object.entries(existingVars)) {
        if (!(k in merged) && (k.endsWith('_Web') || k.endsWith('_APP'))) {
            const keySrc = existingSources[k] || null;
            if (keySrc && keySrc !== src) {
                merged[k] = v;
                mergedSources[k] = keySrc;
            }
        }
    }

    return { merged, mergedSources, conflicts };
}

module.exports = { mergeDeviceVars };
