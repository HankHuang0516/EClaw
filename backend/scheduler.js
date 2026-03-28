/**
 * Scheduler module — DEPRECATED (migrated to Kanban board)
 *
 * This stub exists only to prevent require() errors in Jest test mocks.
 * All schedule functionality has been moved to the Kanban board (kanban.js).
 */

'use strict';

module.exports = {
    init: () => {},
    getSchedules: async () => [],
    getExecutions: async () => [],
    getSchedule: async () => null,
    createSchedule: async () => ({ id: 0 }),
    updateSchedule: async () => ({}),
    deleteSchedule: async () => {},
    togglePause: async () => ({}),
    getSchedulesForBot: async () => [],
};
