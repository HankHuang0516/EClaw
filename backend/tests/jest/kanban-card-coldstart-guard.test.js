/**
 * Regression: GET /api/mission/card/:id must NEVER return a different card's
 * JSON with 200 + success:true during a cold-start window.
 *
 * card_0f406678e04b7246b24e4a50 (P2 data-integrity bug):
 *   On 2026-07-09 00:58 TW, during a Railway cold-start (the same window the
 *   global /api gate returns "Server starting up"), a request for
 *   card_a1dcb6f8e7aba2656c2469a5 returned the FULL JSON of a DIFFERENT card
 *   (card_2f6a565982885f34b0cd3ed9) with HTTP 200 + success:true. A retry a few
 *   seconds later returned the 503 "Server starting up" message; after warmup
 *   the same request returned the correct card. Because 200+success:true is
 *   undetectable by callers (unlike a 503), an orchestrator could pick up the
 *   wrong SOP/evidence or write a close-out to the wrong card.
 *
 * Two guards under test:
 *   1. Readiness guard — when persistence is not ready (isReady() === false),
 *      the handler must return the 503 "Server starting up" path, NOT trust the
 *      half-initialised store.
 *   2. Id-mismatch assertion — even when ready, if the DB returns a row whose id
 *      does not match the requested id (nor a valid short-ID resolution), the
 *      handler must fail closed (404), NEVER return 200 with the wrong card.
 *
 * Fails-old / passes-new: on the pristine handler (before the fix) the
 * id-mismatch case returns 200 + the wrong card's JSON, and the not-ready case
 * returns 200 as well — both assertions below fail. With the fix they return
 * 503 / 404 respectively.
 */

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

const mockDevices = {
    'test-dev': {
        deviceSecret: 'test-secret',
        entities: {
            0: { isBound: true, botSecret: 'bot-sec', character: 'Bot0' },
            1: { isBound: true, botSecret: 'bot-sec-1', character: 'Bot1' },
        },
    },
};

const AUTH = { deviceId: 'test-dev', deviceSecret: 'test-secret' };

// Readiness flag flipped per-test. Wired into the module as a late-bound thunk
// exactly like index.js wires `() => persistenceReady`.
let ready = true;

let app;
beforeAll(() => {
    app = express();
    app.use(express.json());
    const kanbanModule = require('../../kanban')(mockDevices, {
        isReady: () => ready,
    });
    app.use('/api/mission', kanbanModule.router);
});

beforeEach(() => {
    ready = true;
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

const get = (path) => request(app).get(path);

// The full-length id the caller asks for (24 hex body → NOT a short-ID, so the
// handler goes straight to the exact-match query).
const REQUESTED_ID = 'card_a1dcb6f8e7aba2656c2469a5';
// A completely different card the not-ready DB (wrongly) hands back.
const WRONG_CARD = {
    id: 'card_2f6a565982885f34b0cd3ed9',
    device_id: 'test-dev',
    title: '[P2][調查] 用量警告錯掛卡',
    description: 'totally different card',
    priority: 'P2',
    status: 'todo',
    assigned_bots: [0],
    created_by: 2,
    created_at: new Date(),
    updated_at: new Date(),
    status_changed_at: new Date(),
    archived: false,
    comment_count: 0,
    note_count: 0,
    file_count: 0,
};

describe('GET /card/:id — cold-start wrong-card guard (card_0f406678)', () => {
    // ── Guard 1: readiness ──────────────────────────────────────────────────
    it('returns 503 "Server starting up" when persistence is NOT ready', async () => {
        ready = false;
        // Even if the (not-ready) DB would hand back a card, the handler must
        // never reach it — return the retryable 503 instead.
        mockQuery.mockResolvedValue({ rows: [WRONG_CARD] });

        const res = await get(`/api/mission/card/${REQUESTED_ID}`).query({ ...AUTH });

        expect(res.status).toBe(503);
        expect(res.body.success).toBe(false);
        expect(res.body.message).toMatch(/starting up/i);
        // Must NOT have leaked the wrong card.
        expect(res.body.card).toBeUndefined();
    });

    // ── Guard 2: id-mismatch assertion (the exact prod repro) ───────────────
    it('NEVER returns 200 with a different card when the DB hands back a wrong-id row', async () => {
        ready = true;
        // Simulate the cold-start data corruption: the exact-match SELECT
        // returns a row whose id is NOT the requested id.
        mockQuery.mockResolvedValueOnce({ rows: [WRONG_CARD] }); // main card query

        const res = await get(`/api/mission/card/${REQUESTED_ID}`).query({ ...AUTH });

        // The core assertion: the bug returned 200 + WRONG_CARD. It must not.
        expect(res.status).not.toBe(200);
        // Fail-closed: a mismatch is treated as not-found.
        expect(res.status).toBe(404);
        // The wrong card's payload must NOT be returned under any status.
        expect(res.body.card).toBeUndefined();
        expect(JSON.stringify(res.body)).not.toContain(WRONG_CARD.id);
    });

    // ── Happy path still works: correct row → 200 ───────────────────────────
    it('returns 200 with the correct card when the DB returns the requested row', async () => {
        ready = true;
        const rightCard = { ...WRONG_CARD, id: REQUESTED_ID, title: 'Correct card' };
        mockQuery
            .mockResolvedValueOnce({ rows: [rightCard] }) // main card query
            .mockResolvedValueOnce({ rows: [] })          // comments
            .mockResolvedValueOnce({ rows: [] })          // notes
            .mockResolvedValueOnce({ rows: [] })          // linked mission notes
            .mockResolvedValueOnce({ rows: [] });         // files

        const res = await get(`/api/mission/card/${REQUESTED_ID}`).query({ ...AUTH });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.card.id).toBe(REQUESTED_ID);
    });

    // ── Legitimate short-ID resolution is NOT flagged as a mismatch ─────────
    it('still resolves a legitimate short-ID to its full card (not a false mismatch)', async () => {
        ready = true;
        const fullId = 'card_d3cdda1455152e3caee8d4ac';
        const fullCard = { ...WRONG_CARD, id: fullId, title: 'Resolved from shorthand' };
        mockQuery
            .mockResolvedValueOnce({ rows: [{ id: fullId }] }) // prefix lookup
            .mockResolvedValueOnce({ rows: [fullCard] })       // main card query
            .mockResolvedValueOnce({ rows: [] })               // comments
            .mockResolvedValueOnce({ rows: [] })               // notes
            .mockResolvedValueOnce({ rows: [] })               // linked mission notes
            .mockResolvedValueOnce({ rows: [] });              // files

        const res = await get('/api/mission/card/card_d3cdda14').query({ ...AUTH });

        expect(res.status).toBe(200);
        expect(res.body.card.id).toBe(fullId);
    });
});
