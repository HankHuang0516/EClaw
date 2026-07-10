/**
 * Opt1 up-forward default-on + routing-chip #10 fix
 *   - card_d199b41c (owner-ratified 2026-07-10): org-chart hierarchy should DRIVE
 *     up-report routing — up-forward defaults ON when a hierarchy is configured,
 *     WITHOUT overriding an explicit taskForward-only choice.
 *   - card_a0485399 (Hank screenshot 2026-07-10): chat routing labels all pointed
 *     to #10 because the client floored EVERY degraded chip's target to
 *     hierarchy.USER[0] (the first entity under USER). The fix resolves each
 *     message's REAL superior via getSuperior(); the backend Opt1 change also
 *     stamps a proper org_upward routing_meta so rows are not degraded at all.
 *
 * RED on origin/main:
 *   - orgChart.effectiveAllForward is undefined → the behavior assertions throw.
 *   - chat.html has no `degradedTargetFor` / `orgSuperiorOf`; the degraded chip
 *     still floors the target to orgChartCommanderId (#USER[0]).
 * GREEN with the fix: all pass.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const orgChart = require('../../org-chart');

// Hank's real device hierarchy from the bug report / routing-detail:
//   #2 → #6, #3/#5/#1/#4 → #2, #6 → USER, #10 → USER.
const HANK_HIERARCHY = { 2: [3, 5, 1, 4], 6: [2], USER: [10, 6] };

describe('org-chart getSuperior resolves Hank\'s hierarchy correctly (the #10 bug\'s ground truth)', () => {
    it('#2 reports to #6 (not #10)', () => {
        expect(orgChart.getSuperior(HANK_HIERARCHY, 2)).toBe(6);
    });
    it('#3 reports to #2 (not #10)', () => {
        expect(orgChart.getSuperior(HANK_HIERARCHY, 3)).toBe(2);
    });
    it('#5/#1/#4 report to #2', () => {
        expect(orgChart.getSuperior(HANK_HIERARCHY, 5)).toBe(2);
        expect(orgChart.getSuperior(HANK_HIERARCHY, 1)).toBe(2);
        expect(orgChart.getSuperior(HANK_HIERARCHY, 4)).toBe(2);
    });
    it('#6 and #10 report to USER (top-level → "User", never #10)', () => {
        expect(orgChart.getSuperior(HANK_HIERARCHY, 6)).toBe('USER');
        expect(orgChart.getSuperior(HANK_HIERARCHY, 10)).toBe('USER');
    });
});

describe('isHierarchyConfigured()', () => {
    it('true when a USER root has at least one report', () => {
        expect(orgChart.isHierarchyConfigured(HANK_HIERARCHY)).toBe(true);
        expect(orgChart.isHierarchyConfigured({ USER: [6] })).toBe(true);
    });
    it('false for empty / no-USER / empty-USER hierarchies', () => {
        expect(orgChart.isHierarchyConfigured({})).toBe(false);
        expect(orgChart.isHierarchyConfigured({ USER: [] })).toBe(false);
        expect(orgChart.isHierarchyConfigured(null)).toBe(false);
        expect(orgChart.isHierarchyConfigured({ 2: [3] })).toBe(false); // no USER root
    });
});

describe('effectiveAllForward() — Opt1 default-on (card_d199b41c)', () => {
    it('default-ON when a hierarchy is configured and NO forward mode chosen (the fix)', () => {
        expect(orgChart.effectiveAllForward(HANK_HIERARCHY, { allForward: false, taskForward: false })).toBe(true);
        expect(orgChart.effectiveAllForward(HANK_HIERARCHY, {})).toBe(true);
        expect(orgChart.effectiveAllForward(HANK_HIERARCHY, null)).toBe(true);
    });
    it('OFF when both options off AND no hierarchy configured (dormant / commander-fallback path unchanged)', () => {
        expect(orgChart.effectiveAllForward({}, { allForward: false, taskForward: false })).toBe(false);
        expect(orgChart.effectiveAllForward({ USER: [] }, {})).toBe(false);
        expect(orgChart.effectiveAllForward(null, {})).toBe(false);
    });
    it('respects an EXPLICIT taskForward-only choice (returns false so caller keeps task-gated path)', () => {
        expect(orgChart.effectiveAllForward(HANK_HIERARCHY, { allForward: false, taskForward: true })).toBe(false);
    });
    it('explicit allForward stays true regardless of hierarchy', () => {
        expect(orgChart.effectiveAllForward(HANK_HIERARCHY, { allForward: true })).toBe(true);
        expect(orgChart.effectiveAllForward({}, { allForward: true })).toBe(true);
        // allForward wins even if taskForward is also set
        expect(orgChart.effectiveAllForward(HANK_HIERARCHY, { allForward: true, taskForward: true })).toBe(true);
    });
});

describe('chat.html routing-chip #10 fix (card_a0485399) — static contract', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', '..', 'public', 'portal', 'chat.html'),
        'utf8'
    );

    it('caches the full hierarchy and defines per-entity superior resolvers', () => {
        expect(src).toContain('let orgChartHierarchy = null;');
        expect(src).toMatch(/function orgSuperiorOf\(/);
        expect(src).toMatch(/function degradedTargetFor\(/);
    });

    it('the degraded client-derived chip targets the sender\'s real superior, NOT #USER[0]', () => {
        // The fixed degraded branch uses degradedTargetFor(...) → tgt.toId.
        expect(src).toContain('const tgt = degradedTargetFor(msg.entity_id);');
        expect(src).toContain('to_entity_id: tgt.toId');
        // The old bug — flooring the degraded target to orgChartCommanderId — is gone.
        expect(src).not.toMatch(/to_entity_id:\s*\(orgChartCommanderId != null/);
    });

    it('no routing target is floored to a blanket #USER[0] via a commander "fallback" const', () => {
        // The positive-branch `const fallback = ... orgChartCommanderId ...` that
        // painted the to-side with #USER[0] is removed in favor of per-entity floors.
        expect(src).not.toMatch(/const fallback = \(orgChartCommanderId != null\)/);
    });
});
