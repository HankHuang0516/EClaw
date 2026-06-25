const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const chatHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'chat.html'), 'utf8');
const socketJs = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'shared', 'socket.js'), 'utf8');
const i18nJs = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'i18n.js'), 'utf8');

describe('chat action request inbox (card_b51598b7 frontend)', () => {
    test('load-time pending inbox calls the backend list API and gates greeting fallback behind a flag', () => {
        expect(chatHtml).toContain('const ACTION_REQUEST_INBOX_EMPTY_FALLBACK_TO_GREETING = true;');
        expect(chatHtml).toMatch(/async function loadActionRequests\(\{ renderGreeting = false, forceGreeting = false \} = \{\}\)/);
        expect(chatHtml).toContain("status: 'pending'");
        expect(chatHtml).toContain("`/api/action-requests?${qs.toString()}`");
        expect(chatHtml).toContain('await loadActionRequests({ renderGreeting: true, forceGreeting: true });');
        expect(chatHtml).toContain('if (!actionRequestsLoaded) return;');
        expect(chatHtml).toContain('if (actionRequests.length > 0) {');
        expect(chatHtml).toContain('renderActionRequestInbox(banner);');
    });

    test('anchor jump uses window.openHistoryMessage as the primary route', () => {
        const fn = chatHtml.slice(chatHtml.indexOf('function openActionRequestAnchor('), chatHtml.indexOf('function actionRequestMeta('));
        expect(fn).toContain("typeof window.openHistoryMessage === 'function'");
        expect(fn).toContain('window.openHistoryMessage(anchorMessageId);');
        expect(fn.indexOf('window.openHistoryMessage(anchorMessageId);')).toBeLessThan(fn.indexOf('openChatMessageDeepLink'));
        expect(chatHtml).toContain('window.openHistoryMessage = openHistoryMessage;');
    });

    test('reply quote state de-dupes action requests by requestId, not anchorMessageId', () => {
        const add = chatHtml.slice(chatHtml.indexOf('function addReplyContext('), chatHtml.indexOf('function removeReplyContextAt('));
        expect(add).toContain('const requestId = normalizeChatMessageId(meta?.actionRequest?.requestId);');
        expect(add).toContain("const key = requestId ? ('request:' + requestId)");
        expect(add).toContain('requestId: requestId || null');
        expect(add).toContain('anchorMessageId: anchorMessageId || null');
    });

    test('outgoing speak payload carries requestId and anchorMessageId reply context', () => {
        expect(chatHtml).toContain('const actionRequestReplyContexts = collectActionRequestReplyContexts();');
        expect(chatHtml).toMatch(/function\s+collectActionRequestReplyContexts\s*\(\)/);
        expect(chatHtml).toMatch(/contexts\.push\(\{\s*requestId,\s*anchorMessageId: anchorMessageId \|\| null\s*\}\)/);
        expect(chatHtml).toMatch(/function\s+attachReplyContextPayload\s*\(\s*body,\s*contexts\s*\)/);
        expect(chatHtml).toContain('body.replyContexts = replyContextsPayload;');
        expect(chatHtml).toContain('body.replyContext = replyContextsPayload.length === 1');
        expect(chatHtml).toMatch(/requestId: ctx\.requestId,\s*\n\s*anchorMessageId: ctx\.anchorMessageId \|\| null/);
        expect(chatHtml).toContain('attachReplyContextPayload(speakBody, actionRequestReplyContexts);');
    });

    test('send success resolves requests and dismiss refreshes the pending count', () => {
        expect(chatHtml).toMatch(/async function resolveActionRequestReplyContexts\(contexts, answerText\)/);
        expect(chatHtml).toContain('`/api/action-requests/${ctx.requestId}/resolve`');
        expect(chatHtml).toContain('await resolveActionRequestReplyContexts(actionRequestReplyContexts, finalText);');
        expect(chatHtml).toMatch(/async function dismissActionRequest\(requestId\)/);
        expect(chatHtml).toContain('`/api/action-requests/${id}/dismiss`');
        expect(chatHtml).toContain('await loadActionRequests({ renderGreeting: true, forceGreeting: true });');
    });

    test('socket realtime contract refreshes the inbox through a client preference gate', () => {
        expect(socketJs).toContain("portalSocket.on('action_request:changed'");
        expect(socketJs).toContain("typeof onSocketActionRequestChanged === 'function'");
        expect(chatHtml).toContain('let actionRequestRealtimeEnabled = true;');
        expect(chatHtml).toMatch(/function scheduleActionRequestRefresh\(reason = 'socket'\)/);
        expect(chatHtml).toContain('if (!actionRequestRealtimeEnabled) return;');
        expect(chatHtml).toMatch(/window\.onSocketActionRequestChanged = function\(data\)/);
        expect(chatHtml).toContain("['emitted', 'resolved', 'dismissed'].includes(data.kind)");
        expect(chatHtml).toContain("scheduleActionRequestRefresh('socket');");
    });

    test('consensus requests get dedicated inbox UI copy and styling hooks', () => {
        expect(chatHtml).toMatch(/function actionRequestTypeMeta\(type\)/);
        expect(chatHtml).toContain("consensus: '🤝'");
        expect(chatHtml).toContain("'action_request_type_consensus_hint'");
        expect(chatHtml).toContain("'action_request_consensus_reply'");
        expect(chatHtml).toContain("item.className = 'action-request-item ' + typeMeta.className;");
        expect(chatHtml).toContain('action-request-type-badge');
        expect(chatHtml).toContain('.action-request-item.type-consensus');
    });

    test('EN and ZH strings exist for the inbox surface', () => {
        [
            'action_request_inbox_title',
            'action_request_inbox_count',
            'action_request_inbox_reply',
            'action_request_inbox_anchor',
            'action_request_inbox_dismiss',
            'action_request_meta',
            'action_request_type_decision',
            'action_request_type_consensus',
            'action_request_type_consensus_hint',
            'action_request_consensus_reply',
        ].forEach(key => {
            expect(i18nJs).toContain(`"${key}"`);
        });
        expect(i18nJs).toContain('"action_request_inbox_title": "Needs you"');
        expect(i18nJs).toContain('"action_request_inbox_title": "需要你"');
        expect(i18nJs).toContain('"action_request_type_consensus": "Consensus"');
        expect(i18nJs).toContain('"action_request_type_consensus": "協商共識"');
    });
});
