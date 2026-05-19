'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const chatHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'chat.html'), 'utf8');
const kanbanHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'kanban.html'), 'utf8');
const missionHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'mission.html'), 'utf8');
const webViewScreenTsx = fs.readFileSync(path.join(ROOT, '..', 'ios-app', 'components', 'WebViewScreen.tsx'), 'utf8');

describe('messageId deep-link follow-up — static wiring', () => {
    test('WebViewScreen native fallback uses canonical ?messageId= URL', () => {
        expect(webViewScreenTsx).toContain("window.location.href = '/portal/chat.html?messageId=' + encodeURIComponent(intent.messageId)");
        expect(webViewScreenTsx).toContain('prefillInput?: string;');
        expect(webViewScreenTsx).toContain('messageId?: string;');
    });

    test('chat.html carries messageId through pending quote relay and native navigate intent', () => {
        expect(chatHtml).toContain("const { source, title, excerpt, prefillInput, messageId, ts } = JSON.parse(pq);");
        expect(chatHtml).toContain("if (setChatMessageDeepLinkId(messageId)) {");
        expect(chatHtml).toContain("const msgId = intent.messageId || (intent.quote && intent.quote.messageId)");
    });

    test('kanban quote payload includes messageId for card anchor and comment references', () => {
        expect(kanbanHtml).toContain("quoteToChat('看板卡片', title, meta, { messageId: card && card.chatAnchorMessageId });");
        expect(kanbanHtml).toContain("messageId: extractChatMessageId(c.messageId || c.message_id || c.text || '')");
        expect(kanbanHtml).toContain("window.location.href = '/portal/chat.html?messageId=' + encodeURIComponent(normalized);");
    });

    test('mission quote bridge preserves messageId into chat deep-link handoff', () => {
        expect(missionHtml).toContain("window.parent.postMessage({ type: 'eclaw_quote', source, title, excerpt: excerpt || '', prefillInput, messageId }, window.location.origin);");
        expect(missionHtml).toContain("if (eclawNavigateChat({ target: 'quote', quote, messageId })) return;");
    });
});
