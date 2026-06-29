'use strict';

/**
 * Regression: multi-device FCM token fan-out (push clobber fix, 2026-06-29).
 *
 * Root cause (emulator E2E, #2): the legacy single `devices.fcm_token` column
 * means MULTIPLE physical devices sharing one deviceId (owner's phone + a
 * desktop emulator + …) each register their token under the same deviceId and
 * OVERWRITE each other — only the last-registered device receives pushes. The
 * owner's "任務完成通知 45 小時前就沒了" was exactly this: a desktop emulator
 * clobbered the phone's token. The pipeline itself was healthy (the emulator
 * DID receive a test card-done push).
 *
 * Fix: a multi-row `device_fcm_tokens` table (mirrors push_subscriptions),
 * register UPSERTs a row, and sendFcm fans out to EVERY token for the device,
 * deleting only a single dead token row on
 * `messaging/registration-token-not-registered` (never the whole device).
 *
 * Style: static source-grep, matching kanban-done-device-push-wiring.test.js
 * (index.js / db.js require a live pg pool, so structural invariants are pinned
 * by source assertion). A refactor that re-introduces single-token clobber
 * fails here.
 */

const fs = require('fs');
const path = require('path');

const indexSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'db.js'), 'utf8');

describe('multi-device FCM token: schema + backfill (db.js)', () => {
    test('device_fcm_tokens table is created with a (device_id, token) primary key', () => {
        expect(dbSrc).toMatch(/CREATE TABLE IF NOT EXISTS device_fcm_tokens/);
        expect(dbSrc).toMatch(/PRIMARY KEY\s*\(device_id,\s*token\)/);
    });

    test('legacy single-column tokens are backfilled into the multi-row table', () => {
        expect(dbSrc).toMatch(/INSERT INTO device_fcm_tokens[\s\S]*SELECT device_id, fcm_token[\s\S]*FROM devices WHERE fcm_token IS NOT NULL/);
        expect(dbSrc).toMatch(/ON CONFLICT \(device_id, token\) DO NOTHING/);
    });
});

describe('multi-device FCM token: registration upserts a row (POST /api/device/fcm-token)', () => {
    test('the FCM register branch upserts into device_fcm_tokens (does not only overwrite the single column)', () => {
        const handlerIdx = indexSrc.indexOf("app.post('/api/device/fcm-token'");
        expect(handlerIdx).toBeGreaterThan(-1);
        const handler = indexSrc.slice(handlerIdx, handlerIdx + 3000);
        expect(handler).toMatch(/INSERT INTO device_fcm_tokens[\s\S]*ON CONFLICT \(device_id, token\) DO UPDATE/);
    });
});

describe('multi-device FCM token: sendFcm fans out to all tokens', () => {
    const fnIdx = indexSrc.indexOf('async function sendFcm(deviceId, notif)');
    const fn = fnIdx > -1 ? indexSrc.slice(fnIdx, fnIdx + 2500) : '';

    test('sendFcm gathers ALL tokens via getDeviceFcmTokens (not a single device.fcmToken)', () => {
        expect(fnIdx).toBeGreaterThan(-1);
        expect(fn).toMatch(/getDeviceFcmTokens\(deviceId\)/);
        // it must iterate the token set, not send to a single token
        expect(fn).toMatch(/for\s*\(const token of tokens\)/);
    });

    test('getDeviceFcmTokens unions in-memory token + device_fcm_tokens rows, deduped', () => {
        const gIdx = indexSrc.indexOf('async function getDeviceFcmTokens(deviceId)');
        expect(gIdx).toBeGreaterThan(-1);
        const g = indexSrc.slice(gIdx, gIdx + 900);
        expect(g).toMatch(/new Set\(\)/);
        expect(g).toMatch(/SELECT token FROM device_fcm_tokens WHERE device_id = \$1/);
    });

    test('a dead token deletes ONLY its own row, never the whole device (no re-clobber)', () => {
        expect(fn).toMatch(/registration-token-not-registered/);
        expect(fn).toMatch(/DELETE FROM device_fcm_tokens WHERE device_id = \$1 AND token = \$2/);
    });
});
