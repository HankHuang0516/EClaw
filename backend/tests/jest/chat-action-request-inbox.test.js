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
        expect(chatHtml).toContain("['emitted', 'resolved', 'dismissed', 'consensus_triggered'].includes(data.kind)");
        expect(chatHtml).toContain("data.kind === 'consensus_triggered'");
        expect(chatHtml).toContain('markActionRequestConsensusTriggered(data.requestId)');
        expect(chatHtml).toContain("scheduleActionRequestRefresh('socket');");
    });

    test('consensus requests get dedicated inbox UI copy and styling hooks', () => {
        expect(chatHtml).toMatch(/function actionRequestTypeMeta\(type\)/);
        expect(chatHtml).toContain("consensus: '🤝'");
        expect(chatHtml).toContain("'action_request_type_consensus_hint'");
        expect(chatHtml).toContain("'action_request_consensus_reply'");
        expect(chatHtml).toContain("item.className = 'action-request-item ' + typeMeta.className + (consensusTriggered ? ' in-consensus' : '');");
        expect(chatHtml).toContain('action-request-type-badge');
        expect(chatHtml).toContain('.action-request-item.type-consensus');
        expect(chatHtml).toContain('function isActionRequestConsensusTriggered(request)');
        expect(chatHtml).toContain('action-request-consensus-state');
        expect(chatHtml).toContain("'action_request_consensus_triggered'");
        expect(chatHtml).toContain(".action-request-item.in-consensus");
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
            'action_request_consensus_triggered',
        ].forEach(key => {
            expect(i18nJs).toContain(`"${key}"`);
        });
        expect(i18nJs).toContain('"action_request_inbox_title": "Needs you"');
        expect(i18nJs).toContain('"action_request_inbox_title": "需要你"');
        expect(i18nJs).toContain('"action_request_type_consensus": "Consensus"');
        expect(i18nJs).toContain('"action_request_type_consensus": "協商共識"');
        expect(i18nJs).toContain('"action_request_consensus_triggered": "In consensus"');
        expect(i18nJs).toContain('"action_request_consensus_triggered": "協商中"');
    });
});

describe('需要你 inbox collapse + lifecycle hardening (card_b176c435)', () => {
    test('inbox is collapsed by default with a persisted open/closed state', () => {
        expect(chatHtml).toContain("const ACTION_REQUEST_INBOX_OPEN_KEY = 'needsyou_inbox_open';");
        // default closed: only an explicit '1' opens it
        expect(chatHtml).toContain("return localStorage.getItem(ACTION_REQUEST_INBOX_OPEN_KEY) === '1';");
        expect(chatHtml).toMatch(/function setActionRequestInboxOpen\(open\)/);
        expect(chatHtml).toContain("localStorage.setItem(ACTION_REQUEST_INBOX_OPEN_KEY, open ? '1' : '0');");
    });

    test('renders a one-line summary 「🔔 + title + count + chevron」 that toggles the body', () => {
        expect(chatHtml).toContain("summary.className = 'action-request-inbox-summary';");
        expect(chatHtml).toContain("bell.textContent = '🔔';");
        expect(chatHtml).toContain("chevron.textContent = '▼';");
        expect(chatHtml).toContain("summary.setAttribute('aria-expanded', actionRequestInboxOpen ? 'true' : 'false');");
        expect(chatHtml).toContain("summary.setAttribute('aria-controls', bodyId);");
        // the request list lives in the collapsible body, not directly in wrap
        expect(chatHtml).toContain("body.className = 'action-request-inbox-body';");
        expect(chatHtml).toContain('body.appendChild(item);');
        expect(chatHtml).toContain('wrap.appendChild(body);');
    });

    test('CSS caps the expanded body so a burst of requests cannot cover the chat', () => {
        expect(chatHtml).toMatch(/\.action-request-inbox-body\s*\{[^}]*max-height:\s*40vh/);
        expect(chatHtml).toMatch(/\.action-request-inbox-body\s*\{[^}]*overflow-y:\s*auto/);
        expect(chatHtml).toContain('.action-request-inbox.is-open .action-request-inbox-body { display: flex; }');
        // the banner must not shrink the message list to absorb the inbox
        expect(chatHtml).toMatch(/\.greet-banner\s*\{[^}]*flex-shrink:\s*0/);
    });

    test('whole inbox is not a live region; only the count announces changes', () => {
        expect(chatHtml).toContain("wrap.setAttribute('aria-live', 'off');");
        expect(chatHtml).toContain("count.setAttribute('aria-live', 'polite');");
    });

    test('dismiss is optimistic and idempotent for already-resolved requests', () => {
        const fn = chatHtml.slice(chatHtml.indexOf('async function dismissActionRequest('), chatHtml.indexOf('function renderActionRequestInbox('));
        expect(fn).toContain('actionRequests = actionRequests.filter(r => normalizeChatMessageId(r && r.id) !== id);');
        expect(fn).toContain('removeReplyContextForRequest(id);');
        expect(fn).toContain('const st = err && err.status;');
        expect(fn).toContain('if (st === 404 || st === 409 || st === 410) {');
    });

    test('a mid-flight refresh is coalesced, never dropped', () => {
        const fn = chatHtml.slice(chatHtml.indexOf('async function loadActionRequests('), chatHtml.indexOf('function scheduleActionRequestRefresh('));
        expect(fn).toContain('actionRequestsRefreshPending = true;');
        expect(fn).toContain('if (actionRequestsRefreshPending) {');
        expect(fn).toContain('await loadActionRequests({ renderGreeting: nextRender, forceGreeting: nextForce });');
    });

    test('emptied inbox tears down stale DOM before greeting early-returns', () => {
        expect(chatHtml).toContain("if (banner.querySelector('.action-request-inbox')) {");
    });

    test('failed send restores the quote chips it optimistically cleared', () => {
        expect(chatHtml).toContain('const replyContextsSnapshot = replyContexts.slice();');
        expect(chatHtml).toContain('if (replyContextsSnapshot.length && replyContexts.length === 0) {');
        expect(chatHtml).toMatch(/function removeReplyContextForRequest\(requestId\)/);
    });
});
