'use strict';

/**
 * Per-device cron wiring guards (card_1ce50de359411f0d0947399f, #6 ruling d).
 *
 * notifyEntities is an inner closure of createKanbanModule, so its behaviour is
 * pinned here via source-grep (same style as kanban-smart-notify-queue.test.js).
 * The actual host-resolution decision is unit-tested in
 * per-device-cron-resolve.test.js; these guards ensure the cron dispatch path is
 * actually wired to that resolver and stays backward-compatible.
 */

const fs = require('fs');
const path = require('path');

const kanbanSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'kanban.js'), 'utf8');

describe('per-device cron — kanban.js wiring', () => {
    test('imports resolveEntityHostDevice from lib/per-device-cron', () => {
        expect(kanbanSrc).toMatch(/require\(['"]\.\/lib\/per-device-cron['"]\)/);
        expect(kanbanSrc).toMatch(/resolveEntityHostDevice/);
    });

    test('notifyEntities accepts a perDeviceCron option (default false → legacy path)', () => {
        expect(kanbanSrc).toMatch(/perDeviceCron\s*=\s*false/);
    });

    test('notifyEntities resolves a host device when perDeviceCron is enabled', () => {
        expect(kanbanSrc).toMatch(/if \(perDeviceCron && devices\)/);
        expect(kanbanSrc).toMatch(/resolveEntityHostDevice\(\{ device_id: deviceId \}, eid, devices\)/);
    });

    test('cross-device resolution redirects the push target (pushDeviceId / pushEid)', () => {
        expect(kanbanSrc).toMatch(/pushDeviceId = hostDecision\.hostDeviceId/);
        expect(kanbanSrc).toMatch(/pushEid = hostDecision\.hostEntityId/);
    });

    test('no-host is logged with a reason and falls back (no silent drop, no throw)', () => {
        expect(kanbanSrc).toMatch(/No registered\/active host device for entity/);
        expect(kanbanSrc).toMatch(/falling back to card-device local binding/);
    });

    test('push branches use the resolved pushDeviceId / pushEid, not the raw card device', () => {
        // channel push
        expect(kanbanSrc).toMatch(/pushToChannelCallback\(pushDeviceId, pushEid,/);
        // webhook push
        expect(kanbanSrc).toMatch(/pushToBot\(entity, pushDeviceId,/);
        // legacy push
        expect(kanbanSrc).toMatch(/pushToEntity\(pushDeviceId, pushEid,/);
    });

    test('hints carry the host device credentials so the receiving entity can authenticate', () => {
        expect(kanbanSrc).toMatch(/getMissionApiHints\(API_BASE, pushDeviceId, pushEid, entity\.botSecret\)/);
    });

    test('all schedule/cron dispatch call sites opt into perDeviceCron', () => {
        // Count notifyEntities calls inside checkScheduleTriggers + idle retry that
        // pass perDeviceCron: true. There are 4 cron dispatch sites:
        //   once-trigger, automation child (smart-queue), normal recurring, idle-retry.
        const occurrences = (kanbanSrc.match(/perDeviceCron: true/g) || []).length;
        expect(occurrences).toBeGreaterThanOrEqual(4);
    });
});
