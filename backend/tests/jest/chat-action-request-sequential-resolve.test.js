/**
 * 需要你 inbox SEQUENTIAL replies — the owner must be able to answer several inbox
 * items one after another (card_6a5cc9bb).
 *
 * Bug (Hank, twice): "我要連續回覆處理多個問題但是會被覆蓋掉,導致我無法連續處理".
 * The inbox has NO per-item reply state — every "Reply"/option click feeds one
 * shared, ACCUMULATING `replyContexts` array. Staging item A then item B left
 * [A, B]; one Send then hit the uniq.length>1 guard in
 * resolveActionRequestReplyContexts and resolved NEITHER (PR #3787 turned the old
 * "one answer resolves both" into "one answer resolves neither"). Fix:
 * focusActionRequestReply() now REPLACES any previously-staged action-request
 * context (clearStagedActionRequestReplies) so exactly one inbox item is staged at
 * a time, while regular chat quotes (card_277c80f5) still accumulate.
 *
 * Also pins Failure Mode 2 ("回覆被覆蓋掉"): an option auto-fill must not clobber
 * owner-typed free text.
 *
 * EXECUTES the real functions extracted from chat.html (no module export — same
 * brace-count + `new Function` harness as chat-action-request-independent-resolve).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const chatHtml = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'chat.html'), 'utf8'
);

function extractFunction(name) {
    const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`, 'g');
    const m = re.exec(chatHtml);
    if (!m) throw new Error(`function ${name} not found in chat.html`);
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < chatHtml.length && depth > 0) {
        const ch = chatHtml[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    return chatHtml.slice(m.index, i);
}

const REQ_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const REQ_B = 'bbbbbbbb-0000-4000-8000-000000000002';

function makeInput() {
    return { value: '', scrollHeight: 0, style: {}, focus() {} };
}

function makeHarness() {
    const apiCall = jest.fn(async () => ({ success: true }));
    const showToast = jest.fn();
    const loadActionRequests = jest.fn(async () => {});
    const currentUser = { deviceId: 'dev-1', deviceSecret: 'sec-1' };
    const i18n = { t: (k) => k };
    const input = makeInput();
    const documentStub = { getElementById: (id) => (id === 'messageInput' ? input : null) };
    const requests = {
        [REQ_A]: { id: REQ_A, fromEntityId: 4, prompt: 'A?', anchorMessageId: 'anchor-a', options: ['A-opt-0', 'A-opt-1'] },
        [REQ_B]: { id: REQ_B, fromEntityId: 5, prompt: 'B?', anchorMessageId: 'anchor-b', options: ['B-opt-0', 'B-opt-1'] },
    };

    const preamble = `
        let replyContexts = [];
        let lastAutoFilledOptionValue = '';
        const normalizeChatMessageId = (v) => (v == null ? '' : String(v));
        const stripReplyQuotePrefix = (t) => (t == null ? '' : String(t));
        const openActionRequestAnchor = () => {};
        const renderReplyPreviews = () => {};
        const recomputeAutoReceivers = () => {};
        const clearAllReceiverHints = () => {};
        const autoToggledReceiverEntities = new Set();
        const getEntityDisplayName = (id) => '#' + id;
        const getActionRequestById = (id) => __REQUESTS__[id] || null;
        const actionRequestMeta = (request) => ({
            kind: 'chat-entity',
            entityId: Number(request.fromEntityId),
            actionRequest: { requestId: request.id, anchorMessageId: request.anchorMessageId || null }
        });
    `;

    const factory = new Function(
        'apiCall', 'showToast', 'loadActionRequests', 'currentUser', 'i18n', 'console', 'document', '__REQUESTS__',
        `${preamble}
         ${extractFunction('addReplyContext')}
         ${extractFunction('clearStagedActionRequestReplies')}
         ${extractFunction('collectActionRequestReplyContexts')}
         ${extractFunction('clearReplyContext')}
         ${extractFunction('focusActionRequestReply')}
         ${extractFunction('resolveActionRequestReplyContexts')}
         return {
             addReplyContext, clearStagedActionRequestReplies, collectActionRequestReplyContexts,
             clearReplyContext, focusActionRequestReply, resolveActionRequestReplyContexts,
             getReplyContexts: () => replyContexts.slice(),
         };`
    );
    const api = factory(apiCall, showToast, loadActionRequests, currentUser, i18n, console, documentStub, requests);
    return { ...api, apiCall, showToast, input };
}

const resolvePosts = (apiCall) =>
    apiCall.mock.calls.filter(([method, url]) => method === 'POST' && /\/api\/action-requests\/.+\/resolve$/.test(url));

describe('需要你 inbox — sequential replies (card_6a5cc9bb)', () => {
    it('staging item B after item A REPLACES A — one Send resolves exactly B', async () => {
        const h = makeHarness();
        h.focusActionRequestReply(REQ_A);              // owner clicks Reply on A
        h.focusActionRequestReply(REQ_B);              // then clicks Reply on B (to answer it)
        const staged = h.getReplyContexts().filter(rc => rc.requestId);
        expect(staged.map(rc => rc.requestId)).toEqual([REQ_B]);   // FAIL-ON-OLD: was [A, B]

        await h.resolveActionRequestReplyContexts(h.collectActionRequestReplyContexts(), 'answer for B');
        const posts = resolvePosts(h.apiCall);
        expect(posts).toHaveLength(1);                              // FAIL-ON-OLD: was 0 (uniq>1 → resolve none)
        expect(posts[0][1]).toBe(`/api/action-requests/${REQ_B}/resolve`);
        expect(posts[0][2].answer.text).toBe('answer for B');
        expect(h.showToast).not.toHaveBeenCalledWith('action_request_one_at_a_time', 'error');
    });

    it('full consecutive flow: answer A → Send, then answer B → Send, each resolves independently', async () => {
        const h = makeHarness();

        h.focusActionRequestReply(REQ_A);
        await h.resolveActionRequestReplyContexts(h.collectActionRequestReplyContexts(), 'ans A');
        h.clearReplyContext();                          // sendMessage clears staged contexts

        h.focusActionRequestReply(REQ_B);
        await h.resolveActionRequestReplyContexts(h.collectActionRequestReplyContexts(), 'ans B');

        const posts = resolvePosts(h.apiCall);
        expect(posts).toHaveLength(2);
        expect(posts[0][1]).toBe(`/api/action-requests/${REQ_A}/resolve`);
        expect(posts[0][2].answer.text).toBe('ans A');
        expect(posts[1][1]).toBe(`/api/action-requests/${REQ_B}/resolve`);
        expect(posts[1][2].answer.text).toBe('ans B');
    });

    it('regular chat quotes are preserved when an inbox item is staged (multi-quote card_277c80f5 intact)', () => {
        const h = makeHarness();
        h.addReplyContext('msg-100', 'Alice', 'a normal quoted message', { kind: 'chat-system' });
        h.focusActionRequestReply(REQ_A);
        const ctxs = h.getReplyContexts();
        expect(ctxs.some(rc => rc.msgId === 'msg-100' && !rc.requestId)).toBe(true);  // quote survives
        expect(ctxs.filter(rc => rc.requestId).map(rc => rc.requestId)).toEqual([REQ_A]);
        h.focusActionRequestReply(REQ_B);   // switching inbox items still keeps the quote
        const ctxs2 = h.getReplyContexts();
        expect(ctxs2.some(rc => rc.msgId === 'msg-100' && !rc.requestId)).toBe(true);
        expect(ctxs2.filter(rc => rc.requestId).map(rc => rc.requestId)).toEqual([REQ_B]);
    });

    describe('option auto-fill guard — Failure Mode 2 ("回覆被覆蓋掉")', () => {
        it('fills the option text into an empty composer', () => {
            const h = makeHarness();
            h.focusActionRequestReply(REQ_A, 0);
            expect(h.input.value).toBe('A-opt-0');
        });

        it('switching options replaces a prior AUTO-FILLED option', () => {
            const h = makeHarness();
            h.focusActionRequestReply(REQ_A, 0);
            expect(h.input.value).toBe('A-opt-0');
            h.focusActionRequestReply(REQ_A, 1);        // change your mind
            expect(h.input.value).toBe('A-opt-1');
        });

        it('does NOT clobber owner-typed free text with an option', () => {
            const h = makeHarness();
            h.focusActionRequestReply(REQ_A);           // plain Reply, no option
            h.input.value = 'my carefully typed answer';  // owner types
            h.focusActionRequestReply(REQ_B, 0);        // clicks an option on B
            expect(h.input.value).toBe('my carefully typed answer');   // preserved
        });
    });
});
