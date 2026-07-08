'use strict';

/**
 * Regression: multi-device push clobber — siblings of the FCM fix (PR #3808, 2026-06-29).
 *
 * PR #3808 fixed the single-column `devices.fcm_token` clobber (phone + emulator sharing one
 * deviceId overwrote each other's token, so only the last got pushes) with a multi-row
 * `device_fcm_tokens` table + sendFcm fan-out. The follow-up audit (card_9435d8da) found two
 * siblings of the SAME bug that #3808 did not touch:
 *
 *   1) APNs — `devices.apns_token` is the identical single column. An iPhone + iPad on one
 *      deviceId clobber each other. There is NO native APNs SEND path yet (apns_token is
 *      write-only: registered + read by the diagnostic endpoint), so this is PREVENTIVE
 *      storage parity: a multi-row device_apns_tokens table + register upsert + a
 *      getDeviceApnsTokens() helper, so whoever later builds the iOS sender is clobber-safe.
 *
 *   2) /api/admin/push-update — the app-update broadcast collected a SINGLE device.fcmToken
 *      per device, so a multi-device user got the update push on only one device. Fixed to
 *      fan out via getDeviceFcmTokens and to delete only a single dead-token ROW on a stale
 *      token (never the whole device — that would re-introduce the clobber).
 *
 * Style: static source-grep, matching multi-fcm-token.test.js (index.js / db.js need a live
 * pg pool, so structural invariants are pinned by source assertion). A refactor that
 * re-introduces single-token clobber on either path fails here.
 */

const fs = require('fs');
const path = require('path');

const indexSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'index.js'), 'utf8');
const dbSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'db.js'), 'utf8');

describe('multi-device APNs token: schema + backfill (db.js)', () => {
    test('device_apns_tokens table is created with a (device_id, token) primary key', () => {
        expect(dbSrc).toMatch(/CREATE TABLE IF NOT EXISTS device_apns_tokens/);
        // the PK clause appears for both fcm + apns tables; assert it exists at least twice
        const pks = dbSrc.match(/PRIMARY KEY\s*\(device_id,\s*token\)/g) || [];
        expect(pks.length).toBeGreaterThanOrEqual(2);
    });

    test('legacy single-column apns_token is backfilled into the multi-row table', () => {
        expect(dbSrc).toMatch(/INSERT INTO device_apns_tokens[\s\S]*SELECT device_id, apns_token[\s\S]*FROM devices WHERE apns_token IS NOT NULL/);
        expect(dbSrc).toMatch(/INSERT INTO device_apns_tokens[\s\S]*ON CONFLICT \(device_id, token\) DO NOTHING/);
    });
});

describe('multi-device APNs token: registration upserts a row (POST /api/device/fcm-token)', () => {
    test('the apns branch upserts into device_apns_tokens (not only the single column)', () => {
        const handlerIdx = indexSrc.indexOf("app.post('/api/device/fcm-token'");
        expect(handlerIdx).toBeGreaterThan(-1);
        const handler = indexSrc.slice(handlerIdx, handlerIdx + 3500);
        // within the apns branch specifically
        const apnsBranchIdx = handler.indexOf("resolvedPlatform === 'apns'");
        expect(apnsBranchIdx).toBeGreaterThan(-1);
        const apnsBranch = handler.slice(apnsBranchIdx, apnsBranchIdx + 1200);
        expect(apnsBranch).toMatch(/INSERT INTO device_apns_tokens[\s\S]*ON CONFLICT \(device_id, token\) DO UPDATE/);
    });
});

describe('multi-device APNs token: getDeviceApnsTokens helper', () => {
    const gIdx = indexSrc.indexOf('async function getDeviceApnsTokens(deviceId)');
    const g = gIdx > -1 ? indexSrc.slice(gIdx, gIdx + 900) : '';

    test('getDeviceApnsTokens unions in-memory apnsToken + device_apns_tokens rows, deduped', () => {
        expect(gIdx).toBeGreaterThan(-1);
        expect(g).toMatch(/new Set\(\)/);
        expect(g).toMatch(/devices\[deviceId\]\?\.apnsToken/);
        expect(g).toMatch(/SELECT token FROM device_apns_tokens WHERE device_id = \$1/);
    });
});

describe('admin push-update broadcast: fans out to all of a device\'s tokens (POST /api/admin/push-update)', () => {
    const hIdx = indexSrc.indexOf("app.post('/api/admin/push-update'");
    const handler = hIdx > -1 ? indexSrc.slice(hIdx, hIdx + 3500) : '';

    test('handler exists', () => {
        expect(hIdx).toBeGreaterThan(-1);
    });

    test('collects tokens via getDeviceFcmTokens, not a single device.fcmToken per device', () => {
        expect(handler).toMatch(/getDeviceFcmTokens/);
        // the old single-token collection (tokens.push(device.fcmToken)) must be gone
        expect(handler).not.toMatch(/tokens\.push\(device\.fcmToken\)/);
    });

    test('keeps a (deviceId, token) meta parallel array so cleanup can target one row', () => {
        expect(handler).toMatch(/tokenMeta/);
    });

    test('a stale token deletes ONLY its own row, never the whole device (no re-clobber)', () => {
        expect(handler).toMatch(/registration-token-not-registered/);
        expect(handler).toMatch(/DELETE FROM device_fcm_tokens WHERE device_id = \$1 AND token = \$2/);
        // guarded clear of the in-memory single column only when it equals the dead token
        expect(handler).toMatch(/devices\[staleDeviceId\]\?\.fcmToken === staleToken/);
    });
});
