/**
 * Static invariant — 需要你 (action-request) inbox must scroll tall items.
 *
 * Bug: the inbox body is `display:flex; flex-direction:column; max-height:…;
 * overflow-y:auto`. Its `.action-request-item` children had the default
 * `flex-shrink:1`, so a TALL item (a decision with a long prompt + options +
 * reply previews) was COMPRESSED to fit the body, then `overflow:hidden`
 * clipped its lower content. Because the compressed item no longer overflowed
 * the body, the body never showed a scrollbar → the owner could not scroll the
 * inbox to read the item ("無法在需要你收件夾內往上滑動… 看不到下面的字").
 *
 * Fix: `.action-request-item { flex-shrink: 0 }` keeps each item at its natural
 * height, so the body overflows and scrolls (verified live on prod: item grew
 * 248→552px, body scrollHeight 321→625 > clientHeight 321 = scrollable).
 *
 * node testEnv → assert the CSS rules statically (same style as the sibling
 * chat-action-request-*.test.js files).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const chatHtml = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'chat.html'),
    'utf8'
);

// Isolate the `.action-request-item { … }` rule block (the first bare-selector
// rule, not the `.action-request-item.in-consensus` / `> *` variants).
function ruleBlock(selector) {
    const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}');
    const m = chatHtml.match(re);
    return m ? m[1] : null;
}

describe('需要你 inbox — tall items keep natural height so the body scrolls', () => {
    test('.action-request-item does not shrink (flex-shrink: 0)', () => {
        const block = ruleBlock('.action-request-item');
        expect(block).not.toBeNull();
        expect(block).toMatch(/flex-shrink:\s*0/);
    });

    test('.action-request-item still clamps horizontally (overflow:hidden + max-width) — fix did not regress the x-axis guard', () => {
        const block = ruleBlock('.action-request-item');
        expect(block).toMatch(/overflow:\s*hidden/);
        expect(block).toMatch(/max-width:\s*100%/);
    });

    test('the inbox body is the scroll container (overflow-y:auto + a max-height)', () => {
        const block = ruleBlock('.action-request-inbox-body');
        expect(block).not.toBeNull();
        expect(block).toMatch(/overflow-y:\s*auto/);
        expect(block).toMatch(/max-height:/);
    });
});
