/**
 * Chat bubble long-press focus/select mode — static-analysis tests.
 *
 * Long-press on a chat bubble usually opens a ctx menu with Reply / Find
 * related. Users complained the popover covered the bubble and blocked
 * text selection. A third "Focus bubble" action is added that raises the
 * bubble above a backdrop with user-select:text so the OS selection
 * handles work. These tests lock in the markup + CSS + wiring so a
 * future refactor doesn't silently regress copyability.
 */
const fs = require('fs');
const path = require('path');

const CHAT_HTML = fs.readFileSync(
    path.join(__dirname, '../../public/portal/chat.html'),
    'utf8'
);
const I18N_JS = fs.readFileSync(
    path.join(__dirname, '../../public/shared/i18n.js'),
    'utf8'
);

describe('chat-bubble focus mode — DOM', () => {
    test('ctx menu has a data-action="focus" button', () => {
        expect(CHAT_HTML).toMatch(/data-action="focus"/);
        expect(CHAT_HTML).toMatch(/data-i18n="chat_focus_btn"/);
    });

    test('reply and related actions are still present', () => {
        expect(CHAT_HTML).toMatch(/data-action="reply"/);
        expect(CHAT_HTML).toMatch(/data-action="related"/);
    });
});

describe('chat-bubble focus mode — CSS', () => {
    test('defines .chat-bubble-focused with user-select:text', () => {
        const rule = CHAT_HTML.match(/\.chat-bubble\.chat-bubble-focused\s*\{[\s\S]*?\}/);
        expect(rule).not.toBeNull();
        expect(rule[0]).toMatch(/user-select\s*:\s*text/);
        expect(rule[0]).toMatch(/-webkit-user-select\s*:\s*text/);
    });

    test('defines a backdrop that covers the viewport', () => {
        expect(CHAT_HTML).toMatch(/\.chat-focus-backdrop\s*\{[\s\S]*?position\s*:\s*fixed[\s\S]*?\}/);
    });

    test('hides reply / related buttons while a bubble is focused', () => {
        const rule = CHAT_HTML.match(/\.chat-msg\.chat-bubble-focus-host[\s\S]*?\{[\s\S]*?display\s*:\s*none[\s\S]*?\}/);
        expect(rule).not.toBeNull();
    });
});

describe('chat-bubble focus mode — behavior wiring', () => {
    test('enterChatFocusMode / exitChatFocusMode are defined', () => {
        expect(CHAT_HTML).toMatch(/function\s+enterChatFocusMode\s*\(/);
        expect(CHAT_HTML).toMatch(/function\s+exitChatFocusMode\s*\(/);
    });

    test('ctx menu click routes data-action="focus" to enterChatFocusMode', () => {
        expect(CHAT_HTML).toMatch(/action\s*===\s*['"]focus['"][\s\S]{0,120}enterChatFocusMode/);
    });

    test('ESC keydown exits focus mode', () => {
        expect(CHAT_HTML).toMatch(/e\.key\s*===\s*['"]Escape['"][\s\S]{0,200}exitChatFocusMode/);
    });

    test('touchstart skips long-press while a bubble is already focused', () => {
        // The long-press timer would otherwise re-open the ctx menu on top of
        // the OS text-selection handles, defeating the purpose of focus mode.
        expect(CHAT_HTML).toMatch(/chat-bubble\.chat-bubble-focused[\s\S]{0,40}return/);
    });
});

describe('chat-bubble focus mode — i18n', () => {
    test('English locale defines chat_focus_btn + chat_focus_exit', () => {
        expect(I18N_JS).toMatch(/"chat_focus_btn":\s*"Focus bubble"/);
        expect(I18N_JS).toMatch(/"chat_focus_exit":\s*"Exit focus"/);
    });

    test('zh-TW locale defines chat_focus_btn + chat_focus_exit', () => {
        expect(I18N_JS).toMatch(/"chat_focus_btn":\s*"聚焦泡泡"/);
        expect(I18N_JS).toMatch(/"chat_focus_exit":\s*"離開聚焦"/);
    });
});

describe('chat-bubble focus mode — exit paths', () => {
    // Guard against a common regression: wiring one exit path but forgetting
    // another. All three must be present — otherwise a user can get stuck in
    // focus mode with no way out on some platforms.
    test('backdrop click triggers exitChatFocusMode', () => {
        expect(CHAT_HTML).toMatch(/backdrop\.addEventListener\s*\(\s*['"]click['"]\s*,\s*exitChatFocusMode/);
    });

    test('floating close button triggers exitChatFocusMode', () => {
        expect(CHAT_HTML).toMatch(/closeBtn\.addEventListener\s*\(\s*['"]click['"]\s*,\s*exitChatFocusMode/);
    });

    test('only one bubble is focused at a time (entering clears prior)', () => {
        // enterChatFocusMode must call exitChatFocusMode() at the top,
        // otherwise a second focus leaves a stray backdrop + stuck class.
        const fn = CHAT_HTML.match(/function\s+enterChatFocusMode\s*\([^)]*\)\s*\{[\s\S]*?\n\s{8}\}/);
        expect(fn).not.toBeNull();
        expect(fn[0]).toMatch(/exitChatFocusMode\s*\(\s*\)/);
    });
});
