'use strict';

/**
 * Regression — cross-tab deep-link must fall back to a single-card fetch.
 *
 * Bug (Hank: "task cards often won't open" from a chat chip / 需要你 inbox /
 * notification): kanban.html's handleHashDeepLink() resolved the target card
 * with findCard() only. findCard scans the currently-loaded board slice
 * (allCards + automationCards), so a deep-link to a done/archived/other-column
 * card — or one that just hasn't been paged in yet — MISSED, and the handler
 * gave up with a "Not found" toast, never asking the backend.
 *
 * Fix pinned here: on a findCard() miss, handleHashDeepLink() must await
 * ensureCardLoaded(cardId) (single-card fetch by id) BEFORE toasting. Only if
 * that ALSO returns null does it toast "Not found".
 *
 * Harness mirrors kanban-stale-dep-gating.test.js: brace-extract the real
 * function body out of kanban.html and run it via `new Function` with stubbed
 * dependencies, so the test breaks if the source stops calling the fallback.
 */

const fs = require('fs');
const path = require('path');

const kanbanHtml = fs.readFileSync(
    path.join(__dirname, '..', '..', 'public', 'portal', 'kanban.html'),
    'utf8'
);

function extractFunctionBody(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) throw new Error(`function not found: ${signature}`);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return src.slice(open, i + 1);
        }
    }
    throw new Error(`unterminated function: ${signature}`);
}

// Signature intentionally omits the `async` prefix so it matches both the fixed
// `async function handleHashDeepLink()` and any hypothetical non-async/no-fallback
// variant — the behavioural assertions (not the extraction) are what fail-on-old.
const handlerBody = extractFunctionBody(kanbanHtml, 'function handleHashDeepLink()');

// Instantiate the REAL handleHashDeepLink body with injected deps. The body
// reads parseDeepLinkHash / findCard / ensureCardLoaded / openDetail /
// showToast / t / loadComments, reads `openCardId`, and WRITES
// `pendingCommentAnchor` — so we declare both bits of module state as `let`
// bindings in the wrapper scope. The body references them by their bare names,
// exactly as in kanban.html, so no source rewriting is needed.
function makeHandler(deps) {
    // eslint-disable-next-line no-new-func
    const factory = new Function(
        'parseDeepLinkHash', 'findCard', 'ensureCardLoaded', 'openDetail',
        'showToast', 't', 'loadComments', 'openCardId', '__state',
        `
        let pendingCommentAnchor = __state.pendingCommentAnchor;
        const __run = async function handleHashDeepLink() ${handlerBody};
        return async function () {
            await __run();
            __state.pendingCommentAnchor = pendingCommentAnchor;
        };
        `
    );
    const state = { pendingCommentAnchor: null };
    const handler = factory(
        deps.parseDeepLinkHash,
        deps.findCard,
        deps.ensureCardLoaded,
        deps.openDetail,
        deps.showToast,
        deps.t,
        deps.loadComments,
        deps.openCardId,
        state
    );
    handler.getPendingAnchor = () => state.pendingCommentAnchor;
    return handler;
}

const baseDeps = () => ({
    parseDeepLinkHash: () => ({ cardId: 'card_abc12345', commentAnchor: null }),
    findCard: jest.fn(() => null),
    ensureCardLoaded: jest.fn(async () => null),
    openDetail: jest.fn(),
    showToast: jest.fn(),
    t: (_key, fallback) => fallback,
    loadComments: jest.fn(),
    openCardId: null,
});

describe('handleHashDeepLink — single-card fetch fallback on findCard miss', () => {
    test('source still calls ensureCardLoaded as the miss fallback (fail-on-old)', () => {
        // The old handler was: `const card = findCard(target.cardId);` with NO
        // fetch fallback, then straight to the "Not found" toast. This assertion
        // fails on that old shape.
        expect(handlerBody).toMatch(
            /findCard\(target\.cardId\)\s*\|\|\s*await ensureCardLoaded\(target\.cardId\)/
        );
    });

    test('when findCard misses but the backend HAS the card → fetches it and opens detail (no toast)', async () => {
        const fetched = { id: 'card_abc12345', title: 'Done column card' };
        const deps = baseDeps();
        deps.ensureCardLoaded = jest.fn(async () => fetched);
        const handler = makeHandler(deps);

        await handler();

        expect(deps.findCard).toHaveBeenCalledWith('card_abc12345');
        // The fallback fetch ran...
        expect(deps.ensureCardLoaded).toHaveBeenCalledWith('card_abc12345');
        // ...and the card opened, without a "Not found" toast.
        expect(deps.openDetail).toHaveBeenCalledWith('card_abc12345');
        expect(deps.showToast).not.toHaveBeenCalled();
    });

    test('only toasts "Not found" when the fetch ALSO returns null', async () => {
        const deps = baseDeps();
        deps.findCard = jest.fn(() => null);
        deps.ensureCardLoaded = jest.fn(async () => null); // backend genuinely has no such card
        const handler = makeHandler(deps);

        await handler();

        expect(deps.ensureCardLoaded).toHaveBeenCalledWith('card_abc12345');
        expect(deps.openDetail).not.toHaveBeenCalled();
        expect(deps.showToast).toHaveBeenCalledTimes(1);
        expect(deps.showToast.mock.calls[0][0]).toBe('Not found: card_abc12345');
        expect(deps.showToast.mock.calls[0][1]).toBe(true);
    });

    test('happy path unchanged: card already in board → opens WITHOUT a backend fetch', async () => {
        const inBoard = { id: 'card_abc12345', title: 'Already loaded' };
        const deps = baseDeps();
        deps.findCard = jest.fn(() => inBoard);
        deps.ensureCardLoaded = jest.fn(async () => { throw new Error('should not fetch on happy path'); });
        const handler = makeHandler(deps);

        await handler();

        expect(deps.findCard).toHaveBeenCalledWith('card_abc12345');
        // Short-circuit: findCard hit, so ensureCardLoaded is never awaited.
        expect(deps.ensureCardLoaded).not.toHaveBeenCalled();
        expect(deps.openDetail).toHaveBeenCalledWith('card_abc12345');
        expect(deps.showToast).not.toHaveBeenCalled();
    });

    test('comment anchor is preserved through the fetch-fallback path', async () => {
        const fetched = { id: 'card_abc12345', title: 'Fetched with anchor' };
        const deps = baseDeps();
        deps.parseDeepLinkHash = () => ({ cardId: 'card_abc12345', commentAnchor: '1a2b3c4d-5e6f' });
        deps.ensureCardLoaded = jest.fn(async () => fetched);
        const handler = makeHandler(deps);

        await handler();

        expect(deps.openDetail).toHaveBeenCalledWith('card_abc12345');
        expect(handler.getPendingAnchor()).toBe('1a2b3c4d-5e6f');
    });

    test('no target (non-card hash) → returns early, no fetch, no toast', async () => {
        const deps = baseDeps();
        deps.parseDeepLinkHash = () => null;
        const handler = makeHandler(deps);

        await handler();

        expect(deps.findCard).not.toHaveBeenCalled();
        expect(deps.ensureCardLoaded).not.toHaveBeenCalled();
        expect(deps.openDetail).not.toHaveBeenCalled();
        expect(deps.showToast).not.toHaveBeenCalled();
    });
});
