/**
 * Kanban → chat kanban_ref deep-link tests.
 *
 * Verifies that notifyEntities forwards { kind: 'kanban_ref', id } to
 * saveChatMessage so chat.html can render a clickable "view card" button.
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
let saveChatSpy;
let channelPushSpy;

beforeAll(() => {
    app = express();
    app.use(express.json());

    const mockDevices = {
        'dev-1': {
            deviceSecret: 'secret-1',
            entities: {
                0: { isBound: true, botSecret: 'bot-0', character: 'Bot0', bindingType: 'channel', channelAccountId: 'ch-0' },
            },
        },
    };

    saveChatSpy = jest.fn().mockResolvedValue('chat-msg-uuid');
    channelPushSpy = jest.fn().mockResolvedValue({ pushed: true });

    const kanbanModule = require('../../kanban')(mockDevices, {
        saveChatMessage: saveChatSpy,
        pushToChannelCallback: channelPushSpy,
        getMissionApiHints: () => '[AVAILABLE TOOLS - Kanban Board]',
    });
    app.use('/api/mission', kanbanModule.router);
});

beforeEach(() => {
    mockQuery.mockReset();
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    saveChatSpy.mockClear();
    channelPushSpy.mockClear();
});

const AUTH = { deviceId: 'dev-1', deviceSecret: 'secret-1' };

const createdCardRow = {
    id: 'card_abc', device_id: 'dev-1', title: 'Hello',
    description: 'desc', priority: 'P2', status: 'todo',
    assigned_bots: [0], created_by: 0,
    created_at: new Date(), updated_at: new Date(),
    status_changed_at: new Date(), archived: false,
};

describe('notifyEntities → saveChatMessage kanban_ref card arg', () => {
    it('forwards { kind: "kanban_ref", id } in the card slot on card create', async () => {
        mockQuery.mockResolvedValueOnce({ rows: [createdCardRow] }); // INSERT
        mockQuery.mockResolvedValueOnce({ rows: [] });                // bumpVersion
        mockQuery.mockResolvedValueOnce({ rows: [] });                // addSystemComment

        const res = await request(app).post('/api/mission/card').send({
            ...AUTH, title: 'Hello', assignedBots: [0], status: 'todo',
            chatAnchorMessageId: 'aaaaaaaa-1111-2222-3333-444444444444',
        });

        expect(res.status).toBe(200);
        // notifyEntities is fire-and-forget (no await at call site) — wait a microtask
        await new Promise((r) => setImmediate(r));

        expect(saveChatSpy).toHaveBeenCalled();
        const args = saveChatSpy.mock.calls[0];
        // saveChatMessage signature: (deviceId, entityId, text, source, isFromUser, isFromBot,
        //                             mediaType, mediaUrl, scheduleId, scheduleLabel,
        //                             backupUrl, mentions, card, attachments)
        const cardArg = args[12];
        expect(cardArg).toEqual({ kind: 'kanban_ref', id: 'card_abc' });
        expect(channelPushSpy).toHaveBeenCalledWith('dev-1', 0, expect.objectContaining({
            event: 'kanban_notification',
            from: 'kanban',
            eclaw_context: expect.objectContaining({
                expectsReply: true,
                silentToken: '[SILENT]',
            }),
        }), 'ch-0');
    });

    it('forwards the moved card id on status change (todo → in_progress)', async () => {
        // POST /card/:id/move exercises the statusChanged notify path (L1040).
        // This is the most-fired path in real use because automated recurring
        // cards transition via move, and we want the chat deep-link to land on
        // the card that just changed state.
        const movedCardRow = {
            ...createdCardRow,
            id: 'card_xyz',
            status: 'todo',
            assigned_bots: [0],
        };
        mockQuery
            .mockResolvedValueOnce({ rows: [movedCardRow] })   // SELECT current row
            .mockResolvedValueOnce({ rows: [{ ...movedCardRow, status: 'in_progress' }] }) // UPDATE returning
            .mockResolvedValue({ rows: [] });                   // addSystemComment + bumpVersion + etc.

        const res = await request(app).post('/api/mission/card/card_xyz/move').send({
            ...AUTH, newStatus: 'in_progress',
        });

        expect(res.status).toBe(200);
        await new Promise((r) => setImmediate(r));

        expect(saveChatSpy).toHaveBeenCalled();
        const cardArg = saveChatSpy.mock.calls[0][12];
        expect(cardArg).toEqual({ kind: 'kanban_ref', id: 'card_xyz' });
    });

    it('debug endpoint reports the fixed Codex-channel nudge payload contract', async () => {
        const staleCard = {
            ...createdCardRow,
            id: 'card_stale',
            assigned_bots: [0],
            stale_threshold_ms: 1000,
            status_changed_at: new Date(Date.now() - 3600_000),
            last_stale_nudge_at: null,
        };
        mockQuery.mockResolvedValueOnce({ rows: [staleCard], rowCount: 1 });

        const res = await request(app)
            .get('/api/mission/debug/kanban-codex-nudge')
            .query(AUTH)
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.bug).toBe('kanban-codex-nudge');
        expect(res.body.diagnostics.expectedChannelPayload).toMatchObject({
            event: 'kanban_notification',
            from: 'kanban',
            eclaw_context: {
                expectsReply: true,
                silentToken: '[SILENT]',
            },
        });
        expect(res.body.diagnostics.assignedEntities).toEqual([
            expect.objectContaining({
                entityId: 0,
                bindingType: 'channel',
                channelPushPossible: true,
                fixedPayloadExpectsReply: true,
            }),
        ]);
    });
});
