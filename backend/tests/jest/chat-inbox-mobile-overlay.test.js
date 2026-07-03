/**
 * Static invariant — 需要你 inbox must be reliably scrollable on phones.
 *
 * Bug (owner-reported, repeated): on mobile the inbox lived inside
 * .chat-messages-wrapper{overflow:hidden} as a tiny 38vh nested-scroll box; the
 * owner physically could not scroll it to see all items. A real-touch swipe test
 * (CDP Input.dispatchTouchEvent) confirmed the body itself CAN scroll, but the
 * nested tiny window trapped in an overflow:hidden ancestor is unusable on real
 * devices.
 *
 * Fix: when OPEN on a phone (max-width:640px), the inbox becomes a position:fixed
 * full-height overlay (escapes the clipping wrapper) and its body flex-fills with
 * overflow-y:auto → large, reliable scroll area; every item reachable. Collapsed
 * state keeps the compact 38vh; desktop unchanged.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const chatHtml = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'chat.html'),
    'utf8'
);

// Isolate the mobile (max-width:640px) media block that styles the open inbox.
const mq = chatHtml.match(/@media \(max-width: 640px\) \{[\s\S]*?\.action-request-inbox\.is-open[\s\S]*?\n\s{8}\}/);

describe('需要你 inbox — mobile open state is a scrollable fixed overlay', () => {
    test('open inbox on phones is position:fixed (escapes the overflow:hidden wrapper)', () => {
        expect(mq).not.toBeNull();
        const css = mq[0];
        expect(css).toMatch(/\.action-request-inbox\.is-open\s*\{[^}]*position:\s*fixed/);
        // full-height overlay: pinned top and bottom
        expect(css).toMatch(/\.action-request-inbox\.is-open\s*\{[^}]*top:\s*\d/);
        expect(css).toMatch(/\.action-request-inbox\.is-open\s*\{[^}]*bottom:\s*\d/);
    });

    test('open inbox body flex-fills and scrolls (max-height:none + flex + overflow-y:auto)', () => {
        const css = mq[0];
        expect(css).toMatch(/\.action-request-inbox\.is-open\s*\.action-request-inbox-body\s*\{[^}]*max-height:\s*none/);
        expect(css).toMatch(/\.action-request-inbox\.is-open\s*\.action-request-inbox-body\s*\{[^}]*overflow-y:\s*auto/);
        expect(css).toMatch(/\.action-request-inbox\.is-open\s*\.action-request-inbox-body\s*\{[^}]*flex:\s*1/);
    });

    test('collapsed inbox keeps the compact height (does not blanket-apply the overlay)', () => {
        // The 38vh cap must now be scoped to the NON-open state, not all bodies.
        expect(chatHtml).toMatch(/\.action-request-inbox:not\(\.is-open\)\s*\.action-request-inbox-body\s*\{[^}]*max-height:\s*38vh/);
    });
});
