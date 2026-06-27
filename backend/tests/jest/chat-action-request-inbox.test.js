const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const chatHtml = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'chat.html'), 'utf8');
const socketJs = fs.readFileSync(path.join(ROOT, 'public', 'portal', 'shared', 'socket.js'), 'utf8');
const i18nJs = fs.readFileSync(path.join(ROOT, 'public', 'shared', 'i18n.js'), 'utf8');

describe('chat action request inbox (card_b51598b7 frontend)', () => {
    test('load-time pending inbox calls the backend list API and renders inbox-or-hide (greeting removed, card_cc9700b7)', () => {
        // Greeting feature fully removed — no EclawGreeting object, no
        // ACTION_REQUEST_INBOX_EMPTY_FALLBACK_TO_GREETING flag. The single render
        // entry is refreshActionRequestBanner(): inbox when pending, hide when empty.
        expect(chatHtml).not.toContain('EclawGreeting');
        expect(chatHtml).not.toContain('ACTION_REQUEST_INBOX_EMPTY_FALLBACK_TO_GREETING');
        expect(chatHtml).toMatch(/function refreshActionRequestBanner\(\)/);
        expect(chatHtml).toMatch(/async function loadActionRequests\(\{ renderInbox = false \} = \{\}\)/);
        expect(chatHtml).toContain("status: 'pending'");
        expect(chatHtml).toContain("`/api/action-requests?${qs.toString()}`");
        expect(chatHtml).toContain('await loadActionRequests({ renderInbox: true });');
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
        expect(chatHtml).toContain('await loadActionRequests({ renderInbox: true });');
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
        expect(fn).toContain('await loadActionRequests({ renderInbox: nextRender });');
    });

    test('emptied inbox tears down stale DOM + hides the banner (no greeting fallback, card_cc9700b7)', () => {
        expect(chatHtml).toContain("if (banner.querySelector('.action-request-inbox')) {");
    });

    test('failed send restores the quote chips it optimistically cleared', () => {
        expect(chatHtml).toContain('const replyContextsSnapshot = replyContexts.slice();');
        expect(chatHtml).toContain('if (replyContextsSnapshot.length && replyContexts.length === 0) {');
        expect(chatHtml).toMatch(/function removeReplyContextForRequest\(requestId\)/);
    });

    test('every send abort path (uploads-pending / no-target / catch) restores the staged reply, not just the catch (card_2625ae06)', () => {
        // clearReplyContext() runs optimistically BEFORE the early-return guards, so
        // each abort must restore the snapshot or the staged quote + action-request
        // binding is silently orphaned with no user feedback. One DRY helper covers all.
        const fn = chatHtml.slice(chatHtml.indexOf('async function sendMessage('), chatHtml.indexOf('async function uploadVoice('));
        expect(fn).toContain('const restoreReplyContextsOnAbort = () => {');
        // uploads-still-pending guard restores before returning
        expect(fn).toMatch(/chat_wait_upload[\s\S]{0,180}restoreReplyContextsOnAbort\(\);\s*\n\s*return;/);
        // no-routing-target guard restores before returning
        expect(fn).toMatch(/chat_select_entity[\s\S]{0,140}restoreReplyContextsOnAbort\(\);\s*\n\s*return;/);
        // invoked on all three abort paths: 2 early-return guards + the catch
        expect((fn.match(/restoreReplyContextsOnAbort\(\)/g) || []).length).toBeGreaterThanOrEqual(3);
    });
});

describe('需要你 inbox 篩選條件 facet (計畫C, card_2a6f260f)', () => {
    test('a persisted All / Consensus filter state drives a matcher', () => {
        expect(chatHtml).toContain("const ACTION_REQUEST_INBOX_FILTER_KEY = 'needsyou_inbox_filter';");
        expect(chatHtml).toContain('let actionRequestInboxFilter = (() => {');
        expect(chatHtml).toMatch(/function setActionRequestInboxFilter\(value\)/);
        expect(chatHtml).toContain("localStorage.setItem(ACTION_REQUEST_INBOX_FILTER_KEY, actionRequestInboxFilter);");
        // matcher: consensus facet narrows to type==='consensus' OR an in-consensus round
        expect(chatHtml).toMatch(/function actionRequestMatchesFilter\(request\)/);
        expect(chatHtml).toContain("if (actionRequestInboxFilter !== 'consensus') return true;");
        expect(chatHtml).toContain("return String(request && request.type) === 'consensus' || isActionRequestConsensusTriggered(request);");
    });

    test('the inbox renders filter chips and applies the matcher to the list', () => {
        const fn = chatHtml.slice(chatHtml.indexOf('function renderActionRequestInbox('), chatHtml.indexOf('function collectActionRequestReplyContexts('));
        expect(fn).toContain("filterRow.className = 'action-request-inbox-filter';");
        expect(fn).toContain("['all', 'action_request_filter_all', 'All'],");
        expect(fn).toContain("['consensus', 'action_request_filter_consensus', 'Consensus'],");
        expect(fn).toContain('setActionRequestInboxFilter(value);');
        // chips reuse the existing .filter-chip look + active state
        expect(fn).toContain("chip.className = 'filter-chip' + (actionRequestInboxFilter === value ? ' active' : '');");
        // the list is the filtered set, not the raw actionRequests
        expect(fn).toContain('const visibleRequests = actionRequests.filter(actionRequestMatchesFilter);');
        expect(fn).toContain('visibleRequests.forEach(request => {');
        // empty-state when the facet matches nothing
        expect(fn).toContain('if (visibleRequests.length === 0) {');
        expect(fn).toContain("empty.className = 'action-request-filter-empty';");
        // does not regress the separate system-message filter
        expect(chatHtml).toContain("function applySysFilterChipState()");
    });

    test('EN + ZH strings exist for the filter facet', () => {
        ['action_request_filter_label', 'action_request_filter_all', 'action_request_filter_consensus', 'action_request_filter_empty']
            .forEach(key => expect(i18nJs).toContain(`"${key}"`));
        expect(i18nJs).toContain('"action_request_filter_consensus": "Consensus"');
        expect(i18nJs).toContain('"action_request_filter_consensus": "協商討論"');
    });
});

describe('需要你 inbox related-card chip (計畫D, card_df646877)', () => {
    test('the chip renders ONLY when a request has relatedCardId and opens the card via openKanbanCard', () => {
        const fn = chatHtml.slice(chatHtml.indexOf('function renderActionRequestInbox('), chatHtml.indexOf('function collectActionRequestReplyContexts('));
        // gated on relatedCardId — absent → no chip, no layout shift
        expect(fn).toContain('if (request.relatedCardId) {');
        expect(fn).toContain("cardLink.className = 'action-request-action action-request-card-link';");
        expect(fn).toContain("cardLink.textContent = t('action_request_card_link', '🗂 Task card');");
        // clicking deep-links to the kanban card via the shared open mechanism
        expect(fn).toContain('openKanbanCard(request.relatedCardId, event)');
        // the chip lives in the actions row (after Show source, before Dismiss)
        expect(fn.indexOf('action-request-card-link')).toBeLessThan(fn.indexOf("dismiss.className = 'action-request-action danger';"));
    });

    test('openKanbanCard exists as the shared deep-link entry', () => {
        expect(chatHtml).toMatch(/function openKanbanCard\(cardId, event\)/);
    });

    test('EN + ZH strings exist for the related-card chip', () => {
        ['action_request_card_link', 'action_request_card_link_title']
            .forEach(key => expect(i18nJs).toContain(`"${key}"`));
        expect(i18nJs).toContain('"action_request_card_link": "🗂 Task card"');
        expect(i18nJs).toContain('"action_request_card_link": "🗂 任務卡"');
    });
});

describe('需要你 inbox ratify badge (計畫E, buildRatifyBadge)', () => {
    test('chat.html contains the buildRatifyBadge function with hold and default_agree modes', () => {
        expect(chatHtml).toContain('function buildRatifyBadge(ratify, opts)');
        expect(chatHtml).toContain("mode !== 'default_agree'");
        expect(chatHtml).toContain("mode !== 'hold'");
        expect(chatHtml).toContain('.action-request-ratify');
    });

    test('EN i18n keys exist for the ratify badge (hold + default_agree)', () => {
        expect(i18nJs).toContain('"action_request_ratify_hold_badge"');
        expect(i18nJs).toContain('"action_request_ratify_default_agree_badge"');
    });
});
