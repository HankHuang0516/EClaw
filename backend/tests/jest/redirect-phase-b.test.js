/**
 * Redirect state machine Phase B — Android App Links (card_8df2a4cbd972d19d7e3d38d2).
 * Spec: docs/redirect-state-machine-spec.md §3/§4/§7.
 * Covers: /.well-known/assetlinks.json statement shape + env append, and the
 * 400 ms APP_ATTEMPT interstitial branch (Android mobile UA only).
 */
'use strict';

const express = require('express');
const request = require('supertest');

const redirect = require('../../redirect-router');

const DEVICE = 'dev-redirect-test';
const DEVICES = {
    [DEVICE]: {
        deviceSecret: 'ds-secret',
        entities: { 2: { isBound: true, botSecret: 'bs-secret' } },
    },
};

const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Mobile Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148 Safari/604.1';
const FP_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const PLAY_APP_SIGNING_CERT_SHA256 = 'A2:EB:6D:55:DD:DF:1C:9D:68:2E:B5:67:1C:1A:E5:8C:01:06:CB:A2:A2:93:5D:DB:CE:D2:AB:E2:E6:F7:76:DB';
const UPLOAD_CERT_SHA256 = '0D:F0:18:33:A4:41:C4:02:74:9C:CF:4A:5A:59:F2:0C:62:00:3D:59:91:86:36:98:17:D5:89:50:47:DB:E8:10';

function makeApp() {
    redirect.init({ chatPool: null, devices: DEVICES, jwtSecret: 'test-signing-secret' });
    const app = express();
    app.use(redirect.router);
    return app;
}

describe('GET /.well-known/assetlinks.json', () => {
    afterEach(() => { delete process.env.ASSETLINKS_FINGERPRINTS; });

    test('serves a handle_all_urls statement for com.hank.clawlive', async () => {
        const res = await request(makeApp()).get('/.well-known/assetlinks.json');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(Array.isArray(res.body)).toBe(true);
        const stmt = res.body[0];
        expect(stmt.relation).toEqual(['delegate_permission/common.handle_all_urls']);
        expect(stmt.target.namespace).toBe('android_app');
        expect(stmt.target.package_name).toBe('com.hank.clawlive');
        expect(stmt.target.sha256_cert_fingerprints.length).toBeGreaterThan(0);
        for (const fp of stmt.target.sha256_cert_fingerprints) expect(fp).toMatch(FP_RE);
        expect(stmt.target.sha256_cert_fingerprints).toContain(PLAY_APP_SIGNING_CERT_SHA256);
        expect(stmt.target.sha256_cert_fingerprints).toContain(UPLOAD_CERT_SHA256);
    });

    test('ASSETLINKS_FINGERPRINTS env appends rotation certs without dropping Play or upload certs', async () => {
        const rotationCert = 'AA:' + Array(31).fill('BB').join(':');
        process.env.ASSETLINKS_FINGERPRINTS = ` ${rotationCert} , ${'CC:' + Array(31).fill('DD').join(':')} `;
        const res = await request(makeApp()).get('/.well-known/assetlinks.json');
        const fps = res.body[0].target.sha256_cert_fingerprints;
        expect(fps).toHaveLength(4);
        expect(fps[0]).toBe(PLAY_APP_SIGNING_CERT_SHA256);
        expect(fps).toContain(UPLOAD_CERT_SHA256);
        expect(fps).toContain(rotationCert);
    });

    test('ignores invalid and duplicate ASSETLINKS_FINGERPRINTS entries', async () => {
        const rotationCert = 'AA:' + Array(31).fill('BB').join(':');
        process.env.ASSETLINKS_FINGERPRINTS = `not-a-fingerprint, ${rotationCert.toLowerCase()}, ${rotationCert}, ${UPLOAD_CERT_SHA256}`;
        const res = await request(makeApp()).get('/.well-known/assetlinks.json');
        const fps = res.body[0].target.sha256_cert_fingerprints;
        expect(fps).toHaveLength(3);
        expect(fps).toContain(rotationCert);
        expect(fps.filter(fp => fp === UPLOAD_CERT_SHA256)).toHaveLength(1);
    });
});

describe('GET /api/debug/android-app-links', () => {
    afterEach(() => { delete process.env.ASSETLINKS_FINGERPRINTS; });

    test('requires device authentication', async () => {
        const res = await request(makeApp()).get('/api/debug/android-app-links');
        expect(res.status).toBe(403);
    });

    test('returns Android App Links diagnostics without exposing secrets', async () => {
        const playCert = 'AA:' + Array(31).fill('BB').join(':');
        process.env.ASSETLINKS_FINGERPRINTS = playCert;
        const res = await request(makeApp())
            .get('/api/debug/android-app-links')
            .query({ deviceId: DEVICE, deviceSecret: DEVICES[DEVICE].deviceSecret });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.bug).toBe('android-app-links');
        expect(res.body.diagnostics.packageName).toBe('com.hank.clawlive');
        expect(res.body.diagnostics.host).toBe('eclawbot.com');
        expect(res.body.diagnostics.pathPrefix).toBe('/r/');
        expect(res.body.diagnostics.assetlinksUrl).toBe('https://eclawbot.com/.well-known/assetlinks.json');
        expect(res.body.diagnostics.hasAdditionalFingerprints).toBe(true);
        expect(res.body.diagnostics.playAppSigningCertFingerprint).toBe(PLAY_APP_SIGNING_CERT_SHA256);
        expect(res.body.diagnostics.uploadCertFingerprint).toBe(UPLOAD_CERT_SHA256);
        expect(res.body.diagnostics.fingerprints).toContain(PLAY_APP_SIGNING_CERT_SHA256);
        expect(res.body.diagnostics.fingerprints).toContain(playCert);
        expect(JSON.stringify(res.body)).not.toContain(DEVICES[DEVICE].deviceSecret);
    });
});

describe('GET /r/:target — APP_ATTEMPT interstitial (Phase B)', () => {
    let app;
    beforeEach(() => { app = makeApp(); });

    test('Android mobile UA gets the 400 ms interstitial, not a 302', async () => {
        const res = await request(app)
            .get('/r/chat?publicCode=3xa3h4')
            .set('User-Agent', ANDROID_UA);
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/text\/html/);
        expect(res.text).toContain('setTimeout');
        expect(res.text).toContain('400');
        // destination carries the traceId and is JSON-escaped into the script
        expect(res.text).toMatch(/location\.replace\("\/portal\/chat\.html\?contact=3xa3h4&traceId=rt_[a-f0-9]{12}"\)/);
        // fallback beacon reports the spec §4 timeout transition
        expect(res.text).toContain('WEB_FALLBACK');
        expect(res.text).toContain('app_attempt_timeout');
        // noscript users still reach the target
        expect(res.text).toContain('http-equiv="refresh"');
    });

    test('iPhone UA keeps the straight 302 (iOS activates in Phase C)', async () => {
        const res = await request(app)
            .get('/r/chat?publicCode=3xa3h4')
            .set('User-Agent', IPHONE_UA);
        expect(res.status).toBe(302);
    });

    test('desktop UA keeps the straight 302', async () => {
        const res = await request(app).get('/r/chat?publicCode=3xa3h4');
        expect(res.status).toBe(302);
    });

    test('app WebView UA (EClawAndroid) bypasses the interstitial', async () => {
        const res = await request(app)
            .get('/r/chat?publicCode=3xa3h4')
            .set('User-Agent', ANDROID_UA + ' EClawAndroid');
        expect(res.status).toBe(302);
    });

    test('sig-rejected sensitive target never reaches the interstitial', async () => {
        const res = await request(app)
            .get('/r/card?cardId=card_abc123def456')
            .set('User-Agent', ANDROID_UA);
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/portal/dashboard.html?redirectError=expired');
    });

    test('APP_ATTEMPT is an accepted telemetry beacon state', () => {
        expect(redirect._internal.STATES).toContain('APP_ATTEMPT');
    });
});
