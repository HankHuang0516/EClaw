/**
 * idle-dispatch-pr-c-wire.test.js — verifies createAutoCronCard fires
 * kanbanEvents.emit('auto_cron_card_created', ...) when the flag is ON,
 * and stays silent when OFF (Mac_F sign-off req: "flag OFF 不得改變現有
 * 行為").
 *
 * Mocks pg + idle_dispatch_handler so we exercise the real spawn path
 * without touching a database.
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

jest.mock('../../idle_dispatch_handler', () => ({
    smartDispatch: jest.fn().mockResolvedValue({ dispatched: true, reason: 'test' }),
    drainBotQueue: jest.fn().mockResolvedValue({ drained: 0 }),
}));

const PARENT_ROW = {
    title: 'Parent cron card',
    description: 'parent desc',
};

function primeSpawn() {
    // 1. SELECT parent
    mockQuery.mockResolvedValueOnce({ rows: [PARENT_ROW] });
    // 2. INSERT new card (createCardWithSmartDispatch)
    mockQuery.mockResolvedValueOnce({ rows: [{
        id: 'auto_card_xyz',
        device_id: 'dev_1',
        title: '[Auto] Parent cron card',
        description: 'auto desc',
        status: 'backlog',
        assigned_bots: [3],
        priority: 'P1',
    }] });
    // 3. UPDATE status='todo' after dispatch (smartDispatch returns dispatched:true)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 4. UPDATE is_auto_generated/parent_card_id link
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 5+: catch-all
    mockQuery.mockResolvedValue({ rows: [] });
}

describe('idle-dispatch PR-C — createAutoCronCard wires emit', () => {
    const originalFlag = process.env.IDLE_DISPATCH_HOOKS_ENABLED;

    afterAll(() => {
        if (originalFlag !== undefined) process.env.IDLE_DISPATCH_HOOKS_ENABLED = originalFlag;
        else delete process.env.IDLE_DISPATCH_HOOKS_ENABLED;
    });

    beforeEach(() => {
        jest.resetModules();
        mockQuery.mockReset();
        mockQuery.mockResolvedValue({ rows: [] });
    });

    test('flag OFF: createAutoCronCard does NOT fire auto_cron_card_created', async () => {
        delete process.env.IDLE_DISPATCH_HOOKS_ENABLED;
        const integ = require('../../idle_dispatch_integration');
        const { kanbanEvents } = require('../../lib/kanban-events');
        primeSpawn();
        const listener = jest.fn();
        kanbanEvents.on('auto_cron_card_created', listener);

        const result = await integ.createAutoCronCard('parent_1', 'dev_1', [3]);

        expect(result).toBeDefined();
        expect(result.id).toBe('auto_card_xyz');
        expect(listener).not.toHaveBeenCalled();
    });

    test('flag ON: createAutoCronCard fires auto_cron_card_created with full payload', async () => {
        process.env.IDLE_DISPATCH_HOOKS_ENABLED = 'true';
        const integ = require('../../idle_dispatch_integration');
        const { kanbanEvents } = require('../../lib/kanban-events');
        primeSpawn();
        const listener = jest.fn();
        kanbanEvents.on('auto_cron_card_created', listener);

        await integ.createAutoCronCard('parent_1', 'dev_1', [3]);

        expect(listener).toHaveBeenCalledTimes(1);
        const evt = listener.mock.calls[0][0];
        expect(evt.name).toBe('auto_cron_card_created');
        expect(evt.payload.cardId).toBe('auto_card_xyz');
        expect(evt.payload.parentCardId).toBe('parent_1');
        expect(evt.payload.deviceId).toBe('dev_1');
        expect(evt.payload.assignedBots).toEqual([3]);
        expect(typeof evt.payload.ts).toBe('string');
    });

    test('flag ON: spawn failure (parent missing) does NOT fire event', async () => {
        process.env.IDLE_DISPATCH_HOOKS_ENABLED = 'true';
        const integ = require('../../idle_dispatch_integration');
        const { kanbanEvents } = require('../../lib/kanban-events');
        // Parent SELECT returns empty → throws before spawn completes
        mockQuery.mockResolvedValueOnce({ rows: [] });
        const listener = jest.fn();
        kanbanEvents.on('auto_cron_card_created', listener);

        await expect(integ.createAutoCronCard('missing_parent', 'dev_1', [3]))
            .rejects.toThrow(/not found/);
        expect(listener).not.toHaveBeenCalled();
    });
});
