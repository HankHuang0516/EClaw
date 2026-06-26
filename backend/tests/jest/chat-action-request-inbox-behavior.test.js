/**
 * chat-action-request-inbox-behavior — BEHAVIORAL (runtime-executing) tests for
 * the "需要你" action-request inbox in the portal chat UI.
 *
 * Card: card_18c430755e.
 *
 * The sibling file `chat-action-request-inbox.test.js` is source-grep only
 * (readFileSync + toContain/toMatch) — it proves the code EXISTS. This file
 * EXECUTES the inbox interaction logic: it extracts the relevant function
 * bodies out of chat.html (which has no module export) and runs them inside a
 * single `new Function(...)` sandbox wired to a hand-rolled DOM + a mutable
 * `apiCall` stub + a fake `localStorage`. No jsdom dependency is added — this
 * mirrors the harness already used by chat-sendto-picker.test.js
 * (extractFunction brace-counting + `new Function`) and
 * sendto-picker-avatar-click.test.js (eval a script in a sandbox to obtain the
 * functions under test). jest.config.js is testEnvironment:'node'.
 *
 * Symbols exercised (all live inline in public/portal/chat.html):
 *   - renderActionRequestInbox  (collapsed-by-default summary render)
 *   - setActionRequestInboxOpen (localStorage persistence)
 *   - the summary click handler (aria-expanded + is-open toggle)
 *   - onSocketActionRequestChanged → scheduleActionRequestRefresh →
 *     loadActionRequests (resolved socket event re-fetches, drops the item)
 *   - dismissActionRequest       (optimistic removal + 404/409/410 = success)
 *
 * Determinism: every network call is the injected `apiCall` mock, i18n is a
 * stub, timers are jest fake timers (scheduleActionRequestRefresh debounces
 * 120ms via setTimeout), and request ids are fixed UUIDs (normalizeChatMessageId
 * requires the 8-4-4-4-12 hex shape or it silently no-ops).
 */
'use strict';

const fs = require('fs');
const path = require('path');

const chatHtmlPath = path.join(__dirname, '..', '..', 'public', 'portal', 'chat.html');
const chatHtml = fs.readFileSync(chatHtmlPath, 'utf8');

// ── extractFunction: brace-count a top-level function body out of chat.html ──
// Identical technique to chat-sendto-picker.test.js.
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

// Fixed, valid UUIDs (normalizeChatMessageId only accepts this shape).
const REQ_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const REQ_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const REQ_C = 'cccccccc-0000-4000-8000-000000000003';

function makeRequest(id, over = {}) {
    return Object.assign({
        id,
        status: 'pending',
        type: 'decision',
        fromEntityId: 5,
        prompt: 'Please decide on X',
        anchorMessageId: null,
        options: [],
    }, over);
}

// ── DOM shim ────────────────────────────────────────────────────────────────
// A minimal but real element model: className/classList, attributes,
// textContent, child list, addEventListener+click dispatch, querySelector for
// the one selector the empty-state teardown uses ('.action-request-inbox').
function makeElement(tag) {
    const el = {
        tagName: String(tag || 'div').toUpperCase(),
        type: '',
        id: '',
        _className: '',
        attrs: {},
        dataset: {},
        style: {},
        children: [],
        parent: null,
        _listeners: {},
        _text: '',
    };
    Object.defineProperty(el, 'className', {
        get() { return el._className; },
        set(v) { el._className = String(v); },
    });
    Object.defineProperty(el, 'textContent', {
        get() { return el._text; },
        // Assigning textContent clears children (matches the real DOM contract
        // chat.html relies on: `banner.textContent = ''` wipes the subtree).
        set(v) { el._text = String(v); el.children.length = 0; },
    });
    el.classList = {
        contains(c) { return el._className.split(/\s+/).filter(Boolean).indexOf(c) !== -1; },
        add(c) {
            const set = new Set(el._className.split(/\s+/).filter(Boolean));
            set.add(c); el._className = Array.from(set).join(' ');
        },
        remove(c) {
            const set = new Set(el._className.split(/\s+/).filter(Boolean));
            set.delete(c); el._className = Array.from(set).join(' ');
        },
        toggle(c, force) {
            const has = this.contains(c);
            const want = (force === undefined) ? !has : !!force;
            if (want) this.add(c); else this.remove(c);
            return want;
        },
    };
    el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
    el.getAttribute = (k) => (Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null);
    el.appendChild = (child) => { child.parent = el; el.children.push(child); return child; };
    el.addEventListener = (evt, cb) => {
        (el._listeners[evt] = el._listeners[evt] || []).push(cb);
    };
    el.removeEventListener = (evt, cb) => {
        const arr = el._listeners[evt] || [];
        const idx = arr.indexOf(cb);
        if (idx >= 0) arr.splice(idx, 1);
    };
    // Test helper: fire a click on this element.
    el.click = () => { (el._listeners.click || []).slice().forEach(cb => cb({ target: el })); };
    // Recursive descendant search for the only selector chat.html queries here.
    el.querySelector = (sel) => {
        const want = sel.replace(/^\./, '');
        const stack = el.children.slice();
        while (stack.length) {
            const node = stack.shift();
            if (node.classList && node.classList.contains(want)) return node;
            stack.push(...node.children);
        }
        return null;
    };
    return el;
}

// Find the first descendant (depth-first) matching a class — test-side helper.
function findByClass(root, cls) {
    const stack = root.children.slice();
    while (stack.length) {
        const node = stack.shift();
        if (node.classList.contains(cls)) return node;
        stack.unshift(...node.children);
    }
    return null;
}

// Collect ALL descendants matching a class.
function findAllByClass(root, cls) {
    const out = [];
    const stack = root.children.slice();
    while (stack.length) {
        const node = stack.shift();
        if (node.classList.contains(cls)) out.push(node);
        stack.unshift(...node.children);
    }
    return out;
}

// ── localStorage shim ────────────────────────────────────────────────────────
function makeLocalStorage(initial = {}) {
    const store = Object.assign({}, initial);
    return {
        getItem(k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
        setItem(k, v) { store[k] = String(v); },
        removeItem(k) { delete store[k]; },
        _store: store,
    };
}

// ── Sandbox factory: build all inbox functions in one closure ─────────────────
// We splice the inbox-relevant function bodies + the state-var declarations into
// a single Function so they share the SAME `actionRequests` / `actionRequestInboxOpen`
// closure exactly as they do in chat.html. We then return the public API + live
// state accessors.
function makeInbox(opts = {}) {
    const localStorageStub = makeLocalStorage(opts.storage || {});
    const banner = makeElement('div');
    banner.id = 'greetBanner';
    banner.style.display = 'none';

    const messageInput = makeElement('textarea');
    messageInput.id = 'messageInput';

    const elementsById = { greetBanner: banner, messageInput };

    const document = {
        createElement: (tag) => makeElement(tag),
        getElementById: (id) => elementsById[id] || null,
    };

    // Mutable apiCall mock — each test installs its own behavior.
    const apiCallMock = opts.apiCall || jest.fn(async () => ({ requests: [] }));

    // showToast spy — tests assert error toasts are/aren't raised.
    const showToast = opts.showToast || jest.fn();

    const i18nStub = {
        t(key, vars) {
            const dict = {
                action_request_inbox_title: 'Needs you',
                action_request_inbox_count: '{count} pending',
                action_request_realtime_on: 'Live',
                action_request_realtime_off: 'Manual refresh',
                action_request_inbox_reply: 'Reply',
                action_request_inbox_dismiss: 'Dismiss',
                action_request_inbox_anchor: 'Show source',
                action_request_meta: 'Entity #{entityId} · {type}',
                action_request_dismissed: 'Request dismissed',
                action_request_filter_label: 'Filter requests',
                action_request_filter_all: 'All',
                action_request_filter_consensus: 'Consensus',
                action_request_filter_empty: 'No requests match this filter.',
                action_request_card_link: '🗂 Task card',
                action_request_card_link_title: 'Open linked card {card}',
                chat_send_failed: 'Failed',
            };
            let s = dict[key] || key;
            if (vars) Object.keys(vars).forEach(k => { s = String(s).replace('{' + k + '}', vars[k]); });
            return s;
        },
    };

    // window carries i18n (actionRequestT reads window.i18n). The greeting
    // feature was removed (card_cc9700b7) — there is no window.EclawGreeting.
    const windowStub = {
        i18n: i18nStub,
        openHistoryMessage: undefined,
    };

    const currentUser = (opts.currentUser !== undefined)
        ? opts.currentUser
        : { deviceId: 'dev-1', deviceSecret: 'sec-1' };

    // Compose the spliced source: state vars + the needed function bodies.
    // Order matters only for hoisting of `const`; functions hoist regardless.
    const stateDecls = `
        let actionRequests = [];
        let actionRequestsLoaded = false;
        let actionRequestsLoading = false;
        let actionRequestRealtimeEnabled = true;
        const actionRequestConsensusTriggeredIds = new Set();
        let actionRequestRefreshTimer = null;
        const ACTION_REQUEST_INBOX_OPEN_KEY = 'needsyou_inbox_open';
        let actionRequestInboxOpen = (() => {
            try { return localStorage.getItem(ACTION_REQUEST_INBOX_OPEN_KEY) === '1'; } catch (_) { return false; }
        })();
        const ACTION_REQUEST_INBOX_FILTER_KEY = 'needsyou_inbox_filter';
        let actionRequestInboxFilter = (() => {
            try { return localStorage.getItem(ACTION_REQUEST_INBOX_FILTER_KEY) === 'consensus' ? 'consensus' : 'all'; }
            catch (_) { return 'all'; }
        })();
        let actionRequestsRefreshPending = false;
        let actionRequestsRefreshPendingRender = false;
        let replyContexts = [];
    `;

    const fnBodies = [
        extractFunction('normalizeChatMessageId'),
        extractFunction('getActionRequestById'),
        extractFunction('actionRequestT'),
        extractFunction('actionRequestTypeMeta'),
        extractFunction('isActionRequestConsensusTriggered'),
        extractFunction('markActionRequestConsensusTriggered'),
        extractFunction('clearActionRequestConsensusTriggered'),
        extractFunction('loadActionRequests'),
        extractFunction('scheduleActionRequestRefresh'),
        // onSocketActionRequestChanged is `window.onSocketActionRequestChanged = function(...)`
        // — captured via a dedicated slice below, not extractFunction.
        extractFunction('removeReplyContextForRequest'),
        extractFunction('dismissActionRequest'),
        extractFunction('setActionRequestInboxOpen'),
        // 計畫C inbox 篩選條件 facet helpers referenced by renderActionRequestInbox.
        extractFunction('setActionRequestInboxFilter'),
        extractFunction('actionRequestMatchesFilter'),
        extractFunction('renderActionRequestInbox'),
        // The inbox render entry point loadActionRequests/dismissActionRequest
        // funnel through (replaced EclawGreeting.maybeShow; card_cc9700b7).
        extractFunction('refreshActionRequestBanner'),
    ].join('\n');

    // Slice the socket handler (assigned to window.*) out by hand.
    const socketStart = chatHtml.indexOf('window.onSocketActionRequestChanged = function');
    const socketEnd = chatHtml.indexOf('\n        };', socketStart) + '\n        };'.length;
    const socketSrc = chatHtml.slice(socketStart, socketEnd);

    // Stubs for helpers the spliced bodies reference but we don't exercise.
    const stubs = `
        function renderReplyPreviews() {}
        function recomputeAutoReceivers() {}
        // 計畫D: the 🗂 任務卡 chip click handler calls openKanbanCard — not invoked
        // during render, stubbed so a click test could spy on it if needed.
        function openKanbanCard() {}
        const CHAT_MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    `;

    const body = `
        ${stateDecls}
        ${stubs}
        ${fnBodies}
        ${socketSrc}
        return {
            // public API under test
            loadActionRequests,
            scheduleActionRequestRefresh,
            onSocketActionRequestChanged: window.onSocketActionRequestChanged,
            dismissActionRequest,
            setActionRequestInboxOpen,
            renderActionRequestInbox,
            refreshActionRequestBanner,
            // live-state accessors (read the SAME closure vars the fns mutate)
            getActionRequests: () => actionRequests,
            setActionRequests: (v) => { actionRequests = v; },
            getInboxOpen: () => actionRequestInboxOpen,
            setLoaded: (v) => { actionRequestsLoaded = v; },
            getLoaded: () => actionRequestsLoaded,
        };
    `;

    /* eslint-disable no-new-func */
    const factory = new Function(
        'document', 'window', 'i18n', 'localStorage',
        'apiCall', 'currentUser', 'showToast',
        body
    );
    const api = factory(
        document, windowStub, i18nStub, localStorageStub,
        apiCallMock, currentUser, showToast
    );

    return { api, banner, document, localStorage: localStorageStub, apiCall: apiCallMock, showToast, currentUser };
}

// ════════════════════════════════════════════════════════════════════════════
// Behavior 1 — render → collapsed by default
// ════════════════════════════════════════════════════════════════════════════
describe('inbox render — collapsed by default (no stored preference)', () => {
    test('renders the one-line summary (🔔 + title + count + ▼) with body collapsed', () => {
        const { api, banner } = makeInbox(); // no storage → actionRequestInboxOpen = false
        api.setActionRequests([makeRequest(REQ_A), makeRequest(REQ_B)]);

        api.renderActionRequestInbox(banner);

        const wrap = findByClass(banner, 'action-request-inbox');
        expect(wrap).not.toBeNull();
        // Collapsed: the wrap must NOT carry is-open (CSS hides the body unless
        // .is-open .action-request-inbox-body { display:flex }).
        expect(wrap.classList.contains('is-open')).toBe(false);

        const summary = findByClass(banner, 'action-request-inbox-summary');
        expect(summary).not.toBeNull();
        expect(summary.tagName).toBe('BUTTON');
        expect(summary.getAttribute('aria-expanded')).toBe('false');

        // Bell + chevron glyphs + count text present in the summary.
        expect(findByClass(summary, 'ar-bell')._text).toBe('🔔');
        expect(findByClass(summary, 'ar-chevron')._text).toBe('▼');
        const count = findByClass(summary, 'action-request-inbox-count');
        expect(count._text).toBe('2 pending');

        // The expandable body element exists (DOM is built) but display is gated
        // by the absent is-open class, not by removal.
        const body = findByClass(wrap, 'action-request-inbox-body');
        expect(body).not.toBeNull();
        expect(body.id).toBe('actionRequestInboxBody');
        // One .action-request-item per pending request.
        expect(findAllByClass(body, 'action-request-item').length).toBe(2);
    });

    test('stored preference "1" → renders expanded (is-open + aria-expanded=true)', () => {
        const { api, banner } = makeInbox({ storage: { needsyou_inbox_open: '1' } });
        api.setActionRequests([makeRequest(REQ_A)]);
        api.renderActionRequestInbox(banner);

        const wrap = findByClass(banner, 'action-request-inbox');
        expect(wrap.classList.contains('is-open')).toBe(true);
        const summary = findByClass(banner, 'action-request-inbox-summary');
        expect(summary.getAttribute('aria-expanded')).toBe('true');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Behavior 2 — toggle: expand/collapse persists + reflects aria-expanded
// ════════════════════════════════════════════════════════════════════════════
describe('inbox toggle — persists needsyou_inbox_open + flips aria-expanded', () => {
    test('clicking the summary expands, persists "1", flips aria + is-open', () => {
        const { api, banner, localStorage } = makeInbox(); // starts collapsed
        api.setActionRequests([makeRequest(REQ_A)]);
        api.renderActionRequestInbox(banner);

        const wrap = findByClass(banner, 'action-request-inbox');
        const summary = findByClass(banner, 'action-request-inbox-summary');
        expect(wrap.classList.contains('is-open')).toBe(false);
        expect(localStorage.getItem('needsyou_inbox_open')).toBeNull();

        // First click → expand.
        summary.click();
        expect(wrap.classList.contains('is-open')).toBe(true);
        expect(summary.getAttribute('aria-expanded')).toBe('true');
        expect(localStorage.getItem('needsyou_inbox_open')).toBe('1');
        expect(api.getInboxOpen()).toBe(true);

        // Second click → collapse.
        summary.click();
        expect(wrap.classList.contains('is-open')).toBe(false);
        expect(summary.getAttribute('aria-expanded')).toBe('false');
        expect(localStorage.getItem('needsyou_inbox_open')).toBe('0');
        expect(api.getInboxOpen()).toBe(false);
    });

    test('setActionRequestInboxOpen writes "1"/"0" to localStorage directly', () => {
        const { api, localStorage } = makeInbox();
        api.setActionRequestInboxOpen(true);
        expect(localStorage.getItem('needsyou_inbox_open')).toBe('1');
        expect(api.getInboxOpen()).toBe(true);
        api.setActionRequestInboxOpen(false);
        expect(localStorage.getItem('needsyou_inbox_open')).toBe('0');
        expect(api.getInboxOpen()).toBe(false);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Behavior 3 — resolved socket event → item removed
// ════════════════════════════════════════════════════════════════════════════
describe('inbox socket — "resolved" event removes exactly that item', () => {
    beforeEach(() => { jest.useFakeTimers(); });
    afterEach(() => { jest.runOnlyPendingTimers(); jest.useRealTimers(); });

    test('onSocketActionRequestChanged({kind:resolved}) refetches → drops the resolved id', async () => {
        // apiCall mock returns the remaining (still-pending) requests — i.e. the
        // server view AFTER REQ_B resolved.
        const apiCall = jest.fn(async () => ({
            requests: [makeRequest(REQ_A), makeRequest(REQ_C)],
        }));
        const { api } = makeInbox({ apiCall });
        api.setLoaded(true);
        api.setActionRequests([makeRequest(REQ_A), makeRequest(REQ_B), makeRequest(REQ_C)]);
        expect(api.getActionRequests().map(r => r.id)).toEqual([REQ_A, REQ_B, REQ_C]);

        // Socket: REQ_B was resolved elsewhere.
        api.onSocketActionRequestChanged({ kind: 'resolved', requestId: REQ_B });

        // Debounced 120ms via scheduleActionRequestRefresh.
        expect(apiCall).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(120);

        expect(apiCall).toHaveBeenCalledTimes(1);
        const [method, url] = apiCall.mock.calls[0];
        expect(method).toBe('GET');
        expect(url).toMatch(/\/api\/action-requests\?/);
        // REQ_B gone, the other two remain.
        const ids = api.getActionRequests().map(r => r.id);
        expect(ids).toEqual([REQ_A, REQ_C]);
        expect(ids).not.toContain(REQ_B);
    });

    test('unrelated socket kind (e.g. "noise") schedules no refetch', async () => {
        const apiCall = jest.fn(async () => ({ requests: [] }));
        const { api } = makeInbox({ apiCall });
        api.setLoaded(true);
        api.setActionRequests([makeRequest(REQ_A)]);

        api.onSocketActionRequestChanged({ kind: 'noise', requestId: REQ_A });
        await jest.advanceTimersByTimeAsync(200);

        expect(apiCall).not.toHaveBeenCalled();
        expect(api.getActionRequests().map(r => r.id)).toEqual([REQ_A]);
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Behavior 4 — dismiss is idempotent (404/409/410 = success, no error toast)
// ════════════════════════════════════════════════════════════════════════════
describe('inbox dismiss — already-resolved (404/409/410) treated as success', () => {
    function makeRejecting(status) {
        // POST /dismiss rejects with the given status; GET refetch returns empty.
        return jest.fn(async (method, url) => {
            if (method === 'POST' && /\/dismiss$/.test(url)) {
                const err = new Error('gone');
                err.status = status;
                throw err;
            }
            return { requests: [] }; // post-dismiss refetch
        });
    }

    test.each([404, 409, 410])('status %i → item optimistically removed, no error toast', async (status) => {
        const apiCall = makeRejecting(status);
        const showToast = jest.fn();
        const { api } = makeInbox({ apiCall, showToast });
        api.setLoaded(true);
        api.setActionRequests([makeRequest(REQ_A), makeRequest(REQ_B)]);

        await api.dismissActionRequest(REQ_B);

        // Optimistically removed (the optimistic filter runs BEFORE the POST).
        expect(api.getActionRequests().map(r => r.id)).not.toContain(REQ_B);
        // No error toast was raised; only the success toast (if any) is allowed.
        const errorToasts = showToast.mock.calls.filter(c => c[1] === 'error');
        expect(errorToasts).toHaveLength(0);
        // The "Request dismissed" success toast IS shown on the swallowed-error path.
        const successToasts = showToast.mock.calls.filter(c => c[1] === 'success');
        expect(successToasts.some(c => c[0] === 'Request dismissed')).toBe(true);
    });

    test('a genuine 500 error DOES raise an error toast (negative control)', async () => {
        const apiCall = jest.fn(async (method, url) => {
            if (method === 'POST' && /\/dismiss$/.test(url)) {
                const err = new Error('boom');
                err.status = 500;
                throw err;
            }
            return { requests: [] };
        });
        const showToast = jest.fn();
        const { api } = makeInbox({ apiCall, showToast });
        api.setLoaded(true);
        api.setActionRequests([makeRequest(REQ_A)]);

        await api.dismissActionRequest(REQ_A);

        // Item still optimistically removed (the UI never re-adds on failure)…
        expect(api.getActionRequests().map(r => r.id)).not.toContain(REQ_A);
        // …but a 500 is a real failure → error toast IS surfaced.
        const errorToasts = showToast.mock.calls.filter(c => c[1] === 'error');
        expect(errorToasts).toHaveLength(1);
        expect(errorToasts[0][0]).toMatch(/Failed/);
    });

    test('dismiss with a successful POST removes the item + shows success toast', async () => {
        const apiCall = jest.fn(async () => ({ requests: [] }));
        const showToast = jest.fn();
        const { api } = makeInbox({ apiCall, showToast });
        api.setLoaded(true);
        api.setActionRequests([makeRequest(REQ_A), makeRequest(REQ_B)]);

        await api.dismissActionRequest(REQ_A);

        expect(api.getActionRequests().map(r => r.id)).not.toContain(REQ_A);
        const errorToasts = showToast.mock.calls.filter(c => c[1] === 'error');
        expect(errorToasts).toHaveLength(0);
        expect(showToast).toHaveBeenCalledWith('Request dismissed', 'success');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Behavior 5 — refreshActionRequestBanner: inbox-or-hide (greeting fully removed)
// ────────────────────────────────────────────────────────────────────────────
// Plan A (Hank 2026-06-26 opt1 全砍 greeting; card_cc9700b7 / card_168aeb1f) deleted
// the EclawGreeting feature outright. The single render entry is now
// refreshActionRequestBanner(): render the inbox while there are pending
// requests, otherwise tear the banner down and hide it — NO greeting fallback.
// ════════════════════════════════════════════════════════════════════════════
describe('refreshActionRequestBanner — inbox-or-hide (greeting removed)', () => {
    test('pending requests → renders the inbox into the banner (banner visible)', () => {
        const { api, banner } = makeInbox();
        api.setLoaded(true);
        api.setActionRequests([makeRequest(REQ_A), makeRequest(REQ_B)]);

        api.refreshActionRequestBanner();

        expect(findByClass(banner, 'action-request-inbox')).not.toBeNull();
        expect(banner.style.display).not.toBe('none');
    });

    test('emptied inbox → tears down the stale inbox DOM and hides the banner (no greeting)', () => {
        const { api, banner } = makeInbox();
        api.setLoaded(true);
        // First a pending request mounts the inbox…
        api.setActionRequests([makeRequest(REQ_A)]);
        api.refreshActionRequestBanner();
        expect(findByClass(banner, 'action-request-inbox')).not.toBeNull();

        // …then it clears → banner must be emptied + hidden, with no greeting markup.
        api.setActionRequests([]);
        api.refreshActionRequestBanner();

        expect(findByClass(banner, 'action-request-inbox')).toBeNull();
        expect(banner.style.display).toBe('none');
        expect(banner.textContent).toBe('');
        // No greeting fallback chips leak into the empty banner.
        expect(findByClass(banner, 'greet-chips')).toBeNull();
        expect(findByClass(banner, 'greet-chip')).toBeNull();
    });

    test('loaded + already empty → banner stays hidden (no greeting, no inbox)', () => {
        const { api, banner } = makeInbox();
        api.setLoaded(true);
        api.setActionRequests([]);

        api.refreshActionRequestBanner();

        expect(findByClass(banner, 'action-request-inbox')).toBeNull();
        expect(banner.style.display).toBe('none');
    });

    test('not-yet-loaded → no-op (keeps the !actionRequestsLoaded guard)', () => {
        const { api, banner } = makeInbox();
        api.setLoaded(false);
        api.setActionRequests([makeRequest(REQ_A)]);

        api.refreshActionRequestBanner();

        // Guard short-circuits before any render so a half-loaded page never flashes.
        expect(findByClass(banner, 'action-request-inbox')).toBeNull();
    });
});

// ════════════════════════════════════════════════════════════════════════════
// Behavior — 計畫C 篩選條件 facet (card_2a6f260f) + 計畫D 🗂 任務卡 chip (card_df646877)
// ════════════════════════════════════════════════════════════════════════════
function findByText(root, text) {
    const stack = root.children.slice();
    while (stack.length) {
        const node = stack.shift();
        if (node._text === text) return node;
        stack.unshift(...node.children);
    }
    return null;
}

describe('計畫C — 需要你 inbox 篩選條件 facet (All / Consensus)', () => {
    test('default (no stored filter) is "all": every pending request renders + both chips present', () => {
        const { api, banner } = makeInbox();
        api.setActionRequests([
            makeRequest(REQ_A, { type: 'decision' }),
            makeRequest(REQ_B, { type: 'consensus' }),
        ]);
        api.renderActionRequestInbox(banner);

        const filter = findByClass(banner, 'action-request-inbox-filter');
        expect(filter).not.toBeNull();
        // two chips, "All" active by default
        const chips = findAllByClass(banner, 'filter-chip');
        expect(chips.length).toBe(2);
        const active = chips.find(c => c.classList.contains('active'));
        expect(active._text).toBe('All');
        // both requests visible, no empty-state
        expect(findAllByClass(banner, 'action-request-item').length).toBe(2);
        expect(findByClass(banner, 'action-request-filter-empty')).toBeNull();
    });

    test('stored filter "consensus" narrows the list to consensus items only', () => {
        const { api, banner } = makeInbox({ storage: { needsyou_inbox_filter: 'consensus' } });
        api.setActionRequests([
            makeRequest(REQ_A, { type: 'decision' }),
            makeRequest(REQ_B, { type: 'consensus' }),
            makeRequest(REQ_C, { type: 'input' }),
        ]);
        api.renderActionRequestInbox(banner);

        // only the consensus request renders
        expect(findAllByClass(banner, 'action-request-item').length).toBe(1);
        // "Consensus" chip is the active one
        const active = findAllByClass(banner, 'filter-chip').find(c => c.classList.contains('active'));
        expect(active._text).toBe('Consensus');
        // summary count stays the TOTAL pending (3), not the filtered count
        expect(findByClass(banner, 'action-request-inbox-count')._text).toBe('3 pending');
    });

    test('consensus filter with no matching request shows the empty-state (no items)', () => {
        const { api, banner } = makeInbox({ storage: { needsyou_inbox_filter: 'consensus' } });
        api.setActionRequests([makeRequest(REQ_A, { type: 'decision' })]);
        api.renderActionRequestInbox(banner);

        expect(findAllByClass(banner, 'action-request-item').length).toBe(0);
        expect(findByClass(banner, 'action-request-filter-empty')._text).toBe('No requests match this filter.');
    });

    test('a request in a triggered consensus round matches the consensus filter', () => {
        const { api, banner } = makeInbox({ storage: { needsyou_inbox_filter: 'consensus' } });
        // type is not consensus, but the timeout worker opened a round (協商中)
        api.setActionRequests([makeRequest(REQ_A, { type: 'decision', consensusTriggered: true })]);
        api.renderActionRequestInbox(banner);

        expect(findAllByClass(banner, 'action-request-item').length).toBe(1);
    });
});

describe('計畫D — 需要你 inbox 🗂 任務卡 deep-link chip', () => {
    test('renders the card chip ONLY when relatedCardId is present', () => {
        const { api, banner } = makeInbox();
        api.setActionRequests([
            makeRequest(REQ_A, { relatedCardId: 'card_df646877' }),
            makeRequest(REQ_B), // no relatedCardId
        ]);
        api.renderActionRequestInbox(banner);

        const links = findAllByClass(banner, 'action-request-card-link');
        expect(links.length).toBe(1);
        expect(links[0]._text).toBe('🗂 Task card');
        expect(links[0].tagName).toBe('BUTTON');
    });

    test('no card chip at all when no request carries relatedCardId (no layout change)', () => {
        const { api, banner } = makeInbox();
        api.setActionRequests([makeRequest(REQ_A), makeRequest(REQ_B)]);
        api.renderActionRequestInbox(banner);
        expect(findAllByClass(banner, 'action-request-card-link').length).toBe(0);
    });
});
