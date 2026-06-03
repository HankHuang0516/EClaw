/**
 * Tests for backend/public/shared/diff-format.js — the unified-diff +
 * semantic-patch-JSON producer fed by the hover-click toolbar.
 *
 * Spec: docs/specs/a-hover-click-dom-interaction.md §6
 * Card: card_af967715a0ab1724da98dcc2 (Test/P2)
 *
 * Two-layer coverage:
 *   1) Behaviour — load the module into a fake-window context and
 *      exercise the produce() / isSendToAgentBlocked() public surface.
 *   2) Static invariants — regex-lock the synthetic-path constraint
 *      (#6 review §6.1.1) and the disqualifier ↔ opener layering so a
 *      future edit can't silently regress the safe defaults.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DIFF_FORMAT_PATH = path.join(
    __dirname, '..', '..', 'public', 'shared', 'diff-format.js'
);

function loadDiffFormat() {
    // The IIFE attaches to `window` if present; provide a fake one and
    // require fresh each time so tests stay isolated.
    const fakeWindow = {};
    global.window = fakeWindow;
    delete require.cache[require.resolve(DIFF_FORMAT_PATH)];
    require(DIFF_FORMAT_PATH);
    return fakeWindow.EClawDiffFormat;
}

function fakeNode(tagName, opts = {}) {
    return {
        nodeType: 1,
        tagName: tagName.toUpperCase(),
        id: opts.id || '',
        className: opts.className || '',
    };
}

describe('diff-format — behaviour', () => {
    const F = loadDiffFormat();

    test('produces unified + semantic + summary for a style change', () => {
        const target = fakeNode('button', { id: 'filterToggle', className: 'btn btn-primary' });
        const result = F.produce(
            [{ type: 'style', target, property: 'color', from: null, to: 'rebeccapurple' }],
            { kind: 'url', url: 'https://eclawbot.com/portal/chat.html' },
        );
        expect(result.semantic.changes).toHaveLength(1);
        expect(result.semantic.changes[0]).toMatchObject({
            selector: 'button#filterToggle',
            property: 'style.color',
            from: null,
            to: 'rebeccapurple',
        });
        expect(result.unified).toContain('--- a/https://eclawbot.com/portal/chat.html');
        expect(result.unified).toContain('+++ b/https://eclawbot.com/portal/chat.html');
        expect(result.unified).toContain('rebeccapurple');
        expect(result.summary).toMatch(/1 change.*button#filterToggle/);
        expect(result.syntheticPath).toBe(false);
    });

    test('produces multi-hunk unified diff for move + style + delete sequence', () => {
        const a = fakeNode('div', { id: 'card-a' });
        const b = fakeNode('span', { className: 'note' });
        const c = fakeNode('p');
        const result = F.produce(
            [
                { type: 'geometry', target: a, from: { x: 0, y: 0 }, to: { x: 200, y: 0 } },
                { type: 'style', target: b, property: 'color', from: '#000', to: '#fff' },
                { type: 'remove', target: c, parent: null, beforeSibling: null },
            ],
            { kind: 'url', url: 'https://eclawbot.com/portal/chat.html' },
        );
        // One hunk separator per mutation
        const hunkCount = result.unified.split(/^@@/m).length - 1;
        expect(hunkCount).toBe(3);
        expect(result.semantic.changes).toHaveLength(3);
        expect(result.summary).toMatch(/3 change/);
    });

    test('synthetic-path flagged when sourceContext lacks a real url', () => {
        const target = fakeNode('div');
        const result = F.produce(
            [{ type: 'style', target, property: 'color', from: null, to: 'red' }],
            { kind: 'portal' }, // no url
        );
        expect(result.syntheticPath).toBe(true);
    });

    test('synthetic-path flagged for explicit <synthetic:user-edit-...> source', () => {
        const target = fakeNode('div');
        const result = F.produce(
            [{ type: 'style', target, property: 'color', from: null, to: 'red' }],
            { kind: 'url', url: '<synthetic:user-edit-now>' },
        );
        expect(result.syntheticPath).toBe(true);
    });

    test('isSendToAgentBlocked enforces synthetic-path gate per spec §6.1.1', () => {
        // Synthetic path + no semantic-only opt-in → blocked
        const draftResult = F.produce(
            [{ type: 'style', target: fakeNode('p'), property: 'color', from: null, to: 'red' }],
            { kind: 'portal' },
        );
        const blocked = F.isSendToAgentBlocked(draftResult);
        expect(blocked.blocked).toBe(true);
        expect(blocked.reason).toMatch(/synthetic-path-requires-real-source-or-semantic-only-opt-in/);

        // Synthetic path + semantic-only opt-in → unblocked
        const optedIn = F.isSendToAgentBlocked(draftResult, { semanticOnly: true });
        expect(optedIn.blocked).toBe(false);

        // Real source path → unblocked
        const realResult = F.produce(
            [{ type: 'style', target: fakeNode('p'), property: 'color', from: null, to: 'red' }],
            { kind: 'url', url: 'https://eclawbot.com/portal/chat.html' },
        );
        const realUnblocked = F.isSendToAgentBlocked(realResult);
        expect(realUnblocked.blocked).toBe(false);

        // No diff at all → blocked
        const nullBlocked = F.isSendToAgentBlocked(null);
        expect(nullBlocked.blocked).toBe(true);
        expect(nullBlocked.reason).toBe('no-diff');
    });

    test('semantic JSON shape stable across runs (deterministic except patchId)', () => {
        const target = fakeNode('button', { id: 'filterToggle' });
        const a = F.produce(
            [{ type: 'style', target, property: 'color', from: null, to: 'red' }],
            { kind: 'url', url: 'https://eclawbot.com/portal/chat.html' },
        );
        const b = F.produce(
            [{ type: 'style', target, property: 'color', from: null, to: 'red' }],
            { kind: 'url', url: 'https://eclawbot.com/portal/chat.html' },
        );
        // Only patchId may differ; everything else stable.
        const stripId = (r) => ({ ...r.semantic, patchId: '<STRIPPED>' });
        expect(stripId(a)).toEqual(stripId(b));
        expect(a.unified).toEqual(b.unified);
    });

    test('describeSelector covers id / class / tag-only forms', () => {
        expect(F.describeSelector(fakeNode('button', { id: 'go' }))).toBe('button#go');
        expect(F.describeSelector(fakeNode('div', { className: 'a b c' }))).toBe('div.a.b');
        expect(F.describeSelector(fakeNode('p'))).toBe('p');
        expect(F.describeSelector(null)).toBe('*');
    });

    test('summary truncates beyond 3 selectors with +N more', () => {
        const muts = ['a', 'b', 'c', 'd', 'e'].map((sel) => ({
            type: 'style',
            target: fakeNode('div', { id: sel }),
            property: 'color', from: null, to: 'red',
        }));
        const r = F.produce(muts, { kind: 'url', url: 'https://eclawbot.com/' });
        expect(r.summary).toMatch(/\+2 more/);
    });
});

describe('diff-format — static invariants', () => {
    const src = fs.readFileSync(DIFF_FORMAT_PATH, 'utf8');

    test('isSyntheticPath regex matches the spec §6.1.1 placeholder format', () => {
        expect(src).toMatch(
            /^\s*function\s+isSyntheticPath\(path\)\s*\{[\s\S]*?\/\^<synthetic:user-edit-/m
        );
    });

    test('isSendToAgentBlocked enforces the semantic-only opt-in gate', () => {
        // The gate must require BOTH syntheticPath AND !semanticOnly to block.
        expect(src).toMatch(
            /diffResult\.syntheticPath\s*&&\s*!\(opts\s*&&\s*opts\.semanticOnly\)/
        );
    });

    test('exports include the four canonical functions', () => {
        expect(src).toMatch(/produce\s*,/);
        expect(src).toMatch(/isSendToAgentBlocked/);
        expect(src).toMatch(/describeSelector/);
        expect(src).toMatch(/summaryLine/);
    });
});
