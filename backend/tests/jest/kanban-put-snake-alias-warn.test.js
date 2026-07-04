'use strict';

/**
 * footgun #1 — card_c17d3c7bb6e789389edf58f4
 *
 * PUT /api/mission/card/:id destructures a FIXED set of camelCase config keys.
 * A caller sending the snake_case spelling (e.g. `requires_screenshot_review`,
 * the exact form used in the DB column and in serializeCard output) used to be
 * SILENTLY dropped — no error, a no-op UPDATE, and the caller believed it
 * worked. This actually bit us: a `requires_screenshot_review` PUT silently
 * failed and the flag never got set.
 *
 * The fix (backend/kanban.js, top of the PUT handler):
 *   1. Alias each known snake_case key onto its camelCase key, applied ONLY when
 *      the camelCase key is absent (explicit camelCase always wins).
 *   2. Collect leftover keys that are neither a known config field, a known
 *      alias, nor an auth passthrough, and return them as a non-fatal
 *      `warnings[]` in the JSON response. Never 400 — backward-compatible.
 *
 * This suite drives the REAL router (supertest) over a mocked pg pool and
 * asserts on the SQL/params the handler builds for the UPDATE (proving the flag
 * is actually set), plus the response `warnings` contract. Harness mirrors
 * kanban-notify-on-assign-comment.test.js.
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

let app;

const mockDevices = {
    'test-dev': {
        deviceSecret: 'test-secret',
        entities: {
            0: { isBound: true, bindingType: 'channel', channelAccountId: 'acct0', botSecret: 'sec0', publicCode: 'aaaaaa', name: 'Bot0', character: 'Bot0' },
            1: { isBound: true, bindingType: 'channel', channelAccountId: 'acct1', botSecret: 'sec1', publicCode: 'bbbbbb', name: 'Bot1', character: 'Bot1' },
        },
    },
};

beforeAll(() => {
    app = express();
    app.use(express.json());
    const kanbanModule = require('../../kanban')(mockDevices, {
        pushToChannelCallback: jest.fn().mockResolvedValue({ pushed: true }),
    });
    app.use('/api/mission', kanbanModule.router);
});

beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

const put = (p) => request(app).put(p);
const AUTH = { deviceId: 'test-dev', deviceSecret: 'test-secret' };

function cardRow(overrides = {}) {
    return {
        id: 'card_x', device_id: 'test-dev', title: 'My task',
        description: 'do the thing', priority: 'P2', status: 'todo',
        assigned_bots: [0], created_by: 0,
        created_at: new Date(), updated_at: new Date(),
        status_changed_at: new Date(), archived: false,
        requires_screenshot_review: false,
        ...overrides,
    };
}

// Standard mock sequence for a PUT that reaches the UPDATE:
//   existing SELECT * → UPDATE ... RETURNING * → bumpVersion → (getDeviceLanguage etc.)
function primeUpdate(returned = cardRow()) {
    mockQuery
        .mockResolvedValueOnce({ rows: [cardRow()] })      // existing SELECT *
        .mockResolvedValueOnce({ rows: [returned] })       // UPDATE RETURNING *
        .mockResolvedValueOnce({ rows: [] });              // bumpVersion
}

// Find the UPDATE kanban_cards ... RETURNING call and return { sql, params }.
function capturedUpdate() {
    const call = mockQuery.mock.calls.find(
        ([sql]) => typeof sql === 'string' && /UPDATE kanban_cards SET[\s\S]*RETURNING/.test(sql)
    );
    return call ? { sql: call[0], params: call[1] } : null;
}

// ════════════════════════════════════════════════════════════════
// (a) snake_case field now ACTUALLY sets the flag (was silently ignored)
// ════════════════════════════════════════════════════════════════
describe('(a) snake_case alias sets the flag', () => {
    it('requires_screenshot_review:true builds the requires_screenshot_review = TRUE update', async () => {
        primeUpdate();

        const res = await put('/api/mission/card/card_x')
            .send({ ...AUTH, requires_screenshot_review: true });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        // No warnings — a known snake alias is not "unknown".
        expect(res.body.warnings).toBeUndefined();

        const upd = capturedUpdate();
        expect(upd).toBeTruthy();
        // The column is in the SET clause (previously this PUT was a no-op:
        // updates would have been empty → "Nothing to update" 400).
        expect(upd.sql).toMatch(/requires_screenshot_review = \$\d+/);
        // and the coerced boolean value is present in params.
        expect(upd.params).toContain(true);
    });

    it('other snake aliases (dispatch_mode / requires_preflight_review) also map through', async () => {
        primeUpdate();

        const res = await put('/api/mission/card/card_x')
            .send({ ...AUTH, dispatch_mode: 'idle_only', requires_preflight_review: true });

        expect(res.status).toBe(200);
        expect(res.body.warnings).toBeUndefined();
        const upd = capturedUpdate();
        expect(upd.sql).toMatch(/dispatch_mode = \$\d+/);
        expect(upd.sql).toMatch(/requires_preflight_review = \$\d+/);
        expect(upd.params).toContain('idle_only');
    });
});

// ════════════════════════════════════════════════════════════════
// (b) camelCase still works and WINS over a conflicting snake alias
// ════════════════════════════════════════════════════════════════
describe('(b) camelCase wins over conflicting snake alias', () => {
    it('camelCase-only still updates', async () => {
        primeUpdate();
        const res = await put('/api/mission/card/card_x')
            .send({ ...AUTH, requiresScreenshotReview: true });

        expect(res.status).toBe(200);
        expect(res.body.warnings).toBeUndefined();
        const upd = capturedUpdate();
        expect(upd.sql).toMatch(/requires_screenshot_review = \$\d+/);
        expect(upd.params).toContain(true);
    });

    it('when BOTH are sent, the explicit camelCase value wins', async () => {
        primeUpdate();
        // camelCase=false must beat snake=true.
        const res = await put('/api/mission/card/card_x')
            .send({ ...AUTH, requiresScreenshotReview: false, requires_screenshot_review: true });

        expect(res.status).toBe(200);
        // requires_screenshot_review is a KNOWN alias key → no "unknown" warning.
        expect(res.body.warnings).toBeUndefined();
        const upd = capturedUpdate();
        expect(upd.sql).toMatch(/requires_screenshot_review = \$\d+/);
        // The coerced value pushed must be false (camelCase), not true (snake).
        expect(upd.params).toContain(false);
        expect(upd.params).not.toContain(true);
    });
});

// ════════════════════════════════════════════════════════════════
// (c) unknown field → warnings entry, does NOT error
// ════════════════════════════════════════════════════════════════
describe('(c) unknown field yields a warning, not an error', () => {
    it('totally_bogus alongside a valid field → 200 + warnings, update still applies', async () => {
        primeUpdate();
        const res = await put('/api/mission/card/card_x')
            .send({ ...AUTH, title: 'Renamed', totally_bogus: 1 });

        expect(res.status).toBe(200);          // NOT a 400
        expect(res.body.success).toBe(true);
        expect(Array.isArray(res.body.warnings)).toBe(true);
        expect(res.body.warnings.some(w => /totally_bogus/.test(w))).toBe(true);
        expect(res.body.warnings[0]).toMatch(/Unknown field 'totally_bogus' ignored/);
        // The valid field still went through.
        const upd = capturedUpdate();
        expect(upd.sql).toMatch(/title = \$\d+/);
    });

    it('a near-miss snake typo of a real field gets a "did you mean" suggestion', async () => {
        primeUpdate();
        // requires_screenshotreview (missing underscore) is NOT a registered
        // alias but normalizes to requiresscreenshotreview → suggests the field.
        const res = await put('/api/mission/card/card_x')
            .send({ ...AUTH, title: 'x', requires_screenshotreview: true });

        expect(res.status).toBe(200);
        expect(res.body.warnings.some(w => /requiresScreenshotReview/.test(w))).toBe(true);
    });

    it('unknown field with NOTHING valid to update → 400 but warning is surfaced (not swallowed)', async () => {
        // existing SELECT * only; never reaches UPDATE.
        mockQuery.mockResolvedValueOnce({ rows: [cardRow()] });
        const res = await put('/api/mission/card/card_x')
            .send({ ...AUTH, totally_bogus: 1 });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Nothing to update');
        expect(res.body.warnings.some(w => /totally_bogus/.test(w))).toBe(true);
    });
});

// ════════════════════════════════════════════════════════════════
// (d) a normal valid PUT still succeeds with NO warnings
// ════════════════════════════════════════════════════════════════
describe('(d) normal valid PUT — no warnings', () => {
    it('title update succeeds with no warnings array', async () => {
        primeUpdate();
        const res = await put('/api/mission/card/card_x')
            .send({ ...AUTH, title: 'Just a rename' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.warnings).toBeUndefined();
        const upd = capturedUpdate();
        expect(upd.sql).toMatch(/title = \$\d+/);
    });

    it('auth passthrough keys (entityId/botSecret) never trigger warnings', async () => {
        primeUpdate();
        const res = await put('/api/mission/card/card_x')
            .send({ deviceId: 'test-dev', deviceSecret: 'test-secret', entityId: 0, botSecret: 'sec0', title: 'ok' });

        expect(res.status).toBe(200);
        expect(res.body.warnings).toBeUndefined();
    });
});
