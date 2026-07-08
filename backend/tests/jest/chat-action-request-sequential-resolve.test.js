/**
 * 需要你 inbox — answering several items (card_6a5cc9bb, then batch/coexist).
 *
 * HISTORY: Hank asked twice for "連續回覆處理多個問題". #3852 first solved this by
 * making the inbox one-at-a-time (staging B REPLACED A) so a single Send resolved
 * exactly the item being answered. The product decision then EVOLVED (owner Hank):
 * the inbox should let the owner STAGE MULTIPLE items at once, EACH carrying its OWN
 * answer, and submit them together in ONE Send — every item resolves with its own
 * text. focusActionRequestReply() no longer clears the previously-staged item; each
 * chip owns a per-item answer (rc.answerText) instead of writing the shared composer.
 *
 * This suite now pins the SEQUENTIAL flow under the batch model (answer A → Send,
 * then answer B → Send still works) plus the still-valid multi-quote invariant. The
 * coexist-in-one-send behaviour is pinned by chat-action-request-batch-resolve.
 *
 * CHANGED vs the #3852 version (why): the two assertions that pinned the reverted
 * one-at-a-time REPLACE behaviour were updated —
 *   1) "staging B REPLACES A → staged == [B]" → now staging B COEXISTS → [A, B]
 *      (one Send resolves BOTH, each with its own answer). The old expectation
 *      contradicts the new product decision.
 *   2) the option auto-fill assertions used the SHARED #messageInput; an option now
 *      writes THIS item's rc.answerText, so they assert on the per-item answer and
 *      that the shared composer is never touched.
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
    const messageInput = makeInput();
    const answerInputs = {};
    const documentStub = {
        getElementById: (id) => {
            if (id === 'messageInput') return messageInput;
            if (id && id.indexOf('replyAnswerInput_') === 0) {
                return (answerInputs[id] = answerInputs[id] || makeInput());
            }
            return null;
        }
    };
    const requests = {
        [REQ_A]: { id: REQ_A, fromEntityId: 4, prompt: 'A?', anchorMessageId: 'anchor-a', options: ['A-opt-0', 'A-opt-1'] },
        [REQ_B]: { id: REQ_B, fromEntityId: 5, prompt: 'B?', anchorMessageId: 'anchor-b', options: ['B-opt-0', 'B-opt-1'] },
    };

    const preamble = `
        let replyContexts = [];
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
             setAnswerText: (rid, val) => { const rc = replyContexts.find(c => c.requestId === rid); if (rc) rc.answerText = val; },
         };`
    );
    const api = factory(apiCall, showToast, loadActionRequests, currentUser, i18n, console, documentStub, requests);
    return { ...api, apiCall, showToast, messageInput };
}

const resolvePosts = (apiCall) =>
    apiCall.mock.calls.filter(([method, url]) => method === 'POST' && /\/api\/action-requests\/.+\/resolve$/.test(url));

describe('需要你 inbox — answering several items (batch/coexist, card_6a5cc9bb → batch)', () => {
    // CHANGED (was: "staging B REPLACES A — one Send resolves exactly B"). The product
    // decision moved from one-at-a-time REPLACE to batch COEXIST, so B no longer
    // discards A; both stage and one Send resolves BOTH, each with its own answer.
    it('staging item B after item A keeps BOTH — one Send resolves each with its own answer', async () => {
        const h = makeHarness();
        h.focusActionRequestReply(REQ_A);              // owner clicks Reply on A
        h.focusActionRequestReply(REQ_B);              // then clicks Reply on B
        const staged = h.getReplyContexts().filter(rc => rc.requestId);
        expect(staged.map(rc => rc.requestId)).toEqual([REQ_A, REQ_B]);   // coexist (was [REQ_B])

        h.setAnswerText(REQ_A, 'answer for A');
        h.setAnswerText(REQ_B, 'answer for B');
        await h.resolveActionRequestReplyContexts(h.collectActionRequestReplyContexts(), '');

        const posts = resolvePosts(h.apiCall);
        expect(posts).toHaveLength(2);                                    // both resolved (was 1)
        const byId = Object.fromEntries(posts.map(p => [p[1], p[2].answer.text]));
        expect(byId[`/api/action-requests/${REQ_A}/resolve`]).toBe('answer for A');
        expect(byId[`/api/action-requests/${REQ_B}/resolve`]).toBe('answer for B');
        expect(h.showToast).not.toHaveBeenCalledWith('action_request_one_at_a_time', 'error');
    });

    it('full consecutive flow: answer A → Send, then answer B → Send, each resolves independently', async () => {
        const h = makeHarness();

        h.focusActionRequestReply(REQ_A);
        h.setAnswerText(REQ_A, 'ans A');
        await h.resolveActionRequestReplyContexts(h.collectActionRequestReplyContexts(), '');
        h.clearReplyContext();                          // sendMessage clears staged contexts

        h.focusActionRequestReply(REQ_B);
        h.setAnswerText(REQ_B, 'ans B');
        await h.resolveActionRequestReplyContexts(h.collectActionRequestReplyContexts(), '');

        const posts = resolvePosts(h.apiCall);
        expect(posts).toHaveLength(2);
        expect(posts[0][1]).toBe(`/api/action-requests/${REQ_A}/resolve`);
        expect(posts[0][2].answer.text).toBe('ans A');
        expect(posts[1][1]).toBe(`/api/action-requests/${REQ_B}/resolve`);
        expect(posts[1][2].answer.text).toBe('ans B');
    });

    it('regular chat quotes are preserved when inbox items are staged (multi-quote card_277c80f5 intact)', () => {
        const h = makeHarness();
        h.addReplyContext('msg-100', 'Alice', 'a normal quoted message', { kind: 'chat-system' });
        h.focusActionRequestReply(REQ_A);
        const ctxs = h.getReplyContexts();
        expect(ctxs.some(rc => rc.msgId === 'msg-100' && !rc.requestId)).toBe(true);  // quote survives
        expect(ctxs.filter(rc => rc.requestId).map(rc => rc.requestId)).toEqual([REQ_A]);
        h.focusActionRequestReply(REQ_B);   // staging another inbox item still keeps the quote AND A
        const ctxs2 = h.getReplyContexts();
        expect(ctxs2.some(rc => rc.msgId === 'msg-100' && !rc.requestId)).toBe(true);
        expect(ctxs2.filter(rc => rc.requestId).map(rc => rc.requestId)).toEqual([REQ_A, REQ_B]);
    });

    // CHANGED (was: option auto-fill writes the SHARED #messageInput; Failure Mode 2
    // guarded owner-typed composer text). An option now writes THIS item's own answer
    // (rc.answerText), so cross-item clobber is structurally impossible and the shared
    // composer is never touched.
    describe('option button writes the item\'s OWN answer (not the shared composer)', () => {
        it('fills the option text into THIS item\'s answer', () => {
            const h = makeHarness();
            h.focusActionRequestReply(REQ_A, 0);
            const rcA = h.getReplyContexts().find(rc => rc.requestId === REQ_A);
            expect(rcA.answerText).toBe('A-opt-0');
            expect(h.messageInput.value).toBe('');       // shared composer untouched
        });

        it('switching options replaces this item\'s prior option answer', () => {
            const h = makeHarness();
            h.focusActionRequestReply(REQ_A, 0);
            h.focusActionRequestReply(REQ_A, 1);          // change your mind
            const rcA = h.getReplyContexts().find(rc => rc.requestId === REQ_A);
            expect(rcA.answerText).toBe('A-opt-1');
        });

        it('an option on item B never disturbs item A\'s answer or the composer', () => {
            const h = makeHarness();
            h.focusActionRequestReply(REQ_A);
            h.setAnswerText(REQ_A, 'my carefully typed answer for A');
            h.focusActionRequestReply(REQ_B, 0);          // clicks an option on B
            const rcA = h.getReplyContexts().find(rc => rc.requestId === REQ_A);
            const rcB = h.getReplyContexts().find(rc => rc.requestId === REQ_B);
            expect(rcA.answerText).toBe('my carefully typed answer for A');  // A preserved
            expect(rcB.answerText).toBe('B-opt-0');                          // B set
            expect(h.messageInput.value).toBe('');                          // composer never touched
        });
    });
});
