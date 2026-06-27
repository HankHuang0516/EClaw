'use strict';

/**
 * Regression test — stale-escalation must skip recurring-schedule automation parents.
 *
 * Background: cron-driven parent cards never have their `status_changed_at`
 * advance (cron creates child cards and resets the parent's `schedule_last_run_at`
 * instead). Without a schedule-skip clause in `checkStaleCards()`, these parents
 * get false-positive escalated to P0 every staleThresholdMs window — exactly
 * what produced the 4× P0 escalations on PR Quality / PR Auto-Review /
 * Golden-Path E2E / i18n Drift Scanner cron parents on 2026-05-02.
 *
 * The same skip filter already exists in `checkDoneAutoArchive()`; this test
 * pins it in `checkStaleCards()` too so a future refactor cannot drop it
 * silently.
 */

const fs = require('fs');
const path = require('path');

const kanbanSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kanban.js'),
    'utf8'
);

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

describe('checkStaleCards — recurring-schedule skip filter', () => {
    const body = extractFunctionBody(kanbanSrc, 'async function checkStaleCards()');

    test('SELECT excludes recurring-schedule automation parents', () => {
        // Mirrors the canonical clause from checkDoneAutoArchive.
        expect(body).toMatch(
            /schedule_enabled\s*=\s*false\s+OR\s+schedule_type\s*!=\s*'recurring'\s+OR\s+schedule_enabled\s+IS\s+NULL/
        );
    });

    test('SELECT still gates on stale_threshold_ms (no false-negative regression)', () => {
        expect(body).toMatch(
            /EXTRACT\(EPOCH FROM \(NOW\(\) - status_changed_at\)\) \* 1000 > stale_threshold_ms/
        );
    });

    test('SELECT still scopes to active statuses (backlog now excluded — parked)', () => {
        // backlog dropped from the candidate set: parked cards must not be re-nudged
        // (see kanban-stale-skip-backlog.test.js for the fail-on-old behavioural proof).
        expect(body).toMatch(/status IN \('todo', 'in_progress', 'review'\)/);
        expect(body).not.toMatch(/status IN \([^)]*'backlog'[^)]*\)/);
    });
});

describe('checkDoneAutoArchive — canonical skip filter still in place', () => {
    const body = extractFunctionBody(kanbanSrc, 'async function checkDoneAutoArchive()');

    test('keeps the same recurring-schedule skip clause used as the reference', () => {
        expect(body).toMatch(
            /schedule_enabled\s*=\s*false\s+OR\s+schedule_type\s*!=\s*'recurring'\s+OR\s+schedule_enabled\s+IS\s+NULL/
        );
    });
});
