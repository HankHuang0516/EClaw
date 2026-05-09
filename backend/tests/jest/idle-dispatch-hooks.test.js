/**
 * idle-dispatch-hooks.test.js - Tests for kanban-events.js instrumentation.
 * Flag OFF: emit is no-op. Flag ON: emit calls listener with correct payload.
 */
const path = require('path');

describe('idle-dispatch hooks', () => {
    const originalEnv = process.env.IDLE_DISPATCH_HOOKS_ENABLED;

    afterAll(() => {
        if (originalEnv !== undefined) {
            process.env.IDLE_DISPATCH_HOOKS_ENABLED = originalEnv;
        } else {
            delete process.env.IDLE_DISPATCH_HOOKS_ENABLED;
        }
    });

    describe('flag OFF', () => {
        beforeEach(() => {
            delete process.env.IDLE_DISPATCH_HOOKS_ENABLED;
            jest.resetModules();
        });

        test('emit() is no-op when flag is OFF', () => {
            const { emit, kanbanEvents } = require('../../lib/kanban-events');
            const listener = jest.fn();
            kanbanEvents.on('card_status_changed', listener);
            emit('card_status_changed', {
                cardId: 'card_123',
                fromStatus: 'todo',
                toStatus: 'done',
                deviceId: 'device_abc',
                entityId: '3',
                ts: new Date().toISOString(),
            });
            expect(listener).not.toHaveBeenCalled();
        });
    });

    describe('flag ON', () => {
        beforeEach(() => {
            process.env.IDLE_DISPATCH_HOOKS_ENABLED = 'true';
            jest.resetModules();
        });

        test('emit() calls listener once with correct payload', () => {
            const { emit, kanbanEvents } = require('../../lib/kanban-events');
            const listener = jest.fn();
            kanbanEvents.on('card_status_changed', listener);
            const payload = {
                cardId: 'card_xyz',
                fromStatus: 'in_progress',
                toStatus: 'done',
                deviceId: 'device_abc',
                entityId: '5',
                ts: new Date().toISOString(),
            };
            emit('card_status_changed', payload);
            expect(listener).toHaveBeenCalledTimes(1);
            const event = listener.mock.calls[0][0];
            expect(event.name).toBe('card_status_changed');
            expect(event.payload.cardId).toBe('card_xyz');
            expect(event.payload.fromStatus).toBe('in_progress');
            expect(event.payload.toStatus).toBe('done');
            expect(event.payload.deviceId).toBe('device_abc');
            expect(event.payload.entityId).toBe('5');
        });

        test('emit() does not throw on listener error', () => {
            const { emit, kanbanEvents } = require('../../lib/kanban-events');
            kanbanEvents.on('card_status_changed', () => {
                throw new Error('listener crash');
            });
            expect(() => {
                emit('card_status_changed', {
                    cardId: 'card_1',
                    fromStatus: 'todo',
                    toStatus: 'done',
                    deviceId: 'd',
                    entityId: '1',
                    ts: new Date().toISOString(),
                });
            }).not.toThrow();
        });

        test('no secrets in payload', () => {
            const { emit, kanbanEvents } = require('../../lib/kanban-events');
            const listener = jest.fn();
            kanbanEvents.on('card_status_changed', listener);
            emit('card_status_changed', {
                cardId: 'card_123',
                fromStatus: 'todo',
                toStatus: 'done',
                deviceId: 'device_secret',
                entityId: '3',
                botSecret: 'BOT_SECRET_HERE',
                ts: new Date().toISOString(),
            });
            const jsonStr = JSON.stringify(listener.mock.calls[0][0]);
            expect(jsonStr).not.toContain('BOT_SECRET_HERE');
        });
    });

    describe('structured log output', () => {
        beforeEach(() => {
            process.env.IDLE_DISPATCH_HOOKS_ENABLED = 'true';
            jest.resetModules();
        });

        test('console.log JSON contains ev field', () => {
            const { emit } = require('../../lib/kanban-events');
            const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
            emit('card_status_changed', {
                cardId: 'card_log',
                fromStatus: 'todo',
                toStatus: 'in_progress',
                deviceId: 'dev_1',
                entityId: '3',
                ts: '2026-05-07T00:00:00.000Z',
            });
            expect(logSpy).toHaveBeenCalled();
            const logArg = JSON.parse(logSpy.mock.calls[0][0]);
            expect(logArg.ev).toBe('idle_dispatch.card_status_changed');
            logSpy.mockRestore();
        });
    });
});