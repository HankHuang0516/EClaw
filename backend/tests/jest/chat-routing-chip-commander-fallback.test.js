/**
 * Regression — card_29eed229d389e53bfae7d954.
 *
 * Routing chip used to render the literal text "-> ?" whenever
 * routing_meta lacked to_entity_id (Hank screenshot:
 * https://live.staticflickr.com/65535/55333736185_78ac26b013_b.jpg).
 *
 * Spec from the card's Acceptance section:
 *   1. to_entity_id null AND org-chart commander known →
 *      use commander as the fallback target (must be read live from
 *      /api/device/org-chart; never hardcoded to #2).
 *   2. to_entity_id null AND no commander → hide the entire chip.
 *   3. '?' must NEVER appear as a fallback label.
 *   4. Same treatment for unknown from + unknown LV.
 *
 * Static surface lock (same pattern as chat-routing-chip.test.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const chatHtml = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'chat.html'),
    'utf8'
);

// Pull renderRoutingChip body once — bounded by the next `\n        }` line,
// matching the file's 8-space indent convention.
const chipFn = chatHtml.match(/function\s+renderRoutingChip\s*\(\s*msg\s*\)\s*\{[\s\S]*?\n        \}/);
const chipBody = chipFn ? chipFn[0] : '';

// The positive-branch invariants below are scoped to the post-"// Positive:"
// tail. (card_ecda7243 later extended the no-bare-'?' rule to the degraded
// fallback branch too — that is locked in routing-meta-card-1f8.test.js.)
const positiveBranch = chipBody.split('// Positive:').pop() || '';

describe('routing chip — commander fallback (card_29eed229d389e53bfae7d954)', () => {
    test('renderRoutingChip body parsed', () => {
        expect(chipFn).not.toBeNull();
    });

    test('resolves the to-side floor via the sender\'s real superior (card_a0485399, not #USER[0])', () => {
        // The positive branch floors an unknown to-side to degradedTargetFor(sender)
        // — the sender's real org-chart superior — never a blanket #USER[0] commander.
        expect(positiveBranch).toMatch(/degradedTargetFor/);
    });

    test('hides chip entirely when both sides remain unknown', () => {
        // After the commander fallback resolves to null, the chip must bail.
        expect(positiveBranch).toMatch(/if\s*\(\s*!from\s*\|\|\s*!to\s*\)\s*return\s*''\s*;/);
    });

    test('no more literal "?" fallback on the from/to labels (positive branch)', () => {
        // Old code: `: '?'` after entity_id check. New code: `: fallback`.
        expect(positiveBranch).not.toMatch(/from_entity_id\s*:\s*'\?'/);
        expect(positiveBranch).not.toMatch(/to_entity_id\s*:\s*'\?'/);
        // And the inner rc-route span must not splice a hardcoded ?.
        expect(positiveBranch).not.toMatch(/→\s*\?/);
    });

    test('LV badge is rendered only when to_lv is finite — no "LV?"', () => {
        // lvNum is computed once, then gated by Number.isFinite — no double parse.
        expect(positiveBranch).toMatch(/const\s+lvNum\s*=\s*Number\(rm\.to_lv\)\s*;/);
        expect(positiveBranch).toMatch(/const\s+hasLv\s*=\s*Number\.isFinite\(lvNum\)\s*;/);
        // The badge is emitted via a conditional that resolves to '' when NaN.
        expect(positiveBranch).toMatch(/hasLv\s*\?\s*`<span class="rc-lv">LV\$\{lvNum\}<\/span>`\s*:\s*''/);
        // And no remaining `LV?` string literal anywhere in the positive branch.
        expect(positiveBranch).not.toMatch(/LV\?/);
    });

    test('still satisfies the v1 spec — pulls from/to/lv straight off routing_meta', () => {
        expect(chipBody).toMatch(/rm\.from_name/);
        expect(chipBody).toMatch(/rm\.to_name/);
        expect(chipBody).toMatch(/rm\.to_lv/);
        // chat-routing-chip.test.js invariant: must not derive from local trees.
        expect(chipBody).not.toMatch(/boundEntities|getSuperior|hierarchy/);
    });
});

describe('org-chart commander loader (cache source of truth)', () => {
    test('module-level cache is declared and starts null', () => {
        expect(chatHtml).toMatch(/let\s+orgChartCommanderId\s*=\s*null\s*;/);
    });

    test('loadOrgChartCommander reads /api/device/org-chart (not a hardcoded id)', () => {
        const loader = chatHtml.match(/async\s+function\s+loadOrgChartCommander\s*\([^)]*\)\s*\{[\s\S]*?\n        \}/);
        expect(loader).not.toBeNull();
        const body = loader[0];
        expect(body).toMatch(/\/api\/device\/org-chart/);
        // Caches the full hierarchy (card_a0485399) for per-entity superior
        // resolution, and still derives the legacy commander (first under USER).
        expect(body).toMatch(/data\?\.orgChart\?\.hierarchy/);
        expect(body).toMatch(/orgChartHierarchy\?\.USER/);
        expect(body).toMatch(/orgChartCommanderId\s*=\s*top/);
    });

    test('init wires the loader after loadBoundEntities', () => {
        // The loader must actually be called during chat boot — otherwise the
        // fallback is dead code and the chip silently hides forever.
        expect(chatHtml).toMatch(/await\s+loadBoundEntities\(\)\s*;\s*\n[\s\S]{0,200}loadOrgChartCommander\(\)/);
    });
});
