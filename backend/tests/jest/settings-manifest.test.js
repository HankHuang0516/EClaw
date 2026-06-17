/**
 * Unit tests for lib/settings-manifest.js — the Stage-1 settings auto-sync seam.
 *
 * Pure logic, no DB / HTTP. Asserts manifest structure, required keys on every
 * feature, minAppVersion version gating (old app → native:false + webFallback),
 * and that webFallback URLs are well-formed.
 */

const {
    buildSettingsManifest,
    FEATURES,
    SUPPORTED_PLATFORMS,
    compareVersions,
} = require('../../lib/settings-manifest');

const REQUIRED_KEYS = ['key', 'name', 'enabled', 'native', 'webFallback', 'minAppVersion'];

describe('buildSettingsManifest() — structure', () => {
    it('returns the manifest envelope with expected top-level fields', () => {
        const m = buildSettingsManifest('1.0.0', 'android');
        expect(m).toMatchObject({
            platform: 'android',
            appVersion: '1.0.0',
            stage: 1,
        });
        expect(typeof m.generatedAt).toBe('string');
        expect(Number.isNaN(Date.parse(m.generatedAt))).toBe(false);
        expect(Array.isArray(m.features)).toBe(true);
        expect(m.features.length).toBe(FEATURES.length);
    });

    it('every feature has all required keys with valid types', () => {
        const m = buildSettingsManifest('1.0.0', 'ios');
        for (const f of m.features) {
            for (const k of REQUIRED_KEYS) {
                expect(f).toHaveProperty(k);
            }
            expect(typeof f.key).toBe('string');
            expect(f.key.length).toBeGreaterThan(0);
            expect(typeof f.name).toBe('string');
            expect(typeof f.enabled).toBe('boolean');
            expect([true, false, 'partial']).toContain(f.native);
            expect(typeof f.webFallback).toBe('string');
            expect(typeof f.minAppVersion).toBe('string');
        }
    });

    it('declares all real settings feature keys (no drift in the canonical set)', () => {
        const keys = buildSettingsManifest('1.0.0', 'android').features.map((f) => f.key);
        const expected = [
            'account_identity', 'channel_api', 'subscription', 'invite', 'language',
            'display', 'chat_prefs', 'rental_management', 'notifications',
            'developer_broadcast', 'agent_policy', 'kanban_nudge', 'passive_health',
            'wallet', 'my_rentals', 'files', 'companion_petdx', 'feedback',
            'rotate_secret', 'switch_device', 'logout',
        ];
        for (const k of expected) expect(keys).toContain(k);
        expect(keys.length).toBe(expected.length);
    });

    it('feature keys are unique', () => {
        const keys = buildSettingsManifest('1.0.0', 'android').features.map((f) => f.key);
        expect(new Set(keys).size).toBe(keys.length);
    });
});

describe('buildSettingsManifest() — platform handling', () => {
    it('supports android and ios', () => {
        expect(buildSettingsManifest('1.0.0', 'android').platform).toBe('android');
        expect(buildSettingsManifest('1.0.0', 'ios').platform).toBe('ios');
    });

    it('is case-insensitive on platform', () => {
        expect(buildSettingsManifest('1.0.0', 'iOS').platform).toBe('ios');
        expect(buildSettingsManifest('1.0.0', 'ANDROID').platform).toBe('android');
    });

    it('falls back to android for unknown / missing platform', () => {
        expect(buildSettingsManifest('1.0.0', 'windows').platform).toBe('android');
        expect(buildSettingsManifest('1.0.0').platform).toBe('android');
    });

    it('reflects per-platform native drift (channel_api Android partial, iOS true)', () => {
        const a = buildSettingsManifest('1.0.0', 'android').features.find((f) => f.key === 'channel_api');
        const i = buildSettingsManifest('1.0.0', 'ios').features.find((f) => f.key === 'channel_api');
        expect(a.native).toBe('partial');
        expect(i.native).toBe(true);
    });

    it('reflects iOS notifications partial drift', () => {
        const a = buildSettingsManifest('1.0.0', 'android').features.find((f) => f.key === 'notifications');
        const i = buildSettingsManifest('1.0.0', 'ios').features.find((f) => f.key === 'notifications');
        expect(a.native).toBe(true);
        expect(i.native).toBe('partial');
    });
});

describe('drift list — HIGH/MED features are web-only on both platforms', () => {
    for (const platform of SUPPORTED_PLATFORMS) {
        for (const key of ['rotate_secret', 'switch_device', 'rental_management', 'agent_policy', 'kanban_nudge', 'passive_health']) {
            it(`${key} is native:false on ${platform}`, () => {
                const f = buildSettingsManifest('1.0.0', platform).features.find((x) => x.key === key);
                expect(f.native).toBe(false);
                expect(f.webFallback).toContain(`focus=${key}`);
            });
        }
    }
});

describe('minAppVersion gating', () => {
    // Synthetic gate: temporarily lift a feature's native floor so we can prove
    // an old app gets downgraded. We do this by mutating the exported FEATURES
    // entry and restoring it (table-driven, deterministic).
    const target = FEATURES.find((f) => f.key === 'companion_petdx');
    const origNative = JSON.parse(JSON.stringify(target.native));
    const origMin = JSON.parse(JSON.stringify(target.minAppVersion));

    afterEach(() => {
        target.native = JSON.parse(JSON.stringify(origNative));
        target.minAppVersion = JSON.parse(JSON.stringify(origMin));
    });

    it('an app OLDER than minAppVersion sees native:false + webFallback', () => {
        target.native = { android: true, ios: true };
        target.minAppVersion = { android: '2.5.0', ios: '2.5.0' };

        const oldApp = buildSettingsManifest('1.0.0', 'android').features.find((f) => f.key === 'companion_petdx');
        expect(oldApp.native).toBe(false);
        expect(oldApp.webFallback).toContain('focus=companion_petdx');
        expect(oldApp.minAppVersion).toBe('2.5.0');
    });

    it('an app AT or ABOVE minAppVersion keeps native support', () => {
        target.native = { android: true, ios: true };
        target.minAppVersion = { android: '2.5.0', ios: '2.5.0' };

        const atVer = buildSettingsManifest('2.5.0', 'android').features.find((f) => f.key === 'companion_petdx');
        const above = buildSettingsManifest('3.0.0', 'android').features.find((f) => f.key === 'companion_petdx');
        expect(atVer.native).toBe(true);
        expect(above.native).toBe(true);
    });

    it('partial native is also downgraded for an old app', () => {
        target.native = { android: 'partial', ios: 'partial' };
        target.minAppVersion = { android: '2.5.0', ios: '2.5.0' };

        const oldApp = buildSettingsManifest('1.0.0', 'android').features.find((f) => f.key === 'companion_petdx');
        expect(oldApp.native).toBe(false);
    });

    it('omitting appVersion reports native as declared (no downgrade)', () => {
        target.native = { android: true, ios: true };
        target.minAppVersion = { android: '2.5.0', ios: '2.5.0' };

        const noVer = buildSettingsManifest(undefined, 'android').features.find((f) => f.key === 'companion_petdx');
        expect(noVer.native).toBe(true);
        expect(noVer.appVersion).toBeUndefined(); // it's a feature, no appVersion field
    });
});

describe('webFallback URLs are well-formed', () => {
    it('every webFallback is an https eclawbot.com portal URL with a focus param', () => {
        const m = buildSettingsManifest('1.0.0', 'android');
        for (const f of m.features) {
            const u = new URL(f.webFallback);
            expect(u.protocol).toBe('https:');
            expect(u.hostname).toBe('eclawbot.com');
            expect(u.pathname).toBe('/portal/settings.html');
            expect(u.searchParams.get('focus')).toBe(f.key);
        }
    });
});

describe('compareVersions()', () => {
    it('orders versions correctly', () => {
        expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
        expect(compareVersions('1.2.0', '1.1.9')).toBe(1);
        expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
        expect(compareVersions('1.0', '1.0.0')).toBe(0);
    });
});
