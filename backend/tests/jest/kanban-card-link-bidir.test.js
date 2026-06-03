/**
 * Kanban card-link bidirectional sync tests (Jest + Supertest)
 *
 * Covers the linkedPrev/linkedNext "Mechanism A" workflow chain documented in
 * docs/specs/card-link-system.md:
 *
 *   1. GET /card/:id hydrates linkedPrev + linkedNext payloads (title, status,
 *      priority) so the UI does not need follow-up round-trips.
 *   2. PUT /card/:id runs the primary UPDATE and the reciprocal UPDATE in a
 *      single transaction (BEGIN/COMMIT on a dedicated client).
 *   3. Setting linkedNextCardId clears the old downstream's prev pointer AND
 *      sets the new downstream's prev pointer.
 *   4. Setting linkedNextCardId=null clears both sides.
 *   5. The primary update is rolled back if the reciprocal write fails.
 */

const mockPoolQuery = jest.fn();
const mockClientQuery = jest.fn();
const mockClientRelease = jest.fn();

jest.mock('pg', () => ({
    Pool: jest.fn().mockImplementation(() => ({
        query: mockPoolQuery,
        connect: jest.fn().mockResolvedValue({
            query: mockClientQuery,
            release: mockClientRelease,
        }),
        end: jest.fn().mockResolvedValue(undefined),
    })),
}));

jest.mock('../../safe-equal', () => (a, b) => a === b);

const express = require('express');
const request = require('supertest');

let app;

beforeAll(() => {
    app = express();
    app.use(express.json());

    const mockDevices = {
        'test-dev': {
            deviceSecret: 'test-secret',
            entities: {
                0: { isBound: true, botSecret: 'bot-sec', character: 'Bot0' },
                1: { isBound: true, botSecret: 'bot-sec-1', character: 'Bot1' },
            },
        },
    };

    const kanbanModule = require('../../kanban')(mockDevices, {});
    app.use('/api/mission', kanbanModule.router);
});

beforeEach(() => {
    mockPoolQuery.mockReset();
    mockClientQuery.mockReset();
    mockClientRelease.mockReset();
});

const AUTH = { deviceId: 'test-dev', deviceSecret: 'test-secret' };

function rowFor(id, overrides = {}) {
    return {
        id,
        device_id: 'test-dev',
        title: overrides.title || `Card ${id}`,
        description: '',
        priority: 'P2',
        status: 'todo',
        assigned_bots: [0],
        created_by: 0,
        created_at: new Date(),
        updated_at: new Date(),
        status_changed_at: new Date(),
        archived: false,
        linked_prev_card_id: overrides.linked_prev_card_id || null,
        linked_next_card_id: overrides.linked_next_card_id || null,
        ...overrides,
    };
}

describe('GET /card/:id — linkedPrev/Next hydration', () => {
    it('hydrates linkedPrev + linkedNext payloads when pointers are set', async () => {
        // 1st query: card row + counts
        mockPoolQuery.mockResolvedValueOnce({
            rows: [rowFor('card_A', { linked_prev_card_id: 'card_P', linked_next_card_id: 'card_N' })],
        });
        // tags
        mockPoolQuery.mockResolvedValueOnce({ rows: [] });
        // comments
        mockPoolQuery.mockResolvedValueOnce({ rows: [] });
        // notes
        mockPoolQuery.mockResolvedValueOnce({ rows: [] });
        // mission_note_card_links
        mockPoolQuery.mockResolvedValueOnce({ rows: [] });
        // files
        mockPoolQuery.mockResolvedValueOnce({ rows: [] });
        // linked card hydration (the new query)
        mockPoolQuery.mockResolvedValueOnce({
            rows: [
                { id: 'card_P', title: 'Spec', status: 'done', priority: 'P1', archived: false },
                { id: 'card_N', title: 'Impl', status: 'in_progress', priority: 'P1', archived: false },
            ],
        });

        const res = await request(app)
            .get('/api/mission/card/card_A')
            .query(AUTH);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.card.linkedPrev).toEqual({
            id: 'card_P', title: 'Spec', status: 'done', priority: 'P1', archived: false,
        });
        expect(res.body.card.linkedNext).toEqual({
            id: 'card_N', title: 'Impl', status: 'in_progress', priority: 'P1', archived: false,
        });
    });

    it('returns linkedPrev=null + linkedNext=null when no pointers are set', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [rowFor('card_A')] });
        mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // tags
        mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // comments
        mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // notes
        mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // mission_notes
        mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // files
        // NOTE: no hydration query expected because no linked IDs.

        const res = await request(app)
            .get('/api/mission/card/card_A')
            .query(AUTH);

        expect(res.status).toBe(200);
        expect(res.body.card.linkedPrev).toBeNull();
        expect(res.body.card.linkedNext).toBeNull();
    });
});

describe('PUT /card/:id — atomic dual-end sync', () => {
    function preparePutMocks(currentRow, updatedRow) {
        // 1st pool.query — load existing row
        mockPoolQuery.mockResolvedValueOnce({ rows: [currentRow] });
        // 2nd pool.query (or 1st client.query when linkedPrev/Next is in play) — normalizeLinkedCardId existence check
        // (normalizeLinkedCardId uses pool.query when validating non-null target ID)
        // Then main UPDATE happens via client.query.
        // Configure client.query: BEGIN, UPDATE, [reciprocal queries], COMMIT
        mockClientQuery.mockImplementation(async (sql, params) => {
            const text = String(sql).trim();
            if (/^BEGIN/i.test(text)) return { rows: [] };
            if (/^COMMIT/i.test(text)) return { rows: [] };
            if (/^UPDATE kanban_cards SET/i.test(text)) {
                // First UPDATE is the primary; subsequent UPDATEs are reciprocal writes.
                if (!mockClientQuery._primaryDone) {
                    mockClientQuery._primaryDone = true;
                    return { rows: [updatedRow] };
                }
                return { rows: [] };
            }
            return { rows: [] };
        });
    }

    afterEach(() => {
        delete mockClientQuery._primaryDone;
    });

    it('setting linkedNextCardId runs reciprocal write to set newNext.prev = this card', async () => {
        const currentRow = rowFor('card_A');
        const updatedRow = rowFor('card_A', { linked_next_card_id: 'card_B' });
        preparePutMocks(currentRow, updatedRow);
        // normalizeLinkedCardId validates card_B exists
        mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'card_B' }] });

        const res = await request(app)
            .put('/api/mission/card/card_A')
            .send({ ...AUTH, linkedNextCardId: 'card_B' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);

        // Verify BEGIN/COMMIT was issued
        const calls = mockClientQuery.mock.calls.map(c => String(c[0]).trim().split(/\s+/)[0].toUpperCase());
        expect(calls).toContain('BEGIN');
        expect(calls).toContain('COMMIT');

        // Verify a reciprocal write set linked_prev_card_id on card_B
        const reciprocal = mockClientQuery.mock.calls.find(([sql, params]) =>
            /linked_prev_card_id = \$1/.test(String(sql)) &&
            Array.isArray(params) && params[0] === 'card_A' && params[1] === 'card_B'
        );
        expect(reciprocal).toBeDefined();
    });

    it('clearing linkedNextCardId (null) clears prior downstream prev pointer', async () => {
        const currentRow = rowFor('card_A', { linked_next_card_id: 'card_B' });
        const updatedRow = rowFor('card_A', { linked_next_card_id: null });
        preparePutMocks(currentRow, updatedRow);

        const res = await request(app)
            .put('/api/mission/card/card_A')
            .send({ ...AUTH, linkedNextCardId: null });

        expect(res.status).toBe(200);

        // Reciprocal write should clear card_B.linked_prev_card_id where it still pointed back to card_A
        const detach = mockClientQuery.mock.calls.find(([sql, params]) =>
            /linked_prev_card_id = NULL/.test(String(sql)) &&
            Array.isArray(params) && params[0] === 'card_B' && params[2] === 'card_A'
        );
        expect(detach).toBeDefined();
    });

    it('rolls back the transaction when the reciprocal write throws', async () => {
        const currentRow = rowFor('card_A');
        mockPoolQuery.mockResolvedValueOnce({ rows: [currentRow] }); // existing card
        mockPoolQuery.mockResolvedValueOnce({ rows: [{ id: 'card_B' }] }); // normalize target exists

        const rollbackSpy = jest.fn();
        let primaryDone = false;
        mockClientQuery.mockImplementation(async (sql) => {
            const text = String(sql).trim();
            if (/^BEGIN/i.test(text)) return { rows: [] };
            if (/^ROLLBACK/i.test(text)) { rollbackSpy(); return { rows: [] }; }
            if (/^UPDATE kanban_cards/i.test(text)) {
                if (!primaryDone) {
                    primaryDone = true;
                    return { rows: [rowFor('card_A', { linked_next_card_id: 'card_B' })] };
                }
                throw new Error('simulated reciprocal write failure');
            }
            return { rows: [] };
        });

        const res = await request(app)
            .put('/api/mission/card/card_A')
            .send({ ...AUTH, linkedNextCardId: 'card_B' });

        expect(res.status).toBe(500);
        expect(rollbackSpy).toHaveBeenCalled();
    });

    it('does NOT open a transaction when no link field is in the body', async () => {
        const currentRow = rowFor('card_A');
        const updatedRow = rowFor('card_A', { title: 'renamed' });
        // pool.query 1 — existing
        mockPoolQuery.mockResolvedValueOnce({ rows: [currentRow] });
        // pool.query 2 — main UPDATE (uses pool, not client, when no link sync)
        mockPoolQuery.mockResolvedValueOnce({ rows: [updatedRow] });

        const res = await request(app)
            .put('/api/mission/card/card_A')
            .send({ ...AUTH, title: 'renamed' });

        expect(res.status).toBe(200);
        // No client transaction should have been opened
        expect(mockClientQuery).not.toHaveBeenCalled();
    });
});
