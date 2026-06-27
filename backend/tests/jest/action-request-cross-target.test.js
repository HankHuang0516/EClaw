/**
 * 需要你 inbox INDEPENDENCE — cross-target resolve integrity.
 *
 * P0 bug: ONE owner reply resolved TWO pending action-requests. An answer the
 * owner composed for inbox item A was written onto an unrelated pending item B,
 * giving B a nonsensical answer it never should have received.
 *
 * The invariant this file pins: a resolve applies to EXACTLY the request it was
 * composed for. The chat composer embeds the source request inside the answer
 * payload (answer.replyContext.requestId). If that embedded target disagrees
 * with the request being resolved, the targeting is ambiguous / mis-bound →
 * resolve NONE (never overwrite the wrong item's pending state).
 *
 * Two layers, both FAIL on the old code (which ignored the embedded target and
 * resolved the URL/positional id regardless) and PASS after the guard lands:
 *   1. resolveActionRequest() helper — the shared chokepoint every resolve path
 *      funnels through (HTTP, /api/client/speak, timeout + ratify workers).
 *   2. POST /:id/resolve route — surfaces the ambiguity as 409, runs no UPDATE.
 */

const mockPoolQuery = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: mockPoolQuery,
        connect: jest.fn().mockResolvedValue({ query: mockPoolQuery, release: jest.fn() }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

const express = require('express');
const request = require('supertest');

const deviceId = 'cross-target-dev';
const deviceSecret = 'dev-secret';
// Two unrelated pending requests — A is the one the owner replies to; B is the
// neighbour that must stay untouched (in the live bug B was the error-counters
// migration request that got the "pin" answer meant for A).
const REQ_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const REQ_B = 'bbbbbbbb-2222-4222-8222-222222222222';

const device = { deviceSecret, entities: { 2: { isBound: true, botSecret: 'bot-2' } } };

let app;
let mod;

beforeAll(() => {
    app = express();
    app.use(express.json());
    mod = require('../../agent-action-requests')({ [deviceId]: device }, { serverLog: () => {} });
    app.use('/api/action-requests', mod.router);
});

afterEach(() => mockPoolQuery.mockClear());

const post = (p) => request(app).post(p);

function rowFixture(over = {}) {
    return {
        id: REQ_A, device_id: deviceId, from_entity_id: 2, anchor_message_id: null,
        type: 'decision', prompt: 'drag: home vs pin', options: null, related_card_id: null,
        decision_context: null, status: 'resolved', answer: { text: 'x' },
        created_at: new Date('2026-06-26T00:00:00Z'), resolved_at: new Date(), consensus_triggered_at: null,
        ...over,
    };
}

const ranResolveUpdate = () => mockPoolQuery.mock.calls.some(
    ([sql]) => typeof sql === 'string' && /UPDATE agent_action_requests/.test(sql) && /status = 'resolved'/.test(sql)
);
const resolveUpdateCall = () => mockPoolQuery.mock.calls.find(
    ([sql]) => typeof sql === 'string' && /UPDATE agent_action_requests/.test(sql) && /status = 'resolved'/.test(sql)
);

// ──────────────────────────────────────────────────────────────────────────
// Layer 1 — resolveActionRequest() helper (the shared chokepoint)
// ──────────────────────────────────────────────────────────────────────────
describe('resolveActionRequest() — cross-target guard', () => {
    it('REJECTS an answer composed for a DIFFERENT request — resolves none, no UPDATE', async () => {
        // Owner reply for A, but the payload self-describes target B → mis-bound.
        const row = await mod.resolveActionRequest(
            deviceId, REQ_A,
            { text: 'pin answer meant for A', replyContext: { requestId: REQ_B } },
            device
        );
        // FAIL-ON-OLD: old code ran the UPDATE on REQ_A regardless, writing this
        // answer onto A (and the loop above it onto B) — cross-contamination.
        expect(row).toBeNull();
        expect(ranResolveUpdate()).toBe(false);
    });

    it('REJECTS a top-level answer.requestId that disagrees with the resolve id', async () => {
        const row = await mod.resolveActionRequest(
            deviceId, REQ_A, { text: 'x', requestId: REQ_B }, device
        );
        expect(row).toBeNull();
        expect(ranResolveUpdate()).toBe(false);
    });

    it('RESOLVES when the embedded target matches the resolve id', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ id: REQ_A })] });
        const row = await mod.resolveActionRequest(
            deviceId, REQ_A,
            { text: 'pin answer', replyContext: { requestId: REQ_A } },
            device
        );
        expect(row).not.toBeNull();
        const [, params] = resolveUpdateCall();
        expect(params[1]).toBe(REQ_A);     // params: [answerJson, requestId, deviceId]
        expect(params[2]).toBe(deviceId);
    });

    it('plain-text / worker answers (no embedded target) resolve normally', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ id: REQ_A })] });
        const row = await mod.resolveActionRequest(deviceId, REQ_A, { text: 'just text' }, device);
        expect(row).not.toBeNull();
        expect(ranResolveUpdate()).toBe(true);
    });

    it('resolving ONE request is device + pending + id scoped — never a sibling', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ id: REQ_A })] });
        await mod.resolveActionRequest(deviceId, REQ_A, { text: 'A only' }, device);
        const [sql, params] = resolveUpdateCall();
        expect(sql).toMatch(/WHERE id = \$2 AND device_id = \$3 AND status = 'pending'/);
        expect(params[1]).toBe(REQ_A);
        // REQ_B (the neighbour) is nowhere in the query the resolve issued.
        expect(JSON.stringify(params)).not.toContain(REQ_B);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Layer 2 — POST /:id/resolve route surfaces the ambiguity
// ──────────────────────────────────────────────────────────────────────────
describe('POST /:id/resolve — cross-target guard', () => {
    it('answer bound to a DIFFERENT request → 409, runs no UPDATE (sibling untouched)', async () => {
        const res = await post(`/api/action-requests/${REQ_A}/resolve`).send({
            deviceId, deviceSecret,
            answer: { text: 'meant for A', replyContext: { requestId: REQ_B } },
        });
        // FAIL-ON-OLD: old route resolved REQ_A (200) and B was separately
        // cross-resolved by the loop. New route rejects the mismatch outright.
        expect(res.status).toBe(409);
        expect(res.body.success).toBe(false);
        expect(ranResolveUpdate()).toBe(false);
    });

    it('answer bound to the SAME request → 200, resolves exactly that request', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFixture({ id: REQ_A })] });
        const res = await post(`/api/action-requests/${REQ_A}/resolve`).send({
            deviceId, deviceSecret,
            answer: { text: 'pin answer', replyContext: { requestId: REQ_A } },
        });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.request.id).toBe(REQ_A);
        const [, params] = resolveUpdateCall();
        expect(params[1]).toBe(REQ_A);
    });
});
