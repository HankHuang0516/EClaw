/**
 * card_ecda7243bf03720a4bbecb2d — routing pointer must NEVER render a bare 「？」.
 *
 * Repro (Hank, real user): an entity UNDER the org hierarchy replies to the
 * User WITHOUT speakTo. The reply row used to be saved with routing_meta=null,
 * so chat.html#renderRoutingChip fell through to a degraded "#N → ?" chip.
 *
 * Two-layer fix locked here:
 *   1. backend resolveSelfReplyRoutingMeta(): for a no-speakTo self-reply,
 *      resolve a real routing_meta target —
 *        • org auto-forward configured + bound superior → mode 'org_upward',
 *          to = that PARENT entity (the org upper-level).
 *        • otherwise → mode 'toUser', to_is_user true, to_name 'User'.
 *      Never produces a '?' target.
 *   2. backend self-save threads that routing_meta into saveChatMessage.
 *   3. frontend degraded fallback + positive branch never emit "→ ?".
 *
 * We functionally eval the two cooperating module-scope helpers (buildRoutingMeta
 * + resolveSelfReplyRoutingMeta) with injected deps, plus a static-surface lock
 * on the self-save wiring + the new i18n keys (same node testEnvironment as the
 * sibling routing tests).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const indexJs = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
const chatHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'portal', 'chat.html'), 'utf8');
const i18nJs = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'shared', 'i18n.js'), 'utf8');
// card_d199b41c: the resolver now consults effectiveAllForward for the Opt1
// default-on decision — inject the REAL helpers so the mirror matches production.
const realOrgChart = require('../../org-chart');

// ── Build a runnable resolveSelfReplyRoutingMeta over injected module deps ──
function makeResolver({ hierarchy, options, entities, hasOpenTask = false, lowSignal = false }) {
    const buildRoutingMetaSrc = indexJs.match(/function buildRoutingMeta\([\s\S]*?\n\}/)[0];
    const resolverSrc = indexJs.match(/async function resolveSelfReplyRoutingMeta\([\s\S]*?\n\}/)[0];

    const orgChartModule = {
        getOrgChart: async () => ({ hierarchy, options }),
        getSuperior: (h, id) => {
            const eid = Number(id);
            for (const [parentKey, kids] of Object.entries(h || {})) {
                if (Array.isArray(kids) && kids.includes(eid)) {
                    return parentKey === 'USER' ? 'USER' : Number(parentKey);
                }
            }
            return null;
        },
        // Real Opt1 helpers (card_d199b41c) so willForward mirrors production.
        effectiveAllForward: realOrgChart.effectiveAllForward,
        isHierarchyConfigured: realOrgChart.isHierarchyConfigured,
    };
    const devices = { dev1: { entities } };
    const chatPool = { query: async () => ({ rows: hasOpenTask ? [{ '?column?': 1 }] : [] }) };
    const isLowSignalFwd = () => lowSignal;
    const console2 = { error: () => {}, log: () => {} };

    // eslint-disable-next-line no-eval
    return eval(`(function (orgChartModule, devices, chatPool, isLowSignalFwd, console) {
        ${buildRoutingMetaSrc}
        ${resolverSrc}
        return resolveSelfReplyRoutingMeta;
    })`)(orgChartModule, devices, chatPool, isLowSignalFwd, console2);
}

describe('resolveSelfReplyRoutingMeta — org-parent vs user, never "?"', () => {
    const parent = { name: 'Boss', level: 5, isBound: true };
    const child = { name: 'Worker', level: 2, isBound: true };

    test('subordinate → User, allForward ON → mode org_upward, to = PARENT (not "?")', async () => {
        const resolve = makeResolver({
            hierarchy: { USER: [9], 9: [3] },
            options: { allForward: true },
            entities: { 3: child, 9: parent },
        });
        const meta = await resolve(child, 'dev1', 3, 'real status update');
        expect(meta.mode).toBe('org_upward');
        expect(meta.to_entity_id).toBe(9);
        expect(meta.to_name).toBe('Boss');
        expect(meta.from_entity_id).toBe(3);
        expect(meta.to_name).not.toBe('?');
    });

    test('subordinate → User, taskForward ON + open task → org_upward to PARENT', async () => {
        const resolve = makeResolver({
            hierarchy: { USER: [9], 9: [3] },
            options: { taskForward: true },
            entities: { 3: child, 9: parent },
            hasOpenTask: true,
        });
        const meta = await resolve(child, 'dev1', 3, 'progress');
        expect(meta.mode).toBe('org_upward');
        expect(meta.to_entity_id).toBe(9);
    });

    test('taskForward ON but NO open task → falls back to toUser (not parent, not "?")', async () => {
        const resolve = makeResolver({
            hierarchy: { USER: [9], 9: [3] },
            options: { taskForward: true },
            entities: { 3: child, 9: parent },
            hasOpenTask: false,
        });
        const meta = await resolve(child, 'dev1', 3, 'chit chat');
        expect(meta.mode).toBe('toUser');
        expect(meta.to_is_user).toBe(true);
        expect(meta.to_name).toBe('User');
    });

    test('no org forwarding configured → mode toUser, to_name "User" (never "?")', async () => {
        const resolve = makeResolver({
            hierarchy: { USER: [3] },
            options: {},
            entities: { 3: child },
        });
        const meta = await resolve(child, 'dev1', 3, 'hi');
        expect(meta.mode).toBe('toUser');
        expect(meta.to_is_user).toBe(true);
        expect(meta.to_name).toBe('User');
        expect(meta.to_entity_id).toBeNull();
    });

    test('entity directly under USER → toUser even with allForward (superior IS user)', async () => {
        const resolve = makeResolver({
            hierarchy: { USER: [3] },
            options: { allForward: true },
            entities: { 3: child },
        });
        const meta = await resolve(child, 'dev1', 3, 'hi');
        expect(meta.mode).toBe('toUser');
    });

    test('superior unbound → toUser (no upward route possible), never "?"', async () => {
        const resolve = makeResolver({
            hierarchy: { USER: [9], 9: [3] },
            options: { allForward: true },
            entities: { 3: child, 9: { name: 'Boss', isBound: false } },
        });
        const meta = await resolve(child, 'dev1', 3, 'hi');
        expect(meta.mode).toBe('toUser');
    });

    test('low-signal fwd suppressed → toUser (pointer must not claim a route that never fires)', async () => {
        const resolve = makeResolver({
            hierarchy: { USER: [9], 9: [3] },
            options: { allForward: true },
            entities: { 3: child, 9: parent },
            lowSignal: true,
        });
        const meta = await resolve(child, 'dev1', 3, 'ok');
        expect(meta.mode).toBe('toUser');
    });

    test('disconnected sub-tree (superior chain never reaches USER) → toUser, chip does not lie (card_d199b41c mirror walk)', async () => {
        // 3→2→5→(orphan): 5 is not under USER, so orgChartForward would DROP the
        // message (reachesUser=false). Opt1 default-on (both options off + a
        // configured hierarchy) would otherwise stamp org_upward — the reaches-USER
        // walk must prevent that so the chip matches the real (non-)route.
        const resolve = makeResolver({
            hierarchy: { USER: [10], 2: [3], 5: [2] },
            options: {},
            entities: { 3: child, 2: parent, 5: { name: 'Orphan', isBound: true }, 10: parent },
        });
        const meta = await resolve(child, 'dev1', 3, 'status');
        expect(meta.mode).toBe('toUser');
        expect(meta.to_is_user).toBe(true);
    });
});

describe('backend self-save wiring (static surface)', () => {
    test('self-reply save resolves + threads routing_meta', () => {
        expect(indexJs).toMatch(/const selfReplyRoutingMeta = await resolveSelfReplyRoutingMeta\(entity, deviceId, eId, finalMessage\)/);
        expect(indexJs).toMatch(/saveChatMessage\(deviceId, eId, finalMessage, chatSource, false, true,[^;]*selfReplyRoutingMeta\)/);
    });

    test('resolver helper is defined with org_upward + toUser modes', () => {
        const src = indexJs.match(/async function resolveSelfReplyRoutingMeta\([\s\S]*?\n\}/)[0];
        expect(src).toMatch(/mode: 'org_upward'/);
        expect(src).toMatch(/mode: 'toUser'/);
        expect(src).toMatch(/to_is_user = true/);
        expect(src).not.toMatch(/to_name:\s*'\?'/);
    });
});

describe('frontend chip never renders bare "?" (static surface)', () => {
    const chipFn = chatHtml.match(/function\s+renderRoutingChip\s*\(\s*msg\s*\)\s*\{[\s\S]*?\n        \}/);
    const chipBody = chipFn ? chipFn[0] : '';

    test('renderRoutingChip parsed', () => {
        expect(chipFn).not.toBeNull();
    });

    test('no literal "→ ?" anywhere in the chip', () => {
        expect(chipBody).not.toMatch(/→\s*\?/);
    });

    test('degraded fallback resolves the sender\'s real superior or localized User label', () => {
        const head = chipBody.split('// Positive:')[0];
        const degraded = head.split('msg.is_from_bot && msg.entity_id != null').pop() || '';
        // card_a0485399: per-entity superior (degradedTargetFor), never #USER[0].
        expect(degraded).toMatch(/degradedTargetFor/);
        expect(degraded).toMatch(/chat_routing_to_user/);
    });

    test('positive branch localizes to_is_user as "User", not raw to_name', () => {
        const positive = chipBody.split('// Positive:').pop() || '';
        expect(positive).toMatch(/rm\.to_is_user/);
        expect(positive).toMatch(/chat_routing_to_user/);
    });
});

describe('i18n keys present (en + zh-CN + zh-TW parity)', () => {
    test('chat_routing_to_user defined in 3 locales', () => {
        expect((i18nJs.match(/"chat_routing_to_user"\s*:\s*"[^"]+"/g) || [])).toHaveLength(3);
    });
    test('chat_routing_org_upward defined in 3 locales', () => {
        expect((i18nJs.match(/"chat_routing_org_upward"\s*:\s*"[^"]+"/g) || [])).toHaveLength(3);
    });
});
