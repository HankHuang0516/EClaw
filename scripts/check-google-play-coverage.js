#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_BASE_URL = 'https://eclawbot.com';
const DEFAULT_EXPECTED_PACKAGE_NAME = 'com.hank.clawlive';
const DEFAULT_EXPECTED_APP_LINK_HOST = 'eclawbot.com';
const DEFAULT_EXPECTED_APP_LINK_PATH_PREFIX = '/r/';
const DEFAULT_MIN_BILLING_LIBRARY_VERSION = '8.0.0';
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
        expectedPackageName: DEFAULT_EXPECTED_PACKAGE_NAME,
        expectedAppLinkHost: DEFAULT_EXPECTED_APP_LINK_HOST,
        expectedAppLinkPathPrefix: DEFAULT_EXPECTED_APP_LINK_PATH_PREFIX,
        minBillingLibraryVersion: DEFAULT_MIN_BILLING_LIBRARY_VERSION,
        minVersionCode: null,
        expectedVersionName: null,
        appGradlePath: path.join(cwd, 'app', 'build.gradle.kts'),
        applicationPath: path.join(cwd, 'app', 'src', 'main', 'java', 'com', 'hank', 'clawlive', 'ClawApplication.kt'),
        androidManifestPath: path.join(cwd, 'app', 'src', 'main', 'AndroidManifest.xml'),
        billingManagerPath: path.join(cwd, 'app', 'src', 'main', 'java', 'com', 'hank', 'clawlive', 'billing', 'BillingManager.kt'),
        playIntegrityReporterPath: path.join(cwd, 'app', 'src', 'main', 'java', 'com', 'hank', 'clawlive', 'integrity', 'PlayIntegrityReporter.kt'),
        playIntegrityBackendPath: path.join(cwd, 'backend', 'play-integrity.js'),
        versionCatalogPath: path.join(cwd, 'gradle', 'libs.versions.toml'),
        backendIndexPath: path.join(cwd, 'backend', 'index.js'),
        deviceId: process.env.DEVICE_ID || '',
        deviceSecret: process.env.DEVICE_SECRET || '',
        expectedVerdictAction: null,
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
        } else if (arg.startsWith('--expected-package=')) {
            options.expectedPackageName = arg.slice('--expected-package='.length);
        } else if (arg.startsWith('--expected-applink-host=')) {
            options.expectedAppLinkHost = arg.slice('--expected-applink-host='.length);
        } else if (arg.startsWith('--expected-applink-prefix=')) {
            options.expectedAppLinkPathPrefix = arg.slice('--expected-applink-prefix='.length);
        } else if (arg.startsWith('--min-billing-library-version=')) {
            options.minBillingLibraryVersion = arg.slice('--min-billing-library-version='.length);
        } else if (arg.startsWith('--min-version-code=')) {
            options.minVersionCode = Number(arg.slice('--min-version-code='.length));
        } else if (arg.startsWith('--expected-version-name=')) {
            options.expectedVersionName = arg.slice('--expected-version-name='.length);
        } else if (arg.startsWith('--expected-verdict-action=')) {
            options.expectedVerdictAction = arg.slice('--expected-verdict-action='.length);
        } else if (arg.startsWith('--expected-verdict-version-code=')) {
            options.expectedVerdictVersionCode = Number(arg.slice('--expected-verdict-version-code='.length));
        } else if (arg.startsWith('--application=')) {
            options.applicationPath = arg.slice('--application='.length);
        } else if (arg.startsWith('--app-gradle=')) {
            options.appGradlePath = arg.slice('--app-gradle='.length);
        } else if (arg.startsWith('--android-manifest=')) {
            options.androidManifestPath = arg.slice('--android-manifest='.length);
        } else if (arg.startsWith('--billing-manager=')) {
            options.billingManagerPath = arg.slice('--billing-manager='.length);
        } else if (arg.startsWith('--play-integrity-reporter=')) {
            options.playIntegrityReporterPath = arg.slice('--play-integrity-reporter='.length);
        } else if (arg.startsWith('--play-integrity-backend=')) {
            options.playIntegrityBackendPath = arg.slice('--play-integrity-backend='.length);
        } else if (arg.startsWith('--version-catalog=')) {
            options.versionCatalogPath = arg.slice('--version-catalog='.length);
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
        '  --expected-package=com.hank.clawlive',
        '  --expected-applink-host=eclawbot.com',
        '  --expected-applink-prefix=/r/',
        '  --min-billing-library-version=8.0.0',
        '  --min-version-code=101          Verify app/build.gradle.kts versionCode.',
        '  --expected-version-name=1.0.93  Verify app versionName and backend LATEST_APP_VERSION.',
        '  --expected-verdict-action=billing_topup  Verify debug lastVerdict.action.',
        '  --expected-verdict-version-code=101  Verify debug lastVerdict appIntegrity.versionCode.',
        '  --application=app/src/main/java/com/hank/clawlive/ClawApplication.kt',
        '  --android-manifest=app/src/main/AndroidManifest.xml',
        '  --billing-manager=app/src/main/java/com/hank/clawlive/billing/BillingManager.kt',
        '  --play-integrity-reporter=app/src/main/java/com/hank/clawlive/integrity/PlayIntegrityReporter.kt',
        '  --play-integrity-backend=backend/play-integrity.js',
        '  --version-catalog=gradle/libs.versions.toml',
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

function parseAndroidConfig(text) {
    const versionCode = Number((text.match(/versionCode\s*=\s*(\d+)/) || [])[1]);
    const versionName = (text.match(/versionName\s*=\s*"([^"]+)"/) || [])[1] || null;
    const applicationId = (text.match(/applicationId\s*=\s*"([^"]+)"/) || [])[1] || null;
    return {
        versionCode: Number.isFinite(versionCode) ? versionCode : null,
        versionName,
        applicationId,
    };
}

function parseAndroidVersion(text) {
    const { versionCode, versionName } = parseAndroidConfig(text);
    return { versionCode, versionName };
}

function parseBackendLatestVersion(text) {
    return (text.match(/LATEST_APP_VERSION\s*=\s*["']([^"']+)["']/) || [])[1] || null;
}

function parseVersionCatalogVersion(text, key) {
    const match = String(text || '').match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]+)"`, 'm'));
    return match ? match[1] : null;
}

function compareSemver(a, b) {
    const left = String(a || '').split(/[.-]/).map(part => Number.parseInt(part, 10));
    const right = String(b || '').split(/[.-]/).map(part => Number.parseInt(part, 10));
    const length = Math.max(left.length, right.length, 3);
    for (let i = 0; i < length; i += 1) {
        const av = Number.isFinite(left[i]) ? left[i] : 0;
        const bv = Number.isFinite(right[i]) ? right[i] : 0;
        if (av > bv) return 1;
        if (av < bv) return -1;
    }
    return 0;
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
    if (!filePath) return null;
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
}

function hasGradleDependency(text, candidates) {
    return candidates.some(candidate => text.includes(candidate));
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readXmlAttribute(text, name) {
    const match = String(text || '').match(new RegExp(`${escapeRegExp(name)}\\s*=\\s*"([^"]*)"`));
    return match ? match[1] : null;
}

function resolveAndroidClassName(name, packageName) {
    if (!name) return null;
    if (name.startsWith('.')) return `${packageName}${name}`;
    return name.includes('.') ? name : `${packageName}.${name}`;
}

function hasNamedElement(text, elementName, androidName) {
    return new RegExp(`<${elementName}\\b[^>]*android:name\\s*=\\s*"${escapeRegExp(androidName)}"`, 'm')
        .test(text);
}

function dataValues(intentBody, attributeName) {
    const values = [];
    const dataRe = /<data\b([^>]*)\/?>/gm;
    let match;
    while ((match = dataRe.exec(intentBody)) !== null) {
        const value = readXmlAttribute(match[1], attributeName);
        if (value) values.push(value);
    }
    return values;
}

function evaluateManifestAppLink(manifestText, {
    expectedPackageName = DEFAULT_EXPECTED_PACKAGE_NAME,
    expectedHost = DEFAULT_EXPECTED_APP_LINK_HOST,
    expectedPathPrefix = DEFAULT_EXPECTED_APP_LINK_PATH_PREFIX,
} = {}) {
    const expectedActivity = `${expectedPackageName}.MainActivity`;
    const result = {
        activityFound: false,
        autoVerify: false,
        viewAction: false,
        defaultCategory: false,
        browsableCategory: false,
        dataMatches: false,
    };
    const activityRe = /<activity\b([^>]*)>([\s\S]*?)<\/activity>/gm;
    let activity;
    while ((activity = activityRe.exec(manifestText)) !== null) {
        const activityName = resolveAndroidClassName(readXmlAttribute(activity[1], 'android:name'), expectedPackageName);
        if (activityName !== expectedActivity) continue;
        result.activityFound = true;

        const filterRe = /<intent-filter\b([^>]*)>([\s\S]*?)<\/intent-filter>/gm;
        let filter;
        while ((filter = filterRe.exec(activity[2])) !== null) {
            const attrs = filter[1];
            const body = filter[2];
            const autoVerify = readXmlAttribute(attrs, 'android:autoVerify') === 'true';
            const viewAction = hasNamedElement(body, 'action', 'android.intent.action.VIEW');
            const defaultCategory = hasNamedElement(body, 'category', 'android.intent.category.DEFAULT');
            const browsableCategory = hasNamedElement(body, 'category', 'android.intent.category.BROWSABLE');
            const schemes = dataValues(body, 'android:scheme');
            const hosts = dataValues(body, 'android:host');
            const pathPrefixes = dataValues(body, 'android:pathPrefix');
            const dataMatches = schemes.includes('https')
                && hosts.includes(expectedHost)
                && pathPrefixes.includes(expectedPathPrefix);

            result.autoVerify ||= autoVerify;
            result.viewAction ||= viewAction;
            result.defaultCategory ||= defaultCategory;
            result.browsableCategory ||= browsableCategory;
            result.dataMatches ||= dataMatches;

            if (autoVerify && viewAction && defaultCategory && browsableCategory && dataMatches) {
                return { ...result, ok: true };
            }
        }
    }
    return {
        ...result,
        ok: result.activityFound
            && result.autoVerify
            && result.viewAction
            && result.defaultCategory
            && result.browsableCategory
            && result.dataMatches,
    };
}

function backendHasPlayIntegrityRouter(text) {
    return /require\(['"]\.\/play-integrity['"]\)/.test(text)
        && /app\.use\(['"]\/api\/play-integrity['"]/.test(text);
}

function applicationReportsPlayIntegrityStartup(text) {
    const source = String(text || '');
    return source.includes('reportPlayIntegrityStartup()')
        && source.includes('BuildConfig.DEBUG')
        && source.includes('PlayIntegrityReporter.getInstance')
        && source.includes('.reportStartup()');
}

function billingReportsPlayIntegrityActions(text) {
    const source = String(text || '');
    const requiredActions = [
        'ACTION_BILLING_TOPUP',
        'ACTION_SUBSCRIPTION_PURCHASE',
        'ACTION_BORROW_SUBSCRIPTION',
    ];
    return source.includes('reportPlayIntegrityAction')
        && source.includes('BuildConfig.DEBUG')
        && requiredActions.every(action => source.includes(action))
        && requiredActions.every(action => new RegExp(`reportPlayIntegrityAction\\([\\s\\S]{0,240}${action}`).test(source));
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
    if (appGradle) {
        const appVersion = parseAndroidConfig(appGradle);
        addCheck(checks, 'android.applicationId', appVersion.applicationId === options.expectedPackageName, {
            actual: appVersion.applicationId,
            expected: options.expectedPackageName,
        });
        addCheck(checks, 'android.billingDependency', hasGradleDependency(appGradle, [
            'libs.billing',
            'com.android.billingclient:billing',
        ]));
        addCheck(checks, 'android.playIntegrityDependency', hasGradleDependency(appGradle, [
            'libs.play.integrity',
            'com.google.android.play:integrity',
        ]));
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

    const androidManifest = safeRead(options.androidManifestPath);
    if (androidManifest) {
        const appLink = evaluateManifestAppLink(androidManifest, {
            expectedPackageName: options.expectedPackageName,
            expectedHost: options.expectedAppLinkHost,
            expectedPathPrefix: options.expectedAppLinkPathPrefix,
        });
        addCheck(checks, 'android.applinkManifest', appLink.ok, appLink);
    }

    const application = safeRead(options.applicationPath);
    if (application) {
        addCheck(checks, 'android.playIntegrityStartupReport', applicationReportsPlayIntegrityStartup(application));
    }

    const versionCatalog = safeRead(options.versionCatalogPath);
    if (versionCatalog && options.minBillingLibraryVersion) {
        const billingVersion = parseVersionCatalogVersion(versionCatalog, 'billing');
        addCheck(checks, 'android.billingLibraryVersion', compareSemver(billingVersion, options.minBillingLibraryVersion) >= 0, {
            actual: billingVersion,
            minimum: options.minBillingLibraryVersion,
        });
    }

    const billingManager = safeRead(options.billingManagerPath);
    if (billingManager) {
        addCheck(checks, 'android.billingAutoReconnect', billingManager.includes('enableAutoServiceReconnection()'));
        addCheck(checks, 'android.billingIntegrityActions', billingReportsPlayIntegrityActions(billingManager));
    }

    const playIntegrityReporter = safeRead(options.playIntegrityReporterPath);
    if (playIntegrityReporter) {
        addCheck(
            checks,
            'android.playIntegrityProviderInvalidRetry',
            playIntegrityReporter.includes('INTEGRITY_TOKEN_PROVIDER_INVALID')
                && playIntegrityReporter.includes('standardTokenProvider = null')
                && playIntegrityReporter.includes('preparedCloudProjectNumber = null')
        );
    }

    const backendIndex = safeRead(options.backendIndexPath);
    if (backendIndex) {
        addCheck(checks, 'backend.playIntegrityRouterMounted', backendHasPlayIntegrityRouter(backendIndex));
        if (options.expectedVersionName) {
            const latest = parseBackendLatestVersion(backendIndex);
            addCheck(checks, 'backend.LATEST_APP_VERSION', latest === options.expectedVersionName, {
                actual: latest,
                expected: options.expectedVersionName,
            });
        }
    }

    const playIntegrityBackend = safeRead(options.playIntegrityBackendPath);
    if (playIntegrityBackend) {
        addCheck(
            checks,
            'backend.playIntegrityDecodeBody',
            playIntegrityBackend.includes('integrityToken')
                && !playIntegrityBackend.includes('integrity_token: integrityToken')
        );
        addCheck(
            checks,
            'backend.playIntegrityAppPackageCheck',
            playIntegrityBackend.includes('appPackageNameMatches')
                && playIntegrityBackend.includes('appPackageNameMatches: appPackageName === PACKAGE_NAME')
        );
        addCheck(
            checks,
            'backend.playIntegrityCertificateDigestCheck',
            playIntegrityBackend.includes('certificateDigestMatches')
                && playIntegrityBackend.includes('expectedCertificateDigests')
                && playIntegrityBackend.includes('PLAY_INTEGRITY_EXPECTED_CERT_SHA256_DIGESTS')
        );
        addCheck(
            checks,
            'backend.playIntegrityLicensingCheck',
            playIntegrityBackend.includes('appLicensed')
                && playIntegrityBackend.includes("appLicensingVerdict === 'LICENSED'")
        );
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
        if (options.expectedVerdictAction) {
            addCheck(checks, 'playIntegrity.lastVerdictAction', diagnostics.lastVerdict?.action === options.expectedVerdictAction, {
                actual: diagnostics.lastVerdict?.action || null,
                expected: options.expectedVerdictAction,
            });
        }
        if (options.expectedVerdictVersionCode) {
            const actualVersionCode = extractLastVerdictVersionCode(diagnostics.lastVerdict);
            addCheck(checks, 'playIntegrity.lastVerdictVersionCode', actualVersionCode === options.expectedVerdictVersionCode, {
                actual: actualVersionCode,
                expected: options.expectedVerdictVersionCode,
            });
        }
    } else if (
        options.requirePlayIntegrity
        || options.requireVerifiedVerdict
        || options.expectedVerdictAction
        || options.expectedVerdictVersionCode
    ) {
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
    DEFAULT_EXPECTED_PACKAGE_NAME,
    DEFAULT_EXPECTED_APP_LINK_HOST,
    DEFAULT_EXPECTED_APP_LINK_PATH_PREFIX,
    DEFAULT_MIN_BILLING_LIBRARY_VERSION,
    normalizeFingerprint,
    parseArgs,
    parseAndroidConfig,
    parseAndroidVersion,
    parseBackendLatestVersion,
    parseVersionCatalogVersion,
    compareSemver,
    extractAssetlinksFingerprints,
    evaluateAssetlinks,
    evaluateManifestAppLink,
    backendHasPlayIntegrityRouter,
    applicationReportsPlayIntegrityStartup,
    billingReportsPlayIntegrityActions,
    extractLastVerdictVersionCode,
    debugUrlLabel,
    run,
};
