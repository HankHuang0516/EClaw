'use strict';

const crypto = require('crypto');
const express = require('express');
const { GoogleAuth } = require('google-auth-library');
const safeEqual = require('./safe-equal');

const PACKAGE_NAME = 'com.hank.clawlive';
const NONCE_TTL_MS = 10 * 60 * 1000;
const VERDICT_FRESHNESS_MS = 10 * 60 * 1000;
const ACTION_RE = /^[a-z][a-z0-9_-]{2,63}$/;
const TOKEN_MIN_LENGTH = 50;
const TOKEN_MAX_LENGTH = 20000;
const PROCESS_LOCAL_NONCE_SECRET = crypto.randomBytes(32).toString('hex');
const PLAY_INTEGRITY_SCOPE = 'https://www.googleapis.com/auth/playintegrity';
const PLAY_INTEGRITY_DECODE_URL = `https://playintegrity.googleapis.com/v1/${PACKAGE_NAME}:decodeIntegrityToken`;
const REQUEST_MODES = new Set(['classic', 'standard']);
const LAST_VERDICT_DEVICE_LIMIT = 500;

let cachedAuthClient = null;
const usedNonceHashes = new Map();
const lastVerdictSummariesByDevice = new Map();

function base64UrlEncode(input) {
    return Buffer.from(input).toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function base64UrlDecode(input) {
    const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
    const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
    return Buffer.from(normalized + padding, 'base64').toString('utf8');
}

function signingSecret() {
    return process.env.PLAY_INTEGRITY_NONCE_SECRET
        || process.env.JWT_SECRET
        || PROCESS_LOCAL_NONCE_SECRET;
}

function signPayload(payload) {
    return crypto.createHmac('sha256', signingSecret())
        .update(JSON.stringify(payload))
        .digest('hex')
        .slice(0, 32);
}

function makeNonce({ deviceId, action, now = Date.now() }) {
    const payload = {
        v: 1,
        d: String(deviceId),
        a: String(action),
        t: now,
        r: crypto.randomBytes(16).toString('hex'),
    };
    payload.s = signPayload(payload);
    return base64UrlEncode(JSON.stringify(payload));
}

function makeRequestHash(nonce) {
    return base64UrlEncode(crypto.createHash('sha256').update(String(nonce)).digest());
}

function verifyNonce(nonce, { deviceId, action, now = Date.now() } = {}) {
    try {
        const payload = JSON.parse(base64UrlDecode(nonce));
        const sig = payload.s;
        const unsigned = { ...payload };
        delete unsigned.s;
        if (!sig || !safeEqual(sig, signPayload(unsigned))) return { ok: false, error: 'bad_signature' };
        if (payload.v !== 1) return { ok: false, error: 'bad_version' };
        if (deviceId && payload.d !== deviceId) return { ok: false, error: 'device_mismatch' };
        if (action && payload.a !== action) return { ok: false, error: 'action_mismatch' };
        if (!Number.isFinite(payload.t) || now - payload.t > NONCE_TTL_MS || payload.t - now > 60_000) {
            return { ok: false, error: 'expired' };
        }
        return { ok: true, payload };
    } catch (_err) {
        return { ok: false, error: 'malformed' };
    }
}

function purgeUsedNonces(now = Date.now()) {
    for (const [hash, expiresAt] of usedNonceHashes.entries()) {
        if (expiresAt <= now) usedNonceHashes.delete(hash);
    }
}

function claimNonce(nonce, now = Date.now()) {
    purgeUsedNonces(now);
    const hash = crypto.createHash('sha256').update(String(nonce)).digest('hex');
    if (usedNonceHashes.has(hash)) return false;
    usedNonceHashes.set(hash, now + NONCE_TTL_MS);
    return true;
}

function verificationConfigured() {
    return Boolean(
        process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON
        || process.env.GOOGLE_APPLICATION_CREDENTIALS
        || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
    );
}

function standardIntegrityCloudProjectNumber() {
    const raw = String(process.env.PLAY_INTEGRITY_CLOUD_PROJECT_NUMBER || '').trim();
    if (!/^[1-9][0-9]{4,20}$/.test(raw)) return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) ? raw : null;
}

function serviceAccountCredentials() {
    const raw = process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON
        || process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON
        || '';
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (err) {
        err.code = 'BAD_SERVICE_ACCOUNT_JSON';
        throw err;
    }
}

async function getAccessToken() {
    if (!cachedAuthClient) {
        const credentials = serviceAccountCredentials();
        const options = { scopes: [PLAY_INTEGRITY_SCOPE] };
        if (credentials) options.credentials = credentials;
        if (!credentials && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
            options.keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS;
        }
        cachedAuthClient = await new GoogleAuth(options).getClient();
    }
    const token = await cachedAuthClient.getAccessToken();
    return typeof token === 'string' ? token : token?.token;
}

async function decodeIntegrityTokenWithGoogle(integrityToken) {
    const accessToken = await getAccessToken();
    if (!accessToken) {
        const err = new Error('missing Google access token');
        err.code = 'MISSING_ACCESS_TOKEN';
        throw err;
    }
    const response = await fetch(PLAY_INTEGRITY_DECODE_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(googleDecodeRequestBody(integrityToken)),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        const err = new Error(`Play Integrity decode failed: HTTP ${response.status}`);
        err.code = 'GOOGLE_DECODE_FAILED';
        err.status = response.status;
        err.body = body.slice(0, 300);
        throw err;
    }
    return response.json();
}

function googleDecodeRequestBody(integrityToken) {
    return { integrityToken };
}

function extractPayload(decoded) {
    return decoded?.tokenPayloadExternal || decoded?.payload || decoded || {};
}

function appAccessRiskApps(appAccessRiskVerdict) {
    return Array.isArray(appAccessRiskVerdict?.appsDetected)
        ? appAccessRiskVerdict.appsDetected
        : [];
}

function summarizeConsoleSignals(verdict) {
    const appAccessApps = appAccessRiskApps(verdict.appAccessRiskVerdict);
    const deviceLabels = Array.isArray(verdict.deviceRecognitionVerdict)
        ? verdict.deviceRecognitionVerdict
        : [];
    const recentDeviceActivityLevel = verdict.recentDeviceActivity?.deviceActivityLevel || null;
    return {
        playLicensing: {
            observed: Boolean(verdict.appLicensingVerdict),
            value: verdict.appLicensingVerdict || null,
        },
        appIntegrity: {
            observed: Boolean(verdict.appRecognitionVerdict && verdict.appRecognitionVerdict !== 'UNKNOWN'),
            value: verdict.appRecognitionVerdict || null,
            packageName: verdict.packageName || null,
            versionCode: verdict.versionCode || null,
            certificateSha256Digest: Array.isArray(verdict.certificateSha256Digest)
                ? verdict.certificateSha256Digest
                : [],
        },
        deviceIntegrity: {
            observed: deviceLabels.length > 0,
            values: deviceLabels,
        },
        virtualIntegrity: {
            observed: deviceLabels.includes('MEETS_VIRTUAL_INTEGRITY'),
            values: deviceLabels.filter(v => v === 'MEETS_VIRTUAL_INTEGRITY'),
        },
        recentDeviceActivity: {
            observed: Boolean(verdict.recentDeviceActivity),
            value: recentDeviceActivityLevel,
        },
        playProtect: {
            observed: Boolean(verdict.playProtectVerdict),
            value: verdict.playProtectVerdict || null,
        },
        appAccessRisk: {
            observed: Boolean(verdict.appAccessRiskVerdict),
            values: appAccessApps,
            hasCaptureOrControlRisk: appAccessApps.some(v => /CAPTURING|CONTROLLING|OVERLAYS/.test(v)),
        },
    };
}

function rememberVerdictSummary(deviceId, summary, audit = () => {}) {
    const safeSummary = {
        checkedAt: new Date().toISOString(),
        packageName: PACKAGE_NAME,
        action: summary.action,
        status: summary.status,
        requestMode: summary.requestMode,
        verificationConfigured: Boolean(summary.verificationConfigured),
        checks: summary.checks || null,
        consoleSignals: summary.verdict ? summarizeConsoleSignals(summary.verdict) : null,
        decodeErrorCode: summary.decodeErrorCode || null,
    };
    lastVerdictSummariesByDevice.delete(deviceId);
    lastVerdictSummariesByDevice.set(deviceId, safeSummary);
    while (lastVerdictSummariesByDevice.size > LAST_VERDICT_DEVICE_LIMIT) {
        const oldest = lastVerdictSummariesByDevice.keys().next().value;
        lastVerdictSummariesByDevice.delete(oldest);
    }
    try {
        audit(
            safeSummary.status === 'verified' ? 'info' : 'warn',
            'play_integrity',
            `Play Integrity verdict ${safeSummary.status} action=${safeSummary.action}`,
            {
                deviceId,
                action: 'play_integrity_verdict',
                resource: PACKAGE_NAME,
                result: safeSummary.status,
                metadata: {
                    requestMode: safeSummary.requestMode,
                    verificationConfigured: safeSummary.verificationConfigured,
                    checks: safeSummary.checks,
                    consoleSignals: safeSummary.consoleSignals,
                    decodeErrorCode: safeSummary.decodeErrorCode,
                },
            }
        );
    } catch (_err) {
        // Audit logging must never affect the user-facing verdict flow.
    }
    return safeSummary;
}

function evaluatePayload(decoded, {
    nonce,
    requestHash,
    requestMode = 'classic',
    now = Date.now(),
}) {
    const payload = extractPayload(decoded);
    const requestDetails = payload.requestDetails || {};
    const requestPackageName = requestDetails.requestPackageName;
    const tokenNonce = requestDetails.nonce;
    const tokenRequestHash = requestDetails.requestHash;
    const timestampMillis = Number(requestDetails.timestampMillis);
    const appIntegrity = payload.appIntegrity || {};
    const deviceIntegrity = payload.deviceIntegrity || {};
    const accountDetails = payload.accountDetails || {};
    const environmentDetails = payload.environmentDetails || {};
    const recentDeviceActivity = deviceIntegrity.recentDeviceActivity || payload.recentDeviceActivity || null;
    const appRecognitionVerdict = appIntegrity.appRecognitionVerdict || 'UNKNOWN';
    const appPackageName = appIntegrity.packageName || null;
    const certificateSha256Digest = Array.isArray(appIntegrity.certificateSha256Digest)
        ? appIntegrity.certificateSha256Digest
        : [];
    const deviceRecognitionVerdict = Array.isArray(deviceIntegrity.deviceRecognitionVerdict)
        ? deviceIntegrity.deviceRecognitionVerdict
        : [];
    const nonceMatches = requestMode === 'classic' && tokenNonce === nonce;
    const requestHashMatches = requestMode === 'standard' && tokenRequestHash === requestHash;

    const checks = {
        packageNameMatches: requestPackageName === PACKAGE_NAME,
        appPackageNameMatches: appPackageName === PACKAGE_NAME,
        nonceMatches,
        requestHashMatches,
        bindingMatches: requestMode === 'standard' ? requestHashMatches : nonceMatches,
        fresh: Number.isFinite(timestampMillis) && Math.abs(now - timestampMillis) <= VERDICT_FRESHNESS_MS,
        appRecognized: appRecognitionVerdict === 'PLAY_RECOGNIZED',
        deviceMeetsIntegrity: deviceRecognitionVerdict.includes('MEETS_DEVICE_INTEGRITY'),
    };
    const verified = checks.packageNameMatches
        && checks.bindingMatches
        && checks.fresh
        && checks.appRecognized
        && checks.appPackageNameMatches
        && checks.deviceMeetsIntegrity;
    return {
        verified,
        requestMode,
        checks,
        verdict: {
            appRecognitionVerdict,
            deviceRecognitionVerdict,
            appLicensingVerdict: accountDetails.appLicensingVerdict || null,
            appAccessRiskVerdict: environmentDetails.appAccessRiskVerdict || null,
            playProtectVerdict: environmentDetails.playProtectVerdict || null,
            recentDeviceActivity,
            packageName: appPackageName,
            versionCode: appIntegrity.versionCode || null,
            certificateSha256Digest,
        },
    };
}

function authenticateDevice(devices, req) {
    const src = Object.assign({}, req.query || {}, req.body || {});
    const deviceId = src.deviceId;
    const deviceSecret = src.deviceSecret;
    if (!deviceId || !deviceSecret || !devices || !devices[deviceId]) return null;
    const device = devices[deviceId];
    if (!device.deviceSecret || !safeEqual(device.deviceSecret, deviceSecret)) return null;
    return { deviceId };
}

function createRouter({ devices, decodeIntegrityToken = decodeIntegrityTokenWithGoogle, audit = () => {} } = {}) {
    const router = express.Router();
    router.use(express.json({ limit: '32kb' }));

    router.post('/nonce', (req, res) => {
        const auth = authenticateDevice(devices, req);
        if (!auth) return res.status(403).json({ success: false, error: 'Invalid credentials' });

        const action = String(req.body?.action || 'startup');
        if (!ACTION_RE.test(action)) {
            return res.status(400).json({ success: false, error: 'invalid_action' });
        }

        const nonce = makeNonce({ deviceId: auth.deviceId, action });
        const cloudProjectNumber = standardIntegrityCloudProjectNumber();
        const requestMode = cloudProjectNumber ? 'standard' : 'classic';
        return res.json({
            success: true,
            nonce,
            requestHash: makeRequestHash(nonce),
            requestMode,
            cloudProjectNumber,
            action,
            ttlSeconds: Math.floor(NONCE_TTL_MS / 1000),
            packageName: PACKAGE_NAME,
            verificationConfigured: verificationConfigured(),
            standardRequestConfigured: Boolean(cloudProjectNumber),
        });
    });

    router.post('/verdict', async (req, res) => {
        const auth = authenticateDevice(devices, req);
        if (!auth) return res.status(403).json({ success: false, error: 'Invalid credentials' });

        const action = String(req.body?.action || 'startup');
        const nonce = String(req.body?.nonce || '');
        const requestHash = String(req.body?.requestHash || '');
        const requestMode = String(req.body?.requestMode || (requestHash ? 'standard' : 'classic'));
        const integrityToken = String(req.body?.integrityToken || '');
        if (!ACTION_RE.test(action)) {
            return res.status(400).json({ success: false, error: 'invalid_action' });
        }
        if (!REQUEST_MODES.has(requestMode)) {
            return res.status(400).json({ success: false, error: 'invalid_request_mode' });
        }
        if (integrityToken.length < TOKEN_MIN_LENGTH || integrityToken.length > TOKEN_MAX_LENGTH) {
            return res.status(400).json({ success: false, error: 'invalid_integrity_token' });
        }

        const nonceCheck = verifyNonce(nonce, { deviceId: auth.deviceId, action });
        if (!nonceCheck.ok) {
            return res.status(400).json({ success: false, error: 'invalid_nonce', reason: nonceCheck.error });
        }
        if (requestMode === 'standard' && requestHash !== makeRequestHash(nonce)) {
            return res.status(400).json({ success: false, error: 'invalid_request_hash' });
        }
        if (!claimNonce(nonce)) {
            return res.status(409).json({ success: false, error: 'nonce_replay' });
        }

        if (verificationConfigured()) {
            try {
                const decoded = await decodeIntegrityToken(integrityToken);
                const evaluation = evaluatePayload(decoded, { nonce, requestHash, requestMode });
                const status = evaluation.verified ? 'verified' : 'verification_failed';
                rememberVerdictSummary(auth.deviceId, {
                    action,
                    status,
                    requestMode,
                    verificationConfigured: true,
                    checks: evaluation.checks,
                    verdict: evaluation.verdict,
                }, audit);
                return res.json({
                    success: true,
                    status,
                    verificationConfigured: true,
                    packageName: PACKAGE_NAME,
                    action,
                    requestMode,
                    integrity: evaluation,
                });
            } catch (err) {
                console.warn('[PlayIntegrity] decode failed:', err.code || err.message, err.status || '');
                rememberVerdictSummary(auth.deviceId, {
                    action,
                    status: 'decode_failed',
                    requestMode,
                    verificationConfigured: true,
                    decodeErrorCode: err.code || 'DECODE_FAILED',
                }, audit);
                return res.status(502).json({
                    success: false,
                    error: 'play_integrity_decode_failed',
                    code: err.code || 'DECODE_FAILED',
                    verificationConfigured: true,
                });
            }
        }

        rememberVerdictSummary(auth.deviceId, {
            action,
            status: 'received_unverified',
            requestMode,
            verificationConfigured: false,
        }, audit);
        return res.json({
            success: true,
            status: 'received_unverified',
            verificationConfigured: false,
            packageName: PACKAGE_NAME,
            action,
            requestMode,
            // Intentionally do not echo or log the token. Server-side Google
            // decode/verify is only active once service credentials are wired.
        });
    });

    router.get('/debug', (req, res) => {
        const auth = authenticateDevice(devices, req);
        if (!auth) return res.status(403).json({ success: false, error: 'Invalid credentials' });
        return res.json({
            success: true,
            feature: 'play-integrity',
            diagnostics: {
                packageName: PACKAGE_NAME,
                nonceTtlSeconds: Math.floor(NONCE_TTL_MS / 1000),
                verificationConfigured: verificationConfigured(),
                standardRequestConfigured: Boolean(standardIntegrityCloudProjectNumber()),
                cloudProjectNumberConfigured: Boolean(standardIntegrityCloudProjectNumber()),
                verifierCredentialSources: {
                    playIntegrityServiceAccountJson: Boolean(process.env.PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON),
                    googleApplicationCredentials: Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS),
                    googleApplicationCredentialsJson: Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON),
                },
                requestModes: ['standard', 'classic'],
                actions: ['startup', 'billing_topup', 'subscription_purchase', 'borrow_subscription'],
                lastVerdict: lastVerdictSummariesByDevice.get(auth.deviceId) || null,
            },
            timestamp: new Date().toISOString(),
        });
    });

    return router;
}

module.exports = {
    createRouter,
    _internal: {
        makeNonce,
        makeRequestHash,
        verifyNonce,
        claimNonce,
        purgeUsedNonces,
        evaluatePayload,
        verificationConfigured,
        standardIntegrityCloudProjectNumber,
        decodeIntegrityTokenWithGoogle,
        googleDecodeRequestBody,
        rememberVerdictSummary,
        summarizeConsoleSignals,
        _resetForTests: () => {
            usedNonceHashes.clear();
            lastVerdictSummariesByDevice.clear();
            cachedAuthClient = null;
        },
        PACKAGE_NAME,
        NONCE_TTL_MS,
        VERDICT_FRESHNESS_MS,
    },
};
