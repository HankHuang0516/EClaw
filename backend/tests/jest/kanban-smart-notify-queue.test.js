'use strict';

/**
 * Smart-queue notify (card_dfe3b8df Phase 2) — code-shape regression tests.
 *
 * Pins the structural invariants of the smart-queue notify implementation
 * so future refactors cannot silently revert to the kanban_cron_spawn_notify
 * boolean gate (see Phase 1 PR #2302 for the drift it caused).
 *
 * Style follows kanban-stale-skip-recurring.test.js — static source-grep
 * rather than live DB integration. The actual queue behavior is exercised
 * end-to-end by the existing kanban smoke tests.
 */

const fs = require('fs');
const path = require('path');

const kanbanSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kanban.js'),
    'utf8'
);

const schemaSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kanban_schema.sql'),
    'utf8'
);

const devicePrefsSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'device-preferences.js'),
    'utf8'
);

describe('kanban smart-queue notify — schema', () => {
    test('kanban_pending_notify table exists with required columns', () => {
        expect(schemaSrc).toMatch(/CREATE TABLE IF NOT EXISTS kanban_pending_notify/);
        expect(schemaSrc).toMatch(/device_id\s+VARCHAR\(64\)\s+NOT NULL/);
        expect(schemaSrc).toMatch(/bot_entity_id\s+INTEGER\s+NOT NULL/);
        expect(schemaSrc).toMatch(/card_id\s+VARCHAR\(48\)\s+NOT NULL/);
        expect(schemaSrc).toMatch(/msg\s+TEXT\s+NOT NULL/);
        expect(schemaSrc).toMatch(/payload\s+JSONB/);
        expect(schemaSrc).toMatch(/created_at\s+TIMESTAMPTZ\s+DEFAULT NOW\(\)/);
    });

    test('FIFO drain index exists on (device_id, bot_entity_id, created_at)', () => {
        expect(schemaSrc).toMatch(
            /CREATE INDEX IF NOT EXISTS idx_kanban_pending_notify_bot ON kanban_pending_notify\(device_id, bot_entity_id, created_at\)/
        );
    });
});

describe('kanban smart-queue notify — helpers', () => {
    test('botHasPendingNotify is defined', () => {
        // Phase 2 hotfix #2307: gate switched from "bot has active cards" →
        // "bot has pending notify queued" to avoid burying every spawn for
        // bots with persistent work.
        expect(kanbanSrc).toMatch(/async function botHasPendingNotify\(deviceId, botId\)/);
    });

    test('botHasPendingNotify reads from kanban_pending_notify, not kanban_cards', () => {
        // Match the helper body (starts with botHasPendingNotify, ends at next async function).
        const helper = kanbanSrc.match(/async function botHasPendingNotify[\s\S]*?\n    \}/);
        expect(helper).not.toBeNull();
        expect(helper[0]).toMatch(/FROM kanban_pending_notify/);
        expect(helper[0]).not.toMatch(/FROM kanban_cards/);
    });

    test('enqueuePendingNotify is defined and writes to kanban_pending_notify', () => {
        expect(kanbanSrc).toMatch(/async function enqueuePendingNotify\(deviceId, botId, cardId, message, payload\)/);
        expect(kanbanSrc).toMatch(/INSERT INTO kanban_pending_notify/);
    });

    test('drainOnePendingNotify uses FOR UPDATE SKIP LOCKED for concurrent safety', () => {
        expect(kanbanSrc).toMatch(/async function drainOnePendingNotify\(deviceId, botId\)/);
        expect(kanbanSrc).toMatch(/FOR UPDATE SKIP LOCKED/);
    });

    test('drainOnePendingNotify orders by created_at ASC (FIFO)', () => {
        expect(kanbanSrc).toMatch(/ORDER BY created_at ASC/);
    });

    test('drainOnePendingNotify calls notifyEntities when an entry is drained', () => {
        // Source-grep: the drain helper hands the row to notifyEntities.
        const drainBlock = kanbanSrc.match(/async function drainOnePendingNotify[\s\S]*?\n    \}/);
        expect(drainBlock).not.toBeNull();
        expect(drainBlock[0]).toMatch(/notifyEntities\(deviceId, \[Number\(botId\)\], row\.msg/);
    });
});

describe('kanban smart-queue notify — cron-spawn integration', () => {
    test('cron-spawn block enqueues when queue non-empty, fires when queue empty', () => {
        // Hotfix #2307: gate must check botHasPendingNotify (not active-cards),
        // so first ping always fires for bots with persistent work.
        expect(kanbanSrc).toMatch(/const hasPending = await botHasPendingNotify\(card\.device_id, botId\)/);
        expect(kanbanSrc).toMatch(/await enqueuePendingNotify\(card\.device_id, botId, childCard\.id/);
    });

    test('cron-spawn block no longer references kanban_cron_spawn_notify pref', () => {
        // The flag was decommissioned in Phase 2. If a future change re-introduces
        // it, this test fails so reviewers can challenge.
        expect(kanbanSrc).not.toMatch(/spawnPrefs\.kanban_cron_spawn_notify/);
        expect(kanbanSrc).not.toMatch(/kanban_cron_spawn_notify\s*===\s*true/);
    });

    test('cron-spawn block no longer uses the active-cards gate (Phase 2 buried-spawn bug)', () => {
        // Regression-pin for #2307: the "active cards" gate buried every spawn
        // for bots with persistent todo/in_progress work. Must not return.
        expect(kanbanSrc).not.toMatch(/botHasActiveCards/);
    });
});

describe('kanban smart-queue notify — drain hook on move-to-done', () => {
    test('move handler drains pending notify when newStatus===done', () => {
        // The drain loop is gated on newStatus === 'done' and iterates over bots.
        const moveSection = kanbanSrc.match(
            /router\.post\('\/card\/:id\/move'[\s\S]*?\n    \}\);/
        );
        expect(moveSection).not.toBeNull();
        expect(moveSection[0]).toMatch(/if \(newStatus === 'done'\) \{[\s\S]*drainOnePendingNotify\(deviceId, bot\)/);
    });
});

describe('kanban smart-queue notify — device-preferences flag decommission', () => {
    test('kanban_cron_spawn_notify is removed from DEFAULTS', () => {
        // The DEFAULTS block must NOT define kanban_cron_spawn_notify any more.
        const defaultsBlock = devicePrefsSrc.match(/const DEFAULTS = \{[\s\S]*?\n\};/);
        expect(defaultsBlock).not.toBeNull();
        expect(defaultsBlock[0]).not.toMatch(/kanban_cron_spawn_notify\s*:/);
    });

    test('kanban_cron_recurring_notify is preserved (separate flag)', () => {
        const defaultsBlock = devicePrefsSrc.match(/const DEFAULTS = \{[\s\S]*?\n\};/);
        expect(defaultsBlock[0]).toMatch(/kanban_cron_recurring_notify\s*:\s*true/);
    });
});
