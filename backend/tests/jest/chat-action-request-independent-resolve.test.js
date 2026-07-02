/**
 * 需要你 inbox INDEPENDENCE — frontend resolve targeting (chat.html).
 *
 * P0 bug (history): the owner sent ONE reply (intended for inbox item A) and the
 * chat resolved EVERY accumulated action-request context with that SAME text — so an
 * unrelated item B was resolved with A's answer (cross-contamination). #3787 fixed
 * this by REFUSING when >1 item was staged; the product decision then EVOLVED to
 * batch/coexist, where each staged item carries its OWN answer (ctx.answerText) and a
 * single Send resolves EACH with its own text (no shared broadcast, no refusal).
 *
 * This EXECUTES resolveActionRequestReplyContexts() (extracted from chat.html, which
 * has no module export — same brace-count + `new Function` harness the sibling
 * chat-action-request-inbox-behavior.test.js uses) and pins:
 *   - exactly ONE distinct request → resolves exactly that one item.
 *   - MULTIPLE distinct requests, EACH with its own answerText → each resolves with
 *     ITS OWN text (no cross-contamination — A's answer never lands on B).
 *   - a duplicate of the same request collapses to a single resolve.
 *
 * CHANGED (why): the old "TWO distinct requests → resolve NONE + one_at_a_time toast"
 * assertion pinned the reverted #3787 refuse behaviour; under batch/coexist the two
 * items now resolve independently with their own answers. Updated below.
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

function makeHarness() {
    const apiCall = jest.fn(async () => ({ success: true }));
    const showToast = jest.fn();
    const loadActionRequests = jest.fn(async () => {});
    const currentUser = { deviceId: 'dev-1', deviceSecret: 'sec-1' };
    const i18n = { t: (k) => k }; // returns the key; `|| fallback` keeps fallback truthy

    const factory = new Function(
        'apiCall', 'showToast', 'loadActionRequests', 'currentUser', 'i18n', 'console',
        `${extractFunction('resolveActionRequestReplyContexts')}
         return resolveActionRequestReplyContexts;`
    );
    const fn = factory(apiCall, showToast, loadActionRequests, currentUser, i18n, console);
    return { fn, apiCall, showToast, loadActionRequests };
}

const resolvePosts = (apiCall) =>
    apiCall.mock.calls.filter(([method, url]) => method === 'POST' && /\/api\/action-requests\/.+\/resolve$/.test(url));

describe('resolveActionRequestReplyContexts — one reply resolves exactly one item', () => {
    it('a single targeted request resolves exactly that request', async () => {
        const { fn, apiCall } = makeHarness();
        await fn([{ requestId: REQ_A, anchorMessageId: null }], 'pin answer for A');
        const posts = resolvePosts(apiCall);
        expect(posts).toHaveLength(1);
        expect(posts[0][1]).toBe(`/api/action-requests/${REQ_A}/resolve`);
        expect(posts[0][2].answer.text).toBe('pin answer for A');
        expect(posts[0][2].answer.replyContext.requestId).toBe(REQ_A);
    });

    it('TWO distinct requests, each with its OWN answer, resolve independently (no cross-contamination)', async () => {
        const { fn, apiCall, showToast } = makeHarness();
        await fn(
            [
                { requestId: REQ_A, anchorMessageId: null, answerText: 'answer for A' },
                { requestId: REQ_B, anchorMessageId: null, answerText: 'answer for B' },
            ],
            'shared fallback — must NOT be used since both carry their own answer'
        );
        const posts = resolvePosts(apiCall);
        expect(posts).toHaveLength(2);   // batch/coexist: BOTH resolve (was 0 under the #3787 refuse)
        const byId = Object.fromEntries(posts.map(p => [p[1], p[2].answer.text]));
        // Each request resolves with its OWN answer — A's text never lands on B.
        expect(byId[`/api/action-requests/${REQ_A}/resolve`]).toBe('answer for A');
        expect(byId[`/api/action-requests/${REQ_B}/resolve`]).toBe('answer for B');
        // No "answer each separately" refusal anymore.
        expect(showToast).not.toHaveBeenCalledWith('action_request_one_at_a_time', 'error');
    });

    it('a duplicate of the same request collapses to a single resolve', async () => {
        const { fn, apiCall } = makeHarness();
        await fn(
            [{ requestId: REQ_A, anchorMessageId: null }, { requestId: REQ_A, anchorMessageId: null }],
            'one answer'
        );
        expect(resolvePosts(apiCall)).toHaveLength(1);
    });
});
