'use strict';

const express = require('express');
const request = require('supertest');
const playIntegrity = require('../../play-integrity');

const DEVICE_ID = 'device-play-integrity';
const DEVICE_SECRET = 'secret-play-integrity';
const devices = {
    [DEVICE_ID]: { deviceSecret: DEVICE_SECRET, entities: {} },
};

function makeApp(options = {}) {
    const app = express();
    app.use('/api/play-integrity', playIntegrity.createRouter({ devices, ...options }));
    return app;
}

describe('Play Integrity bridge', () => {
    afterEach(() => {
        delete process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON;
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
        delete process.env.PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER;
        delete process.env.PLAY_INTEGRITY_EXPECTED_CERT_SHA256_DIGESTS;
        playIntegrity._internal._resetForTests();
        jest.restoreAllMocks();
    });

    test('nonce endpoint requires device auth', async () => {
        const res = await request(makeApp())
            .post('/api/play-integrity/nonce')
            .send({ deviceId: DEVICE_ID, action: 'startup' });
        expect(res.status).toBe(403);
    });

    test('issues a signed nonce scoped to device and action', async () => {
        const res = await request(makeApp())
            .post('/api/play-integrity/nonce')
            .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, action: 'startup' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.packageName).toBe('com.hank.clawlive');
        expect(res.body.verificationConfigured).toBe(false);
        expect(res.body.requestMode).toBe('classic');
        expect(res.body.requestHash).toBe(playIntegrity._internal.makeRequestHash(res.body.nonce));

        const check = playIntegrity._internal.verifyNonce(res.body.nonce, {
            deviceId: DEVICE_ID,
            action: 'startup',
        });
        expect(check.ok).toBe(true);
        expect(check.payload.d).toBe(DEVICE_ID);
        expect(check.payload.a).toBe('startup');
    });

    test('nonce endpoint switches to standard challenge when Cloud project number is configured', async () => {
        process.env.PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER = '123456789012';
        const res = await request(makeApp())
            .post('/api/play-integrity/nonce')
            .send({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET, action: 'startup' });

        expect(res.status).toBe(200);
        expect(res.body.requestMode).toBe('standard');
        expect(res.body.cloudProjectNumber).toBe('123456789012');
        expect(res.body.standardRequestConfigured).toBe(true);
        expect(res.body.requestHash).toBe(playIntegrity._internal.makeRequestHash(res.body.nonce));
    });

    test('rejects tampered or mismatched nonces', async () => {
        const nonce = playIntegrity._internal.makeNonce({ deviceId: DEVICE_ID, action: 'startup' });
        expect(playIntegrity._internal.verifyNonce(nonce + 'x', { deviceId: DEVICE_ID, action: 'startup' }).ok).toBe(false);
        expect(playIntegrity._internal.verifyNonce(nonce, { deviceId: DEVICE_ID, action: 'billing_topup' })).toEqual({
            ok: false,
            error: 'action_mismatch',
        });
    });

    test('verdict endpoint accepts token shape but does not claim verification without credentials', async () => {
        const nonce = playIntegrity._internal.makeNonce({ deviceId: DEVICE_ID, action: 'startup' });
        const token = 'a'.repeat(100);
        const res = await request(makeApp())
            .post('/api/play-integrity/verdict')
            .send({
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                action: 'startup',
                nonce,
                integrityToken: token,
            });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.status).toBe('received_unverified');
        expect(res.body.verificationConfigured).toBe(false);
        expect(res.body.requestMode).toBe('classic');
        expect(JSON.stringify(res.body)).not.toContain(token);
    });

    test('debug endpoint reports last unverified verdict without token or nonce material', async () => {
        const nonce = playIntegrity._internal.makeNonce({ deviceId: DEVICE_ID, action: 'startup' });
        const token = 'u'.repeat(100);
        const app = makeApp();
        const verdict = await request(app)
            .post('/api/play-integrity/verdict')
            .send({
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                action: 'startup',
                nonce,
                integrityToken: token,
            });
        const debug = await request(app)
            .get('/api/play-integrity/debug')
            .query({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });

        expect(verdict.status).toBe(200);
        expect(debug.status).toBe(200);
        expect(debug.body.diagnostics.lastVerdict).toMatchObject({
            packageName: 'com.hank.clawlive',
            action: 'startup',
            status: 'received_unverified',
            requestMode: 'classic',
            verificationConfigured: false,
            checks: null,
            consoleSignals: null,
            decodeErrorCode: null,
        });
        expect(debug.body.diagnostics.lastVerdict.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        const debugJson = JSON.stringify(debug.body);
        expect(debugJson).not.toContain(token);
        expect(debugJson).not.toContain(nonce);
        expect(debugJson).not.toContain(DEVICE_SECRET);
    });

    test('verdict endpoint accepts standard requestHash challenge without credentials', async () => {
        const nonce = playIntegrity._internal.makeNonce({ deviceId: DEVICE_ID, action: 'startup' });
        const requestHash = playIntegrity._internal.makeRequestHash(nonce);
        const token = 's'.repeat(100);
        const res = await request(makeApp())
            .post('/api/play-integrity/verdict')
            .send({
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                action: 'startup',
                nonce,
                requestHash,
                requestMode: 'standard',
                integrityToken: token,
            });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('received_unverified');
        expect(res.body.requestMode).toBe('standard');
        expect(JSON.stringify(res.body)).not.toContain(token);
    });

    test('verdict endpoint rejects a mismatched standard requestHash before claiming nonce', async () => {
        const nonce = playIntegrity._internal.makeNonce({ deviceId: DEVICE_ID, action: 'startup' });
        const body = {
            deviceId: DEVICE_ID,
            deviceSecret: DEVICE_SECRET,
            action: 'startup',
            nonce,
            requestHash: 'wrong-hash',
            requestMode: 'standard',
            integrityToken: 'h'.repeat(100),
        };

        const first = await request(makeApp())
            .post('/api/play-integrity/verdict')
            .send(body);
        const second = await request(makeApp())
            .post('/api/play-integrity/verdict')
            .send({ ...body, requestHash: playIntegrity._internal.makeRequestHash(nonce) });

        expect(first.status).toBe(400);
        expect(first.body.error).toBe('invalid_request_hash');
        expect(second.status).toBe(200);
        expect(second.body.status).toBe('received_unverified');
    });

    test('verdict endpoint rejects nonce replay', async () => {
        const nonce = playIntegrity._internal.makeNonce({ deviceId: DEVICE_ID, action: 'startup' });
        const body = {
            deviceId: DEVICE_ID,
            deviceSecret: DEVICE_SECRET,
            action: 'startup',
            nonce,
            integrityToken: 'r'.repeat(100),
        };

        const first = await request(makeApp())
            .post('/api/play-integrity/verdict')
            .send(body);
        const replay = await request(makeApp())
            .post('/api/play-integrity/verdict')
            .send(body);

        expect(first.status).toBe(200);
        expect(first.body.status).toBe('received_unverified');
        expect(replay.status).toBe(409);
        expect(replay.body.error).toBe('nonce_replay');
    });

    test('debug endpoint reports verifier configuration without exposing secrets', async () => {
        process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
        const res = await request(makeApp())
            .get('/api/play-integrity/debug')
            .query({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.diagnostics.verificationConfigured).toBe(true);
        expect(res.body.diagnostics.standardRequestConfigured).toBe(false);
        expect(res.body.diagnostics.verifierCredentialSources.playIntegrityServiceAccountJson).toBe(true);
        expect(res.body.diagnostics.requestModes).toEqual(['standard', 'classic']);
        expect(res.body.diagnostics.actions).toEqual([
            'startup',
            'billing_topup',
            'subscription_purchase',
            'borrow_subscription',
        ]);
        expect(JSON.stringify(res.body)).not.toContain('service_account');
        expect(JSON.stringify(res.body)).not.toContain(DEVICE_SECRET);
    });

    test('debug endpoint reports standard request configuration without exposing project value', async () => {
        process.env.PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER = '123456789012';
        const res = await request(makeApp())
            .get('/api/play-integrity/debug')
            .query({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });

        expect(res.status).toBe(200);
        expect(res.body.diagnostics.standardRequestConfigured).toBe(true);
        expect(res.body.diagnostics.cloudProjectNumberConfigured).toBe(true);
        expect(JSON.stringify(res.body)).not.toContain('123456789012');
    });

    test('Google decode request uses the official camelCase integrityToken field', () => {
        const body = playIntegrity._internal.googleDecodeRequestBody('token-value');

        expect(body).toEqual({ integrityToken: 'token-value' });
        expect(body).not.toHaveProperty('integrity_token');
    });

    test('normalizes Play Integrity certificate digest inputs', () => {
        const playSigningFingerprint = 'A2:EB:6D:55:DD:DF:1C:9D:68:2E:B5:67:1C:1A:E5:8C:01:06:CB:A2:A2:93:5D:DB:CE:D2:AB:E2:E6:F7:76:DB';

        expect(playIntegrity._internal.normalizeCertificateDigest(playSigningFingerprint))
            .toBe('outtVd3fHJ1oLrVnHBrljAEGy6Kik13bztKr4ub3dts');

        process.env.PLAY_INTEGRITY_EXPECTED_CERT_SHA256_DIGESTS = playSigningFingerprint;
        expect(playIntegrity._internal.expectedCertificateDigests())
            .toEqual(['outtVd3fHJ1oLrVnHBrljAEGy6Kik13bztKr4ub3dts']);
    });

    test('verdict endpoint decodes and evaluates Google payload when credentials are configured', async () => {
        process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
        const nonce = playIntegrity._internal.makeNonce({ deviceId: DEVICE_ID, action: 'startup' });
        const token = 'b'.repeat(100);
        const decodeIntegrityToken = jest.fn(async () => ({
            tokenPayloadExternal: {
                requestDetails: {
                    requestPackageName: 'com.hank.clawlive',
                    nonce,
                    timestampMillis: String(Date.now()),
                },
                appIntegrity: {
                    appRecognitionVerdict: 'PLAY_RECOGNIZED',
                    packageName: 'com.hank.clawlive',
                    versionCode: '100',
                    certificateSha256Digest: ['outtVd3fHJ1oLrVnHBrljAEGy6Kik13bztKr4ub3dts'],
                },
                deviceIntegrity: {
                    deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'],
                },
                accountDetails: {
                    appLicensingVerdict: 'LICENSED',
                },
            },
        }));

        const app = makeApp({ decodeIntegrityToken });
        const res = await request(app)
            .post('/api/play-integrity/verdict')
            .send({
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                action: 'startup',
                nonce,
                integrityToken: token,
            });

        expect(res.status).toBe(200);
        expect(decodeIntegrityToken).toHaveBeenCalledWith(token);
        expect(res.body.status).toBe('verified');
        expect(res.body.integrity.verified).toBe(true);
        expect(res.body.integrity.checks).toEqual({
            packageNameMatches: true,
            appPackageNameMatches: true,
            nonceMatches: true,
            requestHashMatches: false,
            bindingMatches: true,
            fresh: true,
            appRecognized: true,
            appLicensed: true,
            deviceMeetsIntegrity: true,
            certificateDigestMatches: true,
            appAccessRiskClean: true,
            playProtectMeetsPolicy: true,
            recentDeviceActivityAcceptable: true,
        });
        expect(res.body.integrity.verdict.appRecognitionVerdict).toBe('PLAY_RECOGNIZED');
        expect(res.body.integrity.verdict.certificateSha256Digest)
            .toEqual(['outtVd3fHJ1oLrVnHBrljAEGy6Kik13bztKr4ub3dts']);
        expect(JSON.stringify(res.body)).not.toContain(token);
    });

    test('verdict endpoint decodes and evaluates standard requestHash payload', async () => {
        process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
        const nonce = playIntegrity._internal.makeNonce({ deviceId: DEVICE_ID, action: 'startup' });
        const requestHash = playIntegrity._internal.makeRequestHash(nonce);
        const token = 'e'.repeat(100);
        const decodeIntegrityToken = jest.fn(async () => ({
            tokenPayloadExternal: {
                requestDetails: {
                    requestPackageName: 'com.hank.clawlive',
                    requestHash,
                    timestampMillis: String(Date.now()),
                },
                appIntegrity: {
                    appRecognitionVerdict: 'PLAY_RECOGNIZED',
                    packageName: 'com.hank.clawlive',
                    versionCode: '100',
                    certificateSha256Digest: ['outtVd3fHJ1oLrVnHBrljAEGy6Kik13bztKr4ub3dts'],
                },
                deviceIntegrity: {
                    deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'],
                    recentDeviceActivity: {
                        deviceActivityLevel: 'LEVEL_1',
                    },
                },
                accountDetails: {
                    appLicensingVerdict: 'LICENSED',
                },
                environmentDetails: {
                    appAccessRiskVerdict: { appsDetected: ['KNOWN_INSTALLED'] },
                    playProtectVerdict: 'NO_ISSUES',
                },
            },
        }));

        const app = makeApp({ decodeIntegrityToken });
        const res = await request(app)
            .post('/api/play-integrity/verdict')
            .send({
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                action: 'startup',
                nonce,
                requestHash,
                requestMode: 'standard',
                integrityToken: token,
            });

        expect(res.status).toBe(200);
        expect(decodeIntegrityToken).toHaveBeenCalledWith(token);
        expect(res.body.status).toBe('verified');
        expect(res.body.requestMode).toBe('standard');
        expect(res.body.integrity.requestMode).toBe('standard');
        expect(res.body.integrity.checks).toEqual({
            packageNameMatches: true,
            appPackageNameMatches: true,
            nonceMatches: false,
            requestHashMatches: true,
            bindingMatches: true,
            fresh: true,
            appRecognized: true,
            appLicensed: true,
            deviceMeetsIntegrity: true,
            certificateDigestMatches: true,
            appAccessRiskClean: true,
            playProtectMeetsPolicy: true,
            recentDeviceActivityAcceptable: true,
        });
        expect(res.body.integrity.verdict.appAccessRiskVerdict).toEqual({ appsDetected: ['KNOWN_INSTALLED'] });
        expect(res.body.integrity.verdict.playProtectVerdict).toBe('NO_ISSUES');
        expect(res.body.integrity.verdict.recentDeviceActivity).toEqual({ deviceActivityLevel: 'LEVEL_1' });
        const debug = await request(app)
            .get('/api/play-integrity/debug')
            .query({ deviceId: DEVICE_ID, deviceSecret: DEVICE_SECRET });
        expect(debug.status).toBe(200);
        expect(debug.body.diagnostics.lastVerdict).toMatchObject({
            action: 'startup',
            status: 'verified',
            requestMode: 'standard',
            verificationConfigured: true,
            checks: {
                packageNameMatches: true,
                requestHashMatches: true,
                bindingMatches: true,
                fresh: true,
                appRecognized: true,
                appAccessRiskClean: true,
                playProtectMeetsPolicy: true,
                recentDeviceActivityAcceptable: true,
                deviceMeetsIntegrity: true,
            },
            consoleSignals: {
                playLicensing: { observed: true, value: 'LICENSED' },
                appIntegrity: {
                    observed: true,
                    value: 'PLAY_RECOGNIZED',
                    packageName: 'com.hank.clawlive',
                    versionCode: '100',
                    certificateSha256Digest: ['outtVd3fHJ1oLrVnHBrljAEGy6Kik13bztKr4ub3dts'],
                },
                deviceIntegrity: { observed: true, values: ['MEETS_DEVICE_INTEGRITY'] },
                virtualIntegrity: { observed: false, values: [] },
                recentDeviceActivity: { observed: true, value: 'LEVEL_1' },
                playProtect: { observed: true, value: 'NO_ISSUES' },
                appAccessRisk: {
                    observed: true,
                    values: ['KNOWN_INSTALLED'],
                    hasCaptureOrControlRisk: false,
                },
            },
        });
        const debugJson = JSON.stringify(debug.body);
        expect(debugJson).not.toContain(token);
        expect(debugJson).not.toContain(nonce);
        expect(debugJson).not.toContain(requestHash);
        expect(debugJson).not.toContain(DEVICE_SECRET);
        expect(JSON.stringify(res.body)).not.toContain(token);
    });

    test('verdict endpoint rejects mismatched app integrity package even when request details match', async () => {
        process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
        const nonce = playIntegrity._internal.makeNonce({ deviceId: DEVICE_ID, action: 'startup' });
        const decodeIntegrityToken = jest.fn(async () => ({
            tokenPayloadExternal: {
                requestDetails: {
                    requestPackageName: 'com.hank.clawlive',
                    nonce,
                    timestampMillis: String(Date.now()),
                },
                appIntegrity: {
                    appRecognitionVerdict: 'PLAY_RECOGNIZED',
                    packageName: 'com.example.spoofed',
                    versionCode: '100',
                    certificateSha256Digest: ['outtVd3fHJ1oLrVnHBrljAEGy6Kik13bztKr4ub3dts'],
                },
                accountDetails: {
                    appLicensingVerdict: 'LICENSED',
                },
                deviceIntegrity: {
                    deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'],
                },
            },
        }));

        const res = await request(makeApp({ decodeIntegrityToken }))
            .post('/api/play-integrity/verdict')
            .send({
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                action: 'startup',
                nonce,
                integrityToken: 'p'.repeat(100),
            });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('verification_failed');
        expect(res.body.integrity.verified).toBe(false);
        expect(res.body.integrity.checks.packageNameMatches).toBe(true);
        expect(res.body.integrity.checks.appPackageNameMatches).toBe(false);
    });

    test('verdict endpoint rejects mismatched app certificate digest', async () => {
        process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
        const nonce = playIntegrity._internal.makeNonce({ deviceId: DEVICE_ID, action: 'startup' });
        const decodeIntegrityToken = jest.fn(async () => ({
            tokenPayloadExternal: {
                requestDetails: {
                    requestPackageName: 'com.hank.clawlive',
                    nonce,
                    timestampMillis: String(Date.now()),
                },
                appIntegrity: {
                    appRecognitionVerdict: 'PLAY_RECOGNIZED',
                    packageName: 'com.hank.clawlive',
                    versionCode: '100',
                    certificateSha256Digest: ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
                },
                accountDetails: {
                    appLicensingVerdict: 'LICENSED',
                },
                deviceIntegrity: {
                    deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'],
                },
            },
        }));

        const res = await request(makeApp({ decodeIntegrityToken }))
            .post('/api/play-integrity/verdict')
            .send({
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                action: 'startup',
                nonce,
                integrityToken: 'q'.repeat(100),
            });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('verification_failed');
        expect(res.body.integrity.verified).toBe(false);
        expect(res.body.integrity.checks.certificateDigestMatches).toBe(false);
    });

    test('verdict endpoint rejects unlicensed Play account entitlement', async () => {
        process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
        const nonce = playIntegrity._internal.makeNonce({ deviceId: DEVICE_ID, action: 'startup' });
        const decodeIntegrityToken = jest.fn(async () => ({
            tokenPayloadExternal: {
                requestDetails: {
                    requestPackageName: 'com.hank.clawlive',
                    nonce,
                    timestampMillis: String(Date.now()),
                },
                appIntegrity: {
                    appRecognitionVerdict: 'PLAY_RECOGNIZED',
                    packageName: 'com.hank.clawlive',
                    versionCode: '100',
                    certificateSha256Digest: ['outtVd3fHJ1oLrVnHBrljAEGy6Kik13bztKr4ub3dts'],
                },
                accountDetails: {
                    appLicensingVerdict: 'UNLICENSED',
                },
                deviceIntegrity: {
                    deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'],
                },
            },
        }));

        const res = await request(makeApp({ decodeIntegrityToken }))
            .post('/api/play-integrity/verdict')
            .send({
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                action: 'startup',
                nonce,
                integrityToken: 'l'.repeat(100),
            });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('verification_failed');
        expect(res.body.integrity.verified).toBe(false);
        expect(res.body.integrity.checks.appLicensed).toBe(false);
    });

    test('verdict endpoint rejects high-risk optional Play Integrity signals when present', async () => {
        process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
        const nonce = playIntegrity._internal.makeNonce({ deviceId: DEVICE_ID, action: 'startup' });
        const decodeIntegrityToken = jest.fn(async () => ({
            tokenPayloadExternal: {
                requestDetails: {
                    requestPackageName: 'com.hank.clawlive',
                    nonce,
                    timestampMillis: String(Date.now()),
                },
                appIntegrity: {
                    appRecognitionVerdict: 'PLAY_RECOGNIZED',
                    packageName: 'com.hank.clawlive',
                    versionCode: '100',
                    certificateSha256Digest: ['outtVd3fHJ1oLrVnHBrljAEGy6Kik13bztKr4ub3dts'],
                },
                accountDetails: {
                    appLicensingVerdict: 'LICENSED',
                },
                deviceIntegrity: {
                    deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'],
                    recentDeviceActivity: {
                        deviceActivityLevel: 'LEVEL_4',
                    },
                },
                environmentDetails: {
                    appAccessRiskVerdict: { appsDetected: ['UNKNOWN_CAPTURING'] },
                    playProtectVerdict: 'MEDIUM_RISK',
                },
            },
        }));

        const res = await request(makeApp({ decodeIntegrityToken }))
            .post('/api/play-integrity/verdict')
            .send({
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                action: 'startup',
                nonce,
                integrityToken: 'o'.repeat(100),
            });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('verification_failed');
        expect(res.body.integrity.verified).toBe(false);
        expect(res.body.integrity.checks.appAccessRiskClean).toBe(false);
        expect(res.body.integrity.checks.playProtectMeetsPolicy).toBe(false);
        expect(res.body.integrity.checks.recentDeviceActivityAcceptable).toBe(false);
    });

    test('verdict endpoint surfaces failed integrity checks without accepting the action', async () => {
        process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
        const nonce = playIntegrity._internal.makeNonce({ deviceId: DEVICE_ID, action: 'startup' });
        const decodeIntegrityToken = jest.fn(async () => ({
            tokenPayloadExternal: {
                requestDetails: {
                    requestPackageName: 'com.hank.clawlive',
                    nonce: 'wrong-nonce',
                    timestampMillis: String(Date.now()),
                },
                appIntegrity: { appRecognitionVerdict: 'UNRECOGNIZED_VERSION' },
                deviceIntegrity: { deviceRecognitionVerdict: [] },
            },
        }));

        const res = await request(makeApp({ decodeIntegrityToken }))
            .post('/api/play-integrity/verdict')
            .send({
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                action: 'startup',
                nonce,
                integrityToken: 'c'.repeat(100),
            });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('verification_failed');
        expect(res.body.integrity.verified).toBe(false);
        expect(res.body.integrity.checks.nonceMatches).toBe(false);
        expect(res.body.integrity.checks.bindingMatches).toBe(false);
        expect(res.body.integrity.checks.appRecognized).toBe(false);
        expect(res.body.integrity.checks.deviceMeetsIntegrity).toBe(false);
    });

    test('verdict endpoint returns 502 when Google decode fails after credentials are configured', async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON = '{"type":"service_account"}';
        const nonce = playIntegrity._internal.makeNonce({ deviceId: DEVICE_ID, action: 'startup' });
        const decodeIntegrityToken = jest.fn(async () => {
            const err = new Error('upstream failed');
            err.code = 'GOOGLE_DECODE_FAILED';
            throw err;
        });

        const res = await request(makeApp({ decodeIntegrityToken }))
            .post('/api/play-integrity/verdict')
            .send({
                deviceId: DEVICE_ID,
                deviceSecret: DEVICE_SECRET,
                action: 'startup',
                nonce,
                integrityToken: 'd'.repeat(100),
            });

        expect(res.status).toBe(502);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toBe('play_integrity_decode_failed');
        expect(res.body.verificationConfigured).toBe(true);
    });
});
