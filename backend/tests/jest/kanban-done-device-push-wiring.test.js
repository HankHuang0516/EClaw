'use strict';

/**
 * Regression: kanban card-done → owner device web-push / FCM dispatch wiring.
 *
 * card_caa6307361d8e8196bbdeb5a — "[Bug/Mobile/P1] 手機通知最近不工作 — 尤其
 * 任務完成通知 (kanban done push)".
 *
 * Investigation outcome: the device-push chain is intact end-to-end
 * (move→done and auto-close→done both call notifyDevice → sendWebPush +
 * sendFcm). The danger is a SILENT regression — a future refactor dropping
 * the notifyDevice() call from either done path, or wiring an unregistered
 * notification category, would re-introduce "phone never gets task-done
 * push" with zero test coverage (the only prior test,
 * kanban-done-push-categories.test.js, asserts the prefs key exists but NOT
 * that the move handler actually dispatches).
 *
 * Style: static source-grep, matching kanban-smart-notify-queue.test.js
 * (the kanban module requires a live pg pool, so behavioral mocking is not
 * the convention for this module). These tests pin the structural
 * invariants so the wiring cannot silently rot.
 */

const fs = require('fs');
const path = require('path');

const kanbanSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kanban.js'),
    'utf8'
);
const indexSrc = fs.readFileSync(
    path.join(__dirname, '..', '..', 'index.js'),
    'utf8'
);
const { DEFAULT_PREFS } = require('../../notifications');

describe('kanban done → device push wiring (manual /move)', () => {
    test('createKanbanModule accepts notifyDevice dependency', () => {
        expect(kanbanSrc).toMatch(/function createKanbanModule\([^)]*notifyDevice[^)]*\)/);
    });

    test('index.js passes notifyDevice into the kanban module', () => {
        // require('./kanban')(devices, { ... notifyDevice ... })
        expect(indexSrc).toMatch(/require\(['"]\.\/kanban['"]\)\(devices,\s*\{[\s\S]*?notifyDevice[\s\S]*?\}\)/);
    });

    test("move→done dispatches device push via notifyDevice with kanban_done/kanban_done_auto", () => {
        // The newStatus === 'done' branch must call notifyDevice with the
        // owner deviceId and a kanban_done* category.
        expect(kanbanSrc).toMatch(/newStatus === 'done' && typeof notifyDevice === 'function'/);
        const doneBlock = kanbanSrc.slice(
            kanbanSrc.indexOf("newStatus === 'done' && typeof notifyDevice === 'function'")
        ).slice(0, 800);
        expect(doneBlock).toMatch(/notifyDevice\(deviceId,/);
        expect(doneBlock).toMatch(/'kanban_done_auto'/);
        expect(doneBlock).toMatch(/'kanban_done'/);
    });

    test('move→done logs a stdout breadcrumb for diagnosability', () => {
        // serverLog (fcm/web_push) only hits the server_logs DB table, so a
        // stdout breadcrumb is the single Railway-log signal that the dispatch
        // path fired. Without it "手機沒收到推播" is undiagnosable from logs.
        expect(kanbanSrc).toMatch(/move→done device-push dispatch/);
    });
});

describe('kanban auto-close (autoReviewOnTransform) → device push wiring', () => {
    test('auto-done path dispatches device push via notifyDevice', () => {
        const idx = kanbanSrc.indexOf('async function autoReviewOnTransform');
        expect(idx).toBeGreaterThan(-1);
        const fnBody = kanbanSrc.slice(idx, idx + 9000);
        // Bot-reported IDLE auto-completion must still reach the owner device.
        expect(fnBody).toMatch(/notifyDevice\(deviceId,/);
        expect(fnBody).toMatch(/'kanban_done_auto'/);
        expect(fnBody).toMatch(/auto-done device-push dispatch/);
    });
});

describe('device-push category prefs are registered (no silent drop)', () => {
    test('kanban_done and kanban_done_auto exist and default ON', () => {
        // notifyDevice() returns early if isCategoryEnabled() is false; an
        // unregistered category would fall through DEFAULT_PREFS. These keys
        // must stay registered + default true or done-push silently dies.
        expect(DEFAULT_PREFS.kanban_done).toBe(true);
        expect(DEFAULT_PREFS.kanban_done_auto).toBe(true);
    });
});

describe('sendWebPush / sendFcm dispatch is reachable from notifyDevice', () => {
    test('notifyDevice fans out to sendWebPush and sendFcm', () => {
        const idx = indexSrc.indexOf('async function notifyDevice(deviceId, notification)');
        expect(idx).toBeGreaterThan(-1);
        const fnBody = indexSrc.slice(idx, idx + 2400);
        expect(fnBody).toMatch(/sendWebPush\(deviceId, notif\)/);
        expect(fnBody).toMatch(/sendFcm\(deviceId, notif\)/);
        // The category gate must precede the fan-out.
        expect(fnBody).toMatch(/isCategoryEnabled\(prefs, notification\.category\)/);
    });

    test('sendWebPush logs the empty-subscription case (key diagnostic)', () => {
        // The prod symptom is "no push, no log". A device with zero
        // subscriptions must now leave a server_logs breadcrumb instead of a
        // silent no-op.
        const idx = indexSrc.indexOf('async function sendWebPush(deviceId, notif)');
        expect(idx).toBeGreaterThan(-1);
        const fnBody = indexSrc.slice(idx, idx + 1800);
        expect(fnBody).toMatch(/no push subscriptions for device/);
    });

    test('FCM init mirrors a stdout breadcrumb (Railway boot-log visibility)', () => {
        // The investigation was misled because serverLog('fcm_init') never
        // reaches stdout. Pin the stdout mirror so boot-log inspection can
        // confirm Android push is live.
        expect(indexSrc).toMatch(/\[FCM\] Firebase Admin initialized/);
    });
});
