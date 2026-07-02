/**
 * 需要你 inbox BATCH / COEXIST replies — the owner stages SEVERAL inbox items at
 * once, EACH carrying its OWN answer, then submits them together in ONE Send; every
 * item resolves with ITS OWN text.
 *
 * Product decision (owner Hank): the inbox is a multi-item decision surface. Staging
 * item B must NOT replace item A (that was the one-at-a-time behaviour of #3852), and
 * one Send must NOT refuse when >1 item is staged (that was the uniq>1 refuse of
 * #3787). Instead each staged chip owns a per-item answer (rc.answerText, edited via
 * a per-chip <textarea>), collected by collectActionRequestReplyContexts() and sent
 * by resolveActionRequestReplyContexts() — one /resolve POST per distinct request,
 * each with its own answer.
 *
 * FAIL-ON-OLD:
 *   - old resolveActionRequestReplyContexts(): uniq>1 → 0 POSTs + one_at_a_time toast.
 *     Now: 2 staged distinct items → 2 POSTs, each with its OWN answer.
 *   - old focusActionRequestReply(): clearStagedActionRequestReplies() first (B
 *     replaced A) and an option wrote the SHARED #messageInput. Now: both coexist and
 *     an option writes THIS item's rc.answerText only.
 *
 * EXECUTES the real functions extracted from chat.html (no module export — same
 * brace-count + `new Function` harness as chat-action-request-sequential-resolve /
 * -independent-resolve).
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
    // Per-item answer inputs live at id `replyAnswerInput_<requestId>` — focus() only.
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

const postFor = (apiCall, reqId) =>
    resolvePosts(apiCall).find(([, url]) => url === `/api/action-requests/${reqId}/resolve`);

describe('需要你 inbox — batch / coexist replies (each item its own answer)', () => {
    it('stages A and B together; ONE collect+resolve → TWO POSTs, each with its OWN answer', async () => {
        const h = makeHarness();

        // Owner clicks Reply on A, then Reply on B — BOTH must coexist (not replace).
        h.focusActionRequestReply(REQ_A);
        h.focusActionRequestReply(REQ_B);
        const staged = h.getReplyContexts().filter(rc => rc.requestId);
        expect(staged.map(rc => rc.requestId)).toEqual([REQ_A, REQ_B]);   // FAIL-ON-OLD: was [REQ_B]

        // Each carries its OWN answer (as if typed into that chip's textarea).
        h.setAnswerText(REQ_A, 'ans A');
        h.setAnswerText(REQ_B, 'ans B');

        // ONE send: collect + resolve.
        const contexts = h.collectActionRequestReplyContexts();
        expect(contexts).toHaveLength(2);
        await h.resolveActionRequestReplyContexts(contexts, '');

        const posts = resolvePosts(h.apiCall);
        expect(posts).toHaveLength(2);                                    // FAIL-ON-OLD: was 0 (uniq>1 → resolve none)

        const pa = postFor(h.apiCall, REQ_A);
        const pb = postFor(h.apiCall, REQ_B);
        expect(pa).toBeDefined();
        expect(pb).toBeDefined();
        expect(pa[2].answer.text).toBe('ans A');                         // A resolves with A's own answer
        expect(pb[2].answer.text).toBe('ans B');                         // B resolves with B's own answer (NOT shared)
        expect(pa[2].answer.replyContext.requestId).toBe(REQ_A);
        expect(pb[2].answer.replyContext.requestId).toBe(REQ_B);

        // No "answer each separately" refusal anymore.
        expect(h.showToast).not.toHaveBeenCalledWith('action_request_one_at_a_time', 'error');
    });

    it('an option button on item B sets B\'s own answer and does NOT disturb A\'s answer', () => {
        const h = makeHarness();
        h.focusActionRequestReply(REQ_A);
        h.focusActionRequestReply(REQ_B);
        h.setAnswerText(REQ_A, 'my typed answer for A');   // owner typed A's answer

        // Click option index 1 on B — writes B-opt-1 into B's answer, NOT the composer.
        h.focusActionRequestReply(REQ_B, 1);

        const ctxs = h.getReplyContexts();
        const rcA = ctxs.find(rc => rc.requestId === REQ_A);
        const rcB = ctxs.find(rc => rc.requestId === REQ_B);
        expect(rcB.answerText).toBe('B-opt-1');            // option landed on B's own answer
        expect(rcA.answerText).toBe('my typed answer for A'); // A untouched
        expect(h.messageInput.value).toBe('');             // shared composer never written
    });

    it('single-item fallback: one staged item with EMPTY answer + shared param resolves with the shared text', async () => {
        const h = makeHarness();
        h.focusActionRequestReply(REQ_A);                  // no per-item answer typed
        const contexts = h.collectActionRequestReplyContexts();
        expect(contexts).toHaveLength(1);
        expect(contexts[0].answerText).toBe('');           // per-item answer empty

        await h.resolveActionRequestReplyContexts(contexts, 'answer typed in main composer');

        const posts = resolvePosts(h.apiCall);
        expect(posts).toHaveLength(1);
        expect(posts[0][1]).toBe(`/api/action-requests/${REQ_A}/resolve`);
        expect(posts[0][2].answer.text).toBe('answer typed in main composer'); // shared fallback
    });

    it('batch: item A has its own answer, item B is blank → only A resolves; B is SKIPPED (left pending), never given a sibling/shared text', async () => {
        const h = makeHarness();
        h.focusActionRequestReply(REQ_A);
        h.focusActionRequestReply(REQ_B);
        h.setAnswerText(REQ_A, 'specific A');              // A answered
        // B left blank. In a MULTI-item batch the shared composer text must NOT
        // leak onto B (card_2cfe0586 cross-contamination). B is skipped.
        await h.resolveActionRequestReplyContexts(h.collectActionRequestReplyContexts(), 'shared text meant for nobody in particular');

        const posts = resolvePosts(h.apiCall);
        expect(posts).toHaveLength(1);                     // only A resolved
        expect(postFor(h.apiCall, REQ_A)[2].answer.text).toBe('specific A');
        expect(postFor(h.apiCall, REQ_B)).toBeUndefined(); // B NOT resolved
    });

    it('cross-contamination guard: TWO blank items + shared composer text → resolves NEITHER (never broadcast one text across items — the card_2cfe0586 bug)', async () => {
        const h = makeHarness();
        h.focusActionRequestReply(REQ_A);
        h.focusActionRequestReply(REQ_B);
        // both per-item answers blank; owner typed once in the main composer.
        await h.resolveActionRequestReplyContexts(h.collectActionRequestReplyContexts(), 'one text for both — must not happen');

        // FAIL-ON-(agent's first cut): that code fell back to the shared text for
        // every blank item → 2 POSTs both with the same text = cross-contamination.
        expect(resolvePosts(h.apiCall)).toHaveLength(0);
    });

    it('independence: one resolve failure does NOT block the others', async () => {
        const h = makeHarness();
        // Fail the resolve for A only; B must still be POSTed.
        h.apiCall.mockImplementation(async (method, url) => {
            if (url === `/api/action-requests/${REQ_A}/resolve`) throw new Error('boom-A');
            return { success: true };
        });
        h.focusActionRequestReply(REQ_A);
        h.focusActionRequestReply(REQ_B);
        h.setAnswerText(REQ_A, 'ans A');
        h.setAnswerText(REQ_B, 'ans B');

        await h.resolveActionRequestReplyContexts(h.collectActionRequestReplyContexts(), '');

        // Both were attempted; B succeeded independently of A's failure.
        expect(postFor(h.apiCall, REQ_A)).toBeDefined();
        expect(postFor(h.apiCall, REQ_B)).toBeDefined();
        expect(postFor(h.apiCall, REQ_B)[2].answer.text).toBe('ans B');
        // A success toast is still shown (1 resolved), never a fatal throw.
        expect(h.showToast).toHaveBeenCalled();
    });

    it('regular chat quotes are preserved alongside staged inbox items (multi-quote card_277c80f5 intact)', () => {
        const h = makeHarness();
        h.addReplyContext('msg-100', 'Alice', 'a normal quoted message', { kind: 'chat-system' });
        h.focusActionRequestReply(REQ_A);
        h.focusActionRequestReply(REQ_B);
        const ctxs = h.getReplyContexts();
        // The plain chat quote survives and stays a NON-action-request context.
        expect(ctxs.some(rc => rc.msgId === 'msg-100' && !rc.requestId)).toBe(true);
        // collect() only returns the action-request contexts (chat quote excluded).
        expect(h.collectActionRequestReplyContexts().map(c => c.requestId)).toEqual([REQ_A, REQ_B]);
    });
});
