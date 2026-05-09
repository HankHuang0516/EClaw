/**
 * idle-dispatch-pr-b-wire.test.js — verifies the kanban POST /card/:id/move
 * route fires kanbanEvents.emit('card_status_changed', ...) when the flag
 * is ON, and stays silent when OFF (Mac_F sign-off req: "flag OFF 時不得
 *改變現有行為").
 *
 * Uses the same in-process pg mock pattern as kanban-card.test.js so we
 * exercise the real route handler — not just the emit primitive.
 */

const mockQuery = jest.fn();

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

const AUTH = { deviceId: 'test-dev', deviceSecret: 'test-secret' };
const MOCK_DEVICES = {
    'test-dev': {
        deviceSecret: 'test-secret',
        entities: {
            0: { isBound: true, botSecret: 'bot-sec', character: 'Bot0' },
            1: { isBound: true, botSecret: 'bot-sec-1', character: 'Bot1' },
        },
    },
};

// Existing card row + UPDATE result row used by the happy path.
const EXISTING_ROW = {
    id: 'card_test_1',
    device_id: 'test-dev',
    status: 'todo',
    assigned_bots: [0],
    archived: false,
    requires_screenshot_review: false,
    title: 'Test card',
    description: '',
    is_auto_generated: false,
    parent_card_id: null,
};

const UPDATED_ROW = {
    ...EXISTING_ROW,
    status: 'in_progress',
    status_changed_at: new Date(),
    updated_at: new Date(),
    last_stale_nudge_at: null,
};

function primeHappyPath() {
    // 1. SELECT existing card (line 1482)
    mockQuery.mockResolvedValueOnce({ rows: [EXISTING_ROW] });
    // 2. UPDATE kanban_cards (line 1526)
    mockQuery.mockResolvedValueOnce({ rows: [UPDATED_ROW] });
    // 3+. catch-all for addSystemComment / bumpVersion / etc.
    mockQuery.mockResolvedValue({ rows: [] });
}

function freshApp() {
    jest.resetModules();
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [] });
    const app = express();
    app.use(express.json());
    const kanbanModule = require('../../kanban')(MOCK_DEVICES, {});
    app.use('/api/mission', kanbanModule.router);
    const { kanbanEvents } = require('../../lib/kanban-events');
    return { app, kanbanEvents };
}

describe('idle-dispatch PR-B — /card/:id/move wires emit', () => {
    const originalFlag = process.env.IDLE_DISPATCH_HOOKS_ENABLED;

    afterAll(() => {
        if (originalFlag !== undefined) process.env.IDLE_DISPATCH_HOOKS_ENABLED = originalFlag;
        else delete process.env.IDLE_DISPATCH_HOOKS_ENABLED;
    });

    test('flag OFF: successful /move does NOT fire card_status_changed', async () => {
        delete process.env.IDLE_DISPATCH_HOOKS_ENABLED;
        const { app, kanbanEvents } = freshApp();
        primeHappyPath();
        const listener = jest.fn();
        kanbanEvents.on('card_status_changed', listener);

        const res = await request(app)
            .post('/api/mission/card/card_test_1/move')
            .send({ ...AUTH, entityId: 0, newStatus: 'in_progress', assignedBots: [0] });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(listener).not.toHaveBeenCalled();
    });

    test('flag ON: successful /move fires card_status_changed with full payload', async () => {
        process.env.IDLE_DISPATCH_HOOKS_ENABLED = 'true';
        const { app, kanbanEvents } = freshApp();
        primeHappyPath();
        const listener = jest.fn();
        kanbanEvents.on('card_status_changed', listener);

        const res = await request(app)
            .post('/api/mission/card/card_test_1/move')
            .send({ ...AUTH, entityId: 0, newStatus: 'in_progress', assignedBots: [0] });

        expect(res.status).toBe(200);
        expect(listener).toHaveBeenCalledTimes(1);
        const evt = listener.mock.calls[0][0];
        expect(evt.name).toBe('card_status_changed');
        expect(evt.payload.cardId).toBe('card_test_1');
        expect(evt.payload.fromStatus).toBe('todo');
        expect(evt.payload.toStatus).toBe('in_progress');
        expect(evt.payload.deviceId).toBe('test-dev');
        expect(evt.payload.entityId).toBe(0);
        expect(typeof evt.payload.ts).toBe('string');
    });

    test('flag ON: rejected move (validation) does NOT fire event', async () => {
        process.env.IDLE_DISPATCH_HOOKS_ENABLED = 'true';
        const { app, kanbanEvents } = freshApp();
        // No primeHappyPath — first SELECT returns empty so the 404 fires.
        mockQuery.mockResolvedValueOnce({ rows: [] });
        const listener = jest.fn();
        kanbanEvents.on('card_status_changed', listener);

        const res = await request(app)
            .post('/api/mission/card/missing_card/move')
            .send({ ...AUTH, entityId: 0, newStatus: 'in_progress', assignedBots: [0] });

        expect(res.status).toBe(404);
        expect(listener).not.toHaveBeenCalled();
    });
});
