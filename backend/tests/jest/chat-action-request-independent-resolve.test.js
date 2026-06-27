/**
 * 需要你 inbox INDEPENDENCE — frontend resolve targeting (chat.html).
 *
 * P0 bug: the owner sent ONE reply (intended for inbox item A) and the chat sent
 * a resolve for EVERY accumulated action-request reply context with that SAME
 * text — so an unrelated pending item B was also marked resolved with A's answer.
 *
 * This EXECUTES resolveActionRequestReplyContexts() (extracted from chat.html,
 * which has no module export — same brace-count + `new Function` harness the
 * sibling chat-action-request-inbox-behavior.test.js uses) and pins:
 *   - exactly ONE distinct request → resolves exactly that one item.
 *   - MULTIPLE distinct requests in one send → resolves NONE + warns the owner to
 *     answer each separately (no cross-contamination).
 *
 * FAIL-ON-OLD: the old body looped over every context calling /resolve with the
 * shared answerText, so the multi-target test saw 2 resolve POSTs; now it sees 0.
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

    it('TWO distinct requests in one send resolve NONE (no cross-contamination)', async () => {
        const { fn, apiCall, showToast } = makeHarness();
        await fn(
            [{ requestId: REQ_A, anchorMessageId: null }, { requestId: REQ_B, anchorMessageId: null }],
            'pin answer — must NOT also resolve the migration request'
        );
        // FAIL-ON-OLD: old code POSTed a resolve for BOTH REQ_A and REQ_B.
        expect(resolvePosts(apiCall)).toHaveLength(0);
        // The owner is told to answer each request separately.
        expect(showToast).toHaveBeenCalledWith('action_request_one_at_a_time', 'error');
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
