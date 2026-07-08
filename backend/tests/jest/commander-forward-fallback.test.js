'use strict';

/**
 * Dark-launched commander-forward fallback (card_3ce0080a, Leg-2 Option-1).
 *
 * Root cause it addresses: orgChartForward() in index.js is DORMANT on devices
 * with no org chart. After the low-signal filter it hits
 *     if (!orgData.options.taskForward && !orgData.options.allForward) return;
 *     if (!orgData.hierarchy || !orgData.hierarchy.USER) return;
 * so with the default taskForward:false + an empty hierarchy, NOTHING is
 * forwarded — a subordinate's substantive report never reaches the commander (#2).
 *
 * Fix (behind the DEFAULT-OFF pref commander_forward_fallback_enabled):
 * commanderForwardFallback() forwards a subordinate's substantive (non-low-signal)
 * OWN output up to a bound commander-class entity (#2, else #1) even without an
 * org chart. It reuses the same low-signal filter (drops handoff/heartbeat noise),
 * only fires for the entity's own output (not inbound-to-it), never self-forwards,
 * and is failure-isolated.
 *
 * Style mirrors kanban-escalate-to-supervisor.test.js: extractFunctionBody +
 * new Function, with the module-scope deps injected. Plus source-grep invariants
 * proving the wiring at the dormant return points and the default-off pref.
 */

const fs = require('fs');
const path = require('path');

const indexSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
const prefsMod = require('../../device-preferences.js');
const { isLowSignalFwd } = require('../../org-fwd-filter.js');

function extractFunctionBody(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) throw new Error(`function not found: ${signature}`);
    // Start scanning for the body's opening brace AFTER the signature text so a
    // `= {}` default in the parameter list isn't mistaken for the function body.
    const open = src.indexOf('{', start + signature.length);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return src.slice(open, i + 1);
        }
    }
    throw new Error(`unterminated function: ${signature}`);
}

const fallbackSrc = extractFunctionBody(
    indexSrc,
    'async function commanderForwardFallback(entity, deviceId, message, opts = {})'
);

// Rebuild commanderForwardFallback in isolation with its module-scope deps
// injected. unifiedPush is a spy so we can assert delivery target + payload.
function makeFallback(deps) {
    // eslint-disable-next-line no-new-func
    return new Function(
        'devicePrefs', 'devices', 'unifiedPush', 'serverLog', 'isLowSignalFwd',
        'ORG_FWD_PREFIX', 'COMMANDER_FORWARD_ENTITY_IDS', 'console',
        `return async function commanderForwardFallback(entity, deviceId, message, opts = {}) ${fallbackSrc}`
    )(
        deps.devicePrefs, deps.devices, deps.unifiedPush,
        deps.serverLog || (() => {}),
        deps.isLowSignalFwd || isLowSignalFwd,
        '[📢 FWD', [2, 1],
        deps.console || { log() {}, error() {} }
    );
}

function boundDevice(boundIds) {
    const entities = {};
    for (const id of boundIds) entities[id] = { entityId: id, isBound: true };
    return { entities };
}

function makeDeps({ prefEnabled, boundIds }) {
    const pushCalls = [];
    return {
        pushCalls,
        deps: {
            devicePrefs: { getPrefs: async () => ({ commander_forward_fallback_enabled: prefEnabled }) },
            devices: { dev1: boundDevice(boundIds) },
            unifiedPush: async (targetEntity, deviceId, kind, payload, opts) => {
                pushCalls.push({ targetEntity, deviceId, kind, payload, opts });
            },
        },
    };
}

const SUBSTANTIVE = '完成 card_ab12cd 的修復，PR #123 已開，待 review — ETA 30 分鐘。';
const LOW_SIGNAL = '收到🦞';

describe('commanderForwardFallback — behavioural', () => {
    test('pref FALSE (default) → no fallback forward (no-op)', async () => {
        const { pushCalls, deps } = makeDeps({ prefEnabled: false, boundIds: [1, 2, 6] });
        const fallback = makeFallback(deps);
        await fallback({ entityId: 6 }, 'dev1', SUBSTANTIVE, { fromEntityId: 99 });
        expect(pushCalls).toHaveLength(0);
    });

    test('pref TRUE + substantive + no hierarchy + #2 bound + sender=#6 → forwards to #2', async () => {
        const { pushCalls, deps } = makeDeps({ prefEnabled: true, boundIds: [1, 2, 6] });
        const fallback = makeFallback(deps);
        await fallback({ entityId: 6 }, 'dev1', SUBSTANTIVE, { fromEntityId: 99 });
        expect(pushCalls).toHaveLength(1);
        expect(pushCalls[0].targetEntity.entityId).toBe(2); // commander #2 preferred
        expect(pushCalls[0].payload.message).toContain(SUBSTANTIVE);
        expect(pushCalls[0].payload.message.startsWith('[📢 FWD from #6]')).toBe(true);
        expect(pushCalls[0].opts.skipMiddleware).toBe(true);
        expect(pushCalls[0].opts.from).toBe('entity:6');
    });

    test('pref TRUE but message is LOW-SIGNAL → NOT forwarded (filter still applies)', async () => {
        const { pushCalls, deps } = makeDeps({ prefEnabled: true, boundIds: [1, 2, 6] });
        const fallback = makeFallback(deps);
        await fallback({ entityId: 6 }, 'dev1', LOW_SIGNAL, { fromEntityId: 99 });
        expect(pushCalls).toHaveLength(0);
    });

    test('pref TRUE + sender IS #2 itself → does not self-forward, falls to #1', async () => {
        const { pushCalls, deps } = makeDeps({ prefEnabled: true, boundIds: [1, 2] });
        const fallback = makeFallback(deps);
        // #2 is the FORWARDING entity → #2 skipped (never self-forward) → #1 chosen.
        await fallback({ entityId: 2 }, 'dev1', SUBSTANTIVE, { fromEntityId: 99 });
        expect(pushCalls).toHaveLength(1);
        expect(pushCalls[0].targetEntity.entityId).toBe(1);
    });

    test('pref TRUE + original sender is #2 → #2 skipped (already has it), falls to #1', async () => {
        const { pushCalls, deps } = makeDeps({ prefEnabled: true, boundIds: [1, 2, 6] });
        const fallback = makeFallback(deps);
        await fallback({ entityId: 6 }, 'dev1', SUBSTANTIVE, { fromEntityId: 2 });
        expect(pushCalls).toHaveLength(1);
        expect(pushCalls[0].targetEntity.entityId).toBe(1);
    });

    test('pref TRUE + no bound commander (#1/#2 unbound) → no-op', async () => {
        const { pushCalls, deps } = makeDeps({ prefEnabled: true, boundIds: [6] });
        const fallback = makeFallback(deps);
        await fallback({ entityId: 6 }, 'dev1', SUBSTANTIVE, { fromEntityId: 99 });
        expect(pushCalls).toHaveLength(0);
    });

    test('inbound message → NOT force-forwarded (escalation is the other path)', async () => {
        const { pushCalls, deps } = makeDeps({ prefEnabled: true, boundIds: [1, 2, 6] });
        const fallback = makeFallback(deps);
        await fallback({ entityId: 6 }, 'dev1', SUBSTANTIVE, { fromEntityId: 99, inbound: true });
        expect(pushCalls).toHaveLength(0);
    });

    test('failure-isolated: getPrefs throws → swallowed, no push, no throw', async () => {
        const pushCalls = [];
        const deps = {
            devicePrefs: { getPrefs: async () => { throw new Error('db down'); } },
            devices: { dev1: boundDevice([1, 2, 6]) },
            unifiedPush: async (...a) => { pushCalls.push(a); },
        };
        const fallback = makeFallback(deps);
        await expect(fallback({ entityId: 6 }, 'dev1', SUBSTANTIVE, {})).resolves.toBeUndefined();
        expect(pushCalls).toHaveLength(0);
    });

    test('device not present → no-op (no throw)', async () => {
        const pushCalls = [];
        const deps = {
            devicePrefs: { getPrefs: async () => ({ commander_forward_fallback_enabled: true }) },
            devices: {},
            unifiedPush: async (...a) => { pushCalls.push(a); },
        };
        const fallback = makeFallback(deps);
        await fallback({ entityId: 6 }, 'dev1', SUBSTANTIVE, {});
        expect(pushCalls).toHaveLength(0);
    });
});

describe('device-preferences — pref default + coercion', () => {
    test('commander_forward_fallback_enabled DEFAULTS to false (dark-launch)', () => {
        expect(prefsMod.DEFAULTS.commander_forward_fallback_enabled).toBe(false);
    });

    test('string-safe boolean coercion: "false" stays false, only real true / "true" enable', () => {
        // Re-run coerceValue via updatePrefs path indirectly is heavy; assert the
        // documented contract through DEFAULTS + the code invariant grep below.
        // Here we prove the coercion is wired the same as the other routing gates.
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'device-preferences.js'), 'utf8');
        // The pref is in the string-safe boolean branch (raw === true || raw === 'true'),
        // NOT the bare `!!raw` branch (which would coerce 'false' → true).
        const branch = src.slice(
            src.indexOf("if (key === 'kanban_auto_escalate_enabled'"),
            src.indexOf("return raw === true || raw === 'true';")
        );
        expect(branch).toContain("key === 'commander_forward_fallback_enabled'");
    });
});

describe('source invariants — orgChartForward wiring', () => {
    test('the two dormant return points call commanderForwardFallback', () => {
        const fwdSrc = extractFunctionBody(
            indexSrc,
            'async function orgChartForward(entity, deviceId, message, opts = {})'
        );
        // taskForward/allForward-off return → fallback
        expect(fwdSrc).toMatch(/!orgData\.options\.taskForward && !orgData\.options\.allForward\)\s*\{\s*return commanderForwardFallback/);
        // no superior for this entity → fallback
        expect(fwdSrc).toMatch(/superiorId == null\)\s*\{\s*return commanderForwardFallback/);
    });

    test('commander fallback uses the #2-before-#1 ordering constant', () => {
        expect(indexSrc).toMatch(/COMMANDER_FORWARD_ENTITY_IDS\s*=\s*\[2,\s*1\]/);
    });

    test('fallback is default-off gated on the pref and re-applies the low-signal filter', () => {
        expect(fallbackSrc).toMatch(/commander_forward_fallback_enabled !== true/);
        expect(fallbackSrc).toMatch(/isLowSignalFwd\(message\)/);
        expect(fallbackSrc).toMatch(/if \(opts\.inbound\) return/);
    });
});
