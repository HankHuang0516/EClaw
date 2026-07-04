'use strict';

/**
 * card_f5023a5204ef729dfa98abda — Dispatch capability guard.
 *
 * Problem: the platform dispatches visual/screenshot tasks (destructive-modal
 * E2E, UI review, simulator review) to entity #6, but #6's environment has NO
 * usable browser tool (Copilot Computer Use declined; browser plugin errors),
 * so those cards dead-end and bounce back to #2.
 *
 * Fix (NON-BLOCKING): when a card that needs browser/screenshot verification is
 * assigned to a set of entities that ALL lack a usable browser, post a system
 * comment suggesting a browser-capable entity (#2/Playwright). It is a warning —
 * it never rejects the assignment.
 *
 * Two layers of proof:
 *  A. Pure-unit tests of the exported detection + warning builders.
 *  B. An integration test driving the REAL PUT /card router (supertest over a
 *     mocked pg pool), asserting the warning system-comment is INSERTed and
 *     surfaced in the API `warnings` array — mirrors the sibling harness
 *     backend/tests/jest/kanban-notify-on-assign-comment.test.js.
 */

// ── B-layer plumbing: mock pg so the real router runs without a DB. ──
const mockQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: mockQuery,
        connect: jest.fn().mockResolvedValue({
            query: jest.fn().mockResolvedValue({ rows: [] }),
            release: jest.fn(),
        }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

jest.mock('../../safe-equal', () => (a, b) => a === b);

const express = require('express');
const request = require('supertest');

const kanbanFactory = require('../../kanban');
const {
    isBrowserCapableEntity,
    cardNeedsVisualVerification,
    buildDispatchCapabilityWarning,
    BROWSER_INCAPABLE_ENTITIES,
} = kanbanFactory._private;

// The exact warning copy the card specifies (matched loosely on the anchor bits
// so a future wording tweak of the tail doesn't break the assertion).
const WARN_RE = /派工能力提醒[\s\S]*瀏覽器\/截圖驗證[\s\S]*沒有可用的瀏覽器工具[\s\S]*建議改派 #2/;

// ════════════════════════════════════════════════════════════════
// A. Pure detection + warning builder
// ════════════════════════════════════════════════════════════════
describe('A. capability registry + detection', () => {
    it('#6 is browser-incapable; #2/#1/#5 are capable', () => {
        expect(BROWSER_INCAPABLE_ENTITIES.has(6)).toBe(true);
        expect(isBrowserCapableEntity(6)).toBe(false);
        expect(isBrowserCapableEntity(2)).toBe(true);
        expect(isBrowserCapableEntity(1)).toBe(true);
        expect(isBrowserCapableEntity(5)).toBe(true);
        // string id coerces
        expect(isBrowserCapableEntity('6')).toBe(false);
    });

    it('cardNeedsVisualVerification: explicit flags', () => {
        expect(cardNeedsVisualVerification({ requiresScreenshotReview: true })).toBe(true);
        expect(cardNeedsVisualVerification({ requires_screenshot_review: true })).toBe(true);
        expect(cardNeedsVisualVerification({ requiresInteractionReview: true })).toBe(true);
        expect(cardNeedsVisualVerification({ requires_interaction_review: true })).toBe(true);
    });

    it('cardNeedsVisualVerification: UI/UX title keywords (EN + ZH)', () => {
        expect(cardNeedsVisualVerification({ title: 'destructive modal dialog E2E' })).toBe(true); // modal/dialog
        expect(cardNeedsVisualVerification({ title: 'Fix the UI review card' })).toBe(true);  // UI
        expect(cardNeedsVisualVerification({ title: '按鈕外觀破圖' })).toBe(true);            // ZH UI
        expect(cardNeedsVisualVerification({ description: 'verify the drag gesture' })).toBe(true); // UX
        expect(cardNeedsVisualVerification({ title: '拖曳互動流程' })).toBe(true);            // ZH UX
        // Real destructive-modals E2E cards carry requires_screenshot_review=true
        // (an E2E screenshot task); the title alone ("modals" plural) does NOT hit
        // the reused \bmodal\b regex, but the explicit flag catches it.
        expect(cardNeedsVisualVerification({ title: 'destructive-modals E2E', requires_screenshot_review: true })).toBe(true);
    });

    it('cardNeedsVisualVerification: pure-backend card is NOT visual', () => {
        expect(cardNeedsVisualVerification({ title: 'Refactor the SQL pool', description: 'batch the queries' })).toBe(false);
        expect(cardNeedsVisualVerification({ title: 'Harden auth token rotation' })).toBe(false);
        expect(cardNeedsVisualVerification(null)).toBe(false);
        expect(cardNeedsVisualVerification({})).toBe(false);
    });
});

describe('A. buildDispatchCapabilityWarning', () => {
    it('UI card assigned ONLY to browser-incapable #6 → warns', () => {
        const w = buildDispatchCapabilityWarning({ requiresScreenshotReview: true }, [6]);
        expect(w).toMatch(WARN_RE);
        expect(w).toContain('#6');
    });

    it('UI card assigned to a capable entity (#2) → does NOT warn', () => {
        expect(buildDispatchCapabilityWarning({ requiresScreenshotReview: true }, [2])).toBeNull();
    });

    it('UI card assigned to a MIX (#6 + #2) → does NOT warn (a capable entity can land it)', () => {
        expect(buildDispatchCapabilityWarning({ title: 'UI review' }, [6, 2])).toBeNull();
    });

    it('NON-UI card assigned to #6 → never warns', () => {
        expect(buildDispatchCapabilityWarning({ title: 'Refactor pool' }, [6])).toBeNull();
    });

    it('no assignees → no warning', () => {
        expect(buildDispatchCapabilityWarning({ requiresScreenshotReview: true }, [])).toBeNull();
        expect(buildDispatchCapabilityWarning({ requiresScreenshotReview: true }, undefined)).toBeNull();
    });
});

// ════════════════════════════════════════════════════════════════
// B. Integration — PUT /card/:id reassignment posts the warning
// ════════════════════════════════════════════════════════════════
describe('B. PUT /card/:id dispatch-capability guard', () => {
    let app;

    const mockDevices = {
        'test-dev': {
            deviceSecret: 'test-secret',
            entities: {
                0: { isBound: true, name: 'Boss', character: 'Boss' },
                2: { isBound: true, name: 'Bot2', character: 'Bot2' },
                6: { isBound: true, name: 'Bot6', character: 'Bot6' },
            },
        },
    };

    beforeAll(() => {
        app = express();
        app.use(express.json());
        const mod = kanbanFactory(mockDevices, {});
        app.use('/api/mission', mod.router);
    });

    beforeEach(() => {
        mockQuery.mockReset();
        mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    });

    const put = (p) => request(app).put(p);
    const AUTH = { deviceId: 'test-dev', deviceSecret: 'test-secret' };
    const flushAsync = () => new Promise((r) => setImmediate(r));

    function cardRow(overrides = {}) {
        return {
            id: 'card_x', device_id: 'test-dev', title: 'UI review card',
            description: 'check the modal', priority: 'P2', status: 'todo',
            assigned_bots: [0], created_by: 0, requires_screenshot_review: true,
            created_at: new Date(), updated_at: new Date(),
            status_changed_at: new Date(), archived: false,
            ...overrides,
        };
    }

    // Drive by SQL SHAPE (positional ordering is brittle because addSystemComment
    // + assign-notify + latest-comment fetch all fire out of band). Capture every
    // INSERT into kanban_comments so we can assert on the system-comment text.
    function primeMock({ before, after }) {
        const systemComments = [];
        mockQuery.mockImplementation((sql, params) => {
            if (/INSERT INTO kanban_comments/.test(sql)) {
                // addSystemComment binds text as params[2] (card_id, device_id, text)
                systemComments.push(params && params[2]);
                return Promise.resolve({ rows: [{ id: 'cmt' }] });
            }
            if (/UPDATE kanban_cards SET[\s\S]*RETURNING/.test(sql)) {
                return Promise.resolve({ rows: [after] });
            }
            if (/^\s*SELECT \* FROM kanban_cards/.test(sql)) {
                return Promise.resolve({ rows: [before] });
            }
            return Promise.resolve({ rows: [], rowCount: 0 });
        });
        return systemComments;
    }

    it('reassigning a UI/screenshot card ONLY to #6 → warns (comment + API warnings), 200', async () => {
        const systemComments = primeMock({
            before: cardRow({ assigned_bots: [0] }),
            after: cardRow({ assigned_bots: [6] }),
        });

        const res = await put('/api/mission/card/card_x').send({ ...AUTH, assignedBots: [6] });
        expect(res.status).toBe(200);              // NON-BLOCKING — assignment succeeds
        await flushAsync();

        expect(systemComments.some((t) => WARN_RE.test(String(t)))).toBe(true);
        expect((res.body.warnings || []).some((w) => WARN_RE.test(String(w)))).toBe(true);
    });

    it('reassigning the SAME UI card to a capable entity (#2) → NO warning', async () => {
        const systemComments = primeMock({
            before: cardRow({ assigned_bots: [0] }),
            after: cardRow({ assigned_bots: [2] }),
        });

        const res = await put('/api/mission/card/card_x').send({ ...AUTH, assignedBots: [2] });
        expect(res.status).toBe(200);
        await flushAsync();

        expect(systemComments.some((t) => WARN_RE.test(String(t)))).toBe(false);
        expect((res.body.warnings || []).some((w) => WARN_RE.test(String(w)))).toBe(false);
    });

    it('reassigning a NON-UI backend card to #6 → never warns', async () => {
        const backend = { title: 'Refactor SQL pool', description: 'batch queries', requires_screenshot_review: false };
        const systemComments = primeMock({
            before: cardRow({ assigned_bots: [0], ...backend }),
            after: cardRow({ assigned_bots: [6], ...backend }),
        });

        const res = await put('/api/mission/card/card_x').send({ ...AUTH, assignedBots: [6] });
        expect(res.status).toBe(200);
        await flushAsync();

        expect(systemComments.some((t) => WARN_RE.test(String(t)))).toBe(false);
        expect((res.body.warnings || []).some((w) => WARN_RE.test(String(w)))).toBe(false);
    });
});
