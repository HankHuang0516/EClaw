'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');

function readRepoFile(...segments) {
    return fs.readFileSync(path.join(repoRoot, ...segments), 'utf8');
}

describe('chat message deep-link plumbing', () => {
    let kanbanHtml;
    let chatHtml;
    let webViewScreen;

    beforeAll(() => {
        kanbanHtml = readRepoFile('public/portal/kanban.html');
        chatHtml = readRepoFile('public/portal/chat.html');
        webViewScreen = fs.readFileSync(
            path.join(repoRoot, '../ios-app/components/WebViewScreen.tsx'),
            'utf8',
        );
    });

    test('kanban quote chips preserve messageId when navigating to chat', () => {
        expect(kanbanHtml).toContain('function quoteToChat(source, title, excerpt, opts = {})');
        expect(kanbanHtml).toContain('const messageId = normalizeKanbanChatMessageId(opts.messageId);');
        expect(kanbanHtml).toContain("if (messageId) quote.messageId = messageId;");
        expect(kanbanHtml).toContain("target: messageId ? 'message' : 'quote'");
        expect(kanbanHtml).toContain("'/portal/chat.html?messageId=' + encodeURIComponent(messageId)");
        expect(kanbanHtml).toContain('messageId: getCardChatAnchorMessageId(card)');
        expect(kanbanHtml).toContain("extractKanbanChatMessageId(c.text || '') || getCardChatAnchorMessageId(card)");
        expect(kanbanHtml).toContain("const pinPayload = JSON.stringify({ src: '留言 · ' + cardTitle, sender: name, text: c.text || '', messageId })");
    });

    test('chat page opens messageId deep-links from query, quotes, and native intents', () => {
        expect(chatHtml).toContain('async function openChatMessageDeepLink(messageId, { showMissingToast = true, scroll = true } = {})');
        expect(chatHtml).toContain("url.searchParams.set('messageId', id);");
        expect(chatHtml).toContain('const { source, title, excerpt, messageId, meta, ts } = JSON.parse(pq);');
        expect(chatHtml).not.toContain('prefillInput, messageId, meta, ts } = JSON.parse(pq)');
        expect(chatHtml).toContain('await openChatMessageDeepLink(messageId, { showMissingToast: true, scroll: true });');
        expect(chatHtml).toContain('const msgId = intent.messageId || quote.messageId');
        expect(chatHtml).toContain("quoteToChat(quote.source || '引用', quote.title || '', quote.excerpt || '');");
    });

    test('native WebView fallback uses canonical messageId query', () => {
        expect(webViewScreen).toContain('messageId?: string;');
        expect(webViewScreen).toContain('quote?: { source?: string; title?: string; excerpt?: string; messageId?: string };');
        expect(webViewScreen).toContain("intent.targetTab === 'chat' && (intent.messageId || (intent.quote && intent.quote.messageId))");
        expect(webViewScreen).toContain("'/portal/chat.html?messageId=' + encodeURIComponent(intent.messageId || intent.quote.messageId)");
    });
});
