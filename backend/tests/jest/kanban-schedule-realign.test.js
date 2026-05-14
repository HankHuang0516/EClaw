'use strict';

/**
 * Regression guard for automation cron bursts.
 *
 * A stale schedule_next_run_at from an old cron slot must not be replayed when
 * the scheduler wakes up before the next intended minute offset. Otherwise
 * staggered automation parents (minute 5/10/15/20/25 every 2 hours) collapse into one burst.
 */

const { _private } = require('../../kanban');

const { getRecurringScheduleFireDecision } = _private;

describe('kanban recurring schedule realignment', () => {
    test('skips stale staggered cron slot before next minute offset', () => {
        const now = new Date('2026-05-14T04:02:47.000Z'); // 12:02:47 Asia/Taipei
        const decision = getRecurringScheduleFireDecision({
            id: 'auto-slo',
            title: 'API SLO',
            schedule_type: 'recurring',
            schedule_cron: '5 */2 * * *',
            schedule_timezone: 'Asia/Taipei',
            // Previous intended slot: 10:05 Asia/Taipei. It is stale by ~2h.
            schedule_next_run_at: new Date('2026-05-14T02:05:00.000Z'),
        }, now);

        expect(decision.shouldFire).toBe(false);
        expect(decision.reason).toBe('missed_grace_window');
        expect(decision.realignTo.toISOString()).toBe('2026-05-14T04:05:00.000Z');
    });

    test('preserves legitimate late firing inside the grace window', () => {
        const now = new Date('2026-05-14T04:02:47.000Z'); // 12:02:47 Asia/Taipei
        const decision = getRecurringScheduleFireDecision({
            id: 'task-patrol',
            title: 'Task Patrol',
            schedule_type: 'recurring',
            schedule_cron: '0 */4 * * *',
            schedule_timezone: 'Asia/Taipei',
            // Current intended slot: 12:00 Asia/Taipei. 2m47s late is OK.
            schedule_next_run_at: new Date('2026-05-14T04:00:00.000Z'),
        }, now);

        expect(decision.shouldFire).toBe(true);
        expect(decision.reason).toBe('due');
    });

    test('staggered automation parents do not all fire at HH:02', () => {
        const now = new Date('2026-05-14T04:02:47.000Z'); // 12:02:47 Asia/Taipei
        const staggeredCrons = ['5 */2 * * *', '10 */2 * * *', '15 */2 * * *', '20 */2 * * *', '25 */2 * * *'];
        const decisions = staggeredCrons.map((cron) => getRecurringScheduleFireDecision({
            schedule_type: 'recurring',
            schedule_cron: cron,
            schedule_timezone: 'Asia/Taipei',
            schedule_next_run_at: new Date('2026-05-14T02:05:00.000Z'),
        }, now));

        expect(decisions.every((d) => d.shouldFire === false)).toBe(true);
        expect(decisions.map((d) => d.realignTo.toISOString())).toEqual([
            '2026-05-14T04:05:00.000Z',
            '2026-05-14T04:10:00.000Z',
            '2026-05-14T04:15:00.000Z',
            '2026-05-14T04:20:00.000Z',
            '2026-05-14T04:25:00.000Z',
        ]);
    });
});
