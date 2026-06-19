'use strict';

const checker = require('../../../scripts/check-google-play-coverage');

describe('Google Play coverage check script helpers', () => {
    test('extracts Android versionCode and versionName from Gradle file text', () => {
        const parsed = checker.parseAndroidVersion(`
            defaultConfig {
                applicationId = "com.hank.clawlive"
                versionCode = 101
                versionName = "1.0.93"
            }
        `);

        expect(parsed).toEqual({
            versionCode: 101,
            versionName: '1.0.93',
        });
        expect(checker.parseAndroidConfig(`
            defaultConfig {
                applicationId = "com.hank.clawlive"
                versionCode = 101
                versionName = "1.0.93"
            }
        `)).toEqual({
            applicationId: 'com.hank.clawlive',
            versionCode: 101,
            versionName: '1.0.93',
        });
    });

    test('extracts backend LATEST_APP_VERSION', () => {
        expect(checker.parseBackendLatestVersion('const LATEST_APP_VERSION = "1.0.93";')).toBe('1.0.93');
        expect(checker.parseBackendLatestVersion("const LATEST_APP_VERSION = '1.0.94';")).toBe('1.0.94');
    });

    test('extracts and compares version catalog versions', () => {
        expect(checker.parseVersionCatalogVersion(`
            [versions]
            billing = "9.1.0"
            playIntegrity = "1.6.0"
        `, 'billing')).toBe('9.1.0');

        expect(checker.compareSemver('9.1.0', '8.0.0')).toBeGreaterThan(0);
        expect(checker.compareSemver('8.0.0', '8.0.0')).toBe(0);
        expect(checker.compareSemver('7.1.1', '8.0.0')).toBeLessThan(0);
    });

    test('extracts and normalizes assetlinks fingerprints', () => {
        const fingerprints = checker.extractAssetlinksFingerprints([
            {
                target: {
                    sha256_cert_fingerprints: [
                        'aa:bb:cc',
                        'AA:BB:CC',
                        '  0d:f0:18  ',
                    ],
                },
            },
            { target: {} },
        ]);

        expect(fingerprints).toEqual(['AA:BB:CC', '0D:F0:18']);
    });

    test('reports missing Play App Signing fingerprint separately from upload key', () => {
        const uploadKey = '0D:F0:18:33:A4:41:C4:02:74:9C:CF:4A:5A:59:F2:0C:62:00:3D:59:91:86:36:98:17:D5:89:50:47:DB:E8:10';
        const playSigning = 'A2:EB:6D:55:DD:DF:1C:9D:68:2E:B5:67:1C:1A:E5:8C:01:06:CB:A2:A2:93:5D:DB:CE:D2:AB:E2:E6:F7:76:DB';

        const result = checker.evaluateAssetlinks([uploadKey], [playSigning, uploadKey]);

        expect(result.ok).toBe(false);
        expect(result.missing).toEqual([playSigning]);
        expect(result.actual).toEqual([uploadKey]);
    });

    test('parseArgs keeps default fingerprints unless explicitly overridden', () => {
        const defaults = checker.parseArgs([], '/tmp/eclaw');
        const overridden = checker.parseArgs([
            '--expected-fingerprint=aa:bb',
            '--expected-package=com.example.app',
            '--expected-applink-host=example.com',
            '--expected-applink-prefix=/invite/',
            '--min-billing-library-version=9.0.0',
            '--expected-verdict-action=billing_topup',
            '--expected-verdict-version-code=101',
            '--application=/tmp/ClawApplication.kt',
            '--android-manifest=/tmp/AndroidManifest.xml',
            '--billing-manager=/tmp/BillingManager.kt',
            '--play-integrity-reporter=/tmp/PlayIntegrityReporter.kt',
            '--play-integrity-backend=/tmp/play-integrity.js',
            '--version-catalog=/tmp/libs.versions.toml',
        ], '/tmp/eclaw');

        expect(defaults.expectedFingerprints).toEqual(checker.DEFAULT_EXPECTED_FINGERPRINTS);
        expect(defaults.expectedPackageName).toBe(checker.DEFAULT_EXPECTED_PACKAGE_NAME);
        expect(defaults.expectedAppLinkHost).toBe(checker.DEFAULT_EXPECTED_APP_LINK_HOST);
        expect(defaults.expectedAppLinkPathPrefix).toBe(checker.DEFAULT_EXPECTED_APP_LINK_PATH_PREFIX);
        expect(defaults.minBillingLibraryVersion).toBe(checker.DEFAULT_MIN_BILLING_LIBRARY_VERSION);
        expect(overridden.expectedFingerprints).toEqual(['AA:BB']);
        expect(overridden.expectedPackageName).toBe('com.example.app');
        expect(overridden.expectedAppLinkHost).toBe('example.com');
        expect(overridden.expectedAppLinkPathPrefix).toBe('/invite/');
        expect(overridden.minBillingLibraryVersion).toBe('9.0.0');
        expect(overridden.expectedVerdictAction).toBe('billing_topup');
        expect(overridden.expectedVerdictVersionCode).toBe(101);
        expect(overridden.applicationPath).toBe('/tmp/ClawApplication.kt');
        expect(overridden.androidManifestPath).toBe('/tmp/AndroidManifest.xml');
        expect(overridden.billingManagerPath).toBe('/tmp/BillingManager.kt');
        expect(overridden.playIntegrityReporterPath).toBe('/tmp/PlayIntegrityReporter.kt');
        expect(overridden.playIntegrityBackendPath).toBe('/tmp/play-integrity.js');
        expect(overridden.versionCatalogPath).toBe('/tmp/libs.versions.toml');
    });

    test('recognizes the Android App Links manifest entry Play Console validates', () => {
        const manifest = `
            <manifest xmlns:android="http://schemas.android.com/apk/res/android">
              <application>
                <activity android:name=".MainActivity" android:exported="true">
                  <intent-filter android:autoVerify="true">
                    <action android:name="android.intent.action.VIEW" />
                    <category android:name="android.intent.category.DEFAULT" />
                    <category android:name="android.intent.category.BROWSABLE" />
                    <data
                      android:scheme="https"
                      android:host="eclawbot.com"
                      android:pathPrefix="/r/" />
                  </intent-filter>
                </activity>
              </application>
            </manifest>
        `;

        expect(checker.evaluateManifestAppLink(manifest)).toMatchObject({
            ok: true,
            activityFound: true,
            autoVerify: true,
            viewAction: true,
            defaultCategory: true,
            browsableCategory: true,
            dataMatches: true,
        });
    });

    test('rejects App Links manifest entries that are not auto verified', () => {
        const manifest = `
            <activity android:name="com.hank.clawlive.MainActivity">
              <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="https" android:host="eclawbot.com" android:pathPrefix="/r/" />
              </intent-filter>
            </activity>
        `;

        expect(checker.evaluateManifestAppLink(manifest)).toMatchObject({
            ok: false,
            activityFound: true,
            autoVerify: false,
            dataMatches: true,
        });
    });

    test('recognizes backend Play Integrity router mounting', () => {
        expect(checker.backendHasPlayIntegrityRouter(`
            const playIntegrity = require('./play-integrity');
            app.use('/api/play-integrity', playIntegrity.createRouter({ devices }));
        `)).toBe(true);

        expect(checker.backendHasPlayIntegrityRouter(`
            const playIntegrity = require('./play-integrity');
        `)).toBe(false);
    });

    test('coverage check requires backend app integrity package verification', async () => {
        const playIntegrityBackendPath = '/tmp/play-integrity-package-check.js';
        const originalExistsSync = jest.spyOn(require('fs'), 'existsSync');
        const originalReadFileSync = jest.spyOn(require('fs'), 'readFileSync');

        originalExistsSync.mockImplementation(filePath => filePath === playIntegrityBackendPath);
        originalReadFileSync.mockImplementation(filePath => {
            if (filePath !== playIntegrityBackendPath) return '';
            return `
                const checks = {
                    appPackageNameMatches: appPackageName === PACKAGE_NAME,
                };
                JSON.stringify({ integrityToken });
            `;
        });

        try {
            const summary = await checker.run({
                baseUrl: 'https://unused.invalid',
                assetlinksUrl: 'data:application/json,[]',
                expectedFingerprints: [],
                minVersionCode: null,
                expectedVersionName: null,
                appGradlePath: '/tmp/missing.gradle',
                applicationPath: '/tmp/missing-application.kt',
                androidManifestPath: '/tmp/missing-manifest.xml',
                billingManagerPath: '/tmp/missing-billing.kt',
                playIntegrityReporterPath: '/tmp/missing-integrity.kt',
                playIntegrityBackendPath,
                versionCatalogPath: '/tmp/missing-catalog.toml',
                backendIndexPath: '/tmp/missing-index.js',
                deviceId: '',
                deviceSecret: '',
                expectedVerdictAction: null,
                expectedVerdictVersionCode: null,
                requirePlayIntegrity: false,
                requireVerifiedVerdict: false,
            });

            expect(summary.checks).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    name: 'backend.playIntegrityAppPackageCheck',
                    ok: true,
                }),
            ]));
        } finally {
            originalExistsSync.mockRestore();
            originalReadFileSync.mockRestore();
        }
    });

    test('recognizes release startup Play Integrity reporting', () => {
        expect(checker.applicationReportsPlayIntegrityStartup(`
            private fun reportPlayIntegrityStartup() {
                if (BuildConfig.DEBUG) return
                PlayIntegrityReporter.getInstance(this).reportStartup()
            }

            override fun onCreate() {
                reportPlayIntegrityStartup()
            }
        `)).toBe(true);

        expect(checker.applicationReportsPlayIntegrityStartup(`
            override fun onCreate() {
                Timber.i("startup")
            }
        `)).toBe(false);
    });

    test('recognizes Play Integrity actions on billing success paths', () => {
        expect(checker.billingReportsPlayIntegrityActions(`
            private const val ACTION_BILLING_TOPUP = "billing_topup"
            private const val ACTION_SUBSCRIPTION_PURCHASE = "subscription_purchase"
            private const val ACTION_BORROW_SUBSCRIPTION = "borrow_subscription"

            fun onPurchase(productId: String) {
                reportPlayIntegrityAction(ACTION_BILLING_TOPUP)
                reportPlayIntegrityAction(
                    if (productId == BORROW_SUBSCRIPTION_ID) {
                        ACTION_BORROW_SUBSCRIPTION
                    } else {
                        ACTION_SUBSCRIPTION_PURCHASE
                    }
                )
            }

            private fun reportPlayIntegrityAction(action: String) {
                if (BuildConfig.DEBUG) return
            }
        `)).toBe(true);

        expect(checker.billingReportsPlayIntegrityActions(`
            private const val ACTION_BILLING_TOPUP = "billing_topup"
            private fun onPurchase() {
                reportPlayIntegrityAction(ACTION_BILLING_TOPUP)
            }
        `)).toBe(false);
    });

    test('requires device auth when checking expected verdict action', async () => {
        const summary = await checker.run({
            baseUrl: 'https://unused.invalid',
            assetlinksUrl: 'data:application/json,[]',
            expectedFingerprints: [],
            minVersionCode: null,
            expectedVersionName: null,
            appGradlePath: '/tmp/missing.gradle',
            backendIndexPath: '/tmp/missing-index.js',
            deviceId: '',
            deviceSecret: '',
            expectedVerdictAction: 'billing_topup',
            expectedVerdictVersionCode: null,
            requirePlayIntegrity: false,
            requireVerifiedVerdict: false,
        });

        expect(summary.ok).toBe(false);
        expect(summary.checks).toEqual(expect.arrayContaining([
            expect.objectContaining({
                name: 'playIntegrity.deviceAuthPresent',
                ok: false,
            }),
        ]));
    });

    test('extracts Play Integrity last verdict version code from debug diagnostics', () => {
        expect(checker.extractLastVerdictVersionCode({
            consoleSignals: {
                appIntegrity: {
                    versionCode: '101',
                },
            },
        })).toBe(101);
        expect(checker.extractLastVerdictVersionCode({
            consoleSignals: {
                appIntegrity: {
                    versionCode: null,
                },
            },
        })).toBeNull();
    });

    test('redacts device secret from debug endpoint labels', () => {
        const label = checker.debugUrlLabel({
            baseUrl: 'https://eclawbot.com',
            deviceId: 'device-123',
            deviceSecret: 'secret-value',
        });

        expect(label).toContain('deviceSecret=REDACTED');
        expect(label).not.toContain('secret-value');
        expect(label).not.toContain('device-123');
    });
});
