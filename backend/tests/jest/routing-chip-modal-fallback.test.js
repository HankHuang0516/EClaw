/**
 * card_816c435e759649fea9186694 — routing-chip detail modal must NEVER render
 * the literal string "undefined" in any pill/label.
 *
 * Repro: Hank screenshot shows the modal's "to / 目標" field reading "undefined"
 * instead of the supervisor (org-chart commander) name. Prior cards
 * (e53b0908 / 1f8 / ecda7243 / 29eed229) hardened the CHIP path
 * (renderRoutingChip) — this card hardens the MODAL path
 * (openRoutingChipDetail → renderRoutingChipDetailBody) by adding a
 * normalizeRoutingPayload() pre-pass + a shared resolveEntityLabel() helper
 * that every label render site routes through.
 *
 * What this test locks:
 *   1. resolveEntityLabel + normalizeRoutingPayload exist in chat.html.
 *   2. The label resolver coalesces sum → fallbackName → fallbackId →
 *      fallbackCode → orgChartCommanderId → neutral, in that order, and
 *      treats undefined / null / '' / 'undefined' / 'null' / '?' / '？'
 *      as bad-name sentinels (none reach the DOM).
 *   3. The modal's chain section (superior/subordinates/peers) and the
 *      org-tree renderer both use resolveEntityLabel — no naked
 *      `'#' + entityId` (which renders '#undefined' when id is undefined).
 *   4. renderPill calls pass the to_is_user FLAG through (not the resolved
 *      label inline) so the resolver controls all "User" / "Supervisor"
 *      fallback decisions in one place.
 *   5. i18n key chat_routing_supervisor ships in EN + ZH (>=3 locales).
 *   6. The resolver, exercised against canned payloads, never emits the
 *      string "undefined" in any output label.
 *
 * Test approach: chat.html has no module export, so we extract the two
 * helper-function source blocks (resolveEntityLabel + normalizeRoutingPayload)
 * with regex slicing and eval them inside a closure that supplies the
 * `orgChartCommanderId` cache + a stub i18n.t — mirrors the pattern used in
 * routing-self-reply-card-ecda7243.test.js. No jsdom required.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const chatHtmlPath = path.join(__dirname, '..', '..', 'public', 'portal', 'chat.html');
const chatHtml = fs.readFileSync(chatHtmlPath, 'utf8');
const i18nPath = path.join(__dirname, '..', '..', 'public', 'shared', 'i18n.js');
const i18nSrc = fs.readFileSync(i18nPath, 'utf8');

// ── Extract the two helpers as runnable source ─────────────────────────────
function extractFn(src, signature, endMarker) {
    const start = src.indexOf(signature);
    if (start < 0) throw new Error(`signature not found: ${signature}`);
    const end = src.indexOf(endMarker, start);
    if (end < 0) throw new Error(`endMarker not found after signature: ${endMarker}`);
    return src.slice(start, end);
}

const resolverSrc = extractFn(
    chatHtml,
    'function resolveEntityLabel(',
    '\n        }\n\n        // card_816c435e: normalize'
) + '\n        }';
const normalizerSrc = extractFn(
    chatHtml,
    'function normalizeRoutingPayload(',
    '\n        }\n\n        function renderRoutingChipDetailBody'
) + '\n        }';

// Stand up the helpers in a closure with `orgChartCommanderId` reachable.
function makeHelpers(commanderId) {
    // eslint-disable-next-line no-eval
    const factory = eval(
        `(function (orgChartCommanderId) {
            ${resolverSrc}
            ${normalizerSrc}
            return { resolveEntityLabel, normalizeRoutingPayload };
        })`
    );
    return factory(commanderId);
}

// Stub tt — return a known shape so we can assert on the label.
const ttStub = (k, fb) => {
    const dict = {
        chat_routing_to_user: 'User',
        chat_routing_supervisor: '主管',
        chat_routing_sender: 'Sender',
        chat_routing_unspecified: 'Unspecified',
    };
    return dict[k] || fb;
};

// ── Helpers also referenced indirectly: getEntityDisplayName mock (the resolver
// does NOT call it directly today — kept for forward-compat if a future patch
// wires the entity name map through). Provided here for documentation.
const ENTITY_NAMES = { 1: 'Mac_F', 2: 'LOBSTER', 3: 'Mac_E' };
function getEntityDisplayName(id) { return ENTITY_NAMES[id] || null; }

describe('chat.html surface — resolveEntityLabel + normalizeRoutingPayload exist', () => {
    test('resolveEntityLabel is defined and reachable from the modal renderer', () => {
        expect(chatHtml).toMatch(/function\s+resolveEntityLabel\s*\(\s*sum,\s*fallbackId,\s*fallbackName,\s*fallbackCode,\s*opts\s*\)/);
    });

    test('normalizeRoutingPayload is defined and called at top of renderRoutingChipDetailBody', () => {
        expect(chatHtml).toMatch(/function\s+normalizeRoutingPayload\s*\(\s*payload\s*\)/);
        // Called inside renderRoutingChipDetailBody before any render site.
        const bodyStart = chatHtml.indexOf('function renderRoutingChipDetailBody(bodyEl, payload');
        expect(bodyStart).toBeGreaterThan(-1);
        const body = chatHtml.slice(bodyStart, bodyStart + 2000);
        expect(body).toMatch(/payload\s*=\s*normalizeRoutingPayload\(payload\)/);
    });

    test('renderPill passes isUser flag through (label not inlined at call site)', () => {
        const bodyStart = chatHtml.indexOf('function renderRoutingChipDetailBody(bodyEl, payload');
        const body = chatHtml.slice(bodyStart, bodyStart + 9000);
        // The to-side call must pass the boolean flag, not a tt(...) label.
        expect(body).toMatch(/renderPill\('to',\s*toSum,\s*payload\.to_entity_id,\s*payload\.to_name,\s*payload\.to_public_code,\s*!!payload\.to_is_user\)/);
        // And the from-side must explicitly opt out of isUser.
        expect(body).toMatch(/renderPill\('from',\s*fromSum,\s*payload\.from_entity_id,\s*payload\.from_name,\s*payload\.from_public_code,\s*false\)/);
    });

    test('chain section (superior/subordinates/peers) routes through resolveEntityLabel', () => {
        const bodyStart = chatHtml.indexOf('function renderRoutingChipDetailBody(bodyEl, payload');
        const body = chatHtml.slice(bodyStart, bodyStart + 9000);
        // No raw `'#' + c.superior.entityId` / `'#' + s.entityId` / `'#' + p.entityId`
        // — those would render '#undefined' when entityId is absent.
        expect(body).not.toMatch(/\(\s*'#'\s*\+\s*c\.superior\.entityId\s*\)/);
        expect(body).not.toMatch(/\(\s*'#'\s*\+\s*s\.entityId\s*\)/);
        expect(body).not.toMatch(/\(\s*'#'\s*\+\s*p\.entityId\s*\)/);
        // Positive: resolveEntityLabel(...) appears in the chain block.
        const chainStart = body.indexOf('Section 4');
        expect(chainStart).toBeGreaterThan(-1);
        const chainBody = body.slice(chainStart);
        expect(chainBody).toMatch(/resolveEntityLabel\(/);
    });

    test('renderOrgTreeHtml labelFor uses resolveEntityLabel (no naked #id)', () => {
        const treeStart = chatHtml.indexOf('function renderOrgTreeHtml(hierarchy');
        expect(treeStart).toBeGreaterThan(-1);
        const body = chatHtml.slice(treeStart, treeStart + 3000);
        // Old shape (banned): `if (!s) return '#' + id;` followed by `s.name || s.character || ('#' + id)`.
        expect(body).not.toMatch(/if\s*\(!s\)\s*return\s*'#'\s*\+\s*id;/);
        expect(body).toMatch(/resolveEntityLabel\(/);
    });
});

describe('i18n — chat_routing_supervisor ships in EN + ZH (>=3 locales)', () => {
    test('chat_routing_supervisor key occurs at least 3 times (en + zh-TW + zh-CN)', () => {
        const occurrences = (i18nSrc.match(/"chat_routing_supervisor"\s*:/g) || []).length;
        expect(occurrences).toBeGreaterThanOrEqual(3);
    });

    test('EN value is "Supervisor"', () => {
        expect(i18nSrc).toMatch(/"chat_routing_supervisor"\s*:\s*"Supervisor"/);
    });

    test('zh-TW value is "主管"', () => {
        // Just check the localized string is present near the key in some form.
        expect(i18nSrc).toMatch(/"chat_routing_supervisor"\s*:\s*"主管"/);
    });
});

describe('resolveEntityLabel — behaviour (extracted into a closure)', () => {
    // ── Test 1: payload has undefined to_name but valid to_entity_id ──
    test('Test 1: undefined to_name + valid to_entity_id → label falls back to #id, no "undefined"', () => {
        const { resolveEntityLabel } = makeHelpers(null);
        // Simulate the modal sum lookup miss (no detail.entities row for id 2).
        const r = resolveEntityLabel(null, 2, undefined, null, { which: 'to', tt: ttStub });
        expect(r.label).toBe('#2');
        expect(r.label).not.toContain('undefined');
    });

    test('Test 1b: when summary carries a real name, the label is the name (not #id)', () => {
        const { resolveEntityLabel } = makeHelpers(null);
        const sum = { name: 'LOBSTER', publicCode: '3xa3h4', level: 2 };
        const r = resolveEntityLabel(sum, 2, undefined, null, { which: 'to', tt: ttStub });
        expect(r.label).toBe('LOBSTER');
        expect(r.code).toBe('#3xa3h4');
        expect(r.lv).toBe('LV2');
    });

    // ── Test 2: all fields blank (legacy null routing_meta) → supervisor floor ──
    test('Test 2: all fields blank/null → falls back to supervisor i18n label, NEVER "undefined"', () => {
        const { resolveEntityLabel } = makeHelpers(null);
        const r = resolveEntityLabel(null, null, undefined, null, { which: 'to', tt: ttStub });
        // No commanderId either, so we land on the neutral i18n label.
        expect(r.label).toBe('主管');
        expect(r.label).not.toContain('undefined');
    });

    test('Test 2b: blank fields BUT commander cached → commander floor wins over neutral', () => {
        const { resolveEntityLabel } = makeHelpers(7);
        const r = resolveEntityLabel(null, null, undefined, null, { which: 'to', tt: ttStub });
        expect(r.label).toBe('#7');
        expect(r.label).not.toContain('undefined');
    });

    // ── Test 3: to_is_user → localized "User" label ──
    test('Test 3: to_is_user=true with undefined to_name → "User" via i18n, never "undefined"', () => {
        const { resolveEntityLabel } = makeHelpers(null);
        const r = resolveEntityLabel(null, null, undefined, null, { which: 'to', isUser: true, tt: ttStub });
        expect(r.label).toBe('User');
        expect(r.label).not.toContain('undefined');
    });

    test('Test 3b: to_is_user=true STILL wins even when a sum.name is present', () => {
        const { resolveEntityLabel } = makeHelpers(null);
        const sum = { name: 'should-be-ignored' };
        const r = resolveEntityLabel(sum, 9, 'also-ignored', null, { which: 'to', isUser: true, tt: ttStub });
        expect(r.label).toBe('User');
    });

    // ── Test 4: all fields valid → no fallback applied ──
    test('Test 4: all fields valid → label = sum.name, code from sum.publicCode, no fallback', () => {
        const { resolveEntityLabel } = makeHelpers(99);
        const sum = { name: 'Mac_F', publicCode: 'tbwb9e', level: 5, avatar: 'https://x/y.png' };
        const r = resolveEntityLabel(sum, 1, 'irrelevant-fallback', 'irrelevant-code', { which: 'to', tt: ttStub });
        expect(r.label).toBe('Mac_F');
        expect(r.code).toBe('#tbwb9e');
        expect(r.lv).toBe('LV5');
        expect(r.avatar).toBe('https://x/y.png');
    });

    // ── Bad-name sentinel coverage ──
    test('literal "undefined" string in sum.name is treated as bad → next chain step wins', () => {
        const { resolveEntityLabel } = makeHelpers(null);
        const sum = { name: 'undefined' };
        const r = resolveEntityLabel(sum, 2, 'GoodFallback', null, { which: 'to', tt: ttStub });
        expect(r.label).toBe('GoodFallback');
    });

    test('literal "?" / "？" in fallbackName is rejected', () => {
        const { resolveEntityLabel } = makeHelpers(null);
        expect(resolveEntityLabel(null, 5, '?', null, { which: 'to', tt: ttStub }).label).toBe('#5');
        expect(resolveEntityLabel(null, 5, '？', null, { which: 'to', tt: ttStub }).label).toBe('#5');
    });

    test('from-side neutral is "Sender" (not "Unspecified"/"Supervisor")', () => {
        const { resolveEntityLabel } = makeHelpers(null);
        const r = resolveEntityLabel(null, null, undefined, null, { which: 'from', tt: ttStub });
        expect(r.label).toBe('Sender');
    });

    test('fallbackId of NaN / non-finite is rejected (no "#NaN" leak)', () => {
        const { resolveEntityLabel } = makeHelpers(null);
        const r = resolveEntityLabel(null, 'not-a-number', null, null, { which: 'to', tt: ttStub });
        expect(r.label).toBe('主管');
        expect(r.label).not.toContain('NaN');
    });
});

describe('normalizeRoutingPayload — coerce undefined name fields to null up-front', () => {
    test('undefined / "undefined" / "" → null', () => {
        const { normalizeRoutingPayload } = makeHelpers(null);
        const p = normalizeRoutingPayload({
            to_name: undefined,
            from_name: 'undefined',
            to_public_code: '',
            from_public_code: '   ',
        });
        expect(p.to_name).toBeNull();
        expect(p.from_name).toBeNull();
        expect(p.to_public_code).toBeNull();
        expect(p.from_public_code).toBeNull();
    });

    test('valid string names survive untouched', () => {
        const { normalizeRoutingPayload } = makeHelpers(null);
        const p = normalizeRoutingPayload({
            from_name: 'Mac_F',
            to_name: 'LOBSTER',
            from_entity_id: 1,
            to_entity_id: 2,
        });
        expect(p.from_name).toBe('Mac_F');
        expect(p.to_name).toBe('LOBSTER');
        expect(p.from_entity_id).toBe(1);
        expect(p.to_entity_id).toBe(2);
    });

    test('non-finite entity ids → null', () => {
        const { normalizeRoutingPayload } = makeHelpers(null);
        const p = normalizeRoutingPayload({
            from_entity_id: 'not-numeric',
            to_entity_id: NaN,
        });
        expect(p.from_entity_id).toBeNull();
        expect(p.to_entity_id).toBeNull();
    });

    test('returns a shallow copy (does not mutate input)', () => {
        const { normalizeRoutingPayload } = makeHelpers(null);
        const orig = { to_name: undefined };
        const out = normalizeRoutingPayload(orig);
        expect(orig.to_name).toBeUndefined();
        expect(out.to_name).toBeNull();
        expect(out).not.toBe(orig);
    });

    test('null input does not throw', () => {
        const { normalizeRoutingPayload } = makeHelpers(null);
        expect(() => normalizeRoutingPayload(null)).not.toThrow();
        expect(() => normalizeRoutingPayload(undefined)).not.toThrow();
    });
});

describe('end-to-end smoke: every modal label-render path is undefined-proof', () => {
    // Compose normalize + resolve to mimic what the modal does for each pill.
    function renderLabel(payload, which, opts) {
        const { normalizeRoutingPayload, resolveEntityLabel } = makeHelpers(opts.commanderId || null);
        const p = normalizeRoutingPayload(payload);
        const sum = (which === 'to') ? null : null; // no server detail
        const id = (which === 'to') ? p.to_entity_id : p.from_entity_id;
        const nm = (which === 'to') ? p.to_name : p.from_name;
        const code = (which === 'to') ? p.to_public_code : p.from_public_code;
        const isUser = (which === 'to') && !!p.to_is_user;
        return resolveEntityLabel(sum, id, nm, code, { which, isUser, tt: ttStub }).label;
    }

    test('REPRO: legacy row payload (to_name=undefined, ids null) → "主管" not "undefined"', () => {
        const label = renderLabel(
            { to_name: undefined, to_entity_id: null, to_is_user: false, from_name: null, from_entity_id: null },
            'to',
            { commanderId: null }
        );
        expect(label).toBe('主管');
    });

    test('REPRO with commander cached: → "#<commanderId>" not "undefined"', () => {
        const label = renderLabel(
            { to_name: undefined, to_entity_id: null, to_is_user: false },
            'to',
            { commanderId: 9 }
        );
        expect(label).toBe('#9');
    });

    test('to_is_user=true with undefined to_name → "User" not "undefined"', () => {
        const label = renderLabel({ to_is_user: true, to_name: undefined }, 'to', { commanderId: null });
        expect(label).toBe('User');
    });

    test('from-side with undefined from_name + valid from_entity_id → "#id"', () => {
        const label = renderLabel(
            { from_name: undefined, from_entity_id: 1, to_name: 'LOBSTER', to_entity_id: 2 },
            'from',
            { commanderId: null }
        );
        expect(label).toBe('#1');
    });

    test('no path produces the literal string "undefined" for any of the 6 canned payloads', () => {
        const cases = [
            { to_name: undefined, to_entity_id: 2, from_name: 'Mac_F', from_entity_id: 1 },
            { to_name: undefined, to_entity_id: null, to_is_user: false, from_entity_id: null, from_name: null },
            { to_is_user: true, to_name: undefined },
            { to_name: 'LOBSTER', to_entity_id: 2, from_name: 'Mac_F', from_entity_id: 1 },
            { to_name: 'undefined', to_entity_id: 2 }, // literal-string sentinel
            { to_name: '?', to_entity_id: 2 },         // '?' sentinel
        ];
        for (const c of cases) {
            const tlabel = renderLabel(c, 'to', { commanderId: null });
            const flabel = renderLabel(c, 'from', { commanderId: null });
            expect(tlabel).not.toContain('undefined');
            expect(flabel).not.toContain('undefined');
        }
    });
});
