'use strict';

/**
 * Cron-spawn jitter + lane backpressure (card_a19dc866) — code-shape regression tests.
 *
 * 2026-05-14 04:02–04:08 UTC: 5 same-minute mom-card crons (all on the
 * "every 2h, minute 0" schedule) pushed 5 notifyEntities calls into the #1
 * bot lane within ~7s. messageQueue
 * grew from 7 → 11, wait time 295s → 797s. Hank manually staggered the moms
 * to 05/10/15/20/25 minutes. This PR adds infra-level prevention so the wedge
 * cannot recur from a future co-scheduled batch.
 *
 * Style follows kanban-smart-notify-queue.test.js — static source-grep rather
 * than live DB integration. Behavioral coverage rides on the existing kanban
 * smoke + smart-queue tests; this file pins the new invariants only.
 */

const fs = require('fs');
const path = require('path');

const kanbanSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kanban.js'),
    'utf8'
);

describe('cron-spawn jitter — Layer 1', () => {
    test('jitter delay applied before notify push, after child INSERT', () => {
        const childIdxStart = kanbanSrc.indexOf('Automation child created:');
        const jitterIdx = kanbanSrc.indexOf('jitter ${jitterMs}ms before notify');
        const notifyIdx = kanbanSrc.indexOf('Smart-queue: pushed immediate notify');
        expect(childIdxStart).toBeGreaterThan(-1);
        expect(jitterIdx).toBeGreaterThan(-1);
        expect(notifyIdx).toBeGreaterThan(-1);
        // Order: child INSERT log → jitter log → notify push log
        expect(jitterIdx).toBeGreaterThan(childIdxStart);
        expect(notifyIdx).toBeGreaterThan(jitterIdx);
    });

    test('jitter ceiling is configurable via CRON_NOTIFY_JITTER_MS env, default 30s', () => {
        expect(kanbanSrc).toMatch(/Number\(process\.env\.CRON_NOTIFY_JITTER_MS\)\s*\|\|\s*30000/);
    });

    test('jitter is random within [0, max), not fixed', () => {
        expect(kanbanSrc).toMatch(/Math\.floor\(Math\.random\(\)\s*\*\s*jitterMaxMs\)/);
    });

    test('jitter=0 short-circuits the setTimeout (so tests can disable)', () => {
        // Setting CRON_NOTIFY_JITTER_MS=0 must skip the await sleep — otherwise
        // unit tests with fake timers cannot observe the rest of the spawn loop.
        expect(kanbanSrc).toMatch(/jitterMaxMs > 0 \? Math\.floor\(Math\.random\(\)/);
        expect(kanbanSrc).toMatch(/if \(jitterMs > 0\) \{[\s\S]{0,200}setTimeout\(r, jitterMs\)/);
    });

    test('jitter is applied inside the `if (bots.length > 0)` block, not gating the child INSERT', () => {
        // Critical invariant: the child card must be persisted before we sleep.
        // Otherwise a crash during jitter loses the card entirely.
        const insertMatch = kanbanSrc.match(/const childResult = await pool\.query\(\s*`INSERT INTO kanban_cards/);
        const jitterMatch = kanbanSrc.match(/jitter \$\{jitterMs\}ms before notify/);
        expect(insertMatch).not.toBeNull();
        expect(jitterMatch).not.toBeNull();
        expect(jitterMatch.index).toBeGreaterThan(insertMatch.index);
    });
});

describe('lane backpressure — Layer 2', () => {
    test('botActiveWorkload helper is defined and reads from kanban_cards', () => {
        expect(kanbanSrc).toMatch(/async function botActiveWorkload\(deviceId, botId\)/);
        const helper = kanbanSrc.match(/async function botActiveWorkload[\s\S]*?\n    \}/);
        expect(helper).not.toBeNull();
        expect(helper[0]).toMatch(/FROM kanban_cards/);
        expect(helper[0]).toMatch(/archived = false/);
        expect(helper[0]).toMatch(/status IN \('todo','in_progress','review'\)/);
    });

    test('backpressure threshold is configurable via env, default 5', () => {
        expect(kanbanSrc).toMatch(/Number\(process\.env\.CRON_NOTIFY_BACKPRESSURE_THRESHOLD\)\s*\|\|\s*5/);
    });

    test('notify decision uses (hasPending || backpressure) to choose enqueue path', () => {
        expect(kanbanSrc).toMatch(/const workload = await botActiveWorkload\(card\.device_id, botId\)/);
        expect(kanbanSrc).toMatch(/const backpressure = workload >= backpressureThreshold/);
        expect(kanbanSrc).toMatch(/if \(hasPending \|\| backpressure\)/);
    });

    test('backpressure log line surfaces both signals for debug', () => {
        // Operators need to distinguish "queue had pending" from "lane backpressured"
        // when triaging future wedges; log line must expose both.
        expect(kanbanSrc).toMatch(
            /enqueued notify for bot #\$\{botId\}[\s\S]{0,200}hasPending=\$\{hasPending\}, workload=\$\{workload\}, backpressure=\$\{backpressure\}/
        );
    });

    test('immediate push path also logs workload for telemetry', () => {
        expect(kanbanSrc).toMatch(/pushed immediate notify for bot #\$\{botId\}[\s\S]{0,80}workload=\$\{workload\}/);
    });
});

describe('safety — what must NOT change', () => {
    test('child card INSERT still uses status=todo and inherits screenshot review', () => {
        // Sanity: confirm the new jitter/backpressure code didn't disturb the
        // existing spawn behavior (status, inheritance).
        expect(kanbanSrc).toMatch(/VALUES \(\$1, \$2, \$3, \$4, \$5, 'todo', \$6::jsonb/);
        expect(kanbanSrc).toMatch(/requires_screenshot_review\)\n\s*VALUES/);
    });

    test('user-visible schedule_next_run_at is NOT delayed by jitter', () => {
        // task description explicit: "不改 nextRunAt". Confirm the UPDATE that
        // writes schedule_next_run_at sits before the jitter sleep, not after.
        const nextRunMatch = kanbanSrc.match(/schedule_next_run_at = \$1,\s+active_child_id = \$2/);
        const jitterMatch = kanbanSrc.match(/jitter \$\{jitterMs\}ms before notify/);
        expect(nextRunMatch).not.toBeNull();
        expect(jitterMatch).not.toBeNull();
        expect(jitterMatch.index).toBeGreaterThan(nextRunMatch.index);
    });

    test('botHasPendingNotify is still consulted (smart-queue Phase 2 preserved)', () => {
        // Layer 2 must compose with the existing Phase 2 logic, not replace it.
        expect(kanbanSrc).toMatch(/const hasPending = await botHasPendingNotify\(card\.device_id, botId\)/);
    });
});
