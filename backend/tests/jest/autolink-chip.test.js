/**
 * AutolinkChip unit tests — verifies review_ and src:// prefix detection in
 * already-escaped HTML produces 引用晶片 (autolink-chip) spans.
 *
 * Loads the browser module into a stubbed global so we can exercise its
 * public API (render / onChipClick / deepLinkUrl) without a DOM.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadAutolinkChip() {
    const src = fs.readFileSync(
        path.join(__dirname, '../../public/portal/shared/autolink-chip.js'),
        'utf8'
    );
    const sandbox = { window: {}, global: {} };
    sandbox.window.AutolinkChipPreview = undefined;
    // The module IIFE uses `(function(global){...})(window)` — point global at sandbox.window
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return sandbox.window.AutolinkChip;
}

describe('AutolinkChip.render', () => {
    const AutolinkChip = loadAutolinkChip();

    test('review_ prefix becomes an autolink-chip--review span', () => {
        const out = AutolinkChip.render('See review_abc123456 for details');
        expect(out).toMatch(/<span class="autolink-chip autolink-chip--review"/);
        expect(out).toMatch(/data-ref-type="review"/);
        expect(out).toMatch(/data-ref-id="review_abc123456"/);
    });

    test('src:// token becomes an autolink-chip--src span with anchor attr', () => {
        const out = AutolinkChip.render(
            'see src://kanban/card/f6321df2aaa0#comment-xyz plz'
        );
        expect(out).toMatch(/autolink-chip--src/);
        expect(out).toMatch(/data-ref-id="src:\/\/kanban\/card\/f6321df2aaa0#comment-xyz"/);
        expect(out).toMatch(/data-ref-anchor="#comment-xyz"/);
    });

    test('card_ prefix is NOT handled (EntityLinkRender owns it)', () => {
        const out = AutolinkChip.render('touching card_f6321df2 today');
        expect(out).not.toMatch(/autolink-chip--card/);
        // bare text preserved so EntityLinkRender can act on it upstream
        expect(out).toMatch(/card_f6321df2/);
    });

    test('<code>review_xxx</code> is consumed into chip (code wrapper stripped)', () => {
        const out = AutolinkChip.render('done <code>review_hotfix_apr25</code> ok');
        expect(out).toMatch(/autolink-chip--review/);
        // The <code> wrapper should be gone
        expect(out).not.toMatch(/<code>review_hotfix/);
    });

    test('tokens inside <code>/<pre> blocks are preserved as literal text', () => {
        const out = AutolinkChip.render(
            'example: <code>SOURCE: src://kanban/card/abcdef12</code>'
        );
        // The src:// inside code must NOT be chipped
        expect(out).toMatch(/<code>SOURCE: src:\/\/kanban\/card\/abcdef12<\/code>/);
        expect(out).not.toMatch(/autolink-chip--src/);
    });

    test('existing entity-link spans are not double-wrapped', () => {
        // Simulate output after EntityLinkRender has already acted on card_xxx
        const upstream =
            'link <span class="entity-link entity-link-card" data-entity-id="card_f6321df2">card_f6321df2</span> and review_abc12345';
        const out = AutolinkChip.render(upstream);
        // Only the review_ should become a chip; the card span stays intact
        expect(out).toMatch(/<span class="entity-link entity-link-card"[^>]*>card_f6321df2<\/span>/);
        expect(out).toMatch(/autolink-chip--review/);
    });

    test('empty / non-string input passes through', () => {
        expect(AutolinkChip.render('')).toBe('');
        expect(AutolinkChip.render(null)).toBeNull();
        expect(AutolinkChip.render(undefined)).toBeUndefined();
    });

    test('shortLabel truncates long src:// ids', () => {
        const out = AutolinkChip.render('src://kanban/card/d3cdda1455152e3caee8d4ac#comment-alpha');
        expect(out).toMatch(/src:\/\/kanban\/card_d3cd…/);
    });
});

describe('AutolinkChip.deepLinkUrl', () => {
    const AutolinkChip = loadAutolinkChip();

    test('review_ → /portal/reviews.html#<id>', () => {
        expect(AutolinkChip.deepLinkUrl('review', 'review_abc12345', null))
            .toBe('/portal/reviews.html#review_abc12345');
    });

    test('src://kanban/card/<id>#anchor → /portal/kanban.html#card_<id>#anchor', () => {
        const url = AutolinkChip.deepLinkUrl(
            'src',
            'src://kanban/card/f6321df2aaa0#comment-xyz',
            '#comment-xyz'
        );
        expect(url).toBe('/portal/kanban.html#card_f6321df2aaa0#comment-xyz');
    });

    test('unknown ref type returns null', () => {
        expect(AutolinkChip.deepLinkUrl('wat', 'anything', null)).toBeNull();
    });
});
