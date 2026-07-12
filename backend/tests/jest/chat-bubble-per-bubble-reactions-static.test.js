'use strict';

/**
 * Regression: chat.html per-bubble 👍/👎 must survive adjacent-merge
 * (Hank 2026-07-12: 「聊天頁面的每一個聊天泡泡的按讚/倒讚 UX 都要出現
 * 不能因為被 merge 後不見」).
 *
 * Root cause was a lone CSS rule `.chat-msg.grouped .chat-reactions
 * { display: none }` that collapsed the reaction row on every bubble
 * after the first of a merged run. Reactions were already rendered
 * per-message in the DOM (each bubble has its own `chat-reactions` div
 * with a stable `data-msg-id`) — the CSS was the hide.
 *
 * Static asserts over public/portal/chat.html, matching the style used
 * by chat-image-attachment-thumbnail.test.js and other portal HTML tests.
 * Runtime behaviour is covered by the reaction endpoint tests + a manual
 * Playwright pass before enabling on prod.
 */

const fs = require('fs');
const path = require('path');

const CHAT_HTML = path.join(__dirname, '../../public/portal/chat.html');

describe('chat.html per-bubble reactions survive adjacent-merge', () => {
    let html;
    beforeAll(() => { html = fs.readFileSync(CHAT_HTML, 'utf8'); });

    test('the display:none collapse rule on .chat-msg.grouped .chat-reactions is GONE', () => {
        // Old bug: this exact declaration hid feedback on every merged sibling.
        const badRule = /\.chat-msg\.grouped\s+\.chat-reactions\s*\{\s*display\s*:\s*none\s*;?\s*\}/;
        expect(html).not.toMatch(badRule);
    });

    test('grouped-bubble reactions have a softer styling but stay visible', () => {
        // New rule: opacity 0.75 + tighter margin — visible, calmer, hover restores.
        expect(html).toMatch(/\.chat-msg\.grouped\s+\.chat-reactions\s*\{[^}]*opacity\s*:\s*0\.75/);
        expect(html).toMatch(/\.chat-msg\.grouped\s+\.chat-reactions\s*\{[^}]*margin-top\s*:\s*1px/);
    });

    test('hover / focus-within lifts opacity back to 1', () => {
        expect(html).toMatch(/\.chat-msg\.grouped\s+\.chat-reactions:hover[\s\S]*opacity\s*:\s*1/);
    });

    test('per-bubble reactions row still renders on every bot bubble', () => {
        // The per-message render block was never broken — just visually collapsed.
        // Assert the reactions container is still there and the buttons carry a
        // stable data-msg-id so the click handler targets the specific bubble
        // the user reacted to (not just the last of a merged run).
        expect(html).toContain('<div class="chat-reactions">');
        expect(html).toMatch(/<button class="btn-reaction[^"]*"\s+data-msg-id="\$\{msg\.id\}"/);
    });

    test('other .chat-msg.grouped collapse rules (source / meta) are untouched', () => {
        // Guard: I only removed the reactions collapse. If someone later removes
        // .chat-source or .chat-meta hides on grouped rows, the merge UX
        // regresses in the opposite direction (avatar/name/time repeats).
        expect(html).toMatch(/\.chat-msg\.grouped\s+\.chat-source\s*\{\s*display\s*:\s*none/);
        expect(html).toMatch(/\.chat-msg\.grouped\s+\.chat-meta\s*\{\s*display\s*:\s*none/);
    });
});
