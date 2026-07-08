/**
 * chat-needyou-inbox-card-chip-popup — card_29f507ef (Hank 2026-07-06):
 * 「任務chip要能在需要你收件夾中可以點擊彈跳出任務子卡」.
 *
 * The 需要你 inbox 🗂 任務卡 chip (rendered when an action-request carries
 * relatedCardId) must POP UP that card's detail subview (title / status /
 * comments) in place — the shared entityPreviewModal smart-chip popup that
 * chat-message card chips already use — instead of deep-linking the owner
 * away to the kanban board.
 *
 * This file EXECUTES the real chain end-to-end inside a `new Function(...)`
 * sandbox (same harness technique as chat-action-request-inbox-behavior.test.js:
 * extractFunction brace-counting; jest testEnvironment is 'node', no jsdom):
 *
 *   openActionRequestCardPopup  (the chip's click handler — NEW)
 *     → openEntityModal('card', id)   (existing shared popup opener)
 *       → fetchCardData               (existing: GET card + comments + files)
 *         → entityPreviewModal DOM    (title via textContent, body via
 *                                      escapeHtml'd HTML — XSS-safe)
 *
 * Red→green: on origin/main openActionRequestCardPopup does not exist —
 * extractFunction throws and this whole suite FAILS. On the fix it passes.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const chatHtmlPath = path.join(__dirname, '..', '..', 'public', 'portal', 'chat.html');
const chatHtml = fs.readFileSync(chatHtmlPath, 'utf8');

// ── extractFunction: brace-count a top-level function body out of chat.html ──
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

// ── minimal element shim ─────────────────────────────────────────────────────
// Supports what openEntityModal/fetchCardData/escapeHtml touch: textContent,
// innerHTML (reading innerHTML after a textContent write returns the ESCAPED
// text — mirroring the real-DOM contract escapeHtml relies on), dataset, style,
// classList.
function htmlEscape(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function makeElement(tag) {
    const el = {
        tagName: String(tag || 'div').toUpperCase(),
        dataset: {},
        style: {},
        attrs: {},
        _text: '',
        _innerHTML: undefined,
    };
    Object.defineProperty(el, 'textContent', {
        get() { return el._text; },
        set(v) { el._text = String(v); el._innerHTML = undefined; },
    });
    Object.defineProperty(el, 'innerHTML', {
        get() { return el._innerHTML !== undefined ? el._innerHTML : htmlEscape(el._text); },
        set(v) { el._innerHTML = String(v); el._text = String(v); },
    });
    const classes = new Set();
    el.classList = {
        add(c) { classes.add(c); },
        remove(c) { classes.delete(c); },
        contains(c) { return classes.has(c); },
    };
    el.setAttribute = (k, v) => { el.attrs[k] = String(v); };
    return el;
}

// ── sandbox: splice the REAL functions out of chat.html ─────────────────────
function makePopupHarness(opts = {}) {
    const modal = makeElement('div');
    const typeEl = makeElement('div');
    const titleEl = makeElement('div');
    const idEl = makeElement('div');
    const bodyEl = makeElement('div');
    const elementsById = {
        entityPreviewModal: modal,
        entityModalType: typeEl,
        entityModalTitle: titleEl,
        entityModalId: idEl,
        entityModalBody: bodyEl,
    };
    const documentStub = {
        getElementById: (id) => elementsById[id] || null,
        createElement: (tag) => makeElement(tag),
    };
    const windowStub = {}; // no EntityLinkRender → openEntityModal falls back to {}
    const i18nStub = {
        t(key) {
            const dict = {
                chat_card_modal_comments: 'Comments',
                chat_card_modal_comments_empty: 'No comments yet',
                mm_preview_open_task: 'Open in Kanban',
            };
            return dict[key] || '';
        },
    };
    const apiCall = opts.apiCall || jest.fn(async () => ({}));
    const currentUser = { deviceId: 'dev-1', deviceSecret: 'sec-1' };
    const openKanbanCardSpy = jest.fn();

    const stubs = `
        const entityTypeLabels = { card: '📋 Task Card' };
        const statusEmojis = { todo: '📥', in_progress: '🚧', review: '👀', blocked: '🧱', done: '✅' };
        function eclawNavigateMissionCard() { return false; }
        function fetchDashboardItem() {}
        function fetchListingData() {}
        function fetchExamData() {}
        function fetchContractData() {}
        function fetchMindmapNodeData() {}
    `;
    const fnBodies = [
        extractFunction('escapeHtml'),
        extractFunction('escapeJs'),
        extractFunction('getKanbanCardUrl'),
        extractFunction('openModal'),
        extractFunction('fetchCardData'),
        extractFunction('openEntityModal'),
        // the NEW chip click handler under test (fails extraction on origin/main)
        extractFunction('openActionRequestCardPopup'),
    ].join('\n');

    const body = `
        ${stubs}
        ${fnBodies}
        return { openActionRequestCardPopup, openEntityModal, fetchCardData, escapeHtml };
    `;
    /* eslint-disable no-new-func */
    const factory = new Function(
        'document', 'window', 'i18n', 'apiCall', 'currentUser', 'openKanbanCard',
        body
    );
    const api = factory(documentStub, windowStub, i18nStub, apiCall, currentUser, openKanbanCardSpy);
    return { api, modal, typeEl, titleEl, idEl, bodyEl, apiCall, openKanbanCard: openKanbanCardSpy };
}

// flush the async openEntityModal → fetchCardData microtask chain
const flush = () => new Promise((r) => setTimeout(r, 0));

const CARD_ID = 'card_29f507ef9dcdc0a2bc3ce5f2';

function cardApiMock(cardOver = {}, comments = null) {
    return jest.fn(async (method, url) => {
        expect(method).toBe('GET');
        if (/\/comments\?/.test(url)) {
            return { comments: comments || [] };
        }
        if (/\/files\?/.test(url)) {
            return { files: [] };
        }
        expect(url).toMatch(new RegExp(`/api/mission/card/${CARD_ID}\\?`));
        return {
            card: Object.assign({
                id: CARD_ID,
                title: '[Enhance/P2] 需要你收件夾：任務 chip 可點擊彈出任務子卡',
                status: 'in_progress',
                priority: 'P2',
                assignedBots: [2],
                description: 'Pop the card detail subview from the inbox chip.',
                createdAt: '2026-07-06T10:00:00Z',
                updatedAt: '2026-07-06T11:00:00Z',
                commentCount: 1,
                requiresScreenshotReview: false,
            }, cardOver),
        };
    });
}

describe('card_29f507ef — 需要你 inbox 🗂 chip pops the card detail subview', () => {
    test('chip handler → entityPreviewModal opens with the FETCHED card (title/status/comments)', async () => {
        const apiCall = cardApiMock({}, [
            { text: 'First pass shipped', fromEntityId: 2, createdAt: '2026-07-06T10:30:00Z' },
        ]);
        const { api, modal, titleEl, idEl, bodyEl } = makePopupHarness({ apiCall });

        api.openActionRequestCardPopup(CARD_ID, { preventDefault: jest.fn() });
        await flush();

        // popup is OPEN (openModal added .active to #entityPreviewModal)
        expect(modal.classList.contains('active')).toBe(true);
        expect(modal.dataset.entityType).toBe('card');
        expect(modal.dataset.entityId).toBe(CARD_ID);

        // the three fetches went out with the owner auth pair
        expect(apiCall).toHaveBeenCalledTimes(3);
        expect(apiCall.mock.calls[0][1]).toContain('deviceId=dev-1&deviceSecret=sec-1');

        // title (via textContent), short id, and detail body rendered
        expect(titleEl.textContent).toBe('[Enhance/P2] 需要你收件夾：任務 chip 可點擊彈出任務子卡');
        expect(idEl.textContent).toBe(CARD_ID.substring(0, 8));
        expect(bodyEl.innerHTML).toContain('🚧 in_progress');            // status
        expect(bodyEl.innerHTML).toContain('P2');                        // priority
        expect(bodyEl.innerHTML).toContain('First pass shipped');        // comment text
        expect(bodyEl.innerHTML).toContain('#2');                        // comment author
        expect(bodyEl.innerHTML).toContain('Open in Kanban');            // board link kept INSIDE the popup
        expect(bodyEl.innerHTML).toContain(`kanban.html?card=${encodeURIComponent(CARD_ID)}`);
    });

    test('empty comments → the popup shows the comments empty-state', async () => {
        const { api, bodyEl } = makePopupHarness({ apiCall: cardApiMock({}, []) });
        api.openActionRequestCardPopup(CARD_ID, { preventDefault: jest.fn() });
        await flush();
        expect(bodyEl.innerHTML).toContain('No comments yet');
    });

    test('XSS: hostile title/description/comment stay inert (textContent + escapeHtml)', async () => {
        const hostile = '<img src=x onerror=alert(1)>';
        const apiCall = cardApiMock(
            { title: hostile, description: '<script>steal()</script>' },
            [{ text: '<b>bold</b> & <script>x</script>', fromEntityId: 5, createdAt: '2026-07-06T10:30:00Z' }]
        );
        const { api, titleEl, bodyEl } = makePopupHarness({ apiCall });

        api.openActionRequestCardPopup(CARD_ID, { preventDefault: jest.fn() });
        await flush();

        // title assigned via textContent — raw string, never parsed as HTML
        expect(titleEl.textContent).toBe(hostile);
        expect(titleEl.innerHTML).not.toContain('<img');
        // description + comments pass through escapeHtml before innerHTML
        expect(bodyEl.innerHTML).toContain('&lt;script&gt;steal()&lt;/script&gt;');
        expect(bodyEl.innerHTML).not.toContain('<script>steal()');
        expect(bodyEl.innerHTML).toContain('&lt;b&gt;bold&lt;/b&gt;');
        expect(bodyEl.innerHTML).not.toContain('<b>bold</b>');
    });

    test('blank/whitespace cardId → no popup, no fetch (guard)', async () => {
        const apiCall = jest.fn(async () => ({}));
        const { api, modal } = makePopupHarness({ apiCall });
        api.openActionRequestCardPopup('   ', { preventDefault: jest.fn() });
        api.openActionRequestCardPopup(null, { preventDefault: jest.fn() });
        await flush();
        expect(apiCall).not.toHaveBeenCalled();
        expect(modal.classList.contains('active')).toBe(false);
    });

    test('fetch failure → popup opens with the error state, not a crash', async () => {
        const apiCall = jest.fn(async () => { throw new Error('boom'); });
        const { api, modal, bodyEl } = makePopupHarness({ apiCall });
        api.openActionRequestCardPopup(CARD_ID, { preventDefault: jest.fn() });
        await flush();
        expect(modal.classList.contains('active')).toBe(true);
        expect(bodyEl.innerHTML).toContain('Failed to load');
        expect(bodyEl.innerHTML).toContain('boom');
    });
});
