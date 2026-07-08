'use strict';

/**
 * Owner-reported re-nudge loop (P0): the kanban scheduler kept firing / re-nudging
 * cards that the owner had already ARCHIVED or marked DONE.
 *
 * Root cause: checkScheduleTriggers fired any card with schedule_enabled=true and
 * a past schedule_next_run_at. When the owner archived a card or marked a cron母卡
 * (is_automation) / one-shot (once) card DONE, schedule_enabled was never cleared,
 * so schedule_next_run_at stayed in the past and the card looked "due" forever —
 * the server re-spawned child cards and every consumer (UI badge, an external cron
 * watcher binding a static card-id snapshot) kept treating it as pending and
 * re-nudged. (Archived cards were excluded from FIRING by `archived = false`, but
 * the schedule flag was still left enabled, so the stale "due" state persisted.)
 *
 * Fix:
 *   1. scheduleAutoDisableReason(card) — pure predicate: 'archived' | 'done' | null.
 *   2. checkScheduleTriggers now INCLUDES archived cards in its scan and, at the top
 *      of the per-card loop, auto-disables (schedule_enabled=false) + logs + records
 *      a system comment for any card the predicate flags, then skips it.
 *   3. checkStaleCards suppresses L1/L2/L3 nudges on orphaned children of a stopped
 *      parent (parent archived → any child; parent done → cron-spawned children).
 *
 * The behavioural block reconstructs the REAL checkScheduleTriggers loop with stubbed
 * deps + the REAL predicate and asserts an archived card and a done automation母卡 are
 * auto-disabled (no child spawned), while an active母卡 still spawns. This FAILS on the
 * pre-fix code (no guard → all three spawn children, zero disables) and PASSES after.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const kanbanSrc = fs.readFileSync(path.join(ROOT, 'kanban.js'), 'utf8');

const { _private } = require('../../kanban');
const { scheduleAutoDisableReason } = _private;

function extractFunctionBody(src, signature) {
    const start = src.indexOf(signature);
    if (start === -1) throw new Error(`function not found: ${signature}`);
    const open = src.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return src.slice(open, i + 1);
        }
    }
    throw new Error(`unterminated function: ${signature}`);
}

// ════════════════════════════════════════════════════════════════
// 1. Pure predicate
// ════════════════════════════════════════════════════════════════
describe('scheduleAutoDisableReason — pure predicate', () => {
    test('is exported from _private', () => {
        expect(typeof scheduleAutoDisableReason).toBe('function');
    });

    test('archived card (any type/status) → "archived"', () => {
        expect(scheduleAutoDisableReason({ archived: true, status: 'in_progress', schedule_type: 'recurring' })).toBe('archived');
        expect(scheduleAutoDisableReason({ archived: true, status: 'todo', schedule_type: 'once' })).toBe('archived');
        expect(scheduleAutoDisableReason({ archived: true, status: 'done', is_automation: true })).toBe('archived');
    });

    test('DONE automation母卡 → "done"', () => {
        expect(scheduleAutoDisableReason({ archived: false, status: 'done', is_automation: true, schedule_type: 'recurring' })).toBe('done');
    });

    test('DONE one-shot (once) card → "done"', () => {
        expect(scheduleAutoDisableReason({ archived: false, status: 'done', schedule_type: 'once' })).toBe('done');
    });

    test('DONE normal self-recurring card → null (done→todo is its NORMAL cycle)', () => {
        // A plain recurring card (NOT is_automation, NOT once) must keep firing —
        // it legitimately cycles done→todo on each tick.
        expect(scheduleAutoDisableReason({ archived: false, status: 'done', schedule_type: 'recurring', is_automation: false })).toBeNull();
    });

    test('active cards (any type) → null', () => {
        expect(scheduleAutoDisableReason({ archived: false, status: 'in_progress', is_automation: true, schedule_type: 'recurring' })).toBeNull();
        expect(scheduleAutoDisableReason({ archived: false, status: 'todo', schedule_type: 'once' })).toBeNull();
        expect(scheduleAutoDisableReason(null)).toBeNull();
        expect(scheduleAutoDisableReason(undefined)).toBeNull();
    });
});

// ════════════════════════════════════════════════════════════════
// 2. Source-grep invariants
// ════════════════════════════════════════════════════════════════
describe('checkScheduleTriggers — self-heal invariants', () => {
    const body = extractFunctionBody(kanbanSrc, 'async function checkScheduleTriggers()');

    test('SELECT no longer filters out archived cards (so they can be self-healed)', () => {
        // Isolate the trigger SELECT's SQL literal (avoid matching surrounding comments).
        const selStart = body.indexOf('SELECT * FROM kanban_cards');
        const sql = body.slice(selStart, body.indexOf('`)', selStart));
        expect(sql).toMatch(/schedule_next_run_at\s*<=\s*NOW\(\)/);
        expect(sql).not.toMatch(/archived\s*=\s*false/);
    });

    test('per-card guard calls scheduleAutoDisableReason, disables schedule, and continues — BEFORE the firing branches', () => {
        const guardIdx = body.indexOf('scheduleAutoDisableReason(card)');
        const recurringIdx = body.indexOf("schedType === 'recurring'");
        const onceIdx = body.indexOf("schedType === 'once'");
        expect(guardIdx).toBeGreaterThan(-1);
        // The guard must precede every firing branch.
        expect(guardIdx).toBeLessThan(recurringIdx);
        expect(guardIdx).toBeLessThan(onceIdx);
        // It must disable + skip.
        const guardBlock = body.slice(guardIdx, body.indexOf('const bots = card.assigned_bots'));
        expect(guardBlock).toMatch(/schedule_enabled\s*=\s*false/);
        expect(guardBlock).toMatch(/continue;/);
    });
});

describe('checkStaleCards — orphaned-children nudge suppression', () => {
    const body = extractFunctionBody(kanbanSrc, 'async function checkStaleCards()');

    test('SELECT excludes children whose parent is archived (any) or done (auto-generated)', () => {
        expect(body).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM kanban_cards parent/);
        expect(body).toMatch(/parent\.archived\s*=\s*true/);
        expect(body).toMatch(/parent\.status\s*=\s*'done'\s*AND\s*kanban_cards\.is_auto_generated\s*=\s*true/);
    });
});

// ════════════════════════════════════════════════════════════════
// 3. Behavioural — reconstruct the REAL checkScheduleTriggers loop
// ════════════════════════════════════════════════════════════════
describe('checkScheduleTriggers — behavioural self-heal', () => {
    const fnBody = extractFunctionBody(kanbanSrc, 'async function checkScheduleTriggers()');

    function makeHarness(seededCards) {
        const log = {
            disableUpdates: [],   // ids of cards whose schedule was disabled
            childInserts: 0,      // child-card spawns
            comments: [],         // {cardId, text}
            notifies: 0,
        };

        const pool = {
            query: async (sql, params = []) => {
                // 1) the trigger SELECT
                if (/schedule_next_run_at\s*<=\s*NOW\(\)/.test(sql) && /SELECT \* FROM kanban_cards/.test(sql)) {
                    return { rows: seededCards };
                }
                // 2) self-heal disable
                if (/UPDATE kanban_cards SET schedule_enabled = false/.test(sql)) {
                    log.disableUpdates.push(params[0]);
                    return { rows: [] };
                }
                // 3) child-card spawn
                if (/INSERT INTO kanban_cards/.test(sql)) {
                    log.childInserts += 1;
                    return { rows: [{ id: `child_${log.childInserts}`, assigned_bots: [] }] };
                }
                // 4) active-child existence check / all other reads + writes
                return { rows: [] };
            },
        };

        const deps = {
            pool,
            devicePrefs: { getPrefs: async () => ({}) },
            getRecurringScheduleFireDecision: () => ({ shouldFire: true, realignTo: null, reason: 'due' }),
            scheduleAutoDisableReason, // the REAL predicate
            computeNextRun: () => new Date(Date.now() + 3600 * 1000),
            addSystemComment: async (cardId, deviceId, text) => { log.comments.push({ cardId, text }); },
            STATUS_LABELS: { backlog: '待排程', todo: '待辦', in_progress: '進行中', review: '審核', done: '完成', blocked: '阻塞' },
            notifyEntities: async () => { log.notifies += 1; },
            getDeviceLanguage: async () => 'zh',
            tKanban: () => 'msg',
            evaluateUsageSkipDecision: async () => ({ skip: false }),
            newCardId: () => `new_${Math.random().toString(36).slice(2)}`,
            bumpVersion: async () => {},
            botHasPendingNotify: async () => false,
            botActiveWorkload: async () => 0,
            enqueuePendingNotify: async () => {},
            statusLabel: () => 'x',
            console: { log: () => {}, error: () => {} },
        };

        // eslint-disable-next-line no-new-func
        const fn = new Function(
            'pool', 'devicePrefs', 'getRecurringScheduleFireDecision', 'scheduleAutoDisableReason',
            'computeNextRun', 'addSystemComment', 'STATUS_LABELS', 'notifyEntities', 'getDeviceLanguage',
            'tKanban', 'evaluateUsageSkipDecision', 'newCardId', 'bumpVersion', 'botHasPendingNotify',
            'botActiveWorkload', 'enqueuePendingNotify', 'statusLabel', 'console',
            `return async function checkScheduleTriggers() ${fnBody}`
        )(
            deps.pool, deps.devicePrefs, deps.getRecurringScheduleFireDecision, deps.scheduleAutoDisableReason,
            deps.computeNextRun, deps.addSystemComment, deps.STATUS_LABELS, deps.notifyEntities, deps.getDeviceLanguage,
            deps.tKanban, deps.evaluateUsageSkipDecision, deps.newCardId, deps.bumpVersion, deps.botHasPendingNotify,
            deps.botActiveWorkload, deps.enqueuePendingNotify, deps.statusLabel, deps.console
        );

        return { fn, log };
    }

    function automationCard(overrides) {
        return {
            id: 'card_x',
            device_id: 'dev1',
            title: 'cron母卡',
            description: '',
            priority: 'P2',
            status: 'in_progress',
            assigned_bots: [1],
            created_by: 'owner',
            is_automation: true,
            schedule_type: 'recurring',
            schedule_enabled: true,
            schedule_cron: '0 * * * *',
            schedule_timezone: 'Asia/Taipei',
            dispatch_mode: 'immediate',
            active_child_id: null,
            stale_threshold_ms: 10800000,
            done_retention_ms: 86400000,
            reviewer_entity_id: null,
            requires_screenshot_review: null,
            archived: false,
            ...overrides,
        };
    }

    const ORIG_JITTER = process.env.CRON_NOTIFY_JITTER_MS;
    beforeAll(() => { process.env.CRON_NOTIFY_JITTER_MS = '0'; }); // no setTimeout in notify path
    afterAll(() => {
        if (ORIG_JITTER === undefined) delete process.env.CRON_NOTIFY_JITTER_MS;
        else process.env.CRON_NOTIFY_JITTER_MS = ORIG_JITTER;
    });

    test('archived母卡 and DONE automation母卡 are auto-disabled (no child spawned); active母卡 still spawns', async () => {
        const archived = automationCard({ id: 'arch_1', archived: true, status: 'in_progress' });
        const doneCron = automationCard({ id: 'done_1', archived: false, status: 'done' });
        const active = automationCard({ id: 'active_1', archived: false, status: 'in_progress' });

        const { fn, log } = makeHarness([archived, doneCron, active]);
        await fn();

        // The two stopped cards were disabled, NOT fired.
        expect(log.disableUpdates.sort()).toEqual(['arch_1', 'done_1']);
        // Only the active母卡 spawned a child.
        expect(log.childInserts).toBe(1);
        // A self-heal system comment was recorded for each stopped card.
        const commentedIds = log.comments.filter(c => /排程自動停用|auto-disabled/.test(c.text)).map(c => c.cardId).sort();
        expect(commentedIds).toEqual(['arch_1', 'done_1']);
    });

    test('a card whose schedule is auto-disabled never reaches the firing path again', async () => {
        // Single archived card: zero child inserts, exactly one disable.
        const { fn, log } = makeHarness([automationCard({ id: 'arch_only', archived: true })]);
        await fn();
        expect(log.childInserts).toBe(0);
        expect(log.disableUpdates).toEqual(['arch_only']);
        expect(log.notifies).toBe(0);
    });
});
