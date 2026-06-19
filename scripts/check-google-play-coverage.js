#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_URL = 'https://eclawbot.com';
const DEFAULT_EXPECTED_FINGERPRINTS = [
    // Play App Signing certificate fingerprint.
    'A2:EB:6D:55:DD:DF:1C:9D:68:2E:B5:67:1C:1A:E5:8C:01:06:CB:A2:A2:93:5D:DB:CE:D2:AB:E2:E6:F7:76:DB',
    // Upload certificate fingerprint retained for side-loaded/debuggable build handling.
    '0D:F0:18:33:A4:41:C4:02:74:9C:CF:4A:5A:59:F2:0C:62:00:3D:59:91:86:36:98:17:D5:89:50:47:DB:E8:10',
];

function normalizeFingerprint(value) {
    return String(value || '').trim().toUpperCase();
}

function parseArgs(argv = process.argv.slice(2), cwd = process.cwd()) {
    const options = {
        baseUrl: DEFAULT_BASE_URL,
        assetlinksUrl: null,
        expectedFingerprints: DEFAULT_EXPECTED_FINGERPRINTS.slice(),
        minVersionCode: null,
        expectedVersionName: null,
        appGradlePath: path.join(cwd, 'app', 'build.gradle.kts'),
        backendIndexPath: path.join(cwd, 'backend', 'index.js'),
        deviceId: process.env.DEVICE_ID || '',
        deviceSecret: process.env.DEVICE_SECRET || '',
        expectedVerdictVersionCode: null,
        requirePlayIntegrity: false,
        requireVerifiedVerdict: false,
        json: false,
    };

    let customFingerprints = false;
    for (const arg of argv) {
        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg === '--json') {
            options.json = true;
        } else if (arg === '--require-play-integrity') {
            options.requirePlayIntegrity = true;
        } else if (arg === '--require-verified-verdict') {
            options.requireVerifiedVerdict = true;
        } else if (arg.startsWith('--base-url=')) {
            options.baseUrl = arg.slice('--base-url='.length);
        } else if (arg.startsWith('--assetlinks-url=')) {
            options.assetlinksUrl = arg.slice('--assetlinks-url='.length);
        } else if (arg.startsWith('--expected-fingerprint=')) {
            if (!customFingerprints) {
                options.expectedFingerprints = [];
                customFingerprints = true;
            }
            options.expectedFingerprints.push(normalizeFingerprint(arg.slice('--expected-fingerprint='.length)));
        } else if (arg.startsWith('--min-version-code=')) {
            options.minVersionCode = Number(arg.slice('--min-version-code='.length));
        } else if (arg.startsWith('--expected-version-name=')) {
            options.expectedVersionName = arg.slice('--expected-version-name='.length);
        } else if (arg.startsWith('--expected-verdict-version-code=')) {
            options.expectedVerdictVersionCode = Number(arg.slice('--expected-verdict-version-code='.length));
        } else if (arg.startsWith('--app-gradle=')) {
            options.appGradlePath = arg.slice('--app-gradle='.length);
        } else if (arg.startsWith('--backend-index=')) {
            options.backendIndexPath = arg.slice('--backend-index='.length);
        } else if (arg.startsWith('--device-id=')) {
            options.deviceId = arg.slice('--device-id='.length);
        } else if (arg.startsWith('--device-secret=')) {
            options.deviceSecret = arg.slice('--device-secret='.length);
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return options;
}

function usage() {
    return [
        'Usage:',
        '  node scripts/check-google-play-coverage.js [options]',
        '',
        'Options:',
        '  --base-url=https://eclawbot.com',
        '  --assetlinks-url=https://eclawbot.com/.well-known/assetlinks.json',
        '  --expected-fingerprint=SHA256   Repeatable; defaults to Play App Signing + upload cert.',
        '  --min-version-code=101          Verify app/build.gradle.kts versionCode.',
        '  --expected-version-name=1.0.93  Verify app versionName and backend LATEST_APP_VERSION.',
        '  --expected-verdict-version-code=101  Verify debug lastVerdict appIntegrity.versionCode.',
        '  --device-id=ID                  Or DEVICE_ID env var.',
        '  --device-secret=SECRET          Or DEVICE_SECRET env var. Never printed.',
        '  --require-play-integrity        Require debug endpoint verifier + standard config.',
        '  --require-verified-verdict      Require lastVerdict.status=verified.',
        '  --json                          Emit JSON summary.',
    ].join('\n');
}

async function fetchJson(url, label = url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${label}`);
    }
    return response.json();
}

function parseAndroidVersion(text) {
    const versionCode = Number((text.match(/versionCode\s*=\s*(\d+)/) || [])[1]);
    const versionName = (text.match(/versionName\s*=\s*"([^"]+)"/) || [])[1] || null;
    return {
        versionCode: Number.isFinite(versionCode) ? versionCode : null,
        versionName,
    };
}

function parseBackendLatestVersion(text) {
    return (text.match(/LATEST_APP_VERSION\s*=\s*["']([^"']+)["']/) || [])[1] || null;
}

function extractAssetlinksFingerprints(assetlinksJson) {
    const fingerprints = [];
    for (const statement of Array.isArray(assetlinksJson) ? assetlinksJson : []) {
        const target = statement && statement.target;
        for (const fp of Array.isArray(target?.sha256_cert_fingerprints) ? target.sha256_cert_fingerprints : []) {
            fingerprints.push(normalizeFingerprint(fp));
        }
    }
    return Array.from(new Set(fingerprints));
}

function evaluateAssetlinks(actualFingerprints, expectedFingerprints) {
    const actualSet = new Set(actualFingerprints.map(normalizeFingerprint));
    const expected = expectedFingerprints.map(normalizeFingerprint);
    return {
        ok: expected.every(fp => actualSet.has(fp)),
        missing: expected.filter(fp => !actualSet.has(fp)),
        actual: Array.from(actualSet),
    };
}

function extractLastVerdictVersionCode(lastVerdict) {
    const raw = lastVerdict?.consoleSignals?.appIntegrity?.versionCode;
    if (raw === null || raw === undefined || raw === '') return null;
    const versionCode = Number(raw);
    return Number.isFinite(versionCode) ? versionCode : null;
}

function safeRead(filePath) {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
}

function addCheck(checks, name, ok, details = {}) {
    checks.push({ name, ok: Boolean(ok), ...details });
}

function debugUrl(options) {
    const url = new URL('/api/play-integrity/debug', options.baseUrl);
    url.searchParams.set('deviceId', options.deviceId);
    url.searchParams.set('deviceSecret', options.deviceSecret);
    return url.toString();
}

function debugUrlLabel(options) {
    const url = new URL('/api/play-integrity/debug', options.baseUrl);
    url.searchParams.set('deviceId', options.deviceId ? '...' : '');
    url.searchParams.set('deviceSecret', 'REDACTED');
    return url.toString();
}

async function run(options) {
    const checks = [];
    const assetlinksUrl = options.assetlinksUrl || new URL('/.well-known/assetlinks.json', options.baseUrl).toString();
    const assetlinksJson = await fetchJson(assetlinksUrl);
    const assetlinks = evaluateAssetlinks(
        extractAssetlinksFingerprints(assetlinksJson),
        options.expectedFingerprints
    );
    addCheck(checks, 'assetlinks.fingerprints', assetlinks.ok, {
        actualCount: assetlinks.actual.length,
        missing: assetlinks.missing,
    });

    const appGradle = safeRead(options.appGradlePath);
    if (appGradle && (options.minVersionCode || options.expectedVersionName)) {
        const appVersion = parseAndroidVersion(appGradle);
        if (options.minVersionCode) {
            addCheck(checks, 'android.versionCode', appVersion.versionCode >= options.minVersionCode, {
                actual: appVersion.versionCode,
                minimum: options.minVersionCode,
            });
        }
        if (options.expectedVersionName) {
            addCheck(checks, 'android.versionName', appVersion.versionName === options.expectedVersionName, {
                actual: appVersion.versionName,
                expected: options.expectedVersionName,
            });
        }
    }

    const backendIndex = safeRead(options.backendIndexPath);
    if (backendIndex && options.expectedVersionName) {
        const latest = parseBackendLatestVersion(backendIndex);
        addCheck(checks, 'backend.LATEST_APP_VERSION', latest === options.expectedVersionName, {
            actual: latest,
            expected: options.expectedVersionName,
        });
    }

    if (options.deviceId && options.deviceSecret) {
        const debug = await fetchJson(debugUrl(options), debugUrlLabel(options));
        const diagnostics = debug && debug.diagnostics ? debug.diagnostics : {};
        addCheck(checks, 'playIntegrity.verificationConfigured', diagnostics.verificationConfigured, {
            actual: Boolean(diagnostics.verificationConfigured),
        });
        addCheck(checks, 'playIntegrity.standardRequestConfigured', diagnostics.standardRequestConfigured, {
            actual: Boolean(diagnostics.standardRequestConfigured),
        });
        if (options.requireVerifiedVerdict) {
            addCheck(checks, 'playIntegrity.lastVerdictVerified', diagnostics.lastVerdict?.status === 'verified', {
                actual: diagnostics.lastVerdict?.status || null,
            });
        }
        if (options.expectedVerdictVersionCode) {
            const actualVersionCode = extractLastVerdictVersionCode(diagnostics.lastVerdict);
            addCheck(checks, 'playIntegrity.lastVerdictVersionCode', actualVersionCode === options.expectedVerdictVersionCode, {
                actual: actualVersionCode,
                expected: options.expectedVerdictVersionCode,
            });
        }
    } else if (options.requirePlayIntegrity || options.requireVerifiedVerdict || options.expectedVerdictVersionCode) {
        addCheck(checks, 'playIntegrity.deviceAuthPresent', false, {
            message: 'Pass --device-id and --device-secret or set DEVICE_ID/DEVICE_SECRET.',
        });
    }

    if (!options.requirePlayIntegrity) {
        for (const check of checks) {
            if (check.name === 'playIntegrity.verificationConfigured' || check.name === 'playIntegrity.standardRequestConfigured') {
                check.ok = true;
                check.optional = true;
            }
        }
    }

    return {
        ok: checks.every(check => check.ok),
        checkedAt: new Date().toISOString(),
        checks,
    };
}

function printSummary(summary, json = false) {
    if (json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
    }
    for (const check of summary.checks) {
        const mark = check.ok ? 'PASS' : 'FAIL';
        const optional = check.optional ? ' optional' : '';
        console.log(`${mark}${optional} ${check.name}`);
        if (!check.ok && check.missing && check.missing.length) {
            console.log(`  missing: ${check.missing.join(', ')}`);
        }
        if (!check.ok && check.message) {
            console.log(`  ${check.message}`);
        }
    }
    console.log(summary.ok ? 'Google Play coverage checks passed.' : 'Google Play coverage checks failed.');
}

async function main() {
    const options = parseArgs();
    if (options.help) {
        console.log(usage());
        return;
    }
    const summary = await run(options);
    printSummary(summary, options.json);
    process.exitCode = summary.ok ? 0 : 1;
}

if (require.main === module) {
    main().catch(err => {
        console.error(`ERROR: ${err.message}`);
        process.exit(1);
    });
}

module.exports = {
    DEFAULT_EXPECTED_FINGERPRINTS,
    normalizeFingerprint,
    parseArgs,
    parseAndroidVersion,
    parseBackendLatestVersion,
    extractAssetlinksFingerprints,
    evaluateAssetlinks,
    extractLastVerdictVersionCode,
    debugUrlLabel,
    run,
};
