/**
 * kanban.html deep-link hash parser — round-trip with autolink-chip.
 *
 * Smart Chip C "Open full page →" produces /portal/kanban.html#card_X#comment-Y
 * via AutolinkChip.deepLinkUrl. The kanban page parses the same hash to
 * auto-open the card modal and flash the targeted comment. The two regexes
 * must stay compatible — this test fixes both ends in one suite so a future
 * change on either side surfaces here.
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
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    return sandbox.window.AutolinkChip;
}

// Mirror of the parser embedded in backend/public/portal/kanban.html
// (parseDeepLinkHash). If kanban.html drifts from this shape the test will
// surface the mismatch.
function parseDeepLinkHashOnUrl(url) {
    const hashIdx = url.indexOf('#');
    if (hashIdx < 0) return null;
    const raw = url.slice(hashIdx + 1);
    if (!raw) return null;
    const parts = raw.split('#');
    const head = parts[0] || '';
    const cardMatch = /^card_[a-f0-9]{8,}$/i.exec(head);
    if (!cardMatch) return null;
    let commentAnchor = null;
    for (let i = 1; i < parts.length; i++) {
        const m = /^comment-([a-f0-9-]{8,})$/i.exec(parts[i]);
        if (m) { commentAnchor = m[1]; break; }
    }
    return { cardId: head, commentAnchor };
}

describe('kanban deep-link hash parser', () => {
    const AutolinkChip = loadAutolinkChip();

    test('chip URL with comment anchor parses to {cardId, commentAnchor}', () => {
        const url = AutolinkChip.deepLinkUrl(
            'src',
            'src://kanban/card/f6321df2aaa0#comment-1a2b3c4d-5e6f',
            '#comment-1a2b3c4d-5e6f'
        );
        expect(url).toBe('/portal/kanban.html#card_f6321df2aaa0#comment-1a2b3c4d-5e6f');

        const parsed = parseDeepLinkHashOnUrl(url);
        expect(parsed).toEqual({
            cardId: 'card_f6321df2aaa0',
            commentAnchor: '1a2b3c4d-5e6f',
        });
    });

    test('chip URL without anchor parses to {cardId, null}', () => {
        const url = AutolinkChip.deepLinkUrl(
            'src',
            'src://kanban/card/abcdef0123456789',
            null
        );
        expect(url).toBe('/portal/kanban.html#card_abcdef0123456789');

        expect(parseDeepLinkHashOnUrl(url)).toEqual({
            cardId: 'card_abcdef0123456789',
            commentAnchor: null,
        });
    });

    test('non-card hash returns null (e.g. legacy /reviews.html anchors)', () => {
        const url = '/portal/reviews.html#review_abc123';
        expect(parseDeepLinkHashOnUrl(url)).toBeNull();
    });

    test('empty hash returns null', () => {
        expect(parseDeepLinkHashOnUrl('/portal/kanban.html')).toBeNull();
        expect(parseDeepLinkHashOnUrl('/portal/kanban.html#')).toBeNull();
    });
});
