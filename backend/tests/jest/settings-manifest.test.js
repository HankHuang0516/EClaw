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
    FIELD_SCHEMA_VERSION,
    compareVersions,
} = require('../../lib/settings-manifest');

const REQUIRED_KEYS = ['key', 'name', 'enabled', 'native', 'webFallback', 'minAppVersion', 'schemaVersion', 'fields'];

const FIELD_TYPES = ['boolean', 'string', 'number', 'enum', 'multi_enum', 'action'];
const FIELD_CONTROLS = ['switch', 'slider', 'text', 'select', 'multiselect', 'button'];
const FIELD_SCOPES = ['device', 'entity', 'user'];

// Shared assertion: a {fallback, i18nKey} localizable descriptor.
function assertLabelShape(obj) {
    expect(obj).toBeTruthy();
    expect(typeof obj.fallback).toBe('string');
    expect(obj.fallback.length).toBeGreaterThan(0);
    expect(typeof obj.i18nKey).toBe('string');
    expect(obj.i18nKey.length).toBeGreaterThan(0);
}

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
        // Field-registry layer advertises its format version at envelope level.
        expect(m.schemaVersion).toBe(FIELD_SCHEMA_VERSION);
        expect(m.schemaVersion).toBe(1);
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
            expect(typeof f.schemaVersion).toBe('number');
            expect(Array.isArray(f.fields)).toBe(true);
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

describe('Stage-3 field registry (JSON-schema-lite)', () => {
    const manifest = buildSettingsManifest('1.0.0', 'android');
    const byKey = (k) => manifest.features.find((f) => f.key === k);

    it('every feature carries schemaVersion === 1 and a fields array', () => {
        for (const f of manifest.features) {
            expect(f.schemaVersion).toBe(1);
            expect(Array.isArray(f.fields)).toBe(true);
        }
    });

    it('every field has a valid type/control/scope and {fallback,i18nKey} label', () => {
        for (const f of manifest.features) {
            for (const field of f.fields) {
                expect(typeof field.key).toBe('string');
                expect(field.key.length).toBeGreaterThan(0);
                expect(FIELD_TYPES).toContain(field.type);
                expect(FIELD_CONTROLS).toContain(field.control);
                expect(FIELD_SCOPES).toContain(field.scope);
                assertLabelShape(field.label);
                if (field.help !== undefined) assertLabelShape(field.help);
            }
        }
    });

    it('field keys are unique within each feature', () => {
        for (const f of manifest.features) {
            const keys = f.fields.map((x) => x.key);
            expect(new Set(keys).size).toBe(keys.length);
        }
    });

    it('non-action fields declare a default; action fields do not', () => {
        for (const f of manifest.features) {
            for (const field of f.fields) {
                if (field.type === 'action') {
                    expect(field).not.toHaveProperty('default');
                } else {
                    expect(field).toHaveProperty('default');
                }
            }
        }
    });

    it('fields preserve declaration order (notifications: bot_reply first)', () => {
        const notif = byKey('notifications');
        expect(notif.fields.length).toBe(8);
        expect(notif.fields[0].key).toBe('bot_reply');
        expect(notif.fields.map((x) => x.key)).toEqual([
            'bot_reply', 'broadcast', 'speak_to', 'feedback',
            'todo', 'scheduled', 'user_mention', 'rich_card',
        ]);
    });

    it('notification fields are boolean switches scoped to device with required:false', () => {
        const notif = byKey('notifications');
        for (const field of notif.fields) {
            expect(field.type).toBe('boolean');
            expect(field.control).toBe('switch');
            expect(field.scope).toBe('device');
            expect(typeof field.default).toBe('boolean');
            expect(field.validation.required).toBe(false);
        }
    });

    it('chat_prefs avatar_size is an enum/select with an options[] validation', () => {
        const field = byKey('chat_prefs').fields.find((x) => x.key === 'avatar_size');
        expect(field.type).toBe('enum');
        expect(field.control).toBe('select');
        expect(field.default).toBe('medium');
        expect(Array.isArray(field.validation.options)).toBe(true);
        expect(field.validation.options.map((o) => o.value)).toEqual(['small', 'medium', 'large']);
        for (const opt of field.validation.options) assertLabelShape(opt.label);
    });

    it('account_identity display name is a string field with a maxLength validation', () => {
        const field = byKey('account_identity').fields.find((x) => x.key === 'user_display_name');
        expect(field.type).toBe('string');
        expect(field.control).toBe('text');
        expect(field.scope).toBe('user');
        expect(field.validation.maxLength).toBe(64);
        expect(field.validation.required).toBe(false);
    });

    it('rotate_secret exposes a single action field (no default, confirm:true)', () => {
        const fields = byKey('rotate_secret').fields;
        expect(fields.length).toBe(1);
        const action = fields[0];
        expect(action.type).toBe('action');
        expect(action.control).toBe('button');
        expect(action).not.toHaveProperty('default');
        expect(action.validation.confirm).toBe(true);
        assertLabelShape(action.help);
    });

    it('switch_device exposes two required text fields + a confirm action', () => {
        const fields = byKey('switch_device').fields;
        const action = fields.find((x) => x.type === 'action');
        const texts = fields.filter((x) => x.type === 'string');
        expect(action).toBeTruthy();
        expect(action.control).toBe('button');
        expect(texts.map((x) => x.key)).toEqual(['device_id', 'device_secret']);
        for (const t of texts) {
            expect(t.control).toBe('text');
            expect(t.validation.required).toBe(true);
        }
    });

    it('kanban_nudge batch_size is a number field with {min,max,step,unit} validation', () => {
        const field = byKey('kanban_nudge').fields.find((x) => x.key === 'kanban_nudge_batch_size');
        expect(field.type).toBe('number');
        expect(field.control).toBe('slider');
        expect(field.scope).toBe('device');
        expect(field.default).toBe(5);
        expect(field.validation.min).toBe(1);
        expect(field.validation.max).toBe(20);
        expect(field.validation.step).toBe(1);
        expect(field.validation.unit).toBe('cards');
    });

    it('every number-typed field declares {min,max} or {step,unit} bounds', () => {
        let numberFieldCount = 0;
        for (const f of manifest.features) {
            for (const field of f.fields) {
                if (field.type === 'number') {
                    numberFieldCount += 1;
                    const v = field.validation || {};
                    const hasBounds = typeof v.min === 'number' || typeof v.max === 'number'
                        || typeof v.step === 'number' || typeof v.unit === 'string';
                    expect(hasBounds).toBe(true);
                }
            }
        }
        // Sanity: this slice ships at least one real number field.
        expect(numberFieldCount).toBeGreaterThanOrEqual(2);
    });

    it('action type appears for the HIGH-drift features rotate_secret + switch_device', () => {
        const hasAction = (k) => byKey(k).fields.some((x) => x.type === 'action');
        expect(hasAction('rotate_secret')).toBe(true);
        expect(hasAction('switch_device')).toBe(true);
    });

    it('fields are emitted regardless of platform (not gated by native downgrade)', () => {
        const ios = buildSettingsManifest('1.0.0', 'ios').features.find((f) => f.key === 'notifications');
        // notifications is iOS:"partial" but its field registry is still present.
        expect(ios.fields.length).toBe(8);
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
