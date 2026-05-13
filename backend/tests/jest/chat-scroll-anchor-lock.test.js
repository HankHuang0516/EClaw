const fs = require('fs');
const path = require('path');

const chatHtml = fs.readFileSync(
    path.join(__dirname, '../../public/portal/chat.html'),
    'utf8'
);

describe('chat scroll anchor lock regression guard', () => {
    test('renderMessages captures and restores a stable visible message anchor', () => {
        expect(chatHtml).toContain('function captureChatScrollAnchor(container)');
        expect(chatHtml).toContain("container.querySelectorAll('.chat-msg[data-message-id]')");
        expect(chatHtml).toContain('lock.id = id');
        expect(chatHtml).toContain('lock.top = rect.top - cRect.top');
        expect(chatHtml).toContain('restoreChatScrollAnchor(container, scrollLock');
        expect(chatHtml).toContain('container.scrollTop += newTop - lock.top');
    });

    test('history-reading renders do not rely on bottom-only scrollTop restore', () => {
        expect(chatHtml).toContain('const shouldFollowBottom = isFirstLoad || (scrollLock && scrollLock.wasAtBottom)');
        expect(chatHtml).toContain('forceBottom: shouldFollowBottom');
        expect(chatHtml).toContain('settle: !shouldFollowBottom');
        expect(chatHtml).not.toContain('const wasAtBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 50;');
    });

    test('async height changes are guarded for link previews and media hydration', () => {
        expect(chatHtml).toContain('function wireChatAsyncScrollGuards(container)');
        expect(chatHtml).toContain('new ResizeObserver');
        expect(chatHtml).toContain('wireChatAsyncScrollGuards(container);');
        expect(chatHtml).toContain('preserveChatScrollDuring(() => {');
        expect(chatHtml).toContain('container.innerHTML = cardHtml;');
        expect(chatHtml).toContain('el.src = data.url;');
    });

    test('user scroll refreshes the active anchor instead of fighting the reader', () => {
        expect(chatHtml).toContain('refreshChatActiveScrollLock(container);');
        expect(chatHtml).toContain("container.addEventListener('scroll', () =>");
    });
});
