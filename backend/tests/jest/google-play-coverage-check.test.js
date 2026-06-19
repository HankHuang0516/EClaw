'use strict';

const checker = require('../../../scripts/check-google-play-coverage');

describe('Google Play coverage check script helpers', () => {
    test('extracts Android versionCode and versionName from Gradle file text', () => {
        const parsed = checker.parseAndroidVersion(`
            defaultConfig {
                versionCode = 101
                versionName = "1.0.93"
            }
        `);

        expect(parsed).toEqual({
            versionCode: 101,
            versionName: '1.0.93',
        });
    });

    test('extracts backend LATEST_APP_VERSION', () => {
        expect(checker.parseBackendLatestVersion('const LATEST_APP_VERSION = "1.0.93";')).toBe('1.0.93');
        expect(checker.parseBackendLatestVersion("const LATEST_APP_VERSION = '1.0.94';")).toBe('1.0.94');
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
            '--expected-verdict-version-code=101',
        ], '/tmp/eclaw');

        expect(defaults.expectedFingerprints).toEqual(checker.DEFAULT_EXPECTED_FINGERPRINTS);
        expect(overridden.expectedFingerprints).toEqual(['AA:BB']);
        expect(overridden.expectedVerdictVersionCode).toBe(101);
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
