/**
 * Regression test for card_1f8 — routing chip on inbound first message.
 *
 * Symptoms before fix:
 *   1. Server only writes routing_meta on deliverToEntity (canonical path).
 *      Legacy entity/speak-to, cross-speak v1/v2, broadcast, transform
 *      cross-device routes skipped it → first-message rows lacked the chip.
 *   2. chat.html renderRoutingChip returned '' for parseable-but-degraded
 *      rows, so users saw an empty meta row when meta was missing.
 *
 * Fixes locked here:
 *   • backend: buildRoutingMeta() helper + every routed saveChatMessage now
 *     forwards routingMeta.
 *   • frontend: missing-meta + unparseable-source path still renders an
 *     `rc-degraded` sender chip when is_from_bot && entity_id is known.
 *
 * Same static-surface pattern as routing-meta-payload.test.js and
 * chat-routing-chip.test.js (testEnvironment:'node').
 */
'use strict';

const fs = require('fs');
const path = require('path');

const indexJs = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
const chatHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'portal', 'chat.html'), 'utf8');
const i18nJs = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'shared', 'i18n.js'), 'utf8');

describe('card_1f8 — backend: buildRoutingMeta helper', () => {
    test('module-scope helper exists with the canonical shape', () => {
        expect(indexJs).toMatch(/function buildRoutingMeta\(\{ mode, fromEntity, fromId, toEntity, toId, status, fromPublicCode, toPublicCode \} = \{\}\)/);
        expect(indexJs).toMatch(/mode: mode \|\| 'speakTo'/);
        expect(indexJs).toMatch(/from_entity_id: fromId != null \? fromId : null/);
        expect(indexJs).toMatch(/from_lv: entityLv\(fromEntity\)/);
        expect(indexJs).toMatch(/to_lv: entityLv\(toEntity\)/);
        expect(indexJs).toMatch(/status: status \|\| 'sent'/);
    });

    test('runtime: returns canonical shape with sensible defaults', () => {
        const src = indexJs.match(/function buildRoutingMeta\([\s\S]*?\n\}/);
        expect(src).not.toBeNull();
        // eslint-disable-next-line no-eval
        const buildRoutingMeta = eval(`(function () { ${src[0]}; return buildRoutingMeta; })()`);

        const meta = buildRoutingMeta({ fromEntity: { name: 'A', level: 3 }, fromId: 1, toEntity: { name: 'B', level: 5 }, toId: 2 });
        expect(meta).toEqual({
            mode: 'speakTo',
            from_entity_id: 1, from_name: 'A', from_lv: 3,
            to_entity_id: 2, to_name: 'B', to_lv: 5,
            status: 'sent'
        });

        const minimal = buildRoutingMeta({ fromEntity: {}, fromId: 7, toEntity: null, toId: 9, mode: 'broadcast' });
        expect(minimal.mode).toBe('broadcast');
        expect(minimal.from_name).toBe('Entity 7');
        expect(minimal.from_lv).toBe(1);
        expect(minimal.to_name).toBe('Entity 9');
        expect(minimal.to_lv).toBe(1);

        const xd = buildRoutingMeta({ mode: 'xdevice', fromEntity: { character: 'C' }, fromId: 0, toEntity: null, toId: 0, fromPublicCode: 'abc', toPublicCode: 'xyz' });
        expect(xd.from_public_code).toBe('abc');
        expect(xd.to_public_code).toBe('xyz');

        const noXd = buildRoutingMeta({ fromEntity: { name: 'A' }, fromId: 1, toEntity: { name: 'B' }, toId: 2 });
        expect(noXd).not.toHaveProperty('from_public_code');
        expect(noXd).not.toHaveProperty('to_public_code');
    });
});

describe('card_1f8 — backend: all routed paths forward routingMeta', () => {
    test('legacy /api/entity/speak-to', () => {
        expect(indexJs).toMatch(/const speakToRoutingMeta = buildRoutingMeta\(\{ mode: 'speakTo', fromEntity, fromId, toEntity, toId \}\);/);
        expect(indexJs).toMatch(/saveChatMessage\([^;]*speakToText[^;]*speakToRoutingMeta\)/);
    });

    test('cross-speak v1 (publicCode route) saves on both devices', () => {
        expect(indexJs).toMatch(/const crossRoutingMeta = buildRoutingMeta\(\{[\s\S]*?mode: 'xdevice'[\s\S]*?toPublicCode: targetCode[\s\S]*?\}\);/);
        const xs = indexJs.match(/saveChatMessage\([^;]*crossRoutingMeta\)/g) || [];
        expect(xs.length).toBeGreaterThanOrEqual(2);
    });

    test('client cross-speak v2 saves on both devices', () => {
        expect(indexJs).toMatch(/const clientCrossRoutingMeta = buildRoutingMeta\(\{[\s\S]*?mode: 'xdevice'[\s\S]*?\}\);/);
        const xs = indexJs.match(/saveChatMessage\([^;]*clientCrossRoutingMeta\)/g) || [];
        expect(xs.length).toBeGreaterThanOrEqual(2);
    });

    test('broadcast carries mode:broadcast + broadcast_target_ids', () => {
        expect(indexJs).toMatch(/const broadcastRoutingMeta = buildRoutingMeta\(\{[\s\S]*?mode: 'broadcast'[\s\S]*?\}\);/);
        expect(indexJs).toMatch(/broadcastRoutingMeta\.broadcast_target_ids = targetIds\.slice\(\);/);
        expect(indexJs).toMatch(/saveChatMessage\([^;]*broadcastText[^;]*broadcastRoutingMeta\)/);
    });

    test('transform cross-device explicit-route + auto-route', () => {
        expect(indexJs).toMatch(/const explicitRouteMeta = buildRoutingMeta\(\{[\s\S]*?fromPublicCode: entity\.publicCode[\s\S]*?\}\);/);
        expect(indexJs).toMatch(/saveChatMessage\([^;]*finalMessage[^;]*explicitRouteMeta\)/);
        expect(indexJs).toMatch(/const autoRouteMeta = buildRoutingMeta\(\{[\s\S]*?fromPublicCode: entity\.publicCode[\s\S]*?\}\);/);
        expect(indexJs).toMatch(/saveChatMessage\([^;]*finalMessage[^;]*autoRouteMeta\)/);
    });
});

describe('card_1f8 — frontend: sender-fallback chip when source unparseable', () => {
    // Find the renderRoutingChip body, bounded by the function-level closing brace.
    const fn = chatHtml.match(/function\s+renderRoutingChip\s*\(\s*msg\s*\)\s*\{[\s\S]*?\n        \}/);
    test('renderRoutingChip is present', () => {
        expect(fn).not.toBeNull();
    });

    test('falls through to a degraded sender chip when source unparseable but is_from_bot', () => {
        const body = fn ? fn[0] : '';
        // additive branch (added by card_1f8) — guards a sender-only chip
        expect(body).toMatch(/msg\.is_from_bot && msg\.entity_id != null/);
        expect(body).toMatch(/rc-degraded/);
        // chip carries an i18n-aware "client-derived" tooltip
        expect(body).toMatch(/chat_routing_client_derived/);
        // still preserves the existing rc-unconfirmed branch for parseable routed rows
        expect(body).toMatch(/rc-unconfirmed/);
    });

    // card_ecda7243: the degraded branch no longer emits a bare 「？」 target.
    // It resolves the org-chart commander (upper-level entity) when known,
    // else labels the target as the User — never '?'.
    test('degraded branch resolves a real target — never a bare "→ ?"', () => {
        // Scope to the null/unparseable-meta fallback block (before "// Positive:").
        const head = (fn ? fn[0] : '').split('// Positive:')[0] || '';
        // No literal "→ ?" anywhere in the fallback block.
        expect(head).not.toMatch(/→\s*\?/);
        expect(head).not.toMatch(/to_entity_id\s*:\s*null\s*\}.*→ \?/);
        // The degraded chip resolves THIS sender's real org-chart superior
        // (card_a0485399 — never a blanket #USER[0] commander) as the target.
        const degradedBlock = head.split('msg.is_from_bot && msg.entity_id != null').pop() || '';
        expect(degradedBlock).toMatch(/degradedTargetFor/);
        // and falls back to a localized User label (top-level → owner), not '?'.
        expect(degradedBlock).toMatch(/chat_routing_to_user/);
    });

    test('i18n key chat_routing_client_derived defined in en + zh + zh-TW', () => {
        // sanity: same loose match the i18n-check script uses for parity
        expect(i18nJs.match(/"chat_routing_client_derived"\s*:\s*"[^"]+"/g) || []).toHaveLength(3);
    });
});
