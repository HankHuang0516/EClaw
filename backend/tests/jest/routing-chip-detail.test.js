/**
 * card_53c57504bd070c63cf19affc — click routing chip → org-structure + smart
 * hierarchy modal. Locks the wire contract + chip-click attachment + modal
 * surface so future refactors can't silently break the feature.
 *
 *   1. Backend: GET /api/entity/routing-detail exists, gated by deviceId +
 *      (deviceSecret OR botSecret), returns {hierarchy, entities, chain,
 *      orgRules, ruleSource}.
 *   2. Frontend: every routing-chip branch emits the click affordance
 *      (data-routing-meta + onclick=openRoutingChipDetail), and the modal +
 *      handler exist with XSS escape + race-protection seq counter.
 *   3. i18n: the new chat_routing_detail_* / chat_routing_chip_aria keys
 *      ship in EN + ZH (gate per [[feedback_pr_preflight_gates]]).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const backendDir = path.join(__dirname, '..', '..');
const indexSrc = fs.readFileSync(path.join(backendDir, 'index.js'), 'utf8');
const chatSrc = fs.readFileSync(path.join(backendDir, 'public', 'portal', 'chat.html'), 'utf8');

// ── 1. Backend handler surface ───────────────────────────────────────────
describe('GET /api/entity/routing-detail (backend)', () => {
    const anchor = "app.get('/api/entity/routing-detail',";
    const handler = (() => {
        const i = indexSrc.indexOf(anchor);
        expect(i).toBeGreaterThan(-1);
        return indexSrc.slice(i, i + 8000);
    })();

    test('route is registered', () => {
        expect(indexSrc).toContain(anchor);
    });

    test('requires deviceId', () => {
        expect(handler).toMatch(/!deviceId/);
        expect(handler).toMatch(/status\(400\)/);
    });

    test('accepts deviceSecret OR botSecret OR JWT auth', () => {
        expect(handler).toMatch(/deviceSecret/);
        expect(handler).toMatch(/botSecret/);
        expect(handler).toMatch(/safeEqual\(device\.deviceSecret,\s*deviceSecret\)/);
        // botSecret auth must scan device.entities for a matching bound entity
        expect(handler).toMatch(/Object\.values\(device\.entities[\s\S]*?botSecret/);
        expect(handler).toMatch(/req\.user/);
    });

    test('403 on bad credentials (does not return device data on auth fail)', () => {
        expect(handler).toMatch(/status\(403\)/);
        // 403 branch must come BEFORE the response payload (no leak on failure)
        const status403 = handler.indexOf('status(403)');
        const resJson = handler.indexOf('res.json(');
        expect(status403).toBeGreaterThan(-1);
        expect(resJson).toBeGreaterThan(status403);
    });

    test('publicCode resolution stays same-device (no cross-device leak)', () => {
        // Only resolve publicCodeIndex hit when target.deviceId === deviceId
        expect(handler).toMatch(/publicCodeIndex\[req\.query\.publicCode\]/);
        expect(handler).toMatch(/target\.deviceId\s*===\s*deviceId/);
    });

    test('response payload includes the documented fields', () => {
        expect(handler).toMatch(/hierarchy/);
        expect(handler).toMatch(/entities/);
        expect(handler).toMatch(/chain/);
        expect(handler).toMatch(/orgRules/);
        expect(handler).toMatch(/ruleSource/);
        // toEntity and fromEntity surfaces
        expect(handler).toMatch(/toEntity/);
        expect(handler).toMatch(/fromEntity/);
    });

    test('summary helper strips secrets (no botSecret / webhook / channelAccountId)', () => {
        // Grab the summarize function inside the handler.
        const sumStart = handler.indexOf('const summarize = (e)');
        expect(sumStart).toBeGreaterThan(-1);
        // Slice to next `};` after the function body.
        const sumBody = handler.slice(sumStart, sumStart + 1200);
        expect(sumBody).not.toMatch(/botSecret/);
        expect(sumBody).not.toMatch(/webhook/);
        expect(sumBody).not.toMatch(/channelAccountId/);
    });

    test('uses org-chart module (no in-handler hierarchy walk)', () => {
        expect(handler).toMatch(/orgChartModule\.getOrgChart\(deviceId\)/);
        expect(handler).toMatch(/orgChartModule\.getSuperior/);
        expect(handler).toMatch(/orgChartModule\.getSubordinates/);
        // Fall back to buildDefault when hierarchy empty
        expect(handler).toMatch(/orgChartModule\.buildDefault/);
    });

    test('ruleSource normalizes mode query param', () => {
        expect(handler).toMatch(/ruleSource\s*=\s*['"]unknown['"]/);
        expect(handler).toMatch(/speakto.*broadcast.*xdevice|broadcast.*speakto.*xdevice|broadcast.*xdevice.*speakto/);
    });
});

// ── 2. Frontend chip click affordance ────────────────────────────────────
describe('routing chip click affordance (chat.html)', () => {
    test('every chip branch wires the click handler via chipClickAttrs helper', () => {
        // Locate the body of renderRoutingChip and count chipClickAttrs(...)
        // call sites — one per chip-emitting branch. Current branches:
        // unconfirmed, degraded-client (no-meta fallback), degraded/failed,
        // positive. The helper interpolates onclick=openRoutingChipDetail.
        const fnStart = chatSrc.indexOf('function renderRoutingChip(msg)');
        expect(fnStart).toBeGreaterThan(-1);
        // card_e53b0908: window must cover the full function (it grew with the
        // sender-floor resolution) so the 4th (positive-branch) call site is
        // still in range. Slice to the next top-level function declaration.
        const fnEnd = chatSrc.indexOf('function isIncomingCrossDevice', fnStart);
        const body = chatSrc.slice(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 9000);
        // The declaration line uses `chipClickAttrs = (` (with a space before
        // the paren), so `chipClickAttrs\(` only matches the 4 call sites.
        const callSites = (body.match(/chipClickAttrs\(/g) || []).length;
        expect(callSites).toBeGreaterThanOrEqual(4);
        // And the helper itself wires the onclick.
        const helperStart = chatSrc.indexOf('const chipClickAttrs = (kind, payload)');
        const helperBody = chatSrc.slice(helperStart, helperStart + 800);
        expect(helperBody).toMatch(/onclick="openRoutingChipDetail\(this\)/);
    });

    test('every emitted chip carries a JSON payload + role=button + tabindex', () => {
        expect(chatSrc).toMatch(/data-routing-meta="\$\{json\}"/);
        expect(chatSrc).toMatch(/role="button"/);
        expect(chatSrc).toMatch(/tabindex="0"/);
    });

    test('chipClickAttrs escapes the JSON payload (XSS guard)', () => {
        // JSON.stringify alone is not enough — must pass through escapeHtml.
        const fnStart = chatSrc.indexOf('const chipClickAttrs = (kind, payload)');
        expect(fnStart).toBeGreaterThan(-1);
        const body = chatSrc.slice(fnStart, fnStart + 800);
        expect(body).toMatch(/escapeHtml\(JSON\.stringify/);
    });

    test('keyboard activation (Enter / Space) opens the modal', () => {
        expect(chatSrc).toMatch(/onkeydown="[^"]*Enter[^"]*openRoutingChipDetail/);
    });
});

// ── 3. Modal DOM + handler + race protection ─────────────────────────────
describe('routingChipDetailModal + openRoutingChipDetail (chat.html)', () => {
    test('modal DOM is present with aria-modal + labelled-by title', () => {
        expect(chatSrc).toMatch(/id="routingChipDetailModal"/);
        expect(chatSrc).toMatch(/aria-modal="true"/);
        expect(chatSrc).toMatch(/aria-labelledby="routingDetailTitle"/);
    });

    test('openRoutingChipDetail + render helpers exist', () => {
        expect(chatSrc).toMatch(/async function openRoutingChipDetail\(triggerEl\)/);
        expect(chatSrc).toMatch(/function renderRoutingChipDetailBody\(/);
        expect(chatSrc).toMatch(/function renderOrgTreeHtml\(/);
    });

    test('rapid-click race protection via seq counter', () => {
        expect(chatSrc).toMatch(/__routingDetailReqSeq/);
        expect(chatSrc).toMatch(/mySeq !== __routingDetailReqSeq/);
    });

    test('ESC handler closes the modal + returns focus', () => {
        expect(chatSrc).toMatch(/__routingDetailEscBound/);
        expect(chatSrc).toMatch(/e\.key !== 'Escape'/);
        expect(chatSrc).toMatch(/closeModal\('routingChipDetailModal'\)/);
    });

    test('renderRoutingChipDetailBody passes ALL interpolations through escapeHtml', () => {
        const fnStart = chatSrc.indexOf('function renderRoutingChipDetailBody(bodyEl, payload');
        expect(fnStart).toBeGreaterThan(-1);
        const body = chatSrc.slice(fnStart, fnStart + 8000);
        // Local helper `esc` must be defined and used.
        expect(body).toMatch(/const esc = \(v\) => escapeHtml\(/);
        // No naked `${payload.` interpolation outside esc() / JSON.stringify
        // (raw payload fields are bot-controlled and must be escaped).
        const naked = body.match(/\$\{payload\.[a-zA-Z_]+\}/g) || [];
        expect(naked).toEqual([]);
    });

    test('renderOrgTreeHtml never injects unescaped entity labels', () => {
        const fnStart = chatSrc.indexOf('function renderOrgTreeHtml(hierarchy');
        expect(fnStart).toBeGreaterThan(-1);
        const body = chatSrc.slice(fnStart, fnStart + 3000);
        // Each interpolated label/role goes through esc(...)
        expect(body).toMatch(/esc\(label\)/);
        expect(body).toMatch(/esc\(role\)/);
        // Direct `${label}` (without esc) is forbidden in the recursive renderNode.
        const naked = body.match(/<span>\$\{label\}<\/span>/g) || [];
        expect(naked).toEqual([]);
    });

    test('modal request uses currentUser auth (deviceId + deviceSecret) and queries the new endpoint', () => {
        const fnStart = chatSrc.indexOf('async function openRoutingChipDetail');
        const body = chatSrc.slice(fnStart, fnStart + 3000);
        expect(body).toMatch(/currentUser\.deviceId/);
        expect(body).toMatch(/currentUser\.deviceSecret/);
        expect(body).toMatch(/\/api\/entity\/routing-detail/);
    });
});

// ── 4. i18n keys land in EN + ZH ─────────────────────────────────────────
describe('routing-detail modal i18n', () => {
    // Reading the entire i18n.js (>7M lines) once is expensive; grab only the
    // bytes around each key occurrence.
    const i18nPath = path.join(backendDir, 'public', 'shared', 'i18n.js');
    const i18nSrc = fs.readFileSync(i18nPath, 'utf8');

    const NEW_KEYS = [
        'chat_routing_chip_aria',
        'chat_routing_detail_eyebrow',
        'chat_routing_detail_title',
        'chat_routing_detail_section_route',
        'chat_routing_detail_section_org_tree',
        'chat_routing_detail_section_rule',
        'chat_routing_detail_section_chain',
        'chat_routing_detail_helpline',
        'chat_routing_rulesrc_speakto',
        'chat_routing_rulesrc_broadcast',
        'chat_routing_rulesrc_xdevice',
        'chat_routing_chain_superior',
        'chat_routing_chain_subordinates',
        'chat_routing_chain_peers',
    ];

    test.each(NEW_KEYS)('key %s exists at least twice (en + zh minimum)', (key) => {
        const occurrences = (i18nSrc.match(new RegExp(`"${key}"\\s*:`, 'g')) || []).length;
        // At least EN + ZH (zh-TW + zh-CN both count, so threshold = 3 covers
        // PR pre-flight gate "EN+ZH same PR").
        expect(occurrences).toBeGreaterThanOrEqual(3);
    });
});

// ── 5. Sender always resolves on null/degraded routing_meta ───────────────
// card_e53b09082f4d66b8125cccca — legacy null routing_meta rows rendered the
// routing-detail modal as 「Unspecified → Unspecified」/undefined on BOTH sides.
// The SENDER is always knowable from the chat row's own entity_id, so every
// chip stub must carry a sender floor (from_entity_id + resolved from_name) and
// the modal's from-pill must never degrade to the generic "Unspecified" label
// nor stringify a JS `undefined`.
describe('sender-floor resolution (chat.html) — never Unspecified/undefined on from-side', () => {
    const chipFn = (() => {
        const i = chatSrc.indexOf('function renderRoutingChip(msg)');
        const j = chatSrc.indexOf('function isIncomingCrossDevice', i);
        return chatSrc.slice(i, j > i ? j : i + 9000);
    })();
    const detailFn = (() => {
        const i = chatSrc.indexOf('function renderRoutingChipDetailBody(bodyEl, payload');
        return chatSrc.slice(i, i + 9000);
    })();

    test('renderRoutingChip computes a sender floor from msg.entity_id', () => {
        expect(chipFn).toMatch(/senderFloorId\s*=/);
        expect(chipFn).toMatch(/msg\.entity_id/);
        expect(chipFn).toMatch(/getEntityDisplayName/);
    });

    test('unconfirmed stub carries from_entity_id floor + from_name (cross-device too)', () => {
        // The unconfirmed branch must fall back to the row sender when the parsed
        // source has no fromEntityId (e.g. cross-device publicCode-only), and
        // carry from_name + from_public_code so the modal can label it.
        expect(chipFn).toMatch(/from_entity_id:\s*\(routed\.fromEntityId\s*!=\s*null\s*\?\s*routed\.fromEntityId\s*:\s*senderFloorId\)/);
        expect(chipFn).toMatch(/from_name:\s*senderFloorName/);
        expect(chipFn).toMatch(/from_public_code/);
    });

    test('degraded-client stub carries from_name', () => {
        const degraded = chipFn.split('msg.is_from_bot && msg.entity_id != null').pop() || '';
        expect(degraded).toMatch(/from_name:\s*senderFloorName/);
    });

    test('backend degraded/failed meta is floored with the row sender', () => {
        expect(chipFn).toMatch(/degradedPayload\s*=\s*Object\.assign\(\{\},\s*rm,/);
        expect(chipFn).toMatch(/from_entity_id:\s*\(rm\.from_entity_id\s*!=\s*null\s*\?\s*rm\.from_entity_id\s*:\s*senderFloorId\)/);
    });

    test('renderPill guards against a literal "undefined" fallbackName', () => {
        // card_816c435e: guard moved into the shared resolveEntityLabel helper
        // (lives above renderRoutingChipDetailBody). Both 'undefined' and the
        // '?' / '？' sentinels are rejected via the isBadName predicate.
        const resolverStart = chatSrc.indexOf('function resolveEntityLabel(');
        expect(resolverStart).toBeGreaterThan(-1);
        const resolver = chatSrc.slice(resolverStart, resolverStart + 4000);
        expect(resolver).toMatch(/s\s*===\s*'undefined'/);
        expect(resolver).toMatch(/isBadName/);
    });

    test('from-pill uses a sender-specific neutral label, not the shared Unspecified', () => {
        // The from-side must land on chat_routing_sender, never chat_routing_unspecified.
        // card_816c435e: neutral selection moved into resolveEntityLabel.
        const resolverStart = chatSrc.indexOf('function resolveEntityLabel(');
        const resolver = chatSrc.slice(resolverStart, resolverStart + 4000);
        expect(resolver).toMatch(/which\s*===\s*'from'/);
        expect(resolver).toMatch(/chat_routing_sender/);
    });

    test('renderPill accepts a publicCode fallback and both call sites pass it', () => {
        // card_816c435e: renderPill grew an `isUser` 6th arg so the to_is_user
        // flag flows through the shared resolver instead of being inlined as a
        // tt('chat_routing_to_user',...) label at the call site.
        expect(detailFn).toMatch(/renderPill\s*=\s*\(which,\s*sum,\s*fallbackId,\s*fallbackName,\s*fallbackCode,\s*isUser\)/);
        expect(detailFn).toMatch(/renderPill\('from',\s*fromSum,\s*payload\.from_entity_id,\s*payload\.from_name,\s*payload\.from_public_code,\s*false\)/);
        expect(detailFn).toMatch(/renderPill\('to',\s*toSum,[\s\S]*?payload\.to_public_code,\s*!!payload\.to_is_user\)/);
    });

    test('chat_routing_sender key ships in EN + ZH (>=3 locales)', () => {
        const i18nPath = path.join(backendDir, 'public', 'shared', 'i18n.js');
        const i18nSrc = fs.readFileSync(i18nPath, 'utf8');
        const occurrences = (i18nSrc.match(/"chat_routing_sender"\s*:/g) || []).length;
        expect(occurrences).toBeGreaterThanOrEqual(3);
    });
});
