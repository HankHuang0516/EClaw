/**
 * 需要你 inbox — GET /api/action-requests/pending-count.
 *
 * The App's home-screen widget / launcher icon polls this endpoint to know how
 * many 需要你 (owner action-request inbox) items are currently UNRESOLVED for a
 * device, so the badge/widget lights up only when count > 0. It is a single
 * COUNT(*) over agent_action_requests WHERE device_id = $1 AND status = 'pending'
 * — the SAME "unresolved" predicate the default list (GET /) uses and the same
 * rows the guarded resolve/dismiss UPDATEs move off pending.
 *
 * These tests drive the REAL router (mounted via supertest) against a small
 * STATEFUL in-memory pg mock that models the count query + the guarded
 * pending-only resolve/dismiss UPDATEs, so the transitions are real: a resolved
 * or dismissed request actually stops being counted. Auth is exercised too — it
 * is identical to GET / (deviceSecret owner OR botSecret+entityId bound bot).
 *
 * FAIL-ON-OLD: the /pending-count route does not exist on origin/main, so every
 * count assertion below returns 404 on old code and the expected integer on new.
 */
'use strict';

// ── Stateful in-memory pg mock ──
// Rows keyed by id. The count query and the guarded pending-only UPDATEs are the
// only shapes these tests exercise; parse just enough of each to mutate/return.
const store = new Map();

const mockQuery = jest.fn(async (sql, params = []) => {
    const text = String(sql);

    // COUNT(*) of pending rows for a device — the endpoint under test.
    if (/SELECT COUNT\(\*\)/i.test(text) && /FROM agent_action_requests/i.test(text)) {
        const deviceId = params[0];
        const count = [...store.values()].filter(
            (r) => r.device_id === deviceId && r.status === 'pending'
        ).length;
        return { rows: [{ count }], rowCount: 1 };
    }

    // Guarded pending-only resolve (params: [answerJson, requestId, deviceId]).
    if (/UPDATE agent_action_requests/i.test(text) && /status = 'resolved'/i.test(text)) {
        const requestId = params[1];
        const deviceId = params[2];
        const row = store.get(requestId);
        if (row && row.device_id === deviceId && row.status === 'pending') {
            row.status = 'resolved';
            row.resolved_at = new Date();
            row.answer = JSON.parse(params[0]);
            return { rows: [{ ...row }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    }

    // Guarded pending-only dismiss (params: [requestId, deviceId, ...]).
    if (/UPDATE agent_action_requests/i.test(text) && /status = 'dismissed'/i.test(text)) {
        const requestId = params[0];
        const deviceId = params[1];
        const row = store.get(requestId);
        if (row && row.device_id === deviceId && row.status === 'pending') {
            row.status = 'dismissed';
            row.resolved_at = new Date();
            return { rows: [{ ...row }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
    }

    return { rows: [], rowCount: 0 };
});

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: mockQuery,
        connect: jest.fn().mockResolvedValue({ query: mockQuery, release: jest.fn() }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

const express = require('express');
const request = require('supertest');

const deviceId = 'pending-count-dev';
const otherDeviceId = 'other-dev';
const deviceSecret = 'dev-secret';
const botSecret = 'bot-2-secret';
const entityId = 2;

const device = {
    deviceSecret,
    entities: { [entityId]: { isBound: true, botSecret } },
};

let app;

function uuid(n) {
    const h = String(n).padStart(12, '0');
    return `00000000-0000-4000-8000-${h}`;
}

// Seed a row directly into the store (bypassing the emit route — we only test
// the count + resolve/dismiss transitions here).
function seed(id, over = {}) {
    store.set(id, {
        id,
        device_id: deviceId,
        from_entity_id: entityId,
        anchor_message_id: null,
        type: 'decision',
        prompt: 'decide X',
        options: null,
        status: 'pending',
        answer: null,
        related_card_id: null,
        decision_context: null,
        created_at: new Date(),
        resolved_at: null,
        consensus_triggered_at: null,
        ...over,
    });
}

beforeAll(() => {
    app = express();
    app.use(express.json());
    const mod = require('../../agent-action-requests')(
        { [deviceId]: device, [otherDeviceId]: { deviceSecret: 'x', entities: {} } },
        { serverLog: () => {} }
    );
    app.use('/api/action-requests', mod.router);
});

beforeEach(() => {
    store.clear();
    mockQuery.mockClear();
});

const get = (p) => request(app).get(p);

describe('GET /api/action-requests/pending-count', () => {
    it('counts pending items for the device (owner deviceSecret auth)', async () => {
        seed(uuid(1));
        seed(uuid(2));
        seed(uuid(3));
        const res = await get('/api/action-requests/pending-count')
            .query({ deviceId, deviceSecret });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, count: 3, deviceId });
    });

    it('EXCLUDES resolved and dismissed items from the count', async () => {
        seed(uuid(1)); // pending
        seed(uuid(2), { status: 'resolved', resolved_at: new Date() });
        seed(uuid(3), { status: 'dismissed', resolved_at: new Date() });
        seed(uuid(4)); // pending
        const res = await get('/api/action-requests/pending-count')
            .query({ deviceId, deviceSecret });
        expect(res.status).toBe(200);
        expect(res.body.count).toBe(2); // only the two pending rows
    });

    it('returns 0 when there are no pending items', async () => {
        // no rows seeded at all
        const res0 = await get('/api/action-requests/pending-count')
            .query({ deviceId, deviceSecret });
        expect(res0.status).toBe(200);
        expect(res0.body).toEqual({ success: true, count: 0, deviceId });

        // and 0 again when every row is already resolved/dismissed
        seed(uuid(1), { status: 'resolved', resolved_at: new Date() });
        seed(uuid(2), { status: 'dismissed', resolved_at: new Date() });
        const res = await get('/api/action-requests/pending-count')
            .query({ deviceId, deviceSecret });
        expect(res.status).toBe(200);
        expect(res.body.count).toBe(0);
    });

    it('the count drops as items are resolved / dismissed (real transitions)', async () => {
        seed(uuid(1));
        seed(uuid(2));
        seed(uuid(3));

        // start: 3 pending
        let res = await get('/api/action-requests/pending-count').query({ deviceId, deviceSecret });
        expect(res.body.count).toBe(3);

        // resolve one → 2
        const r1 = await request(app)
            .post(`/api/action-requests/${uuid(1)}/resolve`)
            .send({ deviceId, deviceSecret, answer: 'ok' });
        expect(r1.status).toBe(200);
        res = await get('/api/action-requests/pending-count').query({ deviceId, deviceSecret });
        expect(res.body.count).toBe(2);

        // dismiss one → 1
        const r2 = await request(app)
            .post(`/api/action-requests/${uuid(2)}/dismiss`)
            .send({ deviceId, deviceSecret });
        expect(r2.status).toBe(200);
        res = await get('/api/action-requests/pending-count').query({ deviceId, deviceSecret });
        expect(res.body.count).toBe(1);
    });

    it('is device-scoped — never counts another device\'s pending items', async () => {
        seed(uuid(1)); // belongs to `deviceId`
        seed(uuid(2), { device_id: otherDeviceId }); // another device's pending item
        const res = await get('/api/action-requests/pending-count')
            .query({ deviceId, deviceSecret });
        expect(res.body.count).toBe(1);
    });

    it('works with botSecret + entityId auth (same as GET /)', async () => {
        seed(uuid(1));
        seed(uuid(2));
        const res = await get('/api/action-requests/pending-count')
            .query({ deviceId, botSecret, entityId });
        expect(res.status).toBe(200);
        expect(res.body.count).toBe(2);
    });

    it('rejects bad credentials (401) and missing creds (400) — no count leaked', async () => {
        seed(uuid(1));
        const bad = await get('/api/action-requests/pending-count')
            .query({ deviceId, deviceSecret: 'wrong' });
        expect(bad.status).toBe(401);
        expect(bad.body.success).toBe(false);
        expect(bad.body.count).toBeUndefined();

        const missing = await get('/api/action-requests/pending-count')
            .query({ deviceId });
        expect(missing.status).toBe(400);
        expect(missing.body.success).toBe(false);
    });
});
